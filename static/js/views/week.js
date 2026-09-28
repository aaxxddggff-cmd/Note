import { api } from "../api.js";
import { holidaysBetween } from "../holidays.js";
import {
  el, icon, toKey, fromKey, addDays, todayKey, weekStart, DAYS, DAYS_MIN, shortDate, yearOf, isRedDay, catColor, app, fill,
} from "../util.js";

const state = { anchor: null }; // any date inside the week on screen

export const fabDate = () => {
  const start = weekStart(state.anchor || new Date());
  const today = todayKey();
  const end = toKey(addDays(start, 6));
  return today >= toKey(start) && today <= end ? today : toKey(start);
};

export async function render(root, { current, refresh }) {
  if (!state.anchor) state.anchor = fromKey(todayKey());
  const start = weekStart(state.anchor);
  const first = toKey(start);
  const last = toKey(addDays(start, 6));
  const occs = await api.occurrences(first, last);
  if (!current()) return;

  const today = todayKey();
  const holidays = holidaysBetween(first, last);
  const thisWeek = toKey(weekStart(fromKey(today)));
  const weeksAway = Math.round((start - fromKey(thisWeek)) / (7 * 86400000));
  const title = weeksAway === 0 ? "สัปดาห์นี้" : weeksAway === 1 ? "สัปดาห์หน้า" : weeksAway === -1 ? "สัปดาห์ที่แล้ว" : "สัปดาห์";
  const endD = addDays(start, 6);
  const range = `${shortDate(first)} – ${shortDate(last)} ${yearOf(endD.getFullYear())}`;

  const go = (delta) => { state.anchor = addDays(start, delta * 7); refresh(); };

  const days = [];
  const counts = [];
  for (let i = 0; i < 7; i++) {
    const k = toKey(addDays(start, i));
    const d = fromKey(k);
    const list = occs.filter((o) => o.occ === k);
    counts.push([k, list.length]);
    const red = isRedDay(k, holidays);
    const col = el("a", {
      class: "wd-col" + (k === today ? " cur" : red ? " red" : ""), href: `#/calendar?date=${k}`,
      "aria-label": `วัน${DAYS[d.getDay()]}ที่ ${d.getDate()}` + (app.settings.show_holidays && holidays[k] ? ` ${holidays[k]}` : ""),
    }, el("span", { class: "wd" }, DAYS_MIN[d.getDay()]), el("span", { class: "n" }, String(d.getDate())));

    days.push(el("div", { class: "week-day" + (list.length ? "" : " empty-day") },
      col,
      list.length ? el("div", { class: "week-items" }, list.map((o) => el("a", {
        class: "week-item" + (o.done ? " done" : ""), href: `#/note/${o.id}?date=${o.occ}`, "--c": catColor(o.category_id),
      },
        el("div", { class: "top" }, el("b", {}, o.title), el("span", {}, o.time || "ทั้งวัน")),
        o.checklist_total ? el("div", { class: "cl" },
          el("span", { class: "bar-bg" }, el("span", { style: { width: `${(100 * o.checklist_done) / o.checklist_total}%` } })),
          el("span", {}, `เช็กลิสต์ ${o.checklist_done}/${o.checklist_total}`)) : null)))
        : el("span", { class: "free" }, app.settings.show_holidays && holidays[k] ? `ว่าง · ${holidays[k]}` : "ว่าง")));
  }

  const importantIds = new Set(app.categories.filter((c) => c.important).map((c) => c.id));
  const busiest = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  const summary = occs.length
    ? `${title} ${occs.length} เรื่อง · สำคัญ ${occs.filter((o) => importantIds.has(o.category_id)).length}` +
      ` · วันที่แน่นสุดคือ ${DAYS[fromKey(busiest[0]).getDay()]} ${fromKey(busiest[0]).getDate()}`
    : `${title}ยังว่าง`;

  fill(root,
    el("header", { class: "week-head" },
      el("div", { class: "week-nav" },
        el("button", { class: "icon-btn", type: "button", "aria-label": "สัปดาห์ก่อน", onclick: () => go(-1) }, icon("back")),
        el("div", { class: "mid" },
          el("h1", {}, title),
          el("span", {}, range)),
        el("button", { class: "icon-btn", type: "button", "aria-label": "สัปดาห์ถัดไป", onclick: () => go(1) }, icon("next"))),
      el("nav", { class: "segmented", "aria-label": "มุมมอง" },
        el("a", { href: "#/calendar" }, "เดือน"),
        el("a", { href: "#/week", "aria-current": "page" }, "สัปดาห์"),
        el("a", { href: "#/today" }, "วัน"))),
    el("div", { class: "week-list" }, days),
    el("div", { class: "week-summary" }, summary),
    weeksAway !== 0 ? el("div", { style: { textAlign: "center", marginTop: "12px" } },
      el("button", { class: "btn sm", type: "button", onclick: () => { state.anchor = fromKey(today); refresh(); } }, "กลับไปสัปดาห์นี้")) : null,
  );
}
