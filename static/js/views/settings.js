import { api } from "../api.js";
import { askPermission } from "../reminders.js";
import { pushActive, enablePush, disablePush, needsHomeScreen, clearOfflineData } from "../pwa.js";
import { app, el, icon, openSheet, applyTheme, minutesLabel, REMIND_OPTIONS, errorToast, toast, fill, clearUserStorage } from "../util.js";

const COLORS = [
  ["#2563EB", "น้ำเงิน"], ["#0891B2", "ฟ้าอมเขียว"], ["#16A34A", "เขียว"], ["#CA8A04", "เหลือง"],
  ["#EA580C", "ส้ม"], ["#DC2626", "แดง"], ["#7C3AED", "ม่วง"], ["#71717A", "เทา"],
];
const draft = { name: "", color: "#16A34A" };

function swatches(selected, onPick) {
  const wrap = el("div", { class: "color-grid", role: "group", "aria-label": "สี" });
  const draw = (cur) => fill(wrap, ...COLORS.map(([c, name]) => el("button", {
    class: "swatch", type: "button", "--c": c, "aria-label": name, "aria-pressed": String(cur.toLowerCase() === c.toLowerCase()),
    onclick: () => { onPick(c); draw(c); },
  })));
  draw(selected);
  return wrap;
}

async function reloadCategories() {
  app.categories = await api.categories();
}

function editCategory(c, refresh) {
  return openSheet((close) => {
    const s = { name: c.name, color: c.color };
    const name = el("input", { class: "input", type: "text", value: c.name, maxlength: "40", "aria-label": "ชื่อหมวด", oninput: () => { s.name = name.value; } });
    const err = el("p", { class: "error", hidden: true });
    return el("form", {
      style: { display: "contents" },
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api.updateCategory(c.id, s);
          await reloadCategories();
          close(); refresh();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      },
    },
      el("h2", {}, "แก้ไขหมวด"),
      el("label", { class: "field" }, el("span", {}, "ชื่อหมวด"), name),
      el("div", { class: "field" }, el("span", { class: "label" }, "สี"), swatches(c.color, (v) => { s.color = v; })),
      err,
      el("button", {
        class: "btn", type: "button", style: { color: "var(--red)", borderColor: "var(--danger-line)" },
        onclick: async () => {
          const msg = c.count ? `ลบหมวด “${c.name}”? เรื่องที่อยู่ในหมวดนี้ ${c.count} เรื่องจะกลายเป็น “ไม่มีหมวด”` : `ลบหมวด “${c.name}”?`;
          if (!confirm(msg)) return;
          try { await api.deleteCategory(c.id); await reloadCategories(); close(); refresh(); } catch (ex) { errorToast(ex); }
        },
      }, "ลบหมวดนี้"),
      el("div", { class: "actions" },
        el("button", { class: "btn", type: "button", onclick: () => close() }, "ยกเลิก"),
        el("button", { class: "btn primary", type: "submit" }, "บันทึก")));
  }, { label: "แก้ไขหมวด" });
}

function installHelp() {
  return openSheet((close) => el("div", { style: { display: "contents" } },
    el("h2", {}, "วิดเจ็ตและหน้าจอหลัก"),
    el("p", { style: { margin: 0, fontSize: "14px", lineHeight: 1.7, color: "var(--text-2)" } },
      "แอปนี้เป็นเว็บแอป จึงสร้างวิดเจ็ตบนหน้าจอโทรศัพท์โดยตรงไม่ได้ แต่เพิ่มไอคอนไว้ที่หน้าจอหลักให้เปิดได้เหมือนแอปทั่วไป:"),
    el("ul", { style: { margin: 0, paddingLeft: "20px", fontSize: "14px", lineHeight: 1.8 } },
      el("li", {}, "iPhone (Safari): กดปุ่มแชร์ → “เพิ่มไปยังหน้าจอโฮม”"),
      el("li", {}, "Android (Chrome): เมนู ⋮ → “ติดตั้งแอป” หรือ “เพิ่มลงในหน้าจอหลัก”"),
      el("li", {}, "คอมพิวเตอร์ (Chrome/Edge): ไอคอนติดตั้งที่ช่องที่อยู่")),
    el("div", { class: "info" }, icon("bell", 18),
      el("span", {}, "หลังติดตั้งแล้ว เปิด “แจ้งเตือนบนเครื่องนี้” ในหน้าตั้งค่า เพื่อให้เตือนได้แม้ปิดแอป (iPhone ต้องเปิดจากไอคอนบนหน้าจอโฮม และใช้ iOS 16.4 ขึ้นไป)")),
    el("button", { class: "btn primary", type: "button", onclick: () => close() }, "เข้าใจแล้ว")), { label: "วิดเจ็ตและหน้าจอหลัก" });
}

