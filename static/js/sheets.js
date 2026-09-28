// Bottom sheets: quick add, reminder + repeat, category picker.

import { api } from "./api.js";
import {
  app, el, icon, openSheet, longDate, dayShortDate, pad, REMIND_OPTIONS, REPEAT_OPTIONS, remindAt, minutesLabel, fill,
} from "./util.js";

function categoryChips(selected, onPick) {
  const wrap = el("div", { class: "chips", role: "group", "aria-label": "หมวด" });
  const draw = (current) => {
    fill(wrap,
      ...app.categories.map((c) => el("button", {
        class: "chip cat", type: "button", "--c": c.color, "aria-pressed": String(current === c.id),
        onclick: () => { onPick(c.id); draw(c.id); },
      }, c.name)),
      el("button", {
        class: "chip", type: "button", "aria-pressed": String(current == null),
        onclick: () => { onPick(null); draw(null); },
      }, "ไม่มีหมวด"),
    );
  };
  draw(selected);
  return wrap;
}

/** "จดเรื่องใหม่" — resolves with the created note, or undefined. */
export function quickAdd(dateKey) {
  const first = app.categories[0];
  const draft = { category_id: first ? first.id : null };
  return openSheet((close) => {
    const title = el("input", { id: "qa-title", class: "input", type: "text", placeholder: "เช่น ต่อภาษีรถ", maxlength: "200", required: true });
    const time = el("input", { id: "qa-time", class: "input", type: "time" });
    const date = el("input", { id: "qa-date", class: "input", type: "date", value: dateKey, required: true });
    const err = el("p", { class: "error", hidden: true });
    const form = el("form", {
      style: { display: "contents" },
      onsubmit: async (e) => {
        e.preventDefault();
        if (!title.value.trim()) { title.focus(); return; }
        try {
          const note = await api.createNote({
            title: title.value, date: date.value, time: time.value || null, category_id: draft.category_id,
            remind_minutes: app.settings.default_remind ?? null,
          });
          close(note);
        } catch (ex) {
          err.textContent = ex.message; err.hidden = false;
        }
      },
    },
    el("div", {},
      el("h2", {}, "จดเรื่องใหม่"),
      el("div", { class: "sub" }, `สำหรับ ${longDate(dateKey, { year: false })}`)),
    el("label", { class: "field", for: "qa-title" }, el("span", {}, "เรื่องที่ต้องจำ"), title),
    el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" } },
      el("label", { class: "field", for: "qa-date" }, el("span", {}, "วันที่"), date),
      el("label", { class: "field", for: "qa-time" }, el("span", {}, "เวลา (ไม่ใส่ก็ได้)"), time)),
    el("div", { class: "field" }, el("span", { class: "label" }, "หมวด"),
      categoryChips(draft.category_id, (id) => { draft.category_id = id; })),
    err,
    el("div", { class: "actions" },
      el("button", { class: "btn", type: "button", onclick: () => close() }, "ยกเลิก"),
      el("button", { class: "btn primary", type: "submit" }, "บันทึก")));
    return form;
  }, { label: "จดเรื่องใหม่" });
}

