/**
 * The app's settings kept on the PC, so a newly paired phone or tablet picks up your theme, map, sounds, open
 * sections and checklist ticks. Only these keys travel; the pairing token and caches stay on each device.
 */
const KEYS = ["vbuddy.theme", "vbuddy.theme.airline", "vbuddy.mapstyle", "vbuddy.map.weather", "vbuddy.chime", "vbuddy.atc.autoplay", "vbuddy.taxi.screen", "vbuddy.checklists", "vbuddy.dash"];
const PREFIXES = ["vbuddy.live."];
const AT = "vbuddy.sync.at";
const LOADED_AT = Date.now();

const synced = (k: string) => KEYS.includes(k) || PREFIXES.some((p) => k.startsWith(p));

function read(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && synced(k)) out[k] = localStorage.getItem(k) ?? "";
    }
  } catch {
    /* no storage */
  }
  return out;
}
const localAt = () => {
  try {
    return Number(localStorage.getItem(AT)) || 0;
  } catch {
    return 0;
  }
};
const setLocalAt = (n: number) => {
  try {
    localStorage.setItem(AT, String(n));
  } catch {
    /* no storage */
  }
};
const same = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

let lastSent: Record<string, string> | null = null;

/** The bridge sent its copy. Newer than ours: take it (reload right after opening, so every screen starts with it). */
export function receiveAppSettings(updatedAt: number, values: Record<string, string>): void {
  const mine = read();
  if (updatedAt <= localAt()) {
    lastSent = same(mine, values) ? mine : null; // ours is newer: the next check sends it
    return;
  }
  if (same(mine, values)) {
    setLocalAt(updatedAt);
    lastSent = mine;
    return;
  }
  try {
    for (const k of Object.keys(mine)) if (!(k in values)) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(values)) if (synced(k)) localStorage.setItem(k, v);
  } catch {
    return;
  }
  setLocalAt(updatedAt);
  lastSent = values;
  if (Date.now() - LOADED_AT < 10_000) window.location.reload();
  else window.dispatchEvent(new Event("vbuddy-settings"));
}

/** Called every few seconds: sends this device's settings when they changed. */
export function checkAppSettings(send: (updatedAt: number, values: Record<string, string>) => boolean): void {
  const mine = read();
  if (lastSent && same(mine, lastSent)) return;
  const at = Date.now();
  if (send(at, mine)) {
    lastSent = mine;
    setLocalAt(at);
  }
}
