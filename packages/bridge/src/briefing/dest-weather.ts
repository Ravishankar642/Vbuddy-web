import { randomUUID } from "node:crypto";
import type { DecodedMetar, FlightAlert, FlightCategory } from "@vbuddy/protocol";
import { parseMetar } from "./metar.js";
import { fetchWeather, type Fetcher } from "./weather.js";

/** One METAR request every 10 minutes while airborne: nothing for the PC to notice. */
const EVERY_MS = 10 * 60_000;
const RANK: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
const GUSTY_KT = 25;

/** What changed between two reports worth telling the pilot, or null. */
export function weatherChange(icao: string, was: DecodedMetar, now: DecodedMetar): string | null {
  const parts: string[] = [];
  if (was.category && now.category && RANK[now.category] > RANK[was.category]) {
    const vis = now.visM !== null ? (now.visM >= 9999 ? "10 km+" : `${now.visM} m`) : null;
    const ceil = now.ceilingFt !== null ? `ceiling ${now.ceilingFt} ft` : null;
    parts.push(`now ${now.category} (was ${was.category})${[vis && `vis ${vis}`, ceil].filter(Boolean).length ? ": " + [vis && `vis ${vis}`, ceil].filter(Boolean).join(", ") : ""}`);
  }
  if ((now.gustKt ?? 0) >= GUSTY_KT && (was.gustKt ?? 0) < GUSTY_KT) parts.push(`gusting ${now.gustKt} kt`);
  if (now.weather.some((w) => /TS/.test(w)) && !was.weather.some((w) => /TS/.test(w))) parts.push("thunderstorms reported");
  return parts.length ? `${icao} ${parts.join("; ")}.` : null;
}

/**
 * Watches the destination's weather during the flight and alerts when it gets worse (flight category down, strong
 * gusts, thunderstorms). The first report of a flight is only the baseline.
 */
export class DestinationWeather {
  private icao: string | null = null;
  private last: DecodedMetar | null = null;
  private lastAt = -Infinity;
  private busy = false;

  constructor(
    private fetcher: Fetcher,
    private alert: (a: FlightAlert) => void,
  ) {}

  /** Call with each flight sample (it does nothing most of the time). */
  update(dest: string | null, airborne: boolean, now: number) {
    if (!dest || !airborne) return;
    if (dest !== this.icao) {
      this.icao = dest;
      this.last = null;
      this.lastAt = -Infinity;
    }
    if (this.busy || now - this.lastAt < EVERY_MS) return;
    this.busy = true;
    this.lastAt = now;
    void fetchWeather(this.fetcher, [dest])
      .then(({ metar }) => {
        const raw = metar.get(dest);
        if (!raw || dest !== this.icao) return;
        const m = parseMetar(raw, Date.now());
        if (this.last && m.raw !== this.last.raw) {
          const text = weatherChange(dest, this.last, m);
          if (text) this.alert({ id: randomUUID(), kind: "weather", severity: "caution", title: `Weather at ${dest} is getting worse`, text });
        }
        this.last = m;
      })
      .catch(() => {})
      .finally(() => (this.busy = false));
  }
}
