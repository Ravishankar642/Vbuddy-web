import { useSyncExternalStore } from "react";

/**
 * Taxi guidance on this screen: the banner at the top of the Flights tab, and the short notes in the open app.
 * (Notifications when VBuddy is closed are chosen with the others, on the Notifications page.) Kept on this device.
 */
export interface TaxiScreenPrefs {
  banner: boolean;
  notes: boolean;
}
const KEY = "vbuddy.taxi.screen";
const read = (): TaxiScreenPrefs => {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<TaxiScreenPrefs>;
    return { banner: j.banner !== false, notes: j.notes !== false };
  } catch {
    return { banner: true, notes: true };
  }
};
let cur = read();
const subs = new Set<() => void>();
export function setTaxiScreenPrefs(p: Partial<TaxiScreenPrefs>) {
  cur = { ...cur, ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {
    /* for this visit only */
  }
  for (const s of subs) s();
}
export function useTaxiScreenPrefs(): TaxiScreenPrefs {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => cur,
    () => cur,
  );
}
