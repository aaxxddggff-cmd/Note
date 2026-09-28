import { api } from "./api.js";
import { app, el, icon, todayKey, errorToast, toast, applyTheme, fill, clearUserStorage } from "./util.js";
import { quickAdd } from "./sheets.js";
import { startReminders } from "./reminders.js";
import { registerServiceWorker, refreshPush, clearOfflineData } from "./pwa.js";
import * as login from "./views/login.js";
import * as today from "./views/today.js";
import * as calendar from "./views/calendar.js";
import * as important from "./views/important.js";
import * as week from "./views/week.js";
import * as search from "./views/search.js";
import * as detail from "./views/detail.js";
import * as settings from "./views/settings.js";

const VIEWS = { today, calendar, important, week, search, note: detail, settings };
const TAB_OF = { today: "today", calendar: "calendar", important: "calendar", week: "week", settings: "settings" };
const TABS = [["today", "sun", "วันนี้"], ["calendar", "calendar", "ปฏิทิน"], ["week", "week", "สัปดาห์"], ["settings", "sliders", "ตั้งค่า"]];
const WITH_FAB = new Set(["today", "calendar", "important", "week"]);

const root = document.getElementById("view");
const nav = document.getElementById("nav");
const fab = document.getElementById("fab");
let renderId = 0;
let lastRoute = "";
let current = null;
let loggedIn = false;
let started = false;

function parseHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  return { name: VIEWS[parts[0]] ? parts[0] : "calendar", params: parts.slice(1), query: new URLSearchParams(query) };
}

async function showLogin() {
  const reset = location.hash.startsWith("#/reset");
  if (!reset) loggedIn = false;
  nav.hidden = true;
  fab.hidden = true;
  document.querySelectorAll(".sheet-scrim").forEach((s) => s.remove());
  const id = ++renderId;
  await login.render(root, {
    current: () => id === renderId,
    query: parseHash().query,
    onDone: async () => {
      clearOfflineData();   // cached pages may belong to whoever used this browser before
      clearUserStorage();
      loggedIn = true;
      await loadApp();
      render({ scroll: true });
    },
  });
}

/** Load categories and settings, then start the background parts once. */
async function loadApp() {
  try {
    const boot = await api.bootstrap();
    app.user = boot.user;
    app.categories = boot.categories;
    app.settings = boot.settings;
    applyTheme();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && boot.settings.timezone !== tz) {
      api.updateSettings({ timezone: tz }).then((s) => { app.settings = s; }).catch(() => {});
    }
  } catch (e) {
    errorToast(e);
  }
  refreshPush();
  if (!started) {
    started = true;
    startReminders(refresh);
  }
}

export async function render({ scroll = false } = {}) {
  if (!loggedIn || location.hash.startsWith("#/reset")) return showLogin();
  const id = ++renderId;
  const route = parseHash();
  const view = VIEWS[route.name];
  current = { route, view };
  if (TAB_OF[route.name]) app.back = location.hash || "#/calendar";

  nav.hidden = !TAB_OF[route.name];
  for (const a of nav.querySelectorAll("a")) {
    if (a.dataset.tab === TAB_OF[route.name]) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  fab.hidden = !WITH_FAB.has(route.name);

  try {
    await view.render(root, { ...route, current: () => id === renderId, refresh });
  } catch (e) {
    if (id === renderId) {
      fill(root, el("div", { class: "content", style: { paddingTop: "40px" } },
        el("div", { class: "empty" }, e.message || "เกิดข้อผิดพลาด")));
    }
  }
  if (scroll && id === renderId) window.scrollTo(0, 0);
}

export const refresh = () => render();

async function init() {
  for (const a of nav.querySelectorAll("a")) {
    const [, ico, label] = TABS.find(([t]) => t === a.dataset.tab);
    a.append(icon(ico, 20), label);
  }
  fab.append(icon("plus", 26, 2.2));
  fab.addEventListener("click", async () => {
    const date = (current && current.view.fabDate && current.view.fabDate()) || todayKey();
    const note = await quickAdd(date);
    if (note) {
      toast(`จด “${note.title}” แล้ว`);
      if (current && current.view.afterAdd) current.view.afterAdd(note);
      refresh();
    }
  });

  registerServiceWorker();
  window.addEventListener("unauthorized", () => { if (loggedIn) showLogin(); });
  window.addEventListener("online", () => { if (loggedIn) refresh(); });

  try {
    loggedIn = (await api.authStatus()).authed;
  } catch {
    loggedIn = true; // offline: show what the service worker has cached
  }
  if (loggedIn) await loadApp();
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }

  window.addEventListener("hashchange", () => {
    const route = location.hash;
    render({ scroll: route.split("?")[0] !== lastRoute.split("?")[0] });
    lastRoute = route;
  });
  lastRoute = location.hash;
  if (!location.hash) history.replaceState(null, "", "#/calendar");
  await render({ scroll: true });
}

init().catch((e) => {
  // never leave a blank page: show what went wrong
  console.error(e);
  fill(root, el("div", { class: "content", style: { paddingTop: "40px" } },
    el("div", { class: "empty" }, `เปิดแอปไม่สำเร็จ: ${e && e.message ? e.message : e}`)));
});
