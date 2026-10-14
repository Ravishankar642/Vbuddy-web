import { useSyncExternalStore } from "react";

/** Chrome's install prompt event (not in the DOM typings). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaState {
  /** Service workers can run here (https or localhost, supported browser, production build). */
  swAvailable: boolean;
  /** Why not, in a form the UI can show. */
  swReason: "ok" | "insecure" | "unsupported" | "dev";
  /** The app is saved on this device and opens without the network. */
  offlineReady: boolean;
  /** A newer version is downloaded and waiting for a reload. */
  updateReady: boolean;
  /** The browser offers a one-tap install (Chrome/Edge/Android). */
  canInstall: boolean;
  /** Running as an installed app, not in a browser tab. */
  standalone: boolean;
  /** iPhone/iPad Safari: install is manual via the Share sheet. */
  ios: boolean;
  /** The person closed the install hint. */
  hintDismissed: boolean;
}

const HINT_KEY = "vbuddy.installHint.dismissed";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function detectStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function detectIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

let state: PwaState = {
  swAvailable: false,
  swReason: "dev",
  offlineReady: false,
  updateReady: false,
  canInstall: false,
  standalone: false,
  ios: false,
  hintDismissed: false,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<PwaState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};

let installEvent: InstallPromptEvent | null = null;
let registration: ServiceWorkerRegistration | null = null;
let reloading = false;
let started = false;

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Call once at startup. Registers the service worker where the browser allows it. */
export function startPwa() {
  if (started) return;
  started = true;
  set({ standalone: detectStandalone(), ios: detectIos(), hintDismissed: readFlag(HINT_KEY) });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own button instead of the browser's mini-bar
    installEvent = e as InstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    set({ canInstall: false, standalone: true });
  });
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", () => set({ standalone: detectStandalone() }));

  if (!import.meta.env.PROD) return set({ swReason: "dev" });
  // Check this first: on plain http the browser hides navigator.serviceWorker entirely, which would look like "unsupported".
  if (!window.isSecureContext) return set({ swReason: "insecure" });
  if (!("serviceWorker" in navigator)) return set({ swReason: "unsupported" });
  set({ swAvailable: true, swReason: "ok" });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Only a deliberate update reloads the page; the very first install also fires this.
    if (reloading) window.location.reload();
  });

  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((reg) => {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) set({ updateReady: true });
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) set({ updateReady: true });
        });
      });
      const check = () => void reg.update().catch(() => {});
      setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
    })
    .catch((e) => console.warn("[vbuddy] service worker failed to register:", e));

  void navigator.serviceWorker.ready.then(() => set({ offlineReady: true }));
}

/** Switch to the waiting version. The page reloads once it takes over. */
export function applyUpdate() {
  const w = registration?.waiting;
  if (!w) return window.location.reload();
  reloading = true;
  w.postMessage("SKIP_WAITING");
}

export async function promptInstall() {
  const e = installEvent;
  if (!e) return;
  installEvent = null;
  set({ canInstall: false });
  await e.prompt();
  await e.userChoice.catch(() => {});
}

export function dismissInstallHint() {
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    /* private mode: the hint just comes back next time */
  }
  set({ hintDismissed: true });
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
