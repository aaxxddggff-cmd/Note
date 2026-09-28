import { api } from "../api.js";
import { el, fill, icon } from "../util.js";

// mode: "login" | "signup" | "forgot" | "reset"
let mode = "login";

/** Log in, sign up, ask for a reset link, or set a new password from one. onDone() runs once logged in. */
export async function render(root, { current, onDone, query }) {
  let status;
  try {
    status = await api.authStatus();
  } catch (e) {
    status = { error: e.message };
  }
  if (!current()) return;

  const token = query && query.get("token");
  if (token) mode = "reset";
  if (mode === "signup" && !status.signup_open) mode = "login";

  const draw = () => {
    const err = el("p", { class: "error", hidden: true, role: "alert" });
    const info = el("p", { class: "info", hidden: true, role: "status" });
    const showError = (m) => { err.textContent = m; err.hidden = false; info.hidden = true; };
    const go = (m) => { mode = m; draw(); };

    if (status.error) {
      fill(root, el("div", { class: "login" }, logo(), el("div", { class: "empty" }, status.error)));
      return;
    }

    const email = el("input", { id: "email", class: "input", type: "email", autocomplete: "email", required: true, maxlength: "254", inputmode: "email" });
    const pw = el("input", {
      id: "pw", class: "input", type: "password", required: true,
      autocomplete: mode === "login" ? "current-password" : "new-password", minlength: mode === "login" ? null : "8",
    });
    const pw2 = el("input", { id: "pw2", class: "input", type: "password", autocomplete: "new-password", required: true });
    const labels = {
      login: ["เข้าสู่ระบบ", "เข้าสู่ระบบด้วยอีเมลของคุณ"],
      signup: ["สมัครสมาชิก", "สร้างบัญชีใหม่ ข้อมูลของคุณจะเห็นได้เฉพาะคุณ"],
      forgot: ["ส่งลิงก์ตั้งรหัสผ่านใหม่", "เราจะส่งลิงก์ไปที่อีเมลของบัญชี (ใช้ได้ 1 ชั่วโมง)"],
      reset: ["ตั้งรหัสผ่านใหม่", "ตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ"],
    }[mode];
    const btn = el("button", { class: "btn primary", type: "submit", style: { width: "100%" } }, labels[0]);

    const submit = async (e) => {
      e.preventDefault();
      err.hidden = true;
      if ((mode === "signup" || mode === "reset") && pw.value !== pw2.value) return showError("รหัสผ่านสองช่องไม่ตรงกัน");
      btn.disabled = true;
      try {
        if (mode === "login") await api.login(email.value, pw.value);
        else if (mode === "signup") await api.signup(email.value, pw.value);
        else if (mode === "reset") await api.resetPassword(token, pw.value);
        else {
          await api.forgot(email.value);
          info.textContent = "ถ้ามีบัญชีของอีเมลนี้ เราได้ส่งลิงก์ไปแล้ว ตรวจกล่องจดหมาย (และโฟลเดอร์สแปม)";
          info.hidden = false;
          return;
        }
        mode = "login";
        if (token) history.replaceState(null, "", "#/today");
        onDone();
      } catch (ex) {
        showError(ex.message);
      } finally {
        btn.disabled = false;
      }
    };

    const link = (label, target) => el("button", { type: "button", class: "text-btn", onclick: () => go(target) }, label);

    fill(root, el("form", { class: "login", onsubmit: submit },
      logo(),
      el("h1", {}, "สมุดสิ่งสำคัญ"),
      el("p", { class: "login-sub" }, labels[1]),
      mode === "login" || mode === "signup" ? el("div", { class: "segmented", role: "group", "aria-label": "บัญชี" },
        el("button", { type: "button", "aria-pressed": String(mode === "login"), onclick: () => go("login") }, "เข้าสู่ระบบ"),
        status.signup_open ? el("button", { type: "button", "aria-pressed": String(mode === "signup"), onclick: () => go("signup") }, "สมัครสมาชิก") : null) : null,
      mode !== "reset" ? el("label", { class: "field", for: "email" }, el("span", {}, "อีเมล"), email) : null,
      mode !== "forgot" ? el("label", { class: "field", for: "pw" }, el("span", {}, mode === "login" ? "รหัสผ่าน" : "รหัสผ่าน (อย่างน้อย 8 ตัว)"), pw) : null,
      mode === "signup" || mode === "reset" ? el("label", { class: "field", for: "pw2" }, el("span", {}, "พิมพ์รหัสผ่านอีกครั้ง"), pw2) : null,
      err, info, btn,
      el("div", { class: "login-links" },
        mode === "login" && status.reset_available ? link("ลืมรหัสผ่าน?", "forgot") : null,
        mode === "login" && !status.reset_available ? el("span", {}, "ลืมรหัสผ่าน? ติดต่อผู้ดูแลระบบ") : null,
        mode === "forgot" || mode === "reset" ? link("กลับไปหน้าเข้าสู่ระบบ", "login") : null),
      mode === "signup" ? el("p", { class: "login-note" },
        "การสมัครถือว่ายอมรับ ", el("a", { href: "/privacy.html", target: "_blank", rel: "noopener" }, "นโยบายความเป็นส่วนตัว")) : null));
    (mode === "reset" ? pw : email).focus();
  };
  draw();
}

function logo() {
  return el("div", { class: "login-logo" }, icon("calendar", 28));
}
