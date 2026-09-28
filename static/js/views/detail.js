import { api } from "../api.js";
import { reminderSheet, categorySheet } from "../sheets.js";
import { askPermission } from "../reminders.js";
import {
  app, el, icon, openSheet, toKey, fromKey, addDays, todayKey, dayShortDate, remindLabel, REPEAT_LABEL,
  tagFor, errorToast, toast, fill,
} from "../util.js";

const MAX_FILE = 10 * 1024 * 1024;
let focusAfter = null; // element id to focus after the next render

/** A small sheet with one input. Resolves with the input's value, null for "clear", or undefined. */
function inputSheet({ title, type, value, clearLabel }) {
  return openSheet((close) => {
    const input = el("input", { class: "input", type, value: value || "", "aria-label": title });
    return el("form", {
      style: { display: "contents" },
      onsubmit: (e) => { e.preventDefault(); if (input.value || type !== "date") close(input.value || null); },
    },
      el("h2", {}, title),
      input,
      clearLabel ? el("button", { class: "btn", type: "button", onclick: () => close(null) }, clearLabel) : null,
      el("div", { class: "actions" },
        el("button", { class: "btn", type: "button", onclick: () => close() }, "ยกเลิก"),
        el("button", { class: "btn primary", type: "submit" }, "ตกลง")));
  }, { label: title });
}

