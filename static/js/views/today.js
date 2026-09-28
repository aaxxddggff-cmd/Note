import { api } from "../api.js";
import { holidaysBetween, nextHoliday } from "../holidays.js";
import {
  app, el, icon, toKey, fromKey, addDays, todayKey, diffDays, DAYS, DAYS_MIN, MONTHS_SHORT, plainLongDate,
  shortDate, isRedDay, catColor, tagFor, minutesLabel, REPEAT_LABEL, errorToast, fill,
} from "../util.js";

export const fabDate = () => todayKey();

function itemCard(o) {
  return el("a", { class: "item-card" + (o.done ? " done" : ""), href: `#/note/${o.id}?date=${o.occ}` },
    el("div", { class: "time" }, o.time || "ทั้งวัน"),
    el("div", { class: "body" },
      el("span", { class: "t" }, o.title),
      el("div", { class: "meta" },
        tagFor(o.category_id, { small: true }),
        o.done ? el("span", {}, "เสร็จแล้ว") : null,
        o.remind_minutes != null ? el("span", {}, `เตือน ${minutesLabel(o.remind_minutes)}`) : null,
        o.repeat !== "none" ? el("span", {}, REPEAT_LABEL[o.repeat]) : null,
        o.checklist_total ? el("span", { class: "i" }, icon("list", 13), `${o.checklist_done}/${o.checklist_total}`) : null,
        o.attachments ? el("span", { class: "i" }, icon("clip", 13), `${o.attachments} ไฟล์`) : null)));
}

export async function render(root, { current, refresh }) {
  const today = todayKey();
  const end = toKey(addDays(fromKey(today), 7));
  const [occs, overdue] = await Promise.all([api.occurrences(today, end), api.overdue()]);
  if (!current()) return;

  const todays = occs.filter((o) => o.occ === today);
  const open = todays.filter((o) => !o.done);
  const soon = occs.filter((o) => o.occ > today && !o.done);
  const holidays = holidaysBetween(today, end);

  const strip = [];
  for (let i = 0; i < 7; i++) {
    const k = toKey(addDays(fromKey(today), i));
    const d = fromKey(k);
    const first = occs.find((o) => o.occ === k && !o.done);
    strip.push(el("a", {
      class: (i === 0 ? "cur" : "") + (i && isRedDay(k, holidays) ? " red" : ""), href: `#/calendar?date=${k}`,
      "aria-label": `${DAYS[d.getDay()]} ${d.getDate()}` + (first ? " มีรายการ" : ""),
    },
      el("span", { class: "wd" }, DAYS_MIN[d.getDay()]),
      el("span", { class: "n" }, String(d.getDate())),
      first ? el("span", { class: "dot", "--c": catColor(first.category_id) }) : el("span", { style: { height: "5px" } })));
  }

  const moveToday = async (o) => {
    try { await api.updateNote(o.id, { date: today }); refresh(); } catch (e) { errorToast(e); }
  };

  let holidayCard = null;
  if (app.settings.show_holidays) {
    const h = nextHoliday(today);
    const d = fromKey(h.date);
    const n = diffDays(today, h.date);
    holidayCard = el("section", { class: "card", style: { padding: "14px", display: "flex", alignItems: "center", gap: "12px", borderRadius: "16px" } },
      el("div", { class: "date-badge red" }, el("b", {}, String(d.getDate())), el("span", {}, MONTHS_SHORT[d.getMonth()])),
      el("div", { style: { flexGrow: 1, display: "flex", flexDirection: "column", gap: "2px" } },
        el("span", { style: { fontSize: "12px", color: "var(--red-ink)", fontWeight: 600 } }, "วันหยุดราชการที่ใกล้ถึง"),
        el("span", { style: { fontSize: "15px", fontWeight: 500 } }, h.name),
        el("span", { style: { fontSize: "12px", color: "var(--muted-2)" } }, `วัน${DAYS[d.getDay()]} · ${n === 0 ? "วันนี้" : `อีก ${n} วัน`}`)));
  }

  fill(root,
    el("header", { class: "page-head" },
      el("div", {},
        el("div", { class: "kicker" }, plainLongDate(today)),
        el("h1", {}, "วันนี้")),
      el("a", { class: "icon-btn boxed", href: "#/search", "aria-label": "ค้นหา" }, icon("search", 20))),
    el("div", { class: "content" },
      el("section", { class: "hero" },
        el("div", { style: { fontSize: "15px" } },
          open.length ? ["วันนี้มี ", el("b", { style: { fontWeight: 600 } }, `${open.length} เรื่อง`), " ที่ต้องทำ"] : "วันนี้ไม่มีเรื่องค้าง"),
        el("div", { class: "stats" },
          el("div", { class: "stat" }, el("b", {}, String(open.length)), el("span", {}, "ยังไม่เสร็จ")),
          el("a", { class: "stat warn", href: "#/important" }, el("b", {}, String(overdue.length)), el("span", {}, "เลยกำหนด")),
          el("a", { class: "stat", href: "#/week" }, el("b", {}, String(soon.length)), el("span", {}, "อีก 7 วัน")))),
      overdue.slice(0, 3).map((o) => el("section", { class: "overdue" },
        icon("clock", 22),
        el("a", { class: "grow", href: `#/note/${o.id}?date=${o.occ}` },
          el("span", { class: "t" }, o.title),
          el("span", { class: "s" }, `เลยกำหนดมา ${diffDays(o.occ, today)} วัน (${shortDate(o.occ)})`)),
        el("button", { class: "btn sm", type: "button", onclick: () => moveToday(o) }, "ย้ายมาวันนี้"))),
      overdue.length > 3 ? el("a", { href: "#/important", style: { fontSize: "13px", padding: "0 4px" } }, `และอีก ${overdue.length - 3} เรื่องที่เลยกำหนด`) : null,
      el("section", { class: "strip", "aria-label": "7 วันข้างหน้า" }, strip),
      el("h2", { class: "h2" }, "รายการวันนี้"),
      todays.length ? todays.map(itemCard) : el("div", { class: "empty" }, "วันนี้ว่าง — กด + เพื่อจดเพิ่ม"),
      holidayCard),
  );
}
