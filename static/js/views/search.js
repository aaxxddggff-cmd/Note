import { api } from "../api.js";
import {
  app, el, icon, todayKey, diffDays, relDay, dayShortDate, shortDate, REPEAT_LABEL, catColor, highlight,
  storageGet, storageSet, errorToast, fill,
} from "../util.js";

const RECENT = "recent-searches";
const state = { q: "", filter: "all", results: [] };
let timer = null;

function remember(q) {
  q = q.trim();
  if (!q) return;
  storageSet(RECENT, [q, ...storageGet(RECENT, []).filter((x) => x !== q)].slice(0, 8));
}

function whenLabel(o, today) {
  const parts = [];
  const n = diffDays(today, o.occ);
  parts.push(Math.abs(n) <= 1 ? relDay(o.occ) : o.occ >= today ? dayShortDate(o.occ, { year: false }) : shortDate(o.occ, { year: true }));
  if (o.time) parts[0] += ` ${o.time}`;
  if (o.done) parts.push("เสร็จแล้ว");
  else if (o.repeat !== "none") parts.push(REPEAT_LABEL[o.repeat]);
  if (o.matched_in === "detail") parts.push("พบในโน้ต");
  if (o.matched_in === "checklist") parts.push("พบในเช็กลิสต์");
  return parts.join(" · ");
}

function resultItem(o, today) {
  return el("a", {
    class: "list-btn" + (o.done ? " done" : ""), href: `#/note/${o.id}?date=${o.occ}`, style: { gap: "12px" },
    onclick: () => remember(state.q),
  },
    el("span", { class: "dot lg", "--c": catColor(o.category_id) }),
    el("div", { class: "grow" },
      el("span", { class: "t" }, highlight(o.title, state.q)),
      el("span", { class: "s" }, whenLabel(o, today))));
}

function drawResults(box, filters) {
  const today = todayKey();
  const all = state.results;
  const pick = (o) => state.filter === "all" ? true : state.filter === "done" ? o.done : o.category_id === state.filter;
  const shown = all.filter(pick);

  const chip = (key, label) => el("button", {
    class: "chip sm dark", type: "button", "aria-pressed": String(state.filter === key),
    onclick: () => { state.filter = key; drawResults(box, filters); },
  }, label);
  fill(filters,
    chip("all", state.q ? `ทั้งหมด ${all.length}` : "ทั้งหมด"),
    app.categories.map((c) => chip(c.id, c.name)),
    chip("done", "เสร็จแล้ว"));
  filters.hidden = !state.q;

  if (!state.q) {
    const recent = storageGet(RECENT, []);
    fill(box, recent.length ? el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" } },
      el("h2", { class: "section-label" }, "ค้นหาล่าสุด"),
      el("div", { class: "recent" }, recent.map((q) => el("button", { type: "button", onclick: () => setQuery(q) }, q))),
      el("button", {
        type: "button", class: "btn sm", style: { alignSelf: "flex-start", marginTop: "4px" },
        onclick: () => { storageSet(RECENT, []); drawResults(box, filters); },
      }, "ล้างประวัติ"))
      : el("div", { class: "empty", style: { marginTop: "8px" } }, "พิมพ์เพื่อค้นหาในหัวข้อ โน้ต และเช็กลิสต์"));
    return;
  }
  if (!shown.length) {
    fill(box, el("div", { class: "empty", style: { marginTop: "8px" } }, `ไม่พบ “${state.q}”`));
    return;
  }
  const upcoming = shown.filter((o) => !o.done && o.occ >= today).sort((a, b) => a.occ.localeCompare(b.occ));
  const past = shown.filter((o) => o.done || o.occ < today).sort((a, b) => b.occ.localeCompare(a.occ));
  fill(box,
    upcoming.length ? [el("h2", { class: "section-label" }, "กำลังจะถึง"), upcoming.map((o) => resultItem(o, today))] : null,
    past.length ? [el("h2", { class: "section-label", style: { marginTop: "10px" } }, "ผ่านไปแล้ว"), past.map((o) => resultItem(o, today))] : null);
}

let setQuery = () => {};

export async function render(root, { current }) {
  if (root.querySelector("#q")) {
    // refresh while typing: keep the input, just rerun the search
    return setQuery(state.q, { keepInput: true });
  }
  const input = el("input", {
    id: "q", type: "search", value: state.q, placeholder: "ค้นหาสิ่งที่จดไว้", autocomplete: "off", enterkeyhint: "search",
    oninput: () => setQuery(input.value, { keepInput: true }),
    onkeydown: (e) => { if (e.key === "Enter") remember(input.value); },
  });
  const filters = el("div", { class: "filters", role: "group", "aria-label": "กรองผลลัพธ์" });
  const box = el("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });

  setQuery = (q, { keepInput = false } = {}) => {
    if (!keepInput) input.value = q;
    state.q = q.trim();
    clearTimeout(timer);
    if (!state.q) { state.results = []; drawResults(box, filters); return; }
    timer = setTimeout(async () => {
      const q0 = state.q;
      try {
        const res = await api.search(q0);
        if (q0 !== state.q || !current()) return;
        state.results = res;
        if (state.filter !== "all" && state.filter !== "done" && !app.cat(state.filter)) state.filter = "all";
        drawResults(box, filters);
      } catch (e) { errorToast(e); }
    }, 180);
  };

  fill(root,
    el("header", { class: "search-head" },
      el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
        el("label", { class: "search-box" }, icon("search", 18), el("span", { class: "sr-only" }, "ค้นหา"), input),
        el("a", { href: app.back, style: { height: "48px", padding: "0 6px", display: "flex", alignItems: "center", fontSize: "15px", fontWeight: 600, textDecoration: "none" } }, "ยกเลิก")),
      filters),
    el("div", { class: "content", style: { gap: "8px", paddingTop: "6px" } }, box),
  );
  setQuery(state.q);
  input.focus();
}
