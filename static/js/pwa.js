// Service worker registration and push subscription for this device.

import { api } from "./api.js";

let registration = null;

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  // a new version took over: reload once so the page and its files match
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded) {
      reloaded = true;
      location.reload();
    }
  });
  try {
    registration = await navigator.serviceWorker.register("/sw.js");
  } catch (e) {
    console.warn("service worker:", e);
  }
  return registration;
}

export const pushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** True on iPhone/iPad when opened in Safari rather than from the home screen (push needs the latter). */
export function needsHomeScreen() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  return ios && !standalone;
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = registration || (await navigator.serviceWorker.ready);
  return reg.pushManager.getSubscription();
}

/** Is this device receiving server pushes? */
export async function pushActive() {
  try {
    return !!(await currentSubscription());
  } catch {
    return false;
  }
}

function keyBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush() {
  const config = await api.pushConfig();
  if (!config.enabled) throw new Error("เซิร์ฟเวอร์ยังไม่ได้เปิดการแจ้งเตือนแบบ push (ต้องติดตั้ง pywebpush)");
  if (!pushSupported()) throw new Error("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนแบบ push");
  if (needsHomeScreen()) throw new Error("บน iPhone ต้องเพิ่มแอปไว้ที่หน้าจอโฮมก่อน แล้วเปิดจากไอคอนนั้น");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("ยังไม่ได้อนุญาตการแจ้งเตือน (เปิดได้ในตั้งค่าของเบราว์เซอร์)");
  const reg = registration || (await navigator.serviceWorker.ready);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.public_key) });
  }
  await api.pushSubscribe(sub.toJSON());
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/** Re-send this device's subscription (the browser may rotate it). */
export async function refreshPush() {
  try {
    const sub = await currentSubscription();
    if (sub) await api.pushSubscribe(sub.toJSON());
  } catch { /* offline or push disabled on the server */ }
}

export function clearOfflineData() {
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage("logout");
  }
}
