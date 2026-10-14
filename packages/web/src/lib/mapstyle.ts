import { useSyncExternalStore } from "react";

/** What the map looks like. Satellite is the default; the grey canvases are cleaner for reading traffic. */
export type MapStyle = "satellite" | "dark" | "light";
export const MAP_STYLES: Array<[MapStyle, string]> = [
  ["satellite", "Satellite"],
  ["dark", "Dark"],
  ["light", "Light"],
];
const KEY = "vbuddy.mapstyle";
const listeners = new Set<() => void>();
let style: MapStyle = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : "satellite";
  } catch {
    return "satellite";
  }
})();

export function useMapStyle(): [MapStyle, () => void] {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => style,
  );
  const cycle = () => {
    style = MAP_STYLES[(MAP_STYLES.findIndex(([k]) => k === style) + 1) % MAP_STYLES.length]![0];
    try {
      localStorage.setItem(KEY, style);
    } catch {
      /* the choice lasts until the page closes */
    }
    listeners.forEach((l) => l());
  };
  return [s, cycle];
}
