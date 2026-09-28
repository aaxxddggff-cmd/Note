import { api } from "../api.js";
import { el, icon, fromKey, todayKey, MONTHS_SHORT, relDay, app, fill } from "../util.js";

export async function render(root, { current }) {
  const items = await api.important();
  if (!current()) return;
  const stars = app.categories.filter((c) => c.important).map((c) => c.name);
  const today = todayKey();

  fill(root,
    el("header", { class: "page-head" },
      el("div", { style: { display: "flex", alignItems: "center", gap: "4px" } },
        el("a", { class: "icon-btn", href: "#/calendar", "aria-label": "กลับไปปฏิทิน", style: { marginLeft: "-12px" } }, icon("back", 22)),
        el("h1", {}, "เรื่องสำคัญ")),
      el("span", { class: "pill" }, icon("star", 14, 2.2), `ค้าง ${items.length} เรื่อง`)),
    el("div", { class: "content" },
      el("div", { style: { fontSize: "14px", color: "var(--muted)", padding: "0 4px" } },
        "เรื่องสำคัญที่ยังไม่เสร็จ เรียงตามวันที่" + (stars.length ? ` (หมวด ${stars.join(", ")})` : "")),
      items.length ? items.map((o) => {
        const d = fromKey(o.occ);
        return el("a", { class: "list-btn", href: `#/note/${o.id}?date=${o.occ}` },
          el("div", { class: "date-badge" + (o.occ < today ? " red" : "") },
            el("b", {}, String(d.getDate())), el("span", {}, MONTHS_SHORT[d.getMonth()])),
          el("div", { class: "grow" },
            el("span", { class: "t" }, o.title),
            el("span", { class: "s" }, relDay(o.occ) + (o.time ? ` · ${o.time} น.` : ""))),
          icon("next", 18));
      }) : el("div", { class: "empty" },
        stars.length ? "เคลียร์หมดแล้ว ไม่มีเรื่องสำคัญค้าง" : "ยังไม่มีหมวดที่ติดดาว — ติดดาวหมวดในหน้าตั้งค่า")),
  );
}
