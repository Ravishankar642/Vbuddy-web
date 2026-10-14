const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const int = (n: number) => nf0.format(Math.round(n));
export const signed = (n: number) => (Math.round(n) > 0 ? "+" : "") + nf0.format(Math.round(n));
export const hdg = (d: number) => String(Math.round(d) % 360 || 360).padStart(3, "0");
export const fixed = (n: number, d: number) => n.toFixed(d);

/** 19.0887 -> "N19°05.32'" */
export function coord(v: number, isLat: boolean): string {
  const hemi = isLat ? (v >= 0 ? "N" : "S") : v >= 0 ? "E" : "W";
  const a = Math.abs(v);
  const deg = Math.floor(a);
  const min = (a - deg) * 60;
  return `${hemi}${String(deg).padStart(isLat ? 2 : 3, "0")}°${min.toFixed(2).padStart(5, "0")}'`;
}

export function ago(ms: number): string {
  if (ms < 1500) return "live";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

export const signed1 = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "") + Math.abs(n).toFixed(1);

/** "13 Oct, 02:14" in the viewer's locale. */
export function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "just now", "5 min ago", "3 h ago", otherwise the date. */
export function sinceText(ms: number, ts: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return when(ts);
}