function passwordSheet() {
  return openSheet((close) => {
    const cur = el("input", { class: "input", type: "password", autocomplete: "current-password", required: true });
    const next = el("input", { class: "input", type: "password", autocomplete: "new-password", required: true, minlength: "8" });
    const again = el("input", { class: "input", type: "password", autocomplete: "new-password", required: true });
    const err = el("p", { class: "error", hidden: true });
    return el("form", {
      style: { display: "contents" },
      onsubmit: async (e) => {
        e.preventDefault();
        if (next.value !== again.value) { err.textContent = "รหัสผ่านใหม่สองช่องไม่ตรงกัน"; err.hidden = false; return; }
        try {
          await api.changePassword(cur.value, next.value);
          toast("เปลี่ยนรหัสผ่านแล้ว เครื่องอื่นต้องเข้าสู่ระบบใหม่");
          close();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      },
    },
      el("h2", {}, "เปลี่ยนรหัสผ่าน"),
      el("label", { class: "field" }, el("span", {}, "รหัสผ่านเดิม"), cur),
      el("label", { class: "field" }, el("span", {}, "รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)"), next),
      el("label", { class: "field" }, el("span", {}, "พิมพ์รหัสผ่านใหม่อีกครั้ง"), again),
      err,
      el("div", { class: "actions" },
        el("button", { class: "btn", type: "button", onclick: () => close() }, "ยกเลิก"),
        el("button", { class: "btn primary", type: "submit" }, "บันทึก")));
  }, { label: "เปลี่ยนรหัสผ่าน" });
}

function deleteAccountSheet() {
  return openSheet((close) => {
    const pw = el("input", { class: "input", type: "password", autocomplete: "current-password", required: true });
    const err = el("p", { class: "error", hidden: true });
    return el("form", {
      style: { display: "contents" },
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await disablePush().catch(() => {});
          await api.deleteAccount(pw.value);
          clearOfflineData();
          clearUserStorage();
          location.hash = "#/today";
          location.reload();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      },
    },
      el("h2", {}, "ลบบัญชี"),
      el("p", { style: { margin: 0, fontSize: "14px", lineHeight: 1.7, color: "var(--text-2)" } },
        "บัญชี ", el("b", {}, app.user ? app.user.email : ""), " และข้อมูลทั้งหมด (เรื่องที่จด เช็กลิสต์ ไฟล์แนบ การตั้งค่า) จะถูกลบทันทีและกู้คืนไม่ได้ ",
        "ถ้าต้องการเก็บไว้ ให้กด “ดาวน์โหลดข้อมูลของฉัน” ก่อน"),
      el("label", { class: "field" }, el("span", {}, "ใส่รหัสผ่านเพื่อยืนยัน"), pw),
      err,
      el("div", { class: "actions" },
        el("button", { class: "btn", type: "button", onclick: () => close() }, "ยกเลิก"),
        el("button", { class: "btn primary", type: "submit", style: { background: "var(--red)" } }, "ลบบัญชีถาวร")));
  }, { label: "ลบบัญชี" });
}

