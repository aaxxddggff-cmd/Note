"""Web Push: reminders and the morning summary sent by the server, so they arrive with the app closed.

Needs `pip install -r requirements.txt` (pywebpush). Without it the app still runs and the
browser shows reminders only while the app is open.
"""

import base64
import json
import os
import threading
import time
from datetime import date, datetime, timedelta, time as dtime

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None

try:
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid01
    from pywebpush import WebPushException, webpush
    AVAILABLE = True
except ImportError:
    AVAILABLE = False

HOUR = 3600
ALL_DAY_TIME = dtime(9, 0)       # reminders for all-day notes count from 09:00 (same as the web app)
MORNING = dtime(7, 30)
MORNING_UNTIL = dtime(12, 0)
REPEAT_LABEL = {"day": "ทุกวัน", "week": "ทุกสัปดาห์", "month": "ทุกเดือน", "year": "ทุกปี"}


def tz_of(name):
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo("Asia/Bangkok")


def remind_at(o, tz):
    """When an occurrence's reminder fires (unix seconds), or None."""
    if o["remind_minutes"] is None:
        return None
    t = dtime.fromisoformat(o["time"]) if o["time"] else ALL_DAY_TIME
    at = datetime.combine(date.fromisoformat(o["occ"]), t, tzinfo=tz)
    return (at - timedelta(minutes=o["remind_minutes"])).timestamp()


def signature(o):
    return f"{o['time']}|{o['remind_minutes']}"


def due_reminders(occs, log, now, tz):
    """Occurrences whose reminder should be sent now.

    log maps (note_id, date) -> {signature, first_at, last_at, snooze_until}. Rules match the web app:
    once from the reminder time until an hour after the note's time; with nag, again every hour
    for up to 24 hours; a snooze postpones it.
    """
    out = []
    for o in occs:
        if o["done"] or o["remind_minutes"] is None:
            continue
        at = remind_at(o, tz)
        if now < at:
            continue
        entry = log.get((o["id"], o["occ"]))
        if entry and entry["signature"] != signature(o):
            entry = None  # time or reminder changed since it was sent
        event_at = at + o["remind_minutes"] * 60
        if entry and entry["snooze_until"]:
            due = now >= entry["snooze_until"]
        elif not entry:
            due = now <= max(event_at, at) + HOUR or (o["nag"] and now - at <= 24 * HOUR)
        else:
            due = bool(o["nag"]) and now - entry["last_at"] >= HOUR and now - at <= 24 * HOUR
        if due:
            out.append(o)
    return out


def rel_day(occ, today):
    n = (date.fromisoformat(occ) - today).days
    return {0: "วันนี้", 1: "พรุ่งนี้", -1: "เมื่อวาน"}.get(n, f"อีก {n} วัน" if n > 0 else f"เลยมา {-n} วัน")


def reminder_payload(o, today):
    rel = rel_day(o["occ"], today)
    left = o["checklist_total"] - o["checklist_done"]
    body = [f"{rel} {o['time']} น." if o["time"] else f"{rel} ทั้งวัน"]
    if o["repeat"] != "none":
        body.append(REPEAT_LABEL[o["repeat"]])
    if left > 0:
        body.append(f"เช็กลิสต์เหลือ {left} ข้อ")
    return {
        "title": ("" if rel == "วันนี้" else f"{rel}: ") + o["title"],
        "body": " · ".join(body),
        "tag": f"note-{o['id']}-{o['occ']}",
        "url": f"/#/note/{o['id']}?date={o['occ']}",
        "noteId": o["id"],
        "date": o["occ"],
        "actions": True,
    }


class Pusher:
    """Owns the VAPID key, sends pushes, and runs the once-a-minute reminder loop."""

    def __init__(self, store, data_dir, contact="mailto:admin@localhost"):
        self.store = store
        self.contact = contact
        self.enabled = AVAILABLE and ZoneInfo is not None
        self.public_key = None
        self.key_path = os.path.join(data_dir, "vapid_private.pem")
        if not self.enabled:
            return
        if not os.path.exists(self.key_path):
            v = Vapid01()
            v.generate_keys()
            v.save_key(self.key_path)
            os.chmod(self.key_path, 0o600)
        v = Vapid01.from_file(self.key_path)
        raw = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        self.public_key = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    def send(self, uid, payload):
        """Send to every device the user turned push on for. Returns how many accepted it."""
        if not self.enabled:
            return 0
        sent = 0
        for sub in self.store.push_subscriptions(uid):
            info = {"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}}
            try:
                webpush(info, data=json.dumps(payload, ensure_ascii=False), vapid_private_key=self.key_path,
                        vapid_claims={"sub": self.contact}, ttl=12 * HOUR, timeout=10)
                sent += 1
            except WebPushException as e:
                status = e.response.status_code if e.response is not None else None
                if status in (404, 410):  # the browser dropped this subscription
                    self.store.delete_push_subscription(sub["endpoint"])
                else:
                    print(f"push failed ({status}) to {sub['endpoint'][:60]}")
            except Exception as e:  # network errors etc.; try again next time
                print(f"push failed: {e}")
        return sent

    def tick(self, now=None):
        """One pass of the reminder loop, for every user with push turned on somewhere."""
        if not self.enabled:
            return
        now = now or time.time()
        log = self.store.reminder_log()
        for uid in self.store.push_users():
            try:
                self._tick_user(uid, now, log)
            except Exception as e:  # one user's problem must not stop the others
                print(f"reminder error for user {uid}: {e}")
        self.store.prune_reminder_log(now - 3 * 24 * HOUR)

    def _tick_user(self, uid, now, log):
        settings = self.store.settings(uid)
        tz = tz_of(settings["timezone"])
        local = datetime.fromtimestamp(now, tz)
        today = local.date()
        occs = self.store.occurrences_between(uid, today - timedelta(days=1), today + timedelta(days=8))
        for o in due_reminders(occs, log, now, tz):
            self.send(uid, reminder_payload(o, today))
            self.store.log_reminder(o["id"], o["occ"], signature(o), now)

        key = f"last_morning:{uid}"
        if (settings["morning_summary"] and MORNING <= local.time() < MORNING_UNTIL
                and self.store.meta(key) != today.isoformat()):
            self.store.set_meta(key, today.isoformat())
            todays = [o for o in occs if o["occ"] == today.isoformat() and not o["done"]]
            overdue = self.store.overdue(uid, today)
            title = f"วันนี้มี {len(todays)} เรื่อง" + (f" · เลยกำหนด {len(overdue)} เรื่อง" if overdue else "")
            body = " · ".join((f"{o['time']} " if o["time"] else "") + o["title"] for o in todays[:4]) or "วันนี้ว่าง"
            self.send(uid, {"title": title, "body": body, "tag": f"morning-{today}", "url": "/#/today"})

    def start(self):
        if not self.enabled:
            return

        def loop():
            while True:
                try:
                    self.tick()
                except Exception as e:  # keep the loop alive
                    print(f"reminder loop error: {e}")
                time.sleep(60 - time.time() % 60 + 1)

        threading.Thread(target=loop, daemon=True, name="reminders").start()
