// Service worker: works offline (app shell + last loaded data) and shows push notifications.
// Bump VERSION when the list of files changes.

const VERSION = "v3";
const SHELL_CACHE = `shell-${VERSION}`;
const API_CACHE = "api";
const FONT_CACHE = "fonts";
const SHELL = [
  "/", "/style.css", "/manifest.json", "/icon.svg",
  "/js/main.js", "/js/api.js", "/js/util.js", "/js/holidays.js", "/js/sheets.js", "/js/reminders.js", "/js/pwa.js",
  "/js/views/today.js", "/js/views/calendar.js", "/js/views/important.js", "/js/views/week.js",
  "/js/views/search.js", "/js/views/detail.js", "/js/views/settings.js", "/js/views/login.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("shell-") && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function offlineJson() {
  return new Response(JSON.stringify({ error: "ออฟไลน์อยู่ และยังไม่มีข้อมูลนี้ในเครื่อง" }), {
    status: 503, headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com") {
    event.respondWith(caches.open(FONT_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/attachments/") || url.pathname.startsWith("/api/push/")) {
    return; // always live
  }
  if (url.pathname.startsWith("/api/")) {
    // network first; the last good answer when offline
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(API_CACHE)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req, { cacheName: API_CACHE })) || offlineJson();
      }
    })());
    return;
  }
  // app files: always the latest from the server; the cached copy only when offline
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const key = url.pathname === "/index.html" ? "/" : req;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch {
      return (await cache.match(key, { ignoreSearch: true })) || new Response("ออฟไลน์", { status: 503 });
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "logout") event.waitUntil(caches.delete(API_CACHE));
});

// ---------- push ----------

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data && event.data.text() }; }
  const title = data.title || "สมุดสิ่งสำคัญ";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    tag: data.tag,
    renotify: true,
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: data.url || "/#/today", noteId: data.noteId, date: data.date },
    actions: data.actions ? [{ action: "done", title: "เสร็จแล้ว" }, { action: "snooze", title: "เลื่อน 1 ชม." }] : [],
  }));
});

async function post(path, body) {
  return fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
    body: JSON.stringify(body),
  });
}

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const { url, noteId, date } = n.data || {};
  n.close();
  event.waitUntil((async () => {
    if (event.action === "done" && noteId) {
      await post(`/api/notes/${noteId}/done`, { date, done: true });
      return;
    }
    if (event.action === "snooze" && noteId) {
      await post(`/api/notes/${noteId}/snooze`, { date, minutes: 60 });
      return;
    }
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        if ("navigate" in w) await w.navigate(url);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
