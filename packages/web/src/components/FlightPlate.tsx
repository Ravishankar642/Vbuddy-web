import { useEffect, useState } from "react";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { airlineOf } from "../lib/airlines";
import { apiFetch } from "../lib/api";
import { int } from "../lib/format";

/** Public airline-logo images by IATA code, tried in order after the PC's own logos folder. */
const LOGO_SOURCES = [(iata: string) => `https://img.wway.io/pics/root/${iata}@png?exar=1&rs=fit:192:192`, (iata: string) => `https://pics.avs.io/192/192/${iata}.png`];

/** Logos found in VBuddy's data folder on the PC (logos\QTR.png), by ICAO code. null = there isn't one. */
const logos = new Map<string, string | null>();
function useLogo(icao: string | null): string | null {
  const [url, setUrl] = useState<string | null>(icao ? (logos.get(icao) ?? null) : null);
  useEffect(() => {
    if (!icao) return setUrl(null);
    if (logos.has(icao)) return setUrl(logos.get(icao) ?? null);
    let gone = false;
    void apiFetch(`/api/airline-logo/${icao}`)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        const u = b ? URL.createObjectURL(b) : null;
        logos.set(icao, u);
        if (!gone) setUrl(u);
      })
      .catch(() => logos.set(icao, null));
    return () => {
      gone = true;
    };
  }, [icao]);
  return url;
}

const hm = (min: number) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;

/**
 * Who you're flying as, and where to: the airline of your VATSIM callsign (its logo if you've put one in VBuddy's
 * logos folder, else its code in the airline's colour) and the SimBrief plan tied to this flight.
 */
export function FlightPlate({ b }: { b: BridgeSnapshot }) {
  const net = b.comms?.net;
  const callsign = net?.connected ? net.callsign : null;
  const plan = b.plan;
  const shownCallsign = callsign ?? plan?.callsign ?? null;
  const a = airlineOf(shownCallsign);
  const ownLogo = useLogo(a?.icao ?? null);
  // The PC's own logo first, then the public logo images; the airline's code in its colour if none loads.
  const sources = [...(ownLogo ? [ownLogo] : []), ...(a ? LOGO_SOURCES.map((f) => f(a.iata)) : [])];
  const [failed, setFailed] = useState<string[]>([]);
  const logo = sources.find((u) => !failed.includes(u)) ?? null;
  if (!shownCallsign && !plan) return null;
  const left = plan && b.latest && plan.fixes.length ? remainingNm(plan.fixes, b.latest.data.lat, b.latest.data.lon) : null;
  return (
    <section className="plate" aria-label="Your flight">
      <div className="plate__mark" aria-hidden={!!logo}>
        {logo ? <img src={logo} alt={a ? `${a.name} logo` : ""} referrerPolicy="no-referrer" onError={() => setFailed((f) => [...f, logo])} /> : <span>{a?.iata ?? shownCallsign?.slice(0, 3) ?? "—"}</span>}
      </div>
      <div className="plate__who">
        <b>{a?.name ?? "Your flight"}</b>
        <span>
          {shownCallsign ?? "No callsign"}
          {callsign ? <em className="plate__live">On VATSIM</em> : shownCallsign ? <em>From SimBrief</em> : null}
        </span>
      </div>
      {plan && (
        <div className={`plate__plan${plan.matched ? "" : " is-other"}`}>
          <div className="plate__route">
            <b>{plan.dep}</b>
            <i aria-hidden>→</i>
            <b>{plan.arr}</b>
          </div>
          <small>
            {[plan.aircraft, plan.cruiseFt ? `FL${Math.round(plan.cruiseFt / 100)}` : null, plan.eteMin ? hm(plan.eteMin) : null, plan.distanceNm ? `${int(plan.distanceNm)} nm` : null].filter(Boolean).join("  ·  ")}
            {left !== null && plan.matched ? `  ·  ${int(left)} nm to go` : ""}
          </small>
          {!plan.matched && <small className="plate__warn">This SimBrief plan doesn't start where this flight began.</small>}
        </div>
      )}
    </section>
  );
}

const R_NM = 3440.065;
const rad = Math.PI / 180;
const dist = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const x = Math.sin(((bLat - aLat) * rad) / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(x)));
};
/** Along the route from the nearest fix ahead to the end. */
function remainingNm(fixes: Array<{ lat: number; lon: number }>, lat: number, lon: number): number {
  let best = 0;
  let bestD = Infinity;
  fixes.forEach((f, i) => {
    const d = dist(lat, lon, f.lat, f.lon);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  // The nearest fix may be behind: count from the next one if we're past it.
  const next = Math.min(fixes.length - 1, best + (best + 1 < fixes.length && dist(lat, lon, fixes[best + 1]!.lat, fixes[best + 1]!.lon) < dist(fixes[best]!.lat, fixes[best]!.lon, fixes[best + 1]!.lat, fixes[best + 1]!.lon) ? 1 : 0));
  let n = dist(lat, lon, fixes[next]!.lat, fixes[next]!.lon);
  for (let i = next; i + 1 < fixes.length; i++) n += dist(fixes[i]!.lat, fixes[i]!.lon, fixes[i + 1]!.lat, fixes[i + 1]!.lon);
  return n;
}
