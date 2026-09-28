import { todayKey } from "./util.js";

async function call(method, path, body, headers = {}) {
  const opts = { method, headers: { "X-Requested-With": "fetch", ...headers } };
  if (body instanceof Blob) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error(navigator.onLine === false ? "ออฟไลน์อยู่ — แก้ไขได้เมื่อกลับมาออนไลน์" : "ติดต่อเซิร์ฟเวอร์ไม่ได้");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event("unauthorized"));
  }
  if (!res.ok) throw new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
  return data;
}

const t = () => `today=${todayKey()}`;

export const api = {
  authStatus: () => call("GET", "/api/auth/status"),
  signup: (email, password) => call("POST", "/api/auth/signup", { email, password }),
  login: (email, password) => call("POST", "/api/auth/login", { email, password }),
  forgot: (email) => call("POST", "/api/auth/forgot", { email }),
  resetPassword: (token, password) => call("POST", "/api/auth/reset", { token, password }),
  deleteAccount: (password) => call("POST", "/api/account/delete", { password }),
  logout: () => call("POST", "/api/auth/logout", {}),
  changePassword: (current, next) => call("POST", "/api/auth/password", { current, new: next }),
  logoutOthers: () => call("POST", "/api/auth/logout-others", {}),

  pushConfig: () => call("GET", "/api/push/config"),
  pushSubscribe: (sub) => call("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint) => call("POST", "/api/push/unsubscribe", { endpoint }),
  pushTest: () => call("POST", "/api/push/test", {}),
  snooze: (id, date, minutes = 60) => call("POST", `/api/notes/${id}/snooze`, { date, minutes }),

  bootstrap: () => call("GET", "/api/bootstrap"),
  occurrences: (from, to) => call("GET", `/api/occurrences?from=${from}&to=${to}`),
  overdue: () => call("GET", `/api/overdue?${t()}`),
  important: () => call("GET", `/api/important?${t()}`),
  search: (q) => call("GET", `/api/search?q=${encodeURIComponent(q)}&${t()}`),

  note: (id) => call("GET", `/api/notes/${id}`),
  createNote: (data) => call("POST", "/api/notes", data),
  updateNote: (id, data) => call("PUT", `/api/notes/${id}`, data),
  deleteNote: (id) => call("DELETE", `/api/notes/${id}`),
  setDone: (id, date, done) => call("POST", `/api/notes/${id}/done`, { date, done }),

  addCheck: (id, text) => call("POST", `/api/notes/${id}/checklist`, { text }),
  updateCheck: (itemId, data) => call("PUT", `/api/checklist/${itemId}`, data),
  deleteCheck: (itemId) => call("DELETE", `/api/checklist/${itemId}`),

  upload: (id, file) => call("POST", `/api/notes/${id}/attachments`, file, {
    "Content-Type": file.type || "application/octet-stream",
    "X-Filename": encodeURIComponent(file.name),
  }),
  deleteAttachment: (attId) => call("DELETE", `/api/attachments/${attId}`),

  createCategory: (data) => call("POST", "/api/categories", data),
  updateCategory: (id, data) => call("PUT", `/api/categories/${id}`, data),
  deleteCategory: (id) => call("DELETE", `/api/categories/${id}`),
  categories: () => call("GET", "/api/categories"),

  updateSettings: (data) => call("PUT", "/api/settings", data),
};
