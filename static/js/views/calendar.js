import { api } from "../api.js";
import { holidaysBetween } from "../holidays.js";
import {
  app, el, icon, toKey, fromKey, todayKey, MONTHS, DAYS_MIN, yearOf, longDate, plainLongDate, weekdayOrder,
  isRedDay, catColor, tagFor, timeLabel, REPEAT_LABEL, errorToast, fill,
} from "../util.js";

const state = { month: null, selected: todayKey() };

export const fabDate = () => state.selected;
export function afterAdd(note) { select(note.date); }

function select(k) {
  state.selected = k;
  const d = fromKey(k);
  state.month = new Date(d.getFullYear(), d.getMonth(), 1);
}

export function header(extra) {
  const today = fromKey(todayKey());
  return el("header", { class: "page-head" },
    el("div", {},
      el("div", { class: "kicker" }, `วันนี้ ${today.getDate()} ${MONTHS[today.getMonth()]} ${yearOf(today.getFullYear())}`),
      el("h1", {}, "สมุดสิ่งสำคัญ")),
    el("div", { class: "head-actions" }, extra));
}

/** One note occurrence with a round done button (calendar and important lists). */
export function noteRow(o, refresh) {
  return el("div", { class: "note-row" + (o.done ? " done" : "") },
    el("button", {
      class: "check", type: "button", role: "checkbox", "aria-checked": String(o.done),
      "aria-label": o.done ? `ยกเลิกทำเสร็จ: ${o.title}` : `ทำเครื่องหมายว่าเสร็จ: ${o.title}`,
      onclick: async () => {
        try { await api.setDone(o.id, o.occ, !o.done); refresh(); } catch (e) { errorToast(e); }
      },
    }, o.done ? icon("check", 16, 2.6) : null),
    el("a", { class: "body", href: `#/note/${o.id}?date=${o.occ}` },
      el("div", { class: "t" }, o.title),
      el("div", { class: "m" }, [timeLabel(o), o.repeat !== "none" ? REPEAT_LABEL[o.repeat] : null,
        o.checklist_total ? `เช็กลิสต์ ${o.checklist_done}/${o.checklist_total}` : null].filter(Boolean).join(" · "))),
    tagFor(o.category_id));
}

export async function render(root, { query, current, refresh }) {
  if (query.get("date")) {
    select(query.get("date"));
    history.replaceState(null, "", "#/calendar"); // consumed; later refreshes keep the user's selection
  }
  if (!state.month) select(state.selected);

  const m = state.month;
  const first = toKey(m);
  const last = toKey(new Date(m.getFullYear(), m.getMonth() + 1, 0));
  const [occs, imp] = await Promise.all([api.occurrences(first, last), api.important()]);
  if (!current()) return;

  const holidays = holidaysBetween(first, last);
  const today = todayKey();
  const byDay = {};
  for (const o of occs) (byDay[o.occ] ||= []).push(o);

  const move = (delta) => {
    state.month = new Date(m.getFullYear(), m.getMonth() + delta, 1);
    const sameMonth = (k) => k.slice(0, 7) === toKey(state.month).slice(0, 7);
    state.selected = sameMonth(today) ? today : toKey(state.month);
    refresh();
  };

  const order = weekdayOrder();
  const cells = order.map((d) => el("div", { class: "wd", "aria-hidden": "true" }, DAYS_MIN[d]));
  const lead = (m.getDay() - order[0] + 7) % 7;
  for (let i = 0; i < lead; i++) cells.push(el("div", { class: "blank" }));
  const dim = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  for (let d = 1; d <= dim; d++) {
    const k = toKey(new Date(m.getFullYear(), m.getMonth(), d));
    const open = (byDay[k] || []).filter((o) => !o.done);
    const cls = ["day"];
    if (k === state.selected) cls.push("sel");
    else if (k === today) cls.push("today");
    else if (isRedDay(k, holidays)) cls.push("red");
    cells.push(el("button", {
      class: cls.join(" "), type: "button", "aria-pressed": String(k === state.selected),
      "aria-label": `${d} ${MONTHS[m.getMonth()]}` + (open.length ? `, มี ${open.length} เรื่อง` : "") +
        (app.settings.show_holidays && holidays[k] ? `, ${holidays[k]}` : ""),
      onclick: () => { state.selected = k; refresh(); },
    },
      el("span", {}, String(d)),
      el("span", { class: "dots" }, open.slice(0, 3).map((o) => el("span", { class: "dot", "--c": catColor(o.category_id) })))));
  }

  const dayOccs = byDay[state.selected] || [];
  const holiday = app.settings.show_holidays && holidays[state.selected];

  fill(root,
    header([
      el("a", { class: "icon-btn boxed", href: "#/search", "aria-label": "ค้นหา" }, icon("search", 20)),
      el("a", { class: "pill", href: "#/important" }, icon("star", 14, 2.2), `ค้าง ${imp.length} เรื่อง`),
    ]),
    el("section", { class: "card cal", "aria-label": "ปฏิทิน" },
      el("div", { class: "cal-head" },
        el("button", { class: "icon-btn", type: "button", "aria-label": "เดือนก่อน", onclick: () => move(-1) }, icon("back")),
        el("button", {
          class: "month", type: "button", title: "กลับไปวันนี้",
          onclick: () => { select(today); refresh(); },
        }, `${MONTHS[m.getMonth()]} ${yearOf(m.getFullYear())}`),
        el("button", { class: "icon-btn", type: "button", "aria-label": "เดือนถัดไป", onclick: () => move(1) }, icon("next"))),
      el("div", { class: "cal-grid" }, cells)),
    el("div", { class: "day-head" },
      el("h2", { title: plainLongDate(state.selected) }, longDate(state.selected, { year: false })),
      el("span", {}, `${dayOccs.length} รายการ`)),
    holiday ? el("div", { class: "holiday-banner" }, `วันหยุดราชการ · ${holiday}`) : null,
    el("div", { class: "day-list" },
      dayOccs.length ? dayOccs.map((o) => noteRow(o, refresh))
        : el("div", { class: "empty" }, "ยังไม่มีอะไรในวันนี้ — กด + เพื่อจดเพิ่ม")),
  );
}