export async function render(root, { current, refresh }) {
  const [, pushConfig, pushOn] = await Promise.all([
    reloadCategories(), api.pushConfig().catch(() => ({ enabled: false, devices: 0 })), pushActive(),
  ]);
  if (!current()) return;
  const s = app.settings;

  const set = async (data) => {
    try {
      app.settings = await api.updateSettings(data);
      applyTheme();
      refresh();
    } catch (e) { errorToast(e); }
  };
  const toggle = (key, label, sub) => el("button", {
    class: "row", type: "button", role: "switch", "aria-checked": String(!!s[key]), onclick: () => set({ [key]: !s[key] }),
  },
    el("span", { class: "grow" }, el("span", { style: { fontSize: "15px" } }, label), sub ? el("span", { class: "sub" }, sub) : null),
    el("span", { class: "switch" }));

  // ---- add category
  const nameInput = el("input", {
    id: "cat-name", class: "input", type: "text", value: draft.name, maxlength: "40", placeholder: "เช่น บ้าน",
    oninput: () => { draft.name = nameInput.value; preview.textContent = draft.name || "ตัวอย่าง"; },
  });
  const preview = el("span", { class: "tag", "--c": draft.color }, draft.name || "ตัวอย่าง");
  const addCategory = async (e) => {
    e.preventDefault();
    if (!draft.name.trim()) { nameInput.focus(); return; }
    try {
      await api.createCategory({ name: draft.name, color: draft.color });
      toast(`เพิ่มหมวด “${draft.name.trim()}” แล้ว`);
      draft.name = "";
      refresh();
    } catch (ex) { errorToast(ex); }
  };

  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const permLabel = { granted: "อนุญาตแล้ว", denied: "ถูกบล็อก (เปิดในตั้งค่าเบราว์เซอร์)", default: "ขออนุญาต", unsupported: "เบราว์เซอร์ไม่รองรับ" }[perm];

  fill(root,
    el("header", { class: "page-head" }, el("h1", {}, "ตั้งค่า")),
    el("div", { class: "content", style: { gap: "18px" } },

      el("section", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        el("h2", { class: "section-label", style: { margin: "0 4px" } }, "หมวดหมู่ของฉัน"),
        el("div", { class: "card rows" },
          app.categories.length ? app.categories.map((c) => el("div", { class: "row cat-row", style: { paddingRight: "4px" } },
            el("span", { class: "dot lg", "--c": c.color }),
            el("button", {
              type: "button", style: { flexGrow: 1, border: "none", background: "none", textAlign: "left", fontSize: "15px", padding: "16px 0" },
              onclick: () => editCategory(c, refresh), "aria-label": `แก้ไขหมวด ${c.name}`,
            }, c.name),
            el("span", { class: "count" }, String(c.count)),
            el("button", {
              class: "icon-btn star", type: "button", "aria-pressed": String(!!c.important),
              "aria-label": c.important ? `เอา “${c.name}” ออกจากเรื่องสำคัญ` : `นับ “${c.name}” เป็นเรื่องสำคัญ`,
              title: "นับเป็นเรื่องสำคัญ",
              onclick: async () => {
                try { await api.updateCategory(c.id, { important: !c.important }); refresh(); } catch (e) { errorToast(e); }
              },
            }, icon("star", 20)),
            el("button", { class: "icon-btn", type: "button", "aria-label": `แก้ไขหมวด ${c.name}`, onclick: () => editCategory(c, refresh) }, icon("next", 16))))
            : el("div", { class: "row" }, el("span", { class: "k" }, "ยังไม่มีหมวด"))),
        el("div", { style: { fontSize: "12px", color: "var(--muted-2)", padding: "0 4px" } }, "ดาว = นับเป็นเรื่องสำคัญ (แสดงในแท็บ “ค้าง” และสรุป)")),

      el("form", { class: "card pad", style: { gap: "12px", padding: "16px" }, onsubmit: addCategory },
        el("h2", { class: "card-title" }, "เพิ่มหมวดใหม่"),
        el("label", { class: "field", for: "cat-name" }, el("span", {}, "ชื่อหมวด"), nameInput),
        el("div", { class: "field" }, el("span", { class: "label" }, "สี"),
          swatches(draft.color, (c) => { draft.color = c; preview.style.setProperty("--c", c); })),
        el("div", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--muted)" } }, "ตัวอย่าง", preview),
        el("button", { class: "btn primary", type: "submit", style: { height: "48px" } }, "เพิ่มหมวด")),

      el("section", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        el("h2", { class: "section-label", style: { margin: "0 4px" } }, "การแสดงผล"),
        el("div", { class: "card pad" },
          el("div", { style: { fontSize: "15px" } }, "ธีม"),
          el("div", { class: "segmented", role: "group", "aria-label": "ธีม" },
            [["light", "สว่าง"], ["dark", "มืด"], ["system", "ตามเครื่อง"]].map(([v, l]) =>
              el("button", { type: "button", "aria-pressed": String(s.theme === v), onclick: () => set({ theme: v }) }, l)))),
        el("div", { class: "card rows" },
          toggle("show_holidays", "แสดงวันหยุดราชการไทย", "ตัวเลขสีแดงในปฏิทิน"),
          toggle("buddhist_year", "แสดงปีเป็น พ.ศ."),
          el("div", { class: "row" },
            el("span", { class: "k", style: { color: "var(--text)", fontSize: "15px" } }, "สัปดาห์เริ่มวัน"),
            el("div", { class: "segmented", role: "group", "aria-label": "สัปดาห์เริ่มวัน", style: { width: "160px" } },
              [[0, "อาทิตย์"], [1, "จันทร์"]].map(([v, l]) =>
                el("button", { type: "button", style: { height: "34px" }, "aria-pressed": String(s.week_start === v), onclick: () => set({ week_start: v }) }, l)))),
          el("label", { class: "row" },
            el("span", { class: "k", style: { color: "var(--text)", fontSize: "15px" } }, "แจ้งเตือนค่าเริ่มต้น"),
            el("select", {
              class: "input", style: { width: "auto", height: "38px", fontSize: "14px" }, "aria-label": "แจ้งเตือนค่าเริ่มต้น",
              onchange: (e) => set({ default_remind: e.target.value === "" ? null : Number(e.target.value) }),
            },
              el("option", { value: "", selected: s.default_remind == null }, "ไม่เตือน"),
              REMIND_OPTIONS.map(([v]) => el("option", { value: String(v), selected: s.default_remind === v }, minutesLabel(v))),
              s.default_remind != null && !REMIND_OPTIONS.some(([v]) => v === s.default_remind)
                ? el("option", { value: String(s.default_remind), selected: true }, minutesLabel(s.default_remind)) : null)),
          el("button", { class: "row", type: "button", onclick: installHelp },
            el("span", { class: "k", style: { color: "var(--text)", fontSize: "15px" } }, "ติดตั้งแอป / วิดเจ็ต"),
            el("span", { class: "link" }, "วิธีเพิ่ม")))),

      el("section", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        el("h2", { class: "section-label", style: { margin: "0 4px" } }, "การแจ้งเตือน"),
        el("div", { class: "card rows" },
          pushConfig.enabled ? el("button", {
            class: "row", type: "button", role: "switch", "aria-checked": String(pushOn),
            onclick: async () => {
              try {
                if (pushOn) { await disablePush(); toast("ปิดการแจ้งเตือนบนเครื่องนี้แล้ว"); }
                else { await enablePush(); toast("เปิดการแจ้งเตือนบนเครื่องนี้แล้ว"); }
              } catch (e) { errorToast(e); }
              refresh();
            },
          },
            el("span", { class: "grow" },
              el("span", { style: { fontSize: "15px" } }, "แจ้งเตือนบนเครื่องนี้"),
              el("span", { class: "sub" }, needsHomeScreen() && !pushOn
                ? "iPhone: เพิ่มแอปไว้ที่หน้าจอโฮมก่อน แล้วเปิดจากไอคอน"
                : `เด้งได้แม้ปิดแอป · เปิดอยู่ ${pushConfig.devices} เครื่อง`)),
            el("span", { class: "switch" })) : el("button", {
            class: "row", type: "button", disabled: perm !== "default",
            onclick: async () => { await askPermission(); refresh(); },
          },
            el("span", { class: "grow" },
              el("span", { style: { fontSize: "15px" } }, "การแจ้งเตือนของเบราว์เซอร์"),
              el("span", { class: "sub" }, "เตือนได้เฉพาะตอนเปิดแอปค้างไว้ (เซิร์ฟเวอร์ยังไม่ได้เปิด push)")),
            el("span", { class: perm === "default" ? "link" : "v", style: perm === "default" ? null : { color: "var(--muted)" } }, permLabel)),
          pushOn ? el("button", {
            class: "row", type: "button",
            onclick: async () => {
              try { const r = await api.pushTest(); toast(r.sent ? "ส่งแล้ว — รอสักครู่" : "ไม่มีเครื่องที่รับได้"); } catch (e) { errorToast(e); }
            },
          }, el("span", { class: "k", style: { color: "var(--text)", fontSize: "15px" } }, "ทดสอบการแจ้งเตือน"), el("span", { class: "link" }, "ส่ง")) : null,
          toggle("morning_summary", "สรุปเช้า 07:30", "เรื่องของวันนี้และที่เลยกำหนด"),
          el("div", { class: "row" },
            el("span", { class: "k", style: { color: "var(--text)", fontSize: "15px" } }, "เขตเวลา"),
            el("span", { class: "v", style: { color: "var(--muted)" } }, s.timezone)))),

      el("section", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        el("h2", { class: "section-label", style: { margin: "0 4px" } }, "บัญชี"),
        el("div", { class: "card rows" },
          el("div", { class: "row" },
            el("span", { class: "k", style: { color: "var(--text)", fontSize: "15px" } }, "อีเมล"),
            el("span", { class: "v", style: { color: "var(--muted)", overflowWrap: "anywhere" } }, app.user ? app.user.email : "")),
          el("button", { class: "row", type: "button", onclick: passwordSheet },
            el("span", { class: "k", style: { color: "var(--text)", fontSize: "15px" } }, "เปลี่ยนรหัสผ่าน"), icon("next", 16)),
          el("button", {
            class: "row", type: "button",
            onclick: async () => {
              if (!confirm("ออกจากระบบทุกเครื่อง ยกเว้นเครื่องนี้?")) return;
              try { await api.logoutOthers(); toast("ออกจากระบบเครื่องอื่นแล้ว"); } catch (e) { errorToast(e); }
            },
          }, el("span", { class: "k", style: { color: "var(--text)", fontSize: "15px" } }, "ออกจากระบบเครื่องอื่นทั้งหมด")),
          el("button", {
            class: "row", type: "button",
            onclick: async () => {
              if (!confirm("ออกจากระบบ?")) return;
              await disablePush().catch(() => {});
              try { await api.logout(); } catch { /* offline: the cookie stays but the cache is cleared */ }
              clearOfflineData();
              clearUserStorage();
              location.hash = "#/today";
              location.reload();
            },
          }, el("span", { class: "k", style: { color: "var(--red)", fontSize: "15px" } }, "ออกจากระบบ"))),
        el("div", { class: "card rows" },
          el("a", { class: "row", href: "/api/account/export", download: "" },
            el("span", { class: "grow" },
              el("span", { style: { fontSize: "15px" } }, "ดาวน์โหลดข้อมูลของฉัน"),
              el("span", { class: "sub" }, "ไฟล์ JSON ของทุกเรื่องที่จด (ไม่รวมตัวไฟล์แนบ)")),
            icon("next", 16)),
          el("a", { class: "row", href: "/privacy.html", target: "_blank", rel: "noopener" },
            el("span", { class: "k", style: { color: "var(--text)", fontSize: "15px" } }, "นโยบายความเป็นส่วนตัว"), icon("next", 16)),
          el("button", { class: "row", type: "button", onclick: deleteAccountSheet },
            el("span", { class: "k", style: { color: "var(--red)", fontSize: "15px" } }, "ลบบัญชีและข้อมูลทั้งหมด"))))),
  );
}
