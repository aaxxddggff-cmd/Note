// Shared helpers: app state, DOM builder, icons, Thai dates, sheets and toasts.

export const app = {
  categories: [],
  settings: {},
  user: null,
  back: "#/calendar", // the last tab page, for "back" buttons on full-screen pages
  cat(id) { return this.categories.find((c) => c.id === id) || null; },
};

export function applyTheme() {
  const t = app.settings.theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]').setAttribute("content", bg || "#F7F7F8");
}

// ---------- DOM ----------

const PROPS = new Set(["value", "checked", "disabled", "hidden", "textContent", "selected", "multiple"]);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("--")) node.style.setProperty(k, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  append(node, children);
  return node;
}

/** Replace node's children; nested arrays are flattened and null/false skipped. */
export function fill(node, ...children) {
  node.replaceChildren();
  append(node, children);
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
}

const ICONS = {
  back: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bell: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 004 0"/>',
  repeat: '<path d="M4 12a8 8 0 0114-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 01-14 5.3L4 15"/><path d="M4 20v-5h5"/>',
  tag: '<path d="M3.5 12.5l8-8H20v8.5l-8 8z"/><circle cx="15.5" cy="8.5" r="1.3"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  week: '<path d="M5 5v14M10 5v14M15 5v14M20 5v14"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-9 8.5"/>',
  file: '<path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5z"/><path d="M14 3.5v5h5"/>',
  clip: '<path d="M20 11.5l-7.8 7.8a5 5 0 01-7-7L13 4.4a3.3 3.3 0 014.7 4.7l-7.9 7.9a1.7 1.7 0 01-2.4-2.4l7.3-7.3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
};

