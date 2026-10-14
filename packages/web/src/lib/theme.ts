import { useSyncExternalStore } from "react";

/** "system" follows the device; light and dark are the user's choice (kept on this device). */
export type ThemePref = "system" | "light" | "dark";
const KEY = "vbuddy.theme";
const listeners = new Set<() => void>();
const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let pref: ThemePref = readPref();

const resolve = (p: ThemePref): "light" | "dark" => (p === "system" ? (media?.matches ? "dark" : "light") : p);

function apply() {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", resolve(pref) === "dark" ? "#34031a" : "#5c0632");
}

export function setThemePref(next: ThemePref) {
  pref = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* private mode: the choice lasts until the page closes */
  }
  apply();
  listeners.forEach((l) => l());
}

media?.addEventListener?.("change", () => {
  apply();
  listeners.forEach((l) => l());
});
apply();

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useTheme() {
  const p = useSyncExternalStore(subscribe, () => pref);
  const resolved = useSyncExternalStore(subscribe, () => resolve(pref));
  const order: ThemePref[] = ["system", "light", "dark"];
  return { pref: p, resolved, cycle: () => setThemePref(order[(order.indexOf(p) + 1) % order.length]!) };
}
