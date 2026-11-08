import type { LandingRating, LandingSummary } from "@vbuddy/protocol";
import type { SavedFlight } from "./flights";

export const RATING_ORDER: LandingRating[] = ["butter", "smooth", "normal", "firm", "hard", "severe"];
const GOOD = new Set<LandingRating>(["butter", "smooth", "normal"]);

export interface LandingStats {
  count: number;
  avgFpm: number | null;
  softest: LandingSummary | null;
  byRating: Record<LandingRating, number>;
  /** Average sink of the last 10 landings and the 10 before them (null when there aren't enough). */
  recentFpm: number | null;
  previousFpm: number | null;
  /** Landings in a row rated normal or better, counting back from the latest; and the best run ever. */
  streak: number;
  bestStreak: number;
  byAircraft: Array<{ name: string; count: number; avgFpm: number }>;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Landing statistics, newest first in `ls` (as the bridge sends them). Touch-and-gos are left out of the averages. */
export function landingStats(ls: LandingSummary[]): LandingStats {
  const real = ls.filter((l) => !l.touchAndGo);
  const byRating = Object.fromEntries(RATING_ORDER.map((r) => [r, 0])) as Record<LandingRating, number>;
  for (const l of real) byRating[l.rating]++;
  let streak = 0;
  while (streak < real.length && GOOD.has(real[streak]!.rating)) streak++;
  let best = 0;
  let run = 0;
  for (const l of real) {
    run = GOOD.has(l.rating) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const groups = new Map<string, number[]>();
  for (const l of real) {
    const k = l.aircraftTitle || "Unknown aircraft";
    groups.set(k, [...(groups.get(k) ?? []), Math.abs(l.vsFpm)]);
  }
  return {
    count: real.length,
    avgFpm: avg(real.map((l) => Math.abs(l.vsFpm))),
    softest: real.reduce<LandingSummary | null>((a, l) => (!a || Math.abs(l.vsFpm) < Math.abs(a.vsFpm) ? l : a), null),
    byRating,
    recentFpm: real.length >= 10 ? avg(real.slice(0, 10).map((l) => Math.abs(l.vsFpm))) : null,
    previousFpm: real.length >= 20 ? avg(real.slice(10, 20).map((l) => Math.abs(l.vsFpm))) : null,
    streak,
    bestStreak: best,
    byAircraft: [...groups.entries()].map(([name, v]) => ({ name, count: v.length, avgFpm: avg(v)! })).sort((a, b) => b.count - a.count),
  };
}

export interface Achievement {
  id: string;
  title: string;
  text: string;
  earned: boolean;
}

/** Badges from the logbook. Each is a fact about what you've flown, not a target nobody asked for. */
export function achievements(ls: LandingSummary[], flights: SavedFlight[], stats = landingStats(ls)): Achievement[] {
  const crosswindGood = ls.some((l) => !l.touchAndGo && GOOD.has(l.rating) && Math.abs(l.wind?.crosswindKt ?? 0) >= 15);
  const stable = ls.filter((l) => l.approach && l.approach.length >= 2 && l.approach.every((g) => g.stable)).length;
  const longest = Math.max(0, ...flights.map((f) => f.endedAt - f.startedAt));
  const airports = new Set(flights.flatMap((f) => [f.from?.icao, f.to?.icao]).filter(Boolean)).size;
  return [
    { id: "first", title: "First landing", text: "Logged your first landing.", earned: stats.count >= 1 },
    { id: "butter", title: "Butter", text: "A landing rated butter.", earned: stats.byRating.butter > 0 },
    { id: "ten", title: "Ten down", text: "10 landings.", earned: stats.count >= 10 },
    { id: "fifty", title: "Regular", text: "50 landings.", earned: stats.count >= 50 },
    { id: "hundred", title: "Centurion", text: "100 landings.", earned: stats.count >= 100 },
    { id: "streak5", title: "Consistent", text: "5 landings in a row rated normal or better.", earned: stats.bestStreak >= 5 },
    { id: "streak20", title: "Line pilot", text: "20 landings in a row rated normal or better.", earned: stats.bestStreak >= 20 },
    { id: "xwind", title: "Crosswind", text: "Normal or better with 15 kt or more of crosswind.", earned: crosswindGood },
    { id: "stable", title: "By the book", text: "5 approaches stable at both 1,000 and 500 ft.", earned: stable >= 5 },
    { id: "airports", title: "Globetrotter", text: "Flown in or out of 10 airports.", earned: airports >= 10 },
    { id: "longhaul", title: "Long haul", text: "A flight of 8 hours or more.", earned: longest >= 8 * 3_600_000 },
  ];
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: Array<Record<string, unknown>>): string => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
};

export function landingsCsv(ls: LandingSummary[]): string {
  return toCsv(
    ls.map((l) => ({
      date_utc: new Date(l.ts).toISOString(),
      aircraft: l.aircraftTitle,
      rating: l.rating,
      vs_fpm: l.vsFpm,
      g: l.gPeak,
      ias_kt: Math.round(l.iasKt),
      pitch_deg: l.pitch,
      bank_deg: l.bank,
      bounces: l.bounces,
      touch_and_go: l.touchAndGo,
      wind_kt: l.wind?.speedKt ?? "",
      crosswind_kt: l.wind?.crosswindKt ?? "",
      stable_1000: l.approach?.find((g) => g.heightFt === 1000)?.stable ?? "",
      stable_500: l.approach?.find((g) => g.heightFt === 500)?.stable ?? "",
      lat: l.lat,
      lon: l.lon,
    })),
  );
}

export function flightsCsv(fs: SavedFlight[]): string {
  return toCsv(
    fs.map((f) => ({
      start_utc: new Date(f.startedAt).toISOString(),
      end_utc: new Date(f.endedAt).toISOString(),
      minutes: Math.round((f.endedAt - f.startedAt) / 60_000),
      from: f.from?.icao ?? f.planDep ?? "",
      to: f.to?.icao ?? f.planArr ?? "",
      callsign: f.planCallsign ?? "",
      aircraft: f.aircraft,
      distance_nm: f.distanceNm ?? "",
      max_alt_ft: Math.round(f.maxAltFt),
      landings: f.landings,
    })),
  );
}

/** Hands a file to the user: the share sheet where there is one (phones), a download otherwise. */
export async function saveFile(name: string, type: string, data: BlobPart): Promise<void> {
  const blob = new Blob([data], { type });
  const file = typeof File !== "undefined" ? new File([blob], name, { type }) : null;
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (file && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
