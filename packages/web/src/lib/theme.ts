import { useSyncExternalStore } from "react";
import { airlinePalette } from "./airline-theme";
import { airlineOf, type Airline } from "./airlines";

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

/** Airline colours: on unless switched off on this device. */
const AIRLINE_KEY = "vbuddy.theme.airline";
function readAirlinePref(): boolean {
  try {
    return localStorage.getItem(AIRLINE_KEY) !== "off";
  } catch {
    return true;
  }
}
let airlineOn = readAirlinePref();
let airline: (Airline & { icao: string }) | null = null;
let applied: string[] = [];

const resolve = (p: ThemePref): "light" | "dark" => (p === "system" ? (media?.matches ? "dark" : "light") : p);

function apply() {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  const mode = resolve(pref);
  // The airline's palette goes on top of the stylesheet's, as inline custom properties.
  for (const k of applied) root.style.removeProperty(k);
  applied = [];
  const a = airlineOn ? airline : null;
  let themeColor = mode === "dark" ? "#34031a" : "#5c0632";
  if (a) {
    const pal = airlinePalette(a, mode);
    for (const [k, v] of Object.entries(pal)) root.style.setProperty(k, v);
    applied = Object.keys(pal);
    themeColor = pal["--brand-deep"]!;
    root.setAttribute("data-airline", a.icao);
  } else root.removeAttribute("data-airline");
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", themeColor);
}

/** The callsign you're connected to VATSIM with (null when not connected): its airline colours the app. */
export function setThemeCallsign(callsign: string | null) {
  const next = airlineOf(callsign);
  if ((next?.icao ?? null) === (airline?.icao ?? null)) return;
  airline = next;
  apply();
  listeners.forEach((l) => l());
}

export function setAirlineColours(on: boolean) {
  airlineOn = on;
  try {
    if (on) localStorage.removeItem(AIRLINE_KEY);
    else localStorage.setItem(AIRLINE_KEY, "off");
  } catch {
    /* for this visit only */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useAirlineTheme() {
  const on = useSyncExternalStore(subscribe, () => airlineOn);
  const a = useSyncExternalStore(subscribe, () => airline);
  return { on, airline: a, set: setAirlineColours };
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
