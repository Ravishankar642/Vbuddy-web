import { useEffect, useState } from "react";
import { apiFetch } from "./api";

/** One saved flight, as the bridge's flight log reports it. */
export interface SavedFlight {
  id: number;
  startedAt: number;
  endedAt: number;
  aircraft: string;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
  maxAltFt: number;
  maxGsKt: number;
  landings: number;
  /** The airports the flight left from and arrived at, when the position matches one. */
  from?: { icao: string; name: string } | null;
  to?: { icao: string; name: string } | null;
  distanceNm?: number;
  /** Flown on the route of the SimBrief plan filled in for it: only these are logged in the Atlas. */
  onPlan?: boolean;
}

export interface AtlasAirport {
  icao: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  visits: number;
}
export interface AtlasData {
  flights: number;
  flightMs: number;
  distanceNm: number;
  landings: number;
  airports: AtlasAirport[];
  countries: string[];
  aircraft: Array<{ name: string; flights: number; ms: number }>;
  longest: { id: number; ms: number } | null;
  farthest: { id: number; nm: number } | null;
}

function useJson<T>(path: string, link: string, refreshKey: unknown): T | "off" | null {
  const [data, setData] = useState<T | "off" | null>(null);
  useEffect(() => {
    if (link !== "open") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(path);
        if (cancelled) return;
        setData(res.ok ? ((await res.json()) as T) : "off");
      } catch {
        if (!cancelled) setData("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [link, path, refreshKey]);
  return data;
}

/** The saved flights (newest first), or null while loading, or "off" when the bridge keeps no flight log. */
export function useSavedFlights(link: string, refreshKey?: unknown): SavedFlight[] | "off" | null {
  return useJson<SavedFlight[]>("/api/flights?limit=200", link, refreshKey);
}

/** Totals for the Atlas page. */
export function useAtlas(link: string, refreshKey?: unknown): AtlasData | "off" | null {
  return useJson<AtlasData>("/api/atlas", link, refreshKey);
}

/** A saved flight's path as [lat, lon] pairs, or null if it can't be loaded. */
export async function loadRoute(id: number): Promise<Array<[number, number]> | null> {
  try {
    const res = await apiFetch(`/api/flights/${id}/track?max=1500`);
    if (!res.ok) return null;
    const body = (await res.json()) as { points: number[][] };
    return body.points.filter((p) => Number.isFinite(p[1]) && Number.isFinite(p[2])).map((p) => [p[1]!, p[2]!] as [number, number]);
  } catch {
    return null;
  }
}

export const duration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
