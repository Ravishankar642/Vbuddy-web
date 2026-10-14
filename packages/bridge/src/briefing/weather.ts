/** Fetch signature we need; tests pass a fake. */
export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export const WEATHER_HOST = "https://aviationweather.gov";

/** Current METAR and TAF text for the airports, from the US Aviation Weather Center (free, no key). */
export async function fetchWeather(fetcher: Fetcher, icaos: string[]): Promise<{ metar: Map<string, string>; taf: Map<string, string> }> {
  const ids = icaos.join(",");
  const get = async (path: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetcher(`${WEATHER_HOST}/api/data/${path}?ids=${ids}&format=raw`, { signal: ctl.signal, headers: { "user-agent": "VBuddy" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } finally {
      clearTimeout(timer);
    }
  };
  const [metarLines, tafLines] = await Promise.all([get("metar"), get("taf").catch(() => [] as string[])]);
  const metar = new Map<string, string>();
  for (const l of metarLines) {
    const m = /^(?:METAR |SPECI )?([A-Z][A-Z0-9]{3}) /.exec(l);
    if (m && !metar.has(m[1]!)) metar.set(m[1]!, l);
  }
  // A TAF can wrap over several lines: join continuation lines (those that don't start with a report header).
  const taf = new Map<string, string>();
  let cur: string | null = null;
  for (const l of tafLines) {
    const m = /^(?:TAF (?:AMD |COR )?)?([A-Z][A-Z0-9]{3}) \d{6}Z/.exec(l);
    if (m) {
      cur = m[1]!;
      if (!taf.has(cur)) taf.set(cur, l);
      else cur = null;
    } else if (cur) {
      taf.set(cur, taf.get(cur) + "\n" + l);
    }
  }
  return { metar, taf };
}