export function icon(name, size = 20, strokeWidth = 2) {
  const span = document.createElement("span");
  span.style.display = "inline-flex";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// ---------- dates (always local time) ----------

export const MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
export const MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
export const DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
export const DAYS_MIN = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

export const pad = (n) => String(n).padStart(2, "0");
export const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function fromKey(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const todayKey = () => toKey(new Date());
export const diffDays = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);
export const yearOf = (y) => (app.settings.buddhist_year ? y + 543 : y);

/** First day of the week containing d, following the week_start setting. */
export function weekStart(d) {
  const ws = app.settings.week_start ?? 1;
  return addDays(d, -((d.getDay() - ws + 7) % 7));
}
export const weekdayOrder = () => [0, 1, 2, 3, 4, 5, 6].map((i) => (i + (app.settings.week_start ?? 1)) % 7);

export function longDate(k, { year = true } = {}) {
  const d = fromKey(k);
  return `วัน${DAYS[d.getDay()]}ที่ ${d.getDate()} ${MONTHS[d.getMonth()]}` + (year ? ` ${yearOf(d.getFullYear())}` : "");
}
export function plainLongDate(k) {
  const d = fromKey(k);
  return `วัน${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${yearOf(d.getFullYear())}`;
}
export function shortDate(k, { year = false } = {}) {
  const d = fromKey(k);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}` + (year ? ` ${yearOf(d.getFullYear())}` : "");
}
export function dayShortDate(k, { year = true } = {}) {
  const d = fromKey(k);
  return `${DAYS_MIN[d.getDay()]}. ${shortDate(k, { year })}`;
}
export function relDay(k) {
  const n = diffDays(todayKey(), k);
  if (n === 0) return "วันนี้";
  if (n === 1) return "พรุ่งนี้";
  if (n === -1) return "เมื่อวาน";
  return n > 0 ? `อีก ${n} วัน` : `เลยมา ${-n} วัน`;
}

// ---------- labels ----------

export const REMIND_OPTIONS = [[0, "ตรงเวลา"], [10, "10 นาทีก่อน"], [30, "30 นาทีก่อน"], [60, "1 ชม.ก่อน"],
  [1440, "1 วันก่อน"], [10080, "1 สัปดาห์ก่อน"]];
export const REPEAT_OPTIONS = [["none", "ไม่ซ้ำ"], ["day", "ทุกวัน"], ["week", "สัปดาห์"], ["month", "เดือน"], ["year", "ทุกปี"]];
export const REPEAT_LABEL = { none: "ไม่ซ้ำ", day: "ทุกวัน", week: "ทุกสัปดาห์", month: "ทุกเดือน", year: "ทุกปี" };
export const ALL_DAY_TIME = "09:00"; // reminders for all-day notes count from this time

export function minutesLabel(m) {
  if (m == null) return "ไม่เตือน";
  const known = REMIND_OPTIONS.find(([v]) => v === m);
  if (known) return known[1];
  if (m % 1440 === 0) return `${m / 1440} วันก่อน`;
  if (m % 60 === 0) return `${m / 60} ชม.ก่อน`;
  return `${m} นาทีก่อน`;
}
export function remindLabel(n) {
  if (n.remind_minutes == null) return "ไม่เตือน";
  return minutesLabel(n.remind_minutes) + (n.time ? "" : `, ${ALL_DAY_TIME}`);
}
export const timeLabel = (n) => (n.time ? `เวลา ${n.time} น.` : "ทั้งวัน");

/** When a note occurrence's reminder fires (ms), or null. */
export function remindAt(n, occ) {
  if (n.remind_minutes == null) return null;
  const [h, m] = (n.time || ALL_DAY_TIME).split(":").map(Number);
  const at = fromKey(occ);
  at.setHours(h, m, 0, 0);
  return at.getTime() - n.remind_minutes * 60000;
}

export function tagFor(catId, { small = false } = {}) {
  const c = app.cat(catId);
  if (!c) return null;
  return el("span", { class: "tag" + (small ? " sm" : ""), "--c": c.color }, c.name);
}
export const catColor = (catId) => (app.cat(catId) || { color: "#A1A1AA" }).color;

export function isRedDay(k, holidays) {
  const d = fromKey(k).getDay();
  return d === 0 || d === 6 || (app.settings.show_holidays && holidays[k]);
}

// ---------- sheets & toasts ----------

/** Open a bottom sheet. build(close) returns the sheet's children. Resolves with close()'s argument. */
export function openSheet(build, { label = "" } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const scrim = el("div", { class: "sheet-scrim" });
    const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": label });
    const close = (value) => {
      scrim.remove();
      document.removeEventListener("keydown", onKey);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === "Escape") close(undefined); };
    scrim.addEventListener("click", (e) => { if (e.target === scrim) close(undefined); });
    document.addEventListener("keydown", onKey);
    sheet.append(el("div", { class: "grab" }));
    append(sheet, [build(close)]);
    scrim.append(sheet);
    document.body.append(scrim);
    const first = sheet.querySelector("input, textarea, select, button");
    if (first) first.focus();
  });
}

export function toast(message, ms = 3500) {
  const t = el("div", { class: "toast simple", role: "status" }, message);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

/** A notification-style card with optional action buttons. */
export function notice({ title, body, source = "สมุดสิ่งสำคัญ", actions = [], ms = 0 }) {
  const t = el("div", { class: "toast", role: "alert" },
    el("div", { class: "head" },
      el("span", { class: "app-ico" }, icon("calendar", 18)),
      el("span", { class: "src" }, source),
      el("button", { class: "icon-btn", type: "button", "aria-label": "ปิด", onclick: () => t.remove() }, icon("close", 18))),
    el("div", {}, el("div", { class: "t" }, title), body ? el("div", { class: "s" }, body) : null),
    actions.length ? el("div", { class: "acts" }, actions.map(([label, fn, primary]) =>
      el("button", { class: "btn" + (primary ? " primary" : ""), type: "button", onclick: () => { t.remove(); fn(); } }, label))) : null);
  document.getElementById("toasts").append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

export function errorToast(e) { toast(e.message || String(e), 5000); }

export function highlight(text, q) {
  if (!q) return [text];
  const out = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let i = 0;
  for (;;) {
    const j = lower.indexOf(needle, i);
    if (j < 0) break;
    if (j > i) out.push(text.slice(i, j));
    out.push(el("mark", {}, text.slice(j, j + needle.length)));
    i = j + needle.length;
  }
  out.push(text.slice(i));
  return out;
}

/** Forget this device's per-account data (called on login and logout). */
export function clearUserStorage() {
  for (const k of ["recent-searches", "reminders-fired", "reminders-snooze", "morning-summary"]) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

export function storageGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}
