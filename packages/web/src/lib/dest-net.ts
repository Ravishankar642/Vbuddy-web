import { useEffect, useState } from "react";
import type { AtisInfo } from "@vbuddy/protocol";
import { apiFetch } from "./api";

export interface DestAtis extends AtisInfo {
  callsign: string;
  freq: string;
  text: string[];
}
export interface NetEvent {
  name: string;
  link: string | null;
  start: number;
  end: number;
  airports: string[];
}

/** The destination's ATIS (every minute) and VATSIM events at the plan's airports (every 30 minutes), from the bridge. */
export function useDestNet(link: string, dep: string | null, arr: string | null): { atis: DestAtis | null; events: NetEvent[] } {
  const [atis, setAtis] = useState<DestAtis | null>(null);
  const [events, setEvents] = useState<NetEvent[]>([]);
  useEffect(() => {
    setAtis(null);
    if (link !== "open" || !arr) return;
    let stop = false;
    const load = async () => {
      try {
        const j = (await (await apiFetch(`/api/network/atis?icao=${arr}`)).json()) as { atis?: DestAtis | null };
        if (!stop) setAtis(j.atis ?? null);
      } catch {
        /* keep the last one */
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [link, arr]);
  useEffect(() => {
    setEvents([]);
    const ids = [dep, arr].filter(Boolean).join(",");
    if (link !== "open" || !ids) return;
    let stop = false;
    const load = async () => {
      try {
        const j = (await (await apiFetch(`/api/network/events?icaos=${ids}`)).json()) as { events?: NetEvent[] };
        if (!stop) setEvents(j.events ?? []);
      } catch {
        /* none for now */
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 30 * 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [link, dep, arr]);
  return { atis, events };
}
