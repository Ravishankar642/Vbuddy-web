import { useSyncExternalStore } from "react";
import type { GroundChart, TaxiGuide, TaxiPlan } from "@vbuddy/protocol";
import { apiFetch } from "./api";

/**
 * VBuddy Ground on this device: the airport chart being looked at, and the taxi route planned through it. Kept
 * outside React so the map (loaded separately) and the Ground page share it, and it survives tab switches.
 */
export interface GroundState {
  icao: string | null;
  chart: GroundChart | null;
  loading: boolean;
  error: string | null;
  plan: TaxiPlan | null;
  /** Draw the chart on the map. */
  show: boolean;
  /** Bumped when the map should fit the airport (a new chart, or "show on map"). */
  fitSeq: number;
}

/** The bridge's route last followed (its setAt), so the map fits a new one once. */
let followedAt = 0;

let st: GroundState = { icao: null, chart: null, loading: false, error: null, plan: null, show: true, fitSeq: 0 };
const subs = new Set<() => void>();
const set = (patch: Partial<GroundState>) => {
  st = { ...st, ...patch };
  for (const s of subs) s();
};

export const ground = {
  get: () => st,
  subscribe(cb: () => void) {
    subs.add(cb);
    return () => subs.delete(cb);
  },
  async load(icao: string, refresh = false) {
    const code = icao.trim().toUpperCase();
    if (!code) return;
    if (!refresh && st.chart?.icao === code) {
      set({ show: true, fitSeq: st.fitSeq + 1 });
      return;
    }
    set({ icao: code, loading: true, error: null, ...(st.chart?.icao === code ? {} : { plan: null }) });
    try {
      const r = await apiFetch(`/api/ground/${encodeURIComponent(code)}${refresh ? "?refresh=1" : ""}`);
      const j = (await r.json().catch(() => ({}))) as { chart?: GroundChart | null; error?: string };
      if (st.icao !== code) return;
      if (j.chart) set({ chart: j.chart, loading: false, error: null, show: true, fitSeq: st.fitSeq + 1 });
      else set({ loading: false, error: j.error ?? (r.status === 401 ? "Pair this device first." : "No layout for that airport.") });
    } catch {
      if (st.icao === code) set({ loading: false, error: "Couldn't reach the PC." });
    }
  },
  async nearest(lat: number, lon: number): Promise<{ icao: string; name: string } | null> {
    try {
      const r = await apiFetch(`/api/ground/nearest?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
      const j = (await r.json()) as { airport?: { icao: string; name: string } | null };
      return j.airport ?? null;
    } catch {
      return null;
    }
  },
  /**
   * The route the bridge is following: shown on the map (its airport loaded if it isn't), and the map fits it
   * when it is new. When the bridge stops following one, it goes from the map too.
   */
  follow(g: TaxiGuide | null) {
    if (!g) {
      if (followedAt) {
        followedAt = 0;
        set({ plan: null });
      }
      return;
    }
    const isNew = g.setAt !== followedAt;
    followedAt = g.setAt;
    if (st.chart?.icao !== g.icao && st.icao !== g.icao) void ground.load(g.icao);
    // Progress updates every second carry the same route: only a new one is drawn (and fitted).
    if (isNew || !st.plan) set({ plan: g.plan, show: true, fitSeq: st.fitSeq + 1 });
  },
  setPlan(plan: TaxiPlan | null) {
    set({ plan });
  },
  setShow(show: boolean) {
    set({ show, ...(show ? { fitSeq: st.fitSeq + 1 } : {}) });
  },
  fit() {
    set({ show: true, fitSeq: st.fitSeq + 1 });
  },
};

export function useGround(): GroundState {
  return useSyncExternalStore(ground.subscribe, ground.get, ground.get);
}
