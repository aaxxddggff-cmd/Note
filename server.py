"""สมุดสิ่งสำคัญ — notes + calendar web app; anyone can sign up, each account sees only its own data.

Python standard library (http.server + sqlite3); pywebpush is optional (push notifications). Run:

    python3 server.py                         # http://localhost:8001
    python3 server.py --users                 # list accounts
    python3 server.py --create-user EMAIL     # make an account (works with sign-ups closed)
    python3 server.py --reset-password EMAIL  # set a new password for an account
    python3 server.py --delete-user EMAIL
    python3 server.py --reset                 # delete everything and start over

Environment (all optional): DATA_DIR, HOST, PORT, TRUST_PROXY=1 behind a reverse proxy,
ALLOW_SIGNUP=0 to close sign-ups, USER_QUOTA_MB (attachments per account, default 200),
PUBLIC_URL (for e-mailed links), SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM
(password-reset e-mails), PUSH_CONTACT=mailto:you@example.com, OWNER_EMAIL (owner of data from older versions).
"""

import argparse
import calendar
import getpass
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shutil
import smtplib
import sqlite3
import sys
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

import backup
import push

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
SCHEMA_PATH = os.path.join(BASE_DIR, "schema.sql")
DATA_DIR = os.environ.get("DATA_DIR") or BASE_DIR
DEFAULT_DB = os.path.join(DATA_DIR, "data.db")
DEFAULT_UPLOADS = os.path.join(DATA_DIR, "uploads")
SCHEMA_VERSION = 4

SESSION_COOKIE = "sid"
SESSION_DAYS = 180
PBKDF2_ROUNDS = 600_000
MIN_PASSWORD = 8
LOGIN_LIMIT = (10, 15 * 60)    # failed attempts per IP or e-mail, window in seconds
SIGNUP_LIMIT = (5, 60 * 60)     # sign-ups per IP per hour
RESET_LIMIT = (5, 60 * 60)      # reset e-mails per IP per hour
USER_QUOTA = int(os.environ.get("USER_QUOTA_MB") or 200) * 1024 * 1024
MAX_NOTES = 20_000
MAX_CATEGORIES = 50
MAX_CHECKLIST = 200
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$")

MAX_UPLOAD = 10 * 1024 * 1024
MAX_RANGE_DAYS = 400
MAX_REMIND = 60 * 24 * 30
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
REPEATS = ("none", "day", "week", "month", "year")

DEFAULT_CATEGORIES = [
    # name, color, important
    ("สำคัญ", "#EA580C", 1),
    ("งาน", "#2563EB", 0),
    ("ส่วนตัว", "#7C3AED", 0),
    ("บิล / ค่าใช้จ่าย", "#0891B2", 0),
]

DEFAULT_SETTINGS = {
    "theme": "system",          # light | dark | system
    "show_holidays": True,
    "buddhist_year": True,
    "week_start": 1,            # 0 = Sunday, 1 = Monday
    "default_remind": 30,       # minutes, None = no reminder
    "morning_summary": True,
    "timezone": "Asia/Bangkok",  # for server-sent reminders; the app sends the browser's zone
}


class BadRequest(Exception):
    pass


class NotFound(Exception):
    pass


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt.hex()}${digest.hex()}"


def verify_password(password, stored):
    try:
        _, rounds, salt, digest = stored.split("$")
        got = hashlib.pbkdf2_hmac("sha256", (password or "").encode(), bytes.fromhex(salt), int(rounds))
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(got.hex(), digest)


DUMMY_HASH = hash_password(secrets.token_urlsafe(16))  # keeps unknown-email logins as slow as real ones


def signup_open():
    return os.environ.get("ALLOW_SIGNUP", "1") != "0"


def mail_configured():
    return bool(os.environ.get("SMTP_HOST") and os.environ.get("SMTP_FROM"))


def send_mail(to, subject, text):
    msg = EmailMessage()
    msg["From"] = os.environ["SMTP_FROM"]
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    port = int(os.environ.get("SMTP_PORT") or 587)
    try:
        cls = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP
        with cls(os.environ["SMTP_HOST"], port, timeout=20) as smtp:
            if port != 465:
                smtp.starttls()
            if os.environ.get("SMTP_USER"):
                smtp.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
            smtp.send_message(msg)
    except Exception as e:
        print(f"ส่งอีเมลไม่สำเร็จ: {e}")


def public_url(h):
    if os.environ.get("PUBLIC_URL"):
        return os.environ["PUBLIC_URL"].rstrip("/")
    scheme = "https" if h.is_https() else "http"
    return f"{scheme}://{h.headers.get('Host', 'localhost')}"


def clean_email(v):
    v = v.strip().lower() if isinstance(v, str) else ""
    if not EMAIL_RE.match(v) or len(v) > 254:
        raise BadRequest("อีเมลไม่ถูกต้อง")
    return v