/** Reminder + repeat settings. Resolves with {remind_minutes, nag, repeat, repeat_until} or undefined. */
export function reminderSheet(note, occ) {
  const s = {
    remind: note.remind_minutes,
    nag: !!note.nag,
    repeat: note.repeat || "none",
    until: note.repeat_until || "",
  };
  const known = (m) => m == null || REMIND_OPTIONS.some(([v]) => v === m);
  let custom = !known(s.remind);

  return openSheet((close) => {
    const body = el("div", { style: { display: "contents" } });
    const draw = () => {
      const customVal = custom ? (s.remind ?? 30) : 30;
      const unit = customVal % 1440 === 0 ? 1440 : customVal % 60 === 0 ? 60 : 1;
      const num = el("input", {
        class: "input", type: "number", min: "0", max: "999", value: String(customVal / unit), "aria-label": "จำนวน",
        oninput: () => { s.remind = Math.max(0, Math.round(Number(num.value) || 0)) * Number(unitSel.value); summary.textContent = summaryText(); },
      });
      const unitSel = el("select", {
        class: "input", "aria-label": "หน่วย",
        onchange: () => { s.remind = Math.max(0, Math.round(Number(num.value) || 0)) * Number(unitSel.value); summary.textContent = summaryText(); },
      }, [[1, "นาทีก่อน"], [60, "ชั่วโมงก่อน"], [1440, "วันก่อน"]].map(([v, l]) => el("option", { value: String(v), selected: v === unit }, l)));
      const summary = el("span", {}, summaryText());

      fill(body,
        el("div", {},
          el("h2", {}, "แจ้งเตือนและทำซ้ำ"),
          el("div", { class: "sub" }, `${note.title} · ${dayShortDate(occ, { year: false })}`)),

        el("div", { class: "field" },
          el("span", { class: "label" }, "เตือนล่วงหน้า"),
          el("div", { class: "chips" },
            el("button", { class: "chip", type: "button", "aria-pressed": String(!custom && s.remind == null), onclick: () => { custom = false; s.remind = null; draw(); } }, "ไม่เตือน"),
            REMIND_OPTIONS.map(([v, l]) => el("button", {
              class: "chip", type: "button", "aria-pressed": String(!custom && s.remind === v),
              onclick: () => { custom = false; s.remind = v; draw(); },
            }, l)),
            el("button", { class: "chip", type: "button", "aria-pressed": String(custom), onclick: () => { custom = true; s.remind = customVal; draw(); } }, "กำหนดเอง")),
          custom ? el("div", { class: "custom-remind" }, num, unitSel) : null),

        el("button", {
          class: "toggle-row", type: "button", role: "switch", "aria-checked": String(s.nag && s.remind != null),
          disabled: s.remind == null, style: s.remind == null ? { opacity: ".5" } : null,
          onclick: () => { s.nag = !s.nag; draw(); },
        },
          el("span", { class: "grow" }, el("span", { class: "a" }, "เตือนซ้ำจนกว่าจะติ๊กเสร็จ"), el("span", { class: "b" }, "เตือนอีกทุก 1 ชั่วโมง")),
          el("span", { class: "switch" })),

        el("div", { class: "field" },
          el("span", { class: "label" }, "ทำซ้ำ"),
          el("div", { class: "segmented", role: "group", "aria-label": "ทำซ้ำ" },
            REPEAT_OPTIONS.map(([v, l]) => el("button", {
              type: "button", "aria-pressed": String(s.repeat === v), onclick: () => { s.repeat = v; draw(); },
            }, l))),
          s.repeat !== "none" ? el("div", { class: "row", style: { padding: "0 4px", borderBottom: "none", minHeight: "48px" } },
            el("span", { class: "k" }, "สิ้นสุด"),
            el("input", {
              type: "date", value: s.until, min: note.date, "aria-label": "วันสิ้นสุด (ว่าง = ไม่มีกำหนด)",
              onchange: (e) => { s.until = e.target.value; draw(); },
            }),
            s.until ? el("button", { class: "btn sm", type: "button", onclick: () => { s.until = ""; draw(); } }, "ไม่มีกำหนด")
              : el("span", { class: "v" }, "ไม่มีกำหนด")) : null),

        el("div", { class: "info" }, icon("bell", 18), summary),

        el("div", { class: "actions" },
          el("button", { class: "btn", type: "button", onclick: () => close() }, "ยกเลิก"),
          el("button", {
            class: "btn primary", type: "button",
            onclick: () => close({
              remind_minutes: s.remind, nag: s.remind != null && s.nag, repeat: s.repeat,
              repeat_until: s.repeat === "none" ? null : (s.until || null),
            }),
          }, "ตกลง")),
      );
    };

    function summaryText() {
      const rep = { none: "", day: " และทุกวันหลังจากนั้น", week: " และทุกสัปดาห์หลังจากนั้น", month: " และทุกเดือนหลังจากนั้น", year: " และทุกปีหลังจากนั้น" }[s.repeat];
      const until = s.repeat !== "none" && s.until ? ` จนถึง ${dayShortDate(s.until)}` : "";
      if (s.remind == null) {
        return s.repeat === "none" ? "ไม่มีการเตือน" : `ไม่มีการเตือน · ทำซ้ำ${rep.replace(" และ", "").replace("หลังจากนั้น", "")}${until}`;
      }
      const at = new Date(remindAt({ ...note, remind_minutes: s.remind }, occ));
      const when = `${dayShortDate(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, { year: false })} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
      return `จะเตือน ${when} (${minutesLabel(s.remind)})${rep}${until}` + (s.nag ? " · เตือนซ้ำทุกชั่วโมงถ้ายังไม่ติ๊ก" : "");
    }

    draw();
    return body;
  }, { label: "แจ้งเตือนและทำซ้ำ" });
}

/** Resolves with {category_id} or undefined. */
export function categorySheet(current) {
  return openSheet((close) => {
    let picked = current;
    return el("div", { style: { display: "contents" } },
      el("h2", {}, "เลือกหมวด"),
      categoryChips(current, (id) => { picked = id; }),
      el("a", { href: "#/settings", class: "row", style: { padding: "0 4px", borderBottom: "none" }, onclick: () => close() },
        el("span", { class: "k" }, "จัดการหมวดหมู่"), icon("next", 16)),
      el("div", { class: "actions" },
        el("button", { class: "btn", type: "button", onclick: () => close() }, "ยกเลิก"),
        el("button", { class: "btn primary", type: "button", onclick: () => close({ category_id: picked }) }, "ตกลง")));
  }, { label: "เลือกหมวด" });
}
