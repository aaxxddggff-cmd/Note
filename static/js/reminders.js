// Reminders while the app is open: checks every minute, shows an in-page card (and a system
// notification when the tab is in the background). Also the 07:30 morning summary.

import { api } from "./api.js";
import { pushActive } from "./pwa.js";
import {
  app, addDays, fromKey, toKey, todayKey, remindAt, relDay, notice, storageGet, storageSet, errorToast,
} from "./util.js";

const HOUR = 3600000;
const FIRED = "reminders-fired";   // key -> { first, last } (ms)
const SNOOZE = "reminders-snooze"; // key -> until (ms)
const MORNING = "morning-summary"; // date key of the last summary

let onChange = () => {};

export function startReminders(refresh) {
  onChange = refresh;
  check();
  setInterval(check, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}

export function askPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    return Notification.requestPermission();
  }
  return Promise.resolve("Notification" in window ? Notification.permission : "unsupported");
}

function show({ title, body, key, noteId, occ, actions }) {
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    // Android only allows notifications through the service worker
    const url = noteId ? `/#/note/${noteId}?date=${occ}` : "/#/today";
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, tag: key, icon: "/icon.svg", data: { url } }));
    } else {
      try {
        const n = new Notification(title, { body, tag: key, icon: "/icon.svg" });
        n.onclick = () => { window.focus(); location.hash = url.slice(1); n.close(); };
      } catch { /* not allowed here */ }
    }
  }
  notice({ title, body, actions });
}

async function check() {
  if (await pushActive()) return; // the server sends this device's reminders as push notifications
  const now = Date.now();
  const today = todayKey();
  let occs;
  try {
    occs = await api.occurrences(toKey(addDays(fromKey(today), -1)), toKey(addDays(fromKey(today), 8)));
  } catch {
    return; // server not reachable; try again next minute
  }
  const fired = storageGet(FIRED, {});
  const snooze = storageGet(SNOOZE, {});

  for (const o of occs) {
    if (o.done || o.remind_minutes == null) continue;
    const at = remindAt(o, o.occ);
    if (now < at) continue;
    const key = `${o.id}|${o.occ}|${o.time}|${o.remind_minutes}`;
    const f = fired[key];
    const eventAt = at + o.remind_minutes * 60000;
    let due;
    if (snooze[key]) {
      due = now >= snooze[key];
    } else if (!f) {
      due = now <= Math.max(eventAt, at) + HOUR || (o.nag && now - at <= 24 * HOUR);
    } else {
      due = o.nag && now - f.last >= HOUR && now - at <= 24 * HOUR;
    }
    if (!due) continue;

    delete snooze[key];
    fired[key] = { first: f ? f.first : now, last: now };
    const rel = relDay(o.occ);
    const left = o.checklist_total - o.checklist_done;
    show({
      key, noteId: o.id, occ: o.occ,
      title: `${rel === "วันนี้" ? "" : rel + ": "}${o.title}`,
      body: [o.time ? `${rel} ${o.time} น.` : `${rel} ทั้งวัน`, left > 0 ? `เช็กลิสต์เหลือ ${left} ข้อ` : null].filter(Boolean).join(" · "),
      actions: [
        ["เสร็จแล้ว", async () => {
          try { await api.setDone(o.id, o.occ, true); onChange(); } catch (e) { errorToast(e); }
        }, true],
        ["เลื่อน 1 ชม.", () => {
          const s = storageGet(SNOOZE, {});
          s[key] = Date.now() + HOUR;
          storageSet(SNOOZE, s);
        }],
      ],
    });
  }

  for (const [k, v] of Object.entries(fired)) if (now - v.last > 3 * 24 * HOUR) delete fired[k];
  storageSet(FIRED, fired);
  storageSet(SNOOZE, snooze);

  morningSummary(occs, today, now);
}

async function morningSummary(occs, today, now) {
  if (!app.settings.morning_summary || storageGet(MORNING, "") === today) return;
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes < 7 * 60 + 30 || minutes >= 12 * 60) return;
  storageSet(MORNING, today);
  let overdue = [];
  try { overdue = await api.overdue(); } catch { /* ignore */ }
  const todays = occs.filter((o) => o.occ === today && !o.done);
  show({
    key: `morning|${today}`,
    title: `วันนี้มี ${todays.length} เรื่อง` + (overdue.length ? ` · เลยกำหนด ${overdue.length} เรื่อง` : ""),
    body: todays.slice(0, 4).map((o) => (o.time ? `${o.time} ` : "") + o.title).join(" · ") || "วันนี้ว่าง",
    actions: [["เปิดหน้าวันนี้", () => { location.hash = "#/today"; }, true]],
  });
}
