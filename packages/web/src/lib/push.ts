import type { PushPrefs } from "@vbuddy/protocol";

export type PushSupport = "ok" | "insecure" | "unsupported" | "ios-install";

/** Can this browser receive notifications, and if not, why (so the UI can say what to do). */
export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return "insecure";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "ios-install"; // iPhone/iPad only allow notifications for an app added to the Home Screen
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Asks permission and subscribes this browser. Returns the subscription to hand to the bridge, or an error to show. */
export async function subscribeBrowser(publicKey: string): Promise<{ ok: true; sub: PushSubscriptionJSON } | { ok: false; error: string }> {
  try {
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, error: perm === "denied" ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again." : "Notifications weren't allowed." };
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // A subscription made for a different bridge key (new data folder) can't be reused.
    if (sub && !sameKey(sub, publicKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    return { ok: true, sub: sub.toJSON() };
  } catch (e) {
    return { ok: false, error: `Couldn't turn on notifications: ${(e as Error).message}` };
  }
}

/** This browser's subscription, if it has one for this bridge's key and notifications are allowed. Asks nothing. */
export async function existingSubscription(publicKey: string): Promise<PushSubscriptionJSON | null> {
  try {
    if (pushSupport() !== "ok" || Notification.permission !== "granted") return null;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub && sameKey(sub, publicKey) ? sub.toJSON() : null;
  } catch {
    return null;
  }
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  const have = new Uint8Array(k);
  const want = keyBytes(publicKey);
  return have.length === want.length && have.every((v, i) => v === want[i]);
}

export async function unsubscribeBrowser(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    await (await reg.pushManager.getSubscription())?.unsubscribe();
  } catch {
    /* nothing to undo */
  }
}

export type { PushPrefs };