def valid_date(value):
    if not isinstance(value, str) or not DATE_RE.match(value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def parse_date(value, what="วันที่"):
    if not valid_date(value):
        raise BadRequest(f"{what}ไม่ถูกต้อง (YYYY-MM-DD)")
    return date.fromisoformat(value)


def add_months(d, months, day):
    """d's month + months, on `day` clamped to the month's length (31 Jan + 1 month = 28/29 Feb)."""
    m = d.month - 1 + months
    y = d.year + m // 12
    m = m % 12 + 1
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def occurrences(note, start, end):
    """Dates in [start, end] on which the note falls."""
    first = date.fromisoformat(note["date"])
    last = end
    if note["repeat"] != "none" and note["repeat_until"]:
        last = min(last, date.fromisoformat(note["repeat_until"]))
    if last < first or last < start:
        return []
    rep = note["repeat"]
    if rep == "none":
        return [first] if start <= first <= end else []
    if rep in ("day", "week"):
        step = 1 if rep == "day" else 7
        skip = max(0, (start - first).days)
        d = first + timedelta(days=-(-skip // step) * step)
        out = []
        while d <= last:
            out.append(d)
            d += timedelta(days=step)
        return out
    step = 1 if rep == "month" else 12
    months_between = (start.year - first.year) * 12 + start.month - first.month
    i = max(0, months_between // step - 1)
    out = []
    while True:
        d = add_months(first, i * step, first.day)
        if d > last:
            return out
        if d >= start:
            out.append(d)
        i += 1


def next_occurrence(note, today):
    found = occurrences(note, today, today + timedelta(days=800))
    return found[0] if found else None


# ---------------------------------------------------------------- storage


class Store:
    """All database access. Every user-facing method takes the user id and only touches that user's rows."""

    def __init__(self, path, uploads_dir):
        self.lock = threading.RLock()
        self.uploads = uploads_dir
        os.makedirs(uploads_dir, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self._migrate()

    # -- setup

    def _cols(self, table):
        return [r["name"] for r in self.db.execute(f"PRAGMA table_info({table})")]

    def _migrate(self):
        with self.lock:
            version = self.db.execute("PRAGMA user_version").fetchone()[0]
            if version >= SCHEMA_VERSION:
                return
            legacy = bool(self._cols("notes"))
            self.db.execute("PRAGMA foreign_keys = OFF")
            v1 = "priority" in self._cols("notes")
            if v1:  # version 1: notes had priority/color/done
                self.db.execute("DROP INDEX IF EXISTS idx_notes_date")
                self.db.execute("ALTER TABLE notes RENAME TO notes_v1")
            if legacy:
                self.db.execute("DROP INDEX IF EXISTS idx_notes_date")
                for table in ("categories", "notes", "push_subscriptions"):
                    cols = self._cols(table)
                    if cols and "user_id" not in cols:
                        self.db.execute(f"ALTER TABLE {table} ADD COLUMN user_id INTEGER REFERENCES users (id) ON DELETE CASCADE")
                self.db.execute("DROP TABLE IF EXISTS sessions")  # version 3 sessions had no user
            with open(SCHEMA_PATH, encoding="utf-8") as f:
                self.db.executescript(f.read())

            if legacy:
                # Everything that existed before accounts belongs to one "owner" account.
                password = None
                if self._cols("meta"):
                    row = self.db.execute("SELECT value FROM meta WHERE key = 'password'").fetchone()
                    password = row["value"] if row else None
                email = (os.environ.get("OWNER_EMAIL") or "owner@localhost").strip().lower()
                had_password = bool(password)
                if not password:
                    password = hash_password(secrets.token_urlsafe(24))  # unusable until reset
                cur = self.db.execute("INSERT INTO users (email, password, created_at) VALUES (?, ?, ?)",
                                      (email, password, now_iso()))
                owner = cur.lastrowid
                for table in ("categories", "notes", "push_subscriptions"):
                    self.db.execute(f"UPDATE {table} SET user_id = ? WHERE user_id IS NULL", (owner,))
                if not self.db.execute("SELECT 1 FROM categories WHERE user_id = ?", (owner,)).fetchone():
                    self._seed_categories(owner)
                if self._cols("settings"):
                    self.db.execute("INSERT OR IGNORE INTO user_settings (user_id, key, value) "
                                    "SELECT ?, key, value FROM settings", (owner,))
                    self.db.execute("DROP TABLE settings")
                self.db.execute("DELETE FROM meta WHERE key IN ('password', 'last_morning')")
                if v1:
                    important = self.db.execute(
                        "SELECT id FROM categories WHERE user_id = ? AND important = 1 ORDER BY sort LIMIT 1", (owner,)).fetchone()
                    self.db.execute(
                        "INSERT INTO notes (id, user_id, title, detail, date, time, category_id, remind_minutes, created_at, updated_at) "
                        "SELECT id, ?, title, detail, date, time, CASE WHEN priority = 'high' THEN ? END, remind_minutes, "
                        "created_at, updated_at FROM notes_v1",
                        (owner, important["id"] if important else None))
                    self.db.execute("INSERT INTO completions (note_id, date) SELECT id, date FROM notes_v1 WHERE done = 1")
                    self.db.execute("DROP TABLE notes_v1")
                print(f"ย้ายข้อมูลเดิมไปไว้ในบัญชี {email} แล้ว" + (" (ใช้รหัสผ่านเดิม)" if had_password else
                      f" (ตั้งรหัสผ่านด้วย: python3 server.py --reset-password {email})"))
            self.db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            self.db.commit()
            self.db.execute("PRAGMA foreign_keys = ON")

    def _seed_categories(self, uid):
        self.db.executemany(
            "INSERT INTO categories (user_id, name, color, important, sort) VALUES (?, ?, ?, ?, ?)",
            [(uid, n, c, imp, i) for i, (n, c, imp) in enumerate(DEFAULT_CATEGORIES)])

    def _rows(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args)]

    def _write(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur

    # -- users

    def user(self, uid):
        rows = self._rows("SELECT id, email, created_at, last_login_at FROM users WHERE id = ?", (uid,))
        return rows[0] if rows else None

    def user_by_email(self, email):
        rows = self._rows("SELECT * FROM users WHERE email = ?", ((email or "").strip().lower(),))
        return rows[0] if rows else None

    def users(self):
        return self._rows(
            "SELECT u.id, u.email, u.created_at, u.last_login_at, "
            "(SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id) AS notes, "
            "(SELECT COALESCE(SUM(a.size), 0) FROM attachments a JOIN notes n ON n.id = a.note_id WHERE n.user_id = u.id) AS bytes "
            "FROM users u ORDER BY u.id")

    def create_user(self, email, password):
        with self.lock:
            try:
                cur = self.db.execute("INSERT INTO users (email, password, created_at) VALUES (?, ?, ?)",
                                      (email.strip().lower(), hash_password(password), now_iso()))
            except sqlite3.IntegrityError:
                self.db.rollback()
                raise BadRequest("อีเมลนี้มีบัญชีอยู่แล้ว")
            uid = cur.lastrowid
            self._seed_categories(uid)
            self.db.commit()
        return uid

    def check_login(self, email, password):
        """The user id if the password matches, else None (always spends the same time hashing)."""
        u = self.user_by_email(email)
        ok = verify_password(password, u["password"] if u else DUMMY_HASH)
        if not (u and ok):
            return None
        self._write("UPDATE users SET last_login_at = ? WHERE id = ?", (now_iso(), u["id"]))
        return u["id"]

    def check_password(self, uid, password):
        rows = self._rows("SELECT password FROM users WHERE id = ?", (uid,))
        return bool(rows) and verify_password(password, rows[0]["password"])

    def set_password(self, uid, password):
        self._write("UPDATE users SET password = ? WHERE id = ?", (hash_password(password), uid))

    def set_email(self, uid, email):
        try:
            self._write("UPDATE users SET email = ? WHERE id = ?", (email.strip().lower(), uid))
        except sqlite3.IntegrityError:
            raise BadRequest("อีเมลนี้มีบัญชีอยู่แล้ว")

    def delete_user(self, uid):
        stored = [r["stored"] for r in self._rows(
            "SELECT a.stored FROM attachments a JOIN notes n ON n.id = a.note_id WHERE n.user_id = ?", (uid,))]
        self._write("DELETE FROM users WHERE id = ?", (uid,))
        self._write("DELETE FROM meta WHERE key = ?", (f"last_morning:{uid}",))
        for name in stored:
            self._remove_file(name)

    def export(self, uid):
        notes = self._rows("SELECT * FROM notes WHERE user_id = ? ORDER BY date, id", (uid,))
        for n in notes:
            n.pop("user_id", None)
            n["checklist"] = self._rows("SELECT text, done FROM checklist WHERE note_id = ? ORDER BY sort, id", (n["id"],))
            n["completed"] = [r["date"] for r in self._rows("SELECT date FROM completions WHERE note_id = ?", (n["id"],))]
            n["attachments"] = self._rows("SELECT name, mime, size, created_at FROM attachments WHERE note_id = ?", (n["id"],))
        cats = [{k: v for k, v in c.items() if k != "user_id"} for c in self.categories(uid)]
        return {"account": self.user(uid), "exported_at": now_iso(), "settings": self.settings(uid),
                "categories": cats, "notes": notes}

    # -- sessions and password resets

    @staticmethod
    def _hash_token(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def create_session(self, uid, user_agent=""):
        token = secrets.token_urlsafe(32)
        now = datetime.now()
        self._write("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
                    (self._hash_token(token), uid, now.isoformat(timespec="seconds"),
                     (now + timedelta(days=SESSION_DAYS)).isoformat(timespec="seconds"), user_agent[:200]))
        return token

    def session_user(self, token):
        """The user id for a valid session token, else None."""
        if not token:
            return None
        rows = self._rows("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", (self._hash_token(token),))
        if not rows or rows[0]["expires_at"] <= now_iso():
            return None
        return rows[0]["user_id"]

    def end_session(self, token):
        self._write("DELETE FROM sessions WHERE token_hash = ?", (self._hash_token(token or ""),))

    def end_all_sessions(self, uid, keep=None):
        self._write("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (uid, self._hash_token(keep or "")))

    def create_reset(self, uid):
        token = secrets.token_urlsafe(32)
        self._write("DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?", (uid, now_iso()))
        self._write("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                    (self._hash_token(token), uid, (datetime.now() + timedelta(hours=1)).isoformat(timespec="seconds")))
        return token

    def use_reset(self, token, password):
        rows = self._rows("SELECT user_id, expires_at FROM password_resets WHERE token_hash = ?", (self._hash_token(token or ""),))
        if not rows or rows[0]["expires_at"] <= now_iso():
            raise BadRequest("ลิงก์นี้หมดอายุหรือใช้ไปแล้ว ขอลิงก์ใหม่อีกครั้ง")
        uid = rows[0]["user_id"]
        self.set_password(uid, password)
        self._write("DELETE FROM password_resets WHERE user_id = ?", (uid,))
        self.end_all_sessions(uid)
        return uid

    # -- meta (internal values)

    def meta(self, key):
        rows = self._rows("SELECT value FROM meta WHERE key = ?", (key,))
        return rows[0]["value"] if rows else None

    def set_meta(self, key, value):
        self._write("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    (key, value))

    # -- categories

    def categories(self, uid):
        return self._rows(
            "SELECT c.*, (SELECT COUNT(*) FROM notes n WHERE n.category_id = c.id) AS count "
            "FROM categories c WHERE c.user_id = ? ORDER BY sort, id", (uid,))

    def create_category(self, uid, data):
        with self.lock:
            if self.db.execute("SELECT COUNT(*) FROM categories WHERE user_id = ?", (uid,)).fetchone()[0] >= MAX_CATEGORIES:
                raise BadRequest(f"มีหมวดได้ไม่เกิน {MAX_CATEGORIES} หมวด")
            sort = self.db.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM categories WHERE user_id = ?", (uid,)).fetchone()[0]
            cur = self._write(
                "INSERT INTO categories (user_id, name, color, important, sort) VALUES (?, ?, ?, ?, ?)",
                (uid, data["name"], data["color"], data.get("important", 0), sort))
        return self._category(uid, cur.lastrowid)

    def _category(self, uid, cat_id):
        rows = [c for c in self.categories(uid) if c["id"] == cat_id]
        if not rows:
            raise NotFound("ไม่พบหมวดนี้")
        return rows[0]

    def update_category(self, uid, cat_id, data):
        self._category(uid, cat_id)
        sets = ", ".join(f"{k} = ?" for k in data)
        self._write(f"UPDATE categories SET {sets} WHERE id = ? AND user_id = ?", [*data.values(), cat_id, uid])
        return self._category(uid, cat_id)

    def delete_category(self, uid, cat_id):
        if self._write("DELETE FROM categories WHERE id = ? AND user_id = ?", (cat_id, uid)).rowcount == 0:
            raise NotFound("ไม่พบหมวดนี้")

    def category_exists(self, uid, cat_id):
        return bool(self._rows("SELECT 1 FROM categories WHERE id = ? AND user_id = ?", (cat_id, uid)))

    # -- settings

    def settings(self, uid):
        out = dict(DEFAULT_SETTINGS)
        for r in self._rows("SELECT key, value FROM user_settings WHERE user_id = ?", (uid,)):
            if r["key"] in out:
                out[r["key"]] = json.loads(r["value"])
        return out

    def update_settings(self, uid, data):
        with self.lock:
            self.db.executemany(
                "INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) "
                "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
                [(uid, k, json.dumps(v)) for k, v in data.items()])
            self.db.commit()
        return self.settings(uid)

    # -- push subscriptions and the server's reminder log

    def push_subscriptions(self, uid=None):
        if uid is None:
            return self._rows("SELECT * FROM push_subscriptions WHERE user_id IS NOT NULL")
        return self._rows("SELECT * FROM push_subscriptions WHERE user_id = ?", (uid,))

    def push_users(self):
        return [r["user_id"] for r in self._rows("SELECT DISTINCT user_id FROM push_subscriptions WHERE user_id IS NOT NULL")]

    def add_push_subscription(self, uid, endpoint, p256dh, auth, user_agent=""):
        # an endpoint belongs to one browser; if someone else logs in there it moves to them
        self._write(
            "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth",
            (endpoint, uid, p256dh, auth, user_agent[:200], now_iso()))

    def delete_push_subscription(self, endpoint, uid=None):
        if uid is None:
            self._write("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
        else:
            self._write("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", (endpoint, uid))

    def reminder_log(self):
        return {(r["note_id"], r["date"]): r for r in self._rows("SELECT * FROM reminder_log")}

    def log_reminder(self, note_id, day, sig, now):
        self._write(
            "INSERT INTO reminder_log (note_id, date, signature, first_at, last_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (note_id, date) DO UPDATE SET last_at = excluded.last_at, snooze_until = NULL, "
            "signature = excluded.signature, "
            "first_at = CASE WHEN reminder_log.signature = excluded.signature THEN reminder_log.first_at ELSE excluded.first_at END",
            (note_id, day, sig, now, now))

    def snooze_reminder(self, uid, note_id, day, until):
        note = self.note(uid, note_id)
        sig = f"{note['time']}|{note['remind_minutes']}"
        now = time.time()
        self._write(
            "INSERT INTO reminder_log (note_id, date, signature, first_at, last_at, snooze_until) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (note_id, date) DO UPDATE SET snooze_until = excluded.snooze_until, signature = excluded.signature",
            (note_id, day, sig, now, now, until))

    def prune_reminder_log(self, before):
        self._write("DELETE FROM reminder_log WHERE last_at < ? AND (snooze_until IS NULL OR snooze_until < ?)",
                    (before, before))

    # -- notes

    def _extras(self, ids):
        """checklist counts and attachment counts for the given note ids."""
        if not ids:
            return {}, {}
        marks = ",".join("?" * len(ids))
        checks = {
            r["note_id"]: (r["total"], r["done"])
            for r in self._rows(
                f"SELECT note_id, COUNT(*) AS total, SUM(done) AS done FROM checklist "
                f"WHERE note_id IN ({marks}) GROUP BY note_id", ids)
        }
        files = {
            r["note_id"]: r["n"]
            for r in self._rows(
                f"SELECT note_id, COUNT(*) AS n FROM attachments WHERE note_id IN ({marks}) GROUP BY note_id", ids)
        }
        return checks, files

    def _completed(self, ids):
        if not ids:
            return set()
        marks = ",".join("?" * len(ids))
        return {(r["note_id"], r["date"]) for r in self._rows(
            f"SELECT note_id, date FROM completions WHERE note_id IN ({marks})", ids)}

    def _as_occurrences(self, pairs):
        """[(note, date)] -> occurrence dicts: the note plus occ, done, checklist and attachment counts."""
        ids = sorted({n["id"] for n, _ in pairs})
        checks, files = self._extras(ids)
        done = self._completed(ids)
        out = []
        for n, d in pairs:
            key = d.isoformat()
            total, finished = checks.get(n["id"], (0, 0))
            item = {k: v for k, v in n.items() if k != "user_id"}
            item.update({
                "occ": key,
                "done": (n["id"], key) in done,
                "checklist_total": total,
                "checklist_done": finished or 0,
                "attachments": files.get(n["id"], 0),
            })
            out.append(item)
        out.sort(key=lambda o: (o["occ"], o["time"] is not None, o["time"] or "", o["id"]))
        return out

    def occurrences_between(self, uid, start, end):
        notes = self._rows(
            "SELECT * FROM notes WHERE user_id = ? AND date <= ? AND "
            "((repeat = 'none' AND date >= ?) OR (repeat != 'none' AND (repeat_until IS NULL OR repeat_until >= ?)))",
            (uid, end.isoformat(), start.isoformat(), start.isoformat()))
        return self._as_occurrences([(n, d) for n in notes for d in occurrences(n, start, end)])

    def overdue(self, uid, today):
        notes = self._rows(
            "SELECT * FROM notes n WHERE user_id = ? AND repeat = 'none' AND date < ? "
            "AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.note_id = n.id AND c.date = n.date)",
            (uid, today.isoformat()))
        return self._as_occurrences([(n, date.fromisoformat(n["date"])) for n in notes])

    def _current(self, notes, today):
        """Each note at the occurrence that matters now: its date, or for a repeating note the next one."""
        pairs = []
        for n in notes:
            d = date.fromisoformat(n["date"])
            if n["repeat"] != "none":
                d = next_occurrence(n, today) or date.fromisoformat(n["repeat_until"] or n["date"])
            pairs.append((n, d))
        return self._as_occurrences(pairs)

    def important(self, uid, today):
        notes = self._rows(
            "SELECT n.* FROM notes n JOIN categories c ON c.id = n.category_id "
            "WHERE n.user_id = ? AND c.important = 1", (uid,))
        return [o for o in self._current(notes, today) if not o["done"]]

    def search(self, uid, q, today):
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        notes = self._rows(
            "SELECT * FROM notes n WHERE n.user_id = ?2 AND (title LIKE ?1 ESCAPE '\\' OR detail LIKE ?1 ESCAPE '\\' "
            "OR EXISTS (SELECT 1 FROM checklist k WHERE k.note_id = n.id AND k.text LIKE ?1 ESCAPE '\\')) "
            "LIMIT 200",
            (like, uid))
        found = self._current(notes, today)
        needle = q.casefold()
        for o in found:
            o["matched_in"] = "title" if needle in o["title"].casefold() else (
                "detail" if needle in o["detail"].casefold() else "checklist")
        return found

    def note(self, uid, note_id):
        rows = self._rows("SELECT * FROM notes WHERE id = ? AND user_id = ?", (note_id, uid))
        if not rows:
            raise NotFound("ไม่พบบันทึกนี้")
        n = rows[0]
        n.pop("user_id", None)
        n["checklist"] = self._rows("SELECT * FROM checklist WHERE note_id = ? ORDER BY sort, id", (note_id,))
        for item in n["checklist"]:
            item["done"] = bool(item["done"])
        n["attachments"] = self._rows(
            "SELECT id, name, mime, size, created_at FROM attachments WHERE note_id = ? ORDER BY id", (note_id,))
        n["completed"] = [r["date"] for r in self._rows(
            "SELECT date FROM completions WHERE note_id = ? ORDER BY date", (note_id,))]
        return n

    def create_note(self, uid, data):
        with self.lock:
            if self.db.execute("SELECT COUNT(*) FROM notes WHERE user_id = ?", (uid,)).fetchone()[0] >= MAX_NOTES:
                raise BadRequest(f"จดได้ไม่เกิน {MAX_NOTES} เรื่องต่อบัญชี")
            now = now_iso()
            cols = ["user_id", *data.keys(), "created_at", "updated_at"]
            cur = self._write(
                f"INSERT INTO notes ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                [uid, *data.values(), now, now])
        return self.note(uid, cur.lastrowid)

    def update_note(self, uid, note_id, data):
        self.note(uid, note_id)
        with self.lock:
            if "date" in data:
                # a moved one-off note keeps its done state
                old = self.db.execute("SELECT date, repeat FROM notes WHERE id = ?", (note_id,)).fetchone()
                if old["repeat"] == "none" and data.get("repeat", "none") == "none":
                    self.db.execute("UPDATE completions SET date = ? WHERE note_id = ? AND date = ?",
                                    (data["date"], note_id, old["date"]))
            sets = ", ".join(f"{k} = ?" for k in data) + ", updated_at = ?"
            self._write(f"UPDATE notes SET {sets} WHERE id = ? AND user_id = ?", [*data.values(), now_iso(), note_id, uid])
        return self.note(uid, note_id)

    def delete_note(self, uid, note_id):
        stored = [r["stored"] for r in self._rows(
            "SELECT a.stored FROM attachments a JOIN notes n ON n.id = a.note_id WHERE n.id = ? AND n.user_id = ?",
            (note_id, uid))]
        if self._write("DELETE FROM notes WHERE id = ? AND user_id = ?", (note_id, uid)).rowcount == 0:
            raise NotFound("ไม่พบบันทึกนี้")
        for name in stored:
            self._remove_file(name)

    def set_done(self, uid, note_id, day, done):
        self.note(uid, note_id)
        if done:
            self._write("INSERT OR IGNORE INTO completions (note_id, date) VALUES (?, ?)", (note_id, day))
        else:
            self._write("DELETE FROM completions WHERE note_id = ? AND date = ?", (note_id, day))

    # -- checklist

    def add_check(self, uid, note_id, text):
        self.note(uid, note_id)
        with self.lock:
            count, sort = self.db.execute(
                "SELECT COUNT(*), COALESCE(MAX(sort), -1) + 1 FROM checklist WHERE note_id = ?", (note_id,)).fetchone()
            if count >= MAX_CHECKLIST:
                raise BadRequest(f"เช็กลิสต์มีได้ไม่เกิน {MAX_CHECKLIST} รายการ")
            cur = self._write("INSERT INTO checklist (note_id, text, sort) VALUES (?, ?, ?)", (note_id, text, sort))
        return self._check(uid, cur.lastrowid)

    def _check(self, uid, item_id):
        rows = self._rows(
            "SELECT k.* FROM checklist k JOIN notes n ON n.id = k.note_id WHERE k.id = ? AND n.user_id = ?", (item_id, uid))
        if not rows:
            raise NotFound("ไม่พบรายการนี้")
        rows[0]["done"] = bool(rows[0]["done"])
        return rows[0]

    def update_check(self, uid, item_id, data):
        self._check(uid, item_id)
        sets = ", ".join(f"{k} = ?" for k in data)
        self._write(f"UPDATE checklist SET {sets} WHERE id = ?", [*data.values(), item_id])
        return self._check(uid, item_id)

    def delete_check(self, uid, item_id):
        self._check(uid, item_id)
        self._write("DELETE FROM checklist WHERE id = ?", (item_id,))

    # -- attachments

    def storage_used(self, uid):
        return self._rows(
            "SELECT COALESCE(SUM(a.size), 0) AS n FROM attachments a JOIN notes n ON n.id = a.note_id WHERE n.user_id = ?",
            (uid,))[0]["n"]

    def add_attachment(self, uid, note_id, name, mime, body):
        self.note(uid, note_id)
        if self.storage_used(uid) + len(body) > USER_QUOTA:
            raise BadRequest(f"พื้นที่ไฟล์แนบเต็มแล้ว (ได้ {USER_QUOTA // (1024 * 1024)} MB ต่อบัญชี)")
        ext = os.path.splitext(name)[1].lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,8}", ext):
            ext = ""
        stored = uuid.uuid4().hex + ext
        with open(os.path.join(self.uploads, stored), "wb") as f:  # outside the lock: may be large
            f.write(body)
        cur = self._write(
            "INSERT INTO attachments (note_id, name, stored, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (note_id, name, stored, mime, len(body), now_iso()))
        return self._rows("SELECT id, name, mime, size, created_at FROM attachments WHERE id = ?", (cur.lastrowid,))[0]

    def attachment(self, uid, att_id):
        rows = self._rows(
            "SELECT a.* FROM attachments a JOIN notes n ON n.id = a.note_id WHERE a.id = ? AND n.user_id = ?", (att_id, uid))
        if not rows:
            raise NotFound("ไม่พบไฟล์นี้")
        return rows[0], os.path.join(self.uploads, rows[0]["stored"])

    def delete_attachment(self, uid, att_id):
        row, _ = self.attachment(uid, att_id)
        self._write("DELETE FROM attachments WHERE id = ?", (att_id,))
        self._remove_file(row["stored"])

    def _remove_file(self, stored):
        try:
            os.remove(os.path.join(self.uploads, stored))
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------- validation


def _text(v, field, limit, required=False):
    v = v.strip() if isinstance(v, str) else ""
    if required and not v:
        raise BadRequest(f"กรุณาใส่{field}")
    if len(v) > limit:
        raise BadRequest(f"{field}ยาวเกิน {limit} ตัวอักษร")
    return v


def _flag(v):
    return 1 if v else 0


def clean_note(body, store, uid, partial=False):
    """Validate a note from the client. partial=True (PUT) only checks fields that are present."""
    if not isinstance(body, dict):
        raise BadRequest("ข้อมูลต้องเป็น JSON object")
    out = {}
    if "title" in body:
        out["title"] = _text(body["title"], "หัวข้อ", 200, required=True)
    if "detail" in body:
        v = body["detail"] if isinstance(body["detail"], str) else ""
        if len(v) > 5000:
            raise BadRequest("โน้ตยาวเกิน 5000 ตัวอักษร")
        out["detail"] = v
    if "date" in body:
        out["date"] = parse_date(body["date"]).isoformat()
    if "time" in body:
        v = body["time"] or None
        if v is not None and (not isinstance(v, str) or not TIME_RE.match(v)):
            raise BadRequest("เวลาไม่ถูกต้อง (HH:MM)")
        out["time"] = v
    if "category_id" in body:
        v = body["category_id"]
        if v is not None and (isinstance(v, bool) or not isinstance(v, int) or not store.category_exists(uid, v)):
            raise BadRequest("ไม่พบหมวดนี้")
        out["category_id"] = v
    if "remind_minutes" in body:
        v = body["remind_minutes"]
        if v in (None, ""):
            v = None
        elif isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= MAX_REMIND:
            raise BadRequest("เวลาแจ้งเตือนไม่ถูกต้อง")
        out["remind_minutes"] = v
    if "nag" in body:
        out["nag"] = _flag(body["nag"])
    if "repeat" in body:
        if body["repeat"] not in REPEATS:
            raise BadRequest("การทำซ้ำไม่ถูกต้อง")
        out["repeat"] = body["repeat"]
    if "repeat_until" in body:
        v = body["repeat_until"] or None
        out["repeat_until"] = parse_date(v, "วันสิ้นสุด").isoformat() if v else None

    if not partial:
        if "title" not in out:
            raise BadRequest("กรุณาใส่หัวข้อ")
        if "date" not in out:
            raise BadRequest("กรุณาเลือกวันที่")
    elif not out:
        raise BadRequest("ไม่มีข้อมูลที่จะแก้ไข")
    if out.get("repeat_until") and out.get("date") and out["repeat_until"] < out["date"]:
        raise BadRequest("วันสิ้นสุดต้องไม่ก่อนวันเริ่ม")
    return out


def clean_category(body, partial=False):
    if not isinstance(body, dict):
        raise BadRequest("ข้อมูลต้องเป็น JSON object")
    out = {}
    if "name" in body or not partial:
        out["name"] = _text(body.get("name"), "ชื่อหมวด", 40, required=True)
    if "color" in body or not partial:
        if not isinstance(body.get("color"), str) or not COLOR_RE.match(body["color"]):
            raise BadRequest("สีต้องเป็นรูปแบบ #rrggbb")
        out["color"] = body["color"]
    if "important" in body:
        out["important"] = _flag(body["important"])
    if partial and not out:
        raise BadRequest("ไม่มีข้อมูลที่จะแก้ไข")
    return out


def valid_timezone(name):
    if push.ZoneInfo is None:
        return bool(re.fullmatch(r"[A-Za-z_]+(/[A-Za-z0-9_+-]+)*", name))
    try:
        push.ZoneInfo(name)
        return True
    except Exception:
        return False


def check_new_password(pw):
    if not isinstance(pw, str) or len(pw) < MIN_PASSWORD:
        raise BadRequest(f"รหัสผ่านต้องยาวอย่างน้อย {MIN_PASSWORD} ตัวอักษร")
    if len(pw) > 200:
        raise BadRequest("รหัสผ่านยาวเกินไป")
    return pw


def clean_settings(body):
    if not isinstance(body, dict):
        raise BadRequest("ข้อมูลต้องเป็น JSON object")
    out = {}
    for k, v in body.items():
        if k == "theme":
            if v not in ("light", "dark", "system"):
                raise BadRequest("ธีมไม่ถูกต้อง")
        elif k in ("show_holidays", "buddhist_year", "morning_summary"):
            v = bool(v)
        elif k == "week_start":
            if v not in (0, 1):
                raise BadRequest("วันเริ่มสัปดาห์ต้องเป็น 0 หรือ 1")
        elif k == "timezone":
            if not isinstance(v, str) or not valid_timezone(v):
                raise BadRequest("เขตเวลาไม่ถูกต้อง")
        elif k == "default_remind":
            if v is not None and (isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= MAX_REMIND):
                raise BadRequest("แจ้งเตือนค่าเริ่มต้นไม่ถูกต้อง")
        else:
            raise BadRequest(f"ไม่รู้จักการตั้งค่า {k}")
        out[k] = v
    return out


# ---------------------------------------------------------------- HTTP


ROUTES = []

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; "
       "worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


class Unauthorized(Exception):
    pass


def route(method, pattern, public=False):
    """public=True: reachable without logging in (login/setup)."""
    def register(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn, public))
        return fn
    return register


class RateLimit:
    """Failed attempts per key inside a sliding window."""

    def __init__(self, limit, window):
        self.limit, self.window = limit, window
        self.hits = {}
        self.lock = threading.Lock()

    def blocked(self, key):
        with self.lock:
            now = time.time()
            self.hits[key] = [t for t in self.hits.get(key, []) if now - t < self.window]
            return len(self.hits[key]) >= self.limit

    def fail(self, key):
        with self.lock:
            self.hits.setdefault(key, []).append(time.time())

    def clear(self, key):
        with self.lock:
            self.hits.pop(key, None)


class Handler(SimpleHTTPRequestHandler):
    store = None        # set in make_server
    pusher = None
    trust_proxy = False
    login_limit = signup_limit = reset_limit = None
    uid = None          # the logged-in user for this request

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def end_headers(self):
        api = self.path.startswith("/api/")
        self.send_header("Cache-Control", "no-store" if api else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    # -- who is asking

    def client_ip(self):
        if self.trust_proxy and self.headers.get("X-Forwarded-For"):
            return self.headers["X-Forwarded-For"].split(",")[-1].strip()
        return self.client_address[0]

    def is_local(self):
        try:
            return ipaddress.ip_address(self.client_ip()).is_loopback
        except ValueError:
            return False

    def is_https(self):
        return os.environ.get("COOKIE_SECURE") == "1" or (
            self.trust_proxy and self.headers.get("X-Forwarded-Proto", "").lower() == "https")

    def session_token(self):
        jar = cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie") or "")
        except cookies.CookieError:
            return None
        return jar[SESSION_COOKIE].value if SESSION_COOKIE in jar else None


    def cookie_header(self, token, max_age):
        parts = [f"{SESSION_COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max_age}"]
        if self.is_https():
            parts.append("Secure")
        return "; ".join(parts)

    def send_json(self, status, payload, cookie=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit):
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise BadRequest("ข้อมูลใหญ่เกินไป")
        return self.rfile.read(length)

    def read_json(self):
        try:
            return json.loads(self.read_body(100_000) or b"{}")
        except (ValueError, UnicodeDecodeError):
            raise BadRequest("JSON ไม่ถูกต้อง")

    def dispatch(self, method):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            if method == "GET":
                return super().do_GET()
            return self.send_json(405, {"error": "method not allowed"})
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            # Browsers never send this header cross-site without a CORS preflight, which we don't allow.
            if method != "GET" and self.headers.get("X-Requested-With") != "fetch":
                return self.send_json(403, {"error": "missing X-Requested-With header"})
            for m, pattern, fn, public in ROUTES:
                match = pattern.match(url.path)
                if match and m == method:
                    self.uid = self.store.session_user(self.session_token())
                    if not public and self.uid is None:
                        raise Unauthorized()
                    result = fn(self, qs, *[int(g) for g in match.groups()])
                    if result is not None:
                        status, payload = result if isinstance(result, tuple) else (200, result)
                        self.send_json(status, payload)
                    return
            self.send_json(404, {"error": "not found"})
        except BadRequest as e:
            self.send_json(400, {"error": str(e)})
        except Unauthorized:
            self.send_json(401, {"error": "กรุณาเข้าสู่ระบบ"})
        except NotFound as e:
            self.send_json(404, {"error": str(e)})

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")


def _today(qs, h):
    """The browser's local date (falls back to today in the user's time zone)."""
    if qs.get("today"):
        return parse_date(qs["today"])
    if push.ZoneInfo:
        return datetime.now(push.tz_of(h.store.settings(h.uid)["timezone"])).date()
    return date.today()


def _login(h, uid, status=200):
    token = h.store.create_session(uid, h.headers.get("User-Agent", ""))
    h.send_json(status, {"ok": True, "user": h.store.user(uid)}, cookie=h.cookie_header(token, SESSION_DAYS * 86400))


# -- accounts

@route("GET", r"/api/auth/status", public=True)
def api_auth_status(h, qs):
    uid = h.store.session_user(h.session_token())
    return {"authed": uid is not None, "user": h.store.user(uid) if uid else None,
            "signup_open": signup_open(), "reset_available": mail_configured()}


@route("POST", r"/api/auth/signup", public=True)
def api_auth_signup(h, qs):
    if not signup_open():
        raise BadRequest("ขณะนี้ปิดรับสมัครสมาชิกใหม่")
    ip = h.client_ip()
    if h.signup_limit.blocked(ip):
        raise BadRequest("สมัครจากเครือข่ายนี้หลายครั้งเกินไป ลองใหม่ภายหลัง")
    body = h.read_json()
    email = clean_email(body.get("email"))
    password = check_new_password(body.get("password"))
    uid = h.store.create_user(email, password)
    h.signup_limit.fail(ip)  # counts every sign-up, not only failures
    _login(h, uid, 201)


@route("POST", r"/api/auth/login", public=True)
def api_auth_login(h, qs):
    body = h.read_json()
    ip = h.client_ip()
    email = (body.get("email") or "").strip().lower() if isinstance(body.get("email"), str) else ""
    if h.login_limit.blocked(ip) or h.login_limit.blocked("email:" + email):
        raise BadRequest("ลองผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่")
    password = body.get("password")
    uid = h.store.check_login(email, password) if isinstance(password, str) and email else None
    if not uid:
        h.login_limit.fail(ip)
        h.login_limit.fail("email:" + email)
        raise BadRequest("อีเมลหรือรหัสผ่านไม่ถูกต้อง")
    h.login_limit.clear("email:" + email)
    _login(h, uid)


@route("POST", r"/api/auth/logout", public=True)
def api_auth_logout(h, qs):
    h.store.end_session(h.session_token())
    h.send_json(200, {"ok": True}, cookie=h.cookie_header("", 0))


@route("POST", r"/api/auth/forgot", public=True)
def api_auth_forgot(h, qs):
    if not mail_configured():
        raise BadRequest("เซิร์ฟเวอร์นี้ยังส่งอีเมลไม่ได้ ติดต่อผู้ดูแลเพื่อรีเซ็ตรหัสผ่าน")
    ip = h.client_ip()
    if h.reset_limit.blocked(ip):
        raise BadRequest("ขอหลายครั้งเกินไป ลองใหม่ภายหลัง")
    h.reset_limit.fail(ip)
    email = (h.read_json().get("email") or "")
    user = h.store.user_by_email(email) if isinstance(email, str) else None
    if user:
        token = h.store.create_reset(user["id"])
        link = f"{public_url(h)}/#/reset?token={token}"
        threading.Thread(target=send_mail, daemon=True, args=(
            user["email"], "ตั้งรหัสผ่านใหม่ — สมุดสิ่งสำคัญ",
            f"มีคนขอตั้งรหัสผ่านใหม่สำหรับบัญชี {user['email']}\n\n"
            f"กดลิงก์นี้ภายใน 1 ชั่วโมงเพื่อตั้งรหัสผ่านใหม่:\n{link}\n\n"
            "ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ\n")).start()
    return {"ok": True}  # same answer whether or not the email has an account


@route("POST", r"/api/auth/reset", public=True)
def api_auth_reset(h, qs):
    body = h.read_json()
    uid = h.store.use_reset(body.get("token"), check_new_password(body.get("password")))
    _login(h, uid)


@route("POST", r"/api/auth/password")
def api_auth_password(h, qs):
    body = h.read_json()
    if not h.store.check_password(h.uid, body.get("current") or ""):
        raise BadRequest("รหัสผ่านเดิมไม่ถูกต้อง")
    h.store.set_password(h.uid, check_new_password(body.get("new")))
    h.store.end_all_sessions(h.uid, keep=h.session_token())
    return {"ok": True}


@route("POST", r"/api/auth/logout-others")
def api_auth_logout_others(h, qs):
    h.store.end_all_sessions(h.uid, keep=h.session_token())
    return {"ok": True}


@route("GET", r"/api/account/export")
def api_account_export(h, qs):
    body = json.dumps(h.store.export(h.uid), ensure_ascii=False, indent=2).encode("utf-8")
    h.send_response(200)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Disposition", f"attachment; filename=\"notes-export-{date.today().isoformat()}.json\"")
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


@route("POST", r"/api/account/delete")
def api_account_delete(h, qs):
    if not h.store.check_password(h.uid, h.read_json().get("password") or ""):
        raise BadRequest("รหัสผ่านไม่ถูกต้อง")
    h.store.delete_user(h.uid)
    h.send_json(200, {"ok": True}, cookie=h.cookie_header("", 0))


# -- push

@route("GET", r"/api/push/config")
def api_push_config(h, qs):
    p = h.pusher
    return {"enabled": bool(p and p.enabled), "public_key": p.public_key if p else None,
            "devices": len(h.store.push_subscriptions(h.uid))}


@route("POST", r"/api/push/subscribe")
def api_push_subscribe(h, qs):
    if not (h.pusher and h.pusher.enabled):
        raise BadRequest("เซิร์ฟเวอร์ยังไม่ได้เปิดการแจ้งเตือนแบบ push")
    sub = h.read_json()
    endpoint = sub.get("endpoint")
    keys = sub.get("keys") or {}
    if not isinstance(endpoint, str) or not endpoint.startswith("https://") or len(endpoint) > 1000:
        raise BadRequest("subscription ไม่ถูกต้อง")
    if not isinstance(keys.get("p256dh"), str) or not isinstance(keys.get("auth"), str):
        raise BadRequest("subscription ไม่ถูกต้อง")
    if len(h.store.push_subscriptions(h.uid)) >= 20:
        raise BadRequest("เปิดแจ้งเตือนได้ไม่เกิน 20 เครื่อง")
    h.store.add_push_subscription(h.uid, endpoint, keys["p256dh"], keys["auth"], h.headers.get("User-Agent", ""))
    return {"ok": True}


@route("POST", r"/api/push/unsubscribe")
def api_push_unsubscribe(h, qs):
    h.store.delete_push_subscription(str(h.read_json().get("endpoint") or ""), h.uid)
    return {"ok": True}


@route("POST", r"/api/push/test")
def api_push_test(h, qs):
    if not (h.pusher and h.pusher.enabled):
        raise BadRequest("เซิร์ฟเวอร์ยังไม่ได้เปิดการแจ้งเตือนแบบ push")
    sent = h.pusher.send(h.uid, {"title": "ทดสอบการแจ้งเตือน", "body": "ถ้าเห็นข้อความนี้ แปลว่าใช้งานได้แล้ว",
                                 "tag": "test", "url": "/#/settings"})
    return {"sent": sent}


@route("POST", r"/api/notes/(\d+)/snooze")
def api_snooze(h, qs, note_id):
    body = h.read_json()
    day = parse_date(body.get("date")).isoformat()
    minutes = body.get("minutes", 60)
    if isinstance(minutes, bool) or not isinstance(minutes, int) or not 1 <= minutes <= 24 * 60:
        raise BadRequest("เวลาเลื่อนไม่ถูกต้อง")
    h.store.snooze_reminder(h.uid, note_id, day, time.time() + minutes * 60)
    return {"ok": True}


# -- notes

@route("GET", r"/api/bootstrap")
def api_bootstrap(h, qs):
    return {"user": h.store.user(h.uid), "categories": h.store.categories(h.uid), "settings": h.store.settings(h.uid)}


@route("GET", r"/api/occurrences")
def api_occurrences(h, qs):
    start = parse_date(qs.get("from"), "from ")
    end = parse_date(qs.get("to"), "to ")
    if end < start or (end - start).days > MAX_RANGE_DAYS:
        raise BadRequest(f"ช่วงวันต้องไม่เกิน {MAX_RANGE_DAYS} วัน")
    return h.store.occurrences_between(h.uid, start, end)


@route("GET", r"/api/overdue")
def api_overdue(h, qs):
    return h.store.overdue(h.uid, _today(qs, h))


@route("GET", r"/api/important")
def api_important(h, qs):
    return h.store.important(h.uid, _today(qs, h))


@route("GET", r"/api/search")
def api_search(h, qs):
    q = (qs.get("q") or "").strip()[:100]
    return h.store.search(h.uid, q, _today(qs, h)) if q else []


@route("POST", r"/api/notes")
def api_create_note(h, qs):
    return 201, h.store.create_note(h.uid, clean_note(h.read_json(), h.store, h.uid))


@route("GET", r"/api/notes/(\d+)")
def api_note(h, qs, note_id):
    return h.store.note(h.uid, note_id)


@route("PUT", r"/api/notes/(\d+)")
def api_update_note(h, qs, note_id):
    return h.store.update_note(h.uid, note_id, clean_note(h.read_json(), h.store, h.uid, partial=True))


@route("DELETE", r"/api/notes/(\d+)")
def api_delete_note(h, qs, note_id):
    h.store.delete_note(h.uid, note_id)
    return {"ok": True}


@route("POST", r"/api/notes/(\d+)/done")
def api_done(h, qs, note_id):
    body = h.read_json()
    day = parse_date(body.get("date")).isoformat()
    h.store.set_done(h.uid, note_id, day, bool(body.get("done", True)))
    return {"ok": True}


@route("POST", r"/api/notes/(\d+)/checklist")
def api_add_check(h, qs, note_id):
    return 201, h.store.add_check(h.uid, note_id, _text(h.read_json().get("text"), "รายการ", 200, required=True))


@route("PUT", r"/api/checklist/(\d+)")
def api_update_check(h, qs, item_id):
    body = h.read_json()
    data = {}
    if "text" in body:
        data["text"] = _text(body["text"], "รายการ", 200, required=True)
    if "done" in body:
        data["done"] = _flag(body["done"])
    if not data:
        raise BadRequest("ไม่มีข้อมูลที่จะแก้ไข")
    return h.store.update_check(h.uid, item_id, data)


@route("DELETE", r"/api/checklist/(\d+)")
def api_delete_check(h, qs, item_id):
    h.store.delete_check(h.uid, item_id)
    return {"ok": True}


@route("POST", r"/api/notes/(\d+)/attachments")
def api_upload(h, qs, note_id):
    name = unquote(h.headers.get("X-Filename") or "").strip().replace("/", "_").replace("\\", "_")[:200] or "ไฟล์"
    mime = (h.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if not re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", mime):
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    body = h.read_body(MAX_UPLOAD)
    if not body:
        raise BadRequest("ไฟล์ว่างเปล่า")
    return 201, h.store.add_attachment(h.uid, note_id, name, mime, body)


@route("GET", r"/api/attachments/(\d+)")
def api_download(h, qs, att_id):
    row, path = h.store.attachment(h.uid, att_id)
    if not os.path.isfile(path):
        raise NotFound("ไม่พบไฟล์นี้")
    inline = row["mime"] in INLINE_TYPES and "download" not in qs
    h.send_response(200)
    h.send_header("Content-Type", row["mime"] if inline else "application/octet-stream")
    h.send_header("Content-Length", str(os.path.getsize(path)))
    h.send_header("Content-Disposition",
                  f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(row['name'], safe='')}")
    h.end_headers()
    with open(path, "rb") as f:
        shutil.copyfileobj(f, h.wfile)


@route("DELETE", r"/api/attachments/(\d+)")
def api_delete_attachment(h, qs, att_id):
    h.store.delete_attachment(h.uid, att_id)
    return {"ok": True}


@route("GET", r"/api/categories")
def api_categories(h, qs):
    return h.store.categories(h.uid)


@route("POST", r"/api/categories")
def api_create_category(h, qs):
    return 201, h.store.create_category(h.uid, clean_category(h.read_json()))


@route("PUT", r"/api/categories/(\d+)")
def api_update_category(h, qs, cat_id):
    return h.store.update_category(h.uid, cat_id, clean_category(h.read_json(), partial=True))


@route("DELETE", r"/api/categories/(\d+)")
def api_delete_category(h, qs, cat_id):
    h.store.delete_category(h.uid, cat_id)
    return {"ok": True}


@route("GET", r"/api/settings")
def api_settings(h, qs):
    return h.store.settings(h.uid)


@route("PUT", r"/api/settings")
def api_update_settings(h, qs):
    return h.store.update_settings(h.uid, clean_settings(h.read_json()))


def make_server(host, port, db_path, uploads_dir=DEFAULT_UPLOADS, data_dir=None, trust_proxy=False, with_push=True):
    store = Store(db_path, uploads_dir)
    pusher = push.Pusher(store, data_dir or os.path.dirname(os.path.abspath(db_path)),
                         os.environ.get("PUSH_CONTACT") or "mailto:admin@localhost") if with_push else None
    handler = type("BoundHandler", (Handler,), {
        "store": store, "pusher": pusher, "trust_proxy": trust_proxy, "login_limit": RateLimit(*LOGIN_LIMIT),
        "signup_limit": RateLimit(*SIGNUP_LIMIT), "reset_limit": RateLimit(*RESET_LIMIT),
    })
    server = ThreadingHTTPServer((host, port), handler)
    server.store, server.pusher = store, pusher
    return server


def prompt_password():
    while True:
        pw = getpass.getpass("รหัสผ่านใหม่ (อย่างน้อย 8 ตัว): ")
        try:
            check_new_password(pw)
        except BadRequest as e:
            print(e)
            continue
        if getpass.getpass("พิมพ์อีกครั้ง: ") == pw:
            return pw
        print("รหัสผ่านไม่ตรงกัน")


def admin_command(args):
    store = Store(args.db, args.uploads)
    if args.users:
        rows = store.users()
        for u in rows:
            print(f"{u['id']:>5}  {u['email']:<40} สมัคร {u['created_at'][:10]}  "
                  f"เข้าล่าสุด {(u['last_login_at'] or '-')[:10]}  {u['notes']} เรื่อง  {u['bytes'] / 1048576:.1f} MB")
        print(f"ทั้งหมด {len(rows)} บัญชี")
        return
    if args.create_user:
        uid = store.create_user(clean_email(args.create_user), prompt_password())
        print(f"สร้างบัญชี {args.create_user} แล้ว (id {uid})")
        return
    email = args.reset_password or args.delete_user
    user = store.user_by_email(email)
    if not user:
        sys.exit(f"ไม่พบบัญชี {email}")
    if args.reset_password:
        store.set_password(user["id"], prompt_password())
        store.end_all_sessions(user["id"])
        print(f"ตั้งรหัสผ่านใหม่ให้ {user['email']} แล้ว (ทุกเครื่องต้องเข้าสู่ระบบใหม่)")
    else:
        if input(f"ลบบัญชี {user['email']} และข้อมูลทั้งหมด? พิมพ์ yes: ").strip() != "yes":
            sys.exit("ยกเลิก")
        store.delete_user(user["id"])
        print("ลบแล้ว")


def main():
    env = os.environ.get
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=env("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(env("PORT", "8001")))
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--uploads", default=DEFAULT_UPLOADS)
    parser.add_argument("--reset", action="store_true", help="ลบข้อมูลและไฟล์แนบทั้งหมดแล้วเริ่มใหม่")
    parser.add_argument("--users", action="store_true", help="แสดงรายชื่อบัญชี")
    parser.add_argument("--create-user", metavar="EMAIL", help="สร้างบัญชี (ใช้ได้แม้ปิดรับสมัคร)")
    parser.add_argument("--reset-password", metavar="EMAIL", help="ตั้งรหัสผ่านใหม่ให้บัญชี")
    parser.add_argument("--delete-user", metavar="EMAIL", help="ลบบัญชีและข้อมูลทั้งหมดของบัญชีนั้น")
    args = parser.parse_args()

    if args.reset:
        if os.path.exists(args.db):
            os.remove(args.db)
        shutil.rmtree(args.uploads, ignore_errors=True)
        print("ลบข้อมูลเดิมแล้ว")

    if args.users or args.create_user or args.reset_password or args.delete_user:
        return admin_command(args)

    server = make_server(args.host, args.port, args.db, args.uploads,
                         data_dir=os.path.dirname(os.path.abspath(args.db)), trust_proxy=env("TRUST_PROXY") == "1")
    print(f"บัญชีทั้งหมด {len(server.store.users())} บัญชี · รับสมัคร: {'เปิด' if signup_open() else 'ปิด'} · "
          f"อีเมลรีเซ็ตรหัสผ่าน: {'พร้อม' if mail_configured() else 'ยังไม่ได้ตั้ง SMTP'}")
    if os.path.basename(args.db) == "data.db":
        backup.start_daily(os.path.dirname(os.path.abspath(args.db)))
    if server.pusher and server.pusher.enabled:
        server.pusher.start()
        print("แจ้งเตือนแบบ push: เปิดอยู่")
    else:
        print("แจ้งเตือนแบบ push: ปิด (pip install -r requirements.txt เพื่อเปิด)")
    print(f"สมุดสิ่งสำคัญ: http://localhost:{args.port}  (Ctrl+C เพื่อหยุด)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nหยุดแล้ว")


if __name__ == "__main__":
    main()