export async function render(root, { params, query, current, refresh }) {
  const id = Number(params[0]);
  const note = await api.note(id);
  if (!current()) return;
  const occ = query.get("date") || note.date;
  const repeating = note.repeat !== "none";
  const done = note.completed.includes(occ);
  const today = todayKey();

  const save = async (data, { quiet = false } = {}) => {
    try {
      const updated = await api.updateNote(id, data);
      if (!quiet) {
        // a moved one-off note: follow it to its new date
        if (!repeating && data.date) history.replaceState(null, "", `#/note/${id}?date=${updated.date}`);
        refresh();
      }
      return updated;
    } catch (e) { errorToast(e); return null; }
  };

  const goBack = () => { location.hash = app.back; };

  // ---- header

  const more = async () => {
    const choice = await openSheet((close) => el("div", { style: { display: "contents" } },
      el("h2", {}, note.title),
      el("button", { class: "btn", type: "button", onclick: () => close("dup") }, "ทำสำเนา"),
      el("button", { class: "btn", type: "button", style: { color: "var(--red)", borderColor: "var(--danger-line)" }, onclick: () => close("del") }, "ลบเรื่องนี้"),
      el("button", { class: "btn", type: "button", onclick: () => close() }, "ปิด")), { label: "ตัวเลือกเพิ่มเติม" });
    if (choice === "dup") duplicate();
    if (choice === "del") remove();
  };

  const duplicate = async () => {
    try {
      const copy = await api.createNote({
        title: `${note.title} (สำเนา)`, detail: note.detail, date: note.date, time: note.time, category_id: note.category_id,
        remind_minutes: note.remind_minutes, nag: note.nag, repeat: note.repeat, repeat_until: note.repeat_until,
      });
      for (const item of note.checklist) await api.addCheck(copy.id, item.text);
      toast("ทำสำเนาแล้ว");
      location.hash = `#/note/${copy.id}`;
    } catch (e) { errorToast(e); }
  };

  const remove = async () => {
    const msg = repeating ? `ลบ “${note.title}” ทุกครั้งที่ทำซ้ำ?` : `ลบ “${note.title}”?`;
    if (!confirm(msg)) return;
    try { await api.deleteNote(id); toast("ลบแล้ว"); goBack(); } catch (e) { errorToast(e); }
  };

  // ---- fields

  const title = el("input", {
    id: "d-title", class: "title-input", type: "text", value: note.title, maxlength: "200", "aria-label": "ชื่อเรื่อง",
    onchange: () => {
      if (!title.value.trim()) { title.value = note.title; return; }
      if (title.value !== note.title) { note.title = title.value; save({ title: title.value }, { quiet: true }); }
    },
    onkeydown: (e) => { if (e.key === "Enter") title.blur(); },
  });

  const toggleDone = async () => {
    try { await api.setDone(id, occ, !done); refresh(); } catch (e) { errorToast(e); }
  };

  const moveDate = async () => {
    const v = await inputSheet({ title: repeating ? "วันที่เริ่ม" : "ย้ายวัน", type: "date", value: note.date });
    if (v) save({ date: v });
  };
  const setTime = async () => {
    const v = await inputSheet({ title: "เวลา", type: "time", value: note.time, clearLabel: "ทั้งวัน (ไม่ระบุเวลา)" });
    if (v !== undefined) save({ time: v });
  };
  const setReminder = async () => {
    const v = await reminderSheet(note, occ);
    if (!v) return;
    if (v.remind_minutes != null) askPermission();
    save(v);
  };
  const setCategory = async () => {
    const v = await categorySheet(note.category_id);
    if (v) save(v);
  };

  const cat = app.cat(note.category_id);
  const fieldRow = (ico, key, value, onclick, extra) => el("button", { class: "row", type: "button", onclick },
    el("span", { style: { color: "var(--accent)", display: "inline-flex" } }, icon(ico, 20)),
    el("span", { class: "k" }, key),
    value,
    extra || icon("next", 16));

  // ---- checklist

  const checkDone = note.checklist.filter((c) => c.done).length;
  const addInput = el("input", {
    id: "add-check", type: "text", placeholder: "เพิ่มรายการย่อย", maxlength: "200", "aria-label": "เพิ่มรายการย่อย",
    onkeydown: async (e) => {
      if (e.key !== "Enter" || !addInput.value.trim()) return;
      e.preventDefault();
      try { await api.addCheck(id, addInput.value); focusAfter = "add-check"; refresh(); } catch (ex) { errorToast(ex); }
    },
  });
  const checklist = note.checklist.map((c) => {
    const txt = el("input", {
      class: "txt", type: "text", value: c.text, maxlength: "200", "aria-label": "รายการย่อย",
      onchange: async () => {
        if (!txt.value.trim()) { txt.value = c.text; return; }
        try { await api.updateCheck(c.id, { text: txt.value }); c.text = txt.value; } catch (e) { errorToast(e); }
      },
    });
    return el("div", { class: "check-item" + (c.done ? " done" : "") },
      el("button", {
        class: "box", type: "button", role: "checkbox", "aria-checked": String(c.done), "aria-label": c.text,
        onclick: async () => { try { await api.updateCheck(c.id, { done: !c.done }); refresh(); } catch (e) { errorToast(e); } },
      }, c.done ? icon("check", 14, 3) : null),
      txt,
      el("button", {
        class: "icon-btn del", type: "button", "aria-label": `ลบ ${c.text}`,
        onclick: async () => { try { await api.deleteCheck(c.id); refresh(); } catch (e) { errorToast(e); } },
      }, icon("close", 16)));
  });

  // ---- note text

  let detailTimer = null;
  const area = el("textarea", {
    id: "d-note", class: "note-area", rows: "3", maxlength: "5000", value: note.detail,
    oninput: () => { clearTimeout(detailTimer); detailTimer = setTimeout(saveDetail, 800); },
    onchange: () => saveDetail(),
  });
  function saveDetail() {
    clearTimeout(detailTimer);
    if (area.value !== note.detail) { note.detail = area.value; save({ detail: area.value }, { quiet: true }); }
  }

  // ---- attachments

  const fileInput = el("input", {
    type: "file", multiple: true, class: "sr-only", id: "d-file",
    onchange: async () => {
      const files = [...fileInput.files];
      fileInput.value = "";
      for (const f of files) {
        if (f.size > MAX_FILE) { toast(`“${f.name}” ใหญ่เกิน 10 MB`); continue; }
        try { await api.upload(id, f); } catch (e) { errorToast(e); }
      }
      refresh();
    },
  });
  const files = note.attachments.map((a) => {
    const isImg = /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
    return el("div", { style: { position: "relative" } },
      el("a", {
        class: "file", href: `/api/attachments/${a.id}`, target: "_blank", rel: "noopener", title: a.name,
      }, isImg ? el("img", { src: `/api/attachments/${a.id}`, alt: a.name, loading: "lazy" }) : [icon("file", 22, 1.8), a.name]),
      el("button", {
        class: "x", type: "button", "aria-label": `ลบไฟล์ ${a.name}`, style: { position: "absolute" },
        onclick: async () => {
          if (!confirm(`ลบไฟล์ “${a.name}”?`)) return;
          try { await api.deleteAttachment(a.id); refresh(); } catch (e) { errorToast(e); }
        },
      }, icon("close", 14)));
  });

  // ---- bottom bar

  const base = !repeating ? (note.date < today ? today : note.date) : null;
  const postpone = base ? toKey(addDays(fromKey(base), 1)) : null;
  const postponeLabel = !repeating && note.date <= today ? "เลื่อนไปพรุ่งนี้" : "เลื่อนไป 1 วัน";

  fill(root,
    el("header", { class: "bar" },
      el("a", { class: "icon-btn", href: app.back, "aria-label": "กลับ" }, icon("back", 22)),
      el("span", { class: "title" }, "รายละเอียด"),
      el("button", { class: "icon-btn", type: "button", "aria-label": "ตัวเลือกเพิ่มเติม", onclick: more },
        el("span", { "aria-hidden": "true", style: { fontSize: "22px", lineHeight: 1, letterSpacing: "1px" } }, "•••"))),
    el("div", { class: "content", style: { gap: "16px", paddingTop: "4px" } },
      el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "0 4px" } },
        el("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
          tagFor(note.category_id) || el("span", { class: "tag", "--c": "#A1A1AA" }, "ไม่มีหมวด"),
          el("button", {
            class: "chip sm", type: "button", "aria-pressed": String(done), onclick: toggleDone,
            style: { display: "inline-flex", alignItems: "center", gap: "6px" },
          }, done ? [icon("check", 14, 2.6), "เสร็จแล้ว"] : "ทำเครื่องหมายว่าเสร็จ"),
          repeating ? el("span", { style: { fontSize: "12px", color: "var(--muted-2)" } }, `ครั้งวันที่ ${dayShortDate(occ, { year: false })}`) : null),
        title),

      el("section", { class: "card rows" },
        fieldRow("calendar", repeating ? "วันที่เริ่ม" : "วันที่", el("span", { class: "v" }, dayShortDate(note.date)), moveDate,
          el("span", { class: "link" }, "ย้ายวัน")),
        fieldRow("clock", "เวลา", el("span", { class: "v" }, note.time || "ทั้งวัน"), setTime),
        fieldRow("bell", "แจ้งเตือน", el("span", { class: "v" }, remindLabel(note) + (note.nag ? " · ซ้ำทุกชม." : "")), setReminder),
        fieldRow("repeat", "ทำซ้ำ", el("span", { class: "v" },
          REPEAT_LABEL[note.repeat] + (repeating && note.repeat_until ? ` ถึง ${dayShortDate(note.repeat_until)}` : "")), setReminder),
        fieldRow("tag", "หมวด", el("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
          cat ? el("span", { class: "dot lg", "--c": cat.color }) : null,
          el("span", { class: "v" }, cat ? cat.name : "ไม่มีหมวด")), setCategory)),

      el("section", { class: "card pad" },
        el("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          el("h2", { class: "card-title" }, "เช็กลิสต์ย่อย"),
          note.checklist.length ? el("span", { style: { fontSize: "13px", color: "var(--muted)" } }, `${checkDone}/${note.checklist.length}`) : null),
        note.checklist.length ? el("div", { class: "progress" }, el("span", { style: { width: `${(100 * checkDone) / note.checklist.length}%` } })) : null,
        el("div", { class: "checklist" },
          checklist,
          el("label", { class: "add-check" }, icon("plus", 22), addInput))),

      el("section", { class: "card pad", style: { gap: "8px" } },
        el("label", { for: "d-note", class: "card-title" }, "โน้ต"),
        area),

      el("section", { class: "card pad" },
        el("h2", { class: "card-title" }, "ไฟล์แนบ"),
        el("div", { class: "files" },
          files,
          el("label", { class: "file add", for: "d-file" }, icon("plus", 22), "แนบ", fileInput)))),

    el("div", { class: "bottom-bar" },
      el("div", { class: "inner" },
        el("button", { class: "btn danger", type: "button", "aria-label": "ลบ", onclick: remove }, icon("trash", 20)),
        !repeating ? el("button", {
          class: "btn", type: "button",
          onclick: async () => { const u = await save({ date: postpone }, { quiet: true }); if (u) { toast(`เลื่อนไป ${dayShortDate(postpone)}`); goBack(); } },
        }, postponeLabel) : null,
        el("button", {
          class: "btn primary", type: "button",
          onclick: async () => {
            saveDetail();
            if (title.value.trim() && title.value !== note.title) await save({ title: title.value }, { quiet: true });
            goBack();
          },
        }, "บันทึก"))),
  );

  if (focusAfter) {
    const f = document.getElementById(focusAfter);
    focusAfter = null;
    if (f) f.focus();
  }
}
