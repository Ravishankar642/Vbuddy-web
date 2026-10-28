import { useEffect, useMemo, useRef, useState } from "react";
import { isTaxiClearance, metresBetween, parseTaxiClearance, planTaxi, taxiProgress, type GroundChart, type TaxiFrom, type TaxiTo } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { ground, useGround } from "../lib/ground";
import { useBridgeActions } from "../lib/useBridge";
import { mapBus } from "../lib/mapbus";

/** Taxi speed used for the time estimate. */
const TAXI_MPS = 15 * 0.514;
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const fmtMin = (m: number) => {
  const min = Math.max(1, Math.round(m / TAXI_MPS / 60));
  return `${min} min`;
};
/** Within this distance of the airport, your aircraft is the starting point. */
const AT_AIRPORT_M = 6000;

function useClearances(b: BridgeSnapshot) {
  // Taxi clearances heard in the last 30 minutes (radio text, ATC voice transcripts, SayIntentions / BeyondATC).
  return useMemo(() => {
    const since = Date.now() - 30 * 60_000;
    return b.chat.filter((m) => m.dir === "in" && m.ts >= since && isTaxiClearance(m.text)).slice(-3).reverse();
  }, [b.chat]);
}

function nearAirport(c: GroundChart, lat: number, lon: number) {
  return metresBetween(c.lat, c.lon, lat, lon) < AT_AIRPORT_M;
}

/** VBuddy Ground: the airport's layout from the simulator, a taxi route, and turn-by-turn guidance along it. */
export function GroundView({ b }: { b: BridgeSnapshot }) {
  const g = useGround();
  const { taxiCommand } = useBridgeActions();
  /** Paired devices (and this PC) have the bridge follow the route and guide them; others see a preview only. */
  const guided = !!b.control?.allowed && b.link === "open";
  const t = b.latest?.data ?? null;
  const [icao, setIcao] = useState(g.icao ?? "");
  const [destKind, setDestKind] = useState<"runway" | "parking">("runway");
  const [runway, setRunway] = useState("");
  const [stand, setStand] = useState(-1);
  const [fromStand, setFromStand] = useState(-1);
  const [via, setVia] = useState("");
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const clearances = useClearances(b);
  const chart = g.chart;

  // First visit: the airport you're at (on the ground), else your destination, else the nearest one.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || g.chart || g.loading || b.link !== "open") return;
    // Wait until there is something to go on: your position or the flight plan.
    if (!t && !b.plan) return;
    asked.current = true;
    void (async () => {
      let code = "";
      if (t && t.onGround) code = (await ground.nearest(t.lat, t.lon))?.icao ?? "";
      if (!code && b.plan) code = b.sim?.flight?.takeoffAt ? b.plan.arr : b.plan.dep;
      if (!code && t) code = (await ground.nearest(t.lat, t.lon))?.icao ?? "";
      if (code) {
        setIcao(code);
        void ground.load(code);
      } else asked.current = false;
    })();
  }, [b.link, !!t, !!b.plan]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new chart: pick sensible defaults (after landing, a stand; before, a runway).
  useEffect(() => {
    if (!chart) return;
    setIcao(chart.icao);
    setRunway((r) => (r && chart.runways.some((x) => x.ends.some((e) => e.id === r)) ? r : (chart.runways[0]?.ends[0].id ?? "")));
    setStand(-1);
    setFromStand(-1);
    if (b.sim?.flight?.takeoffAt && t?.onGround) setDestKind("parking");
  }, [chart]); // eslint-disable-line react-hooks/exhaustive-deps

  const ends = chart ? chart.runways.flatMap((r) => r.ends.map((e) => e.id)) : [];
  const stands = useMemo(() => (chart ? chart.parking.map((p, i) => ({ i, name: p.name, kind: p.kind })).sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true })) : []), [chart]);
  const atAirport = !!(chart && t && nearAirport(chart, t.lat, t.lon));

  const plan = (over?: { to?: TaxiTo; via?: string[]; fromHere?: boolean }) => {
    setErr(null);
    if (!chart) return;
    const from: TaxiFrom | null = over?.fromHere && t ? { kind: "position", lat: t.lat, lon: t.lon, hdg: t.hdgTrue } : fromStand >= 0 ? { kind: "parking", index: fromStand } : atAirport && t ? { kind: "position", lat: t.lat, lon: t.lon, hdg: t.hdgTrue } : null;
    if (!from) {
      setErr("You're not at this airport: pick the stand to start from.");
      return;
    }
    const to: TaxiTo | null = over?.to ?? (destKind === "runway" ? (runway ? { kind: "runway", runway } : null) : stand >= 0 ? { kind: "parking", index: stand } : null);
    if (!to) {
      setErr(destKind === "runway" ? "Pick a runway." : "Pick a stand.");
      return;
    }
    const viaList = over?.via ?? via.split(/[\s,]+/).filter(Boolean);
    if (guided) {
      // The bridge plans it from where the aircraft is (or the stand) and guides you along it on every device.
      void taxiCommand({ op: "plan", icao: chart.icao, to, via: viaList.slice(0, 20).map((v) => v.slice(0, 8)), ...(from.kind === "parking" ? { fromStand: from.index } : {}) }).then((r) => {
        if (!r.ok) setErr(r.error);
        else mapBus.lowerSheet();
      });
      return;
    }
    const r = planTaxi(chart, from, to, viaList);
    if (!r.ok) {
      setErr(r.error);
      ground.setPlan(null);
      return;
    }
    ground.setPlan(r);
    ground.fit();
    mapBus.lowerSheet();
  };
  const clearRoute = () => {
    if (b.taxi && guided) void taxiCommand({ op: "clear" });
    else ground.setPlan(null);
  };

  /** Fill the form from a clearance (spoken or typed) and plan it. */
  const applyClearance = (text: string) => {
    if (!chart) return;
    const c = parseTaxiClearance(text);
    const v = c.via;
    setVia(v.join(" "));
    let to: TaxiTo | undefined;
    if (c.runway && ends.includes(c.runway)) {
      setDestKind("runway");
      setRunway(c.runway);
      to = { kind: "runway", runway: c.runway };
    } else if (c.stand) {
      const i = chart.parking.findIndex((p) => p.name.replace(/\s/g, "").toUpperCase() === c.stand);
      if (i >= 0) {
        setDestKind("parking");
        setStand(i);
        to = { kind: "parking", index: i };
      }
    }
    if (!to && !c.runway && !c.stand) {
      setErr("That doesn't name a runway or a stand.");
      return;
    }
    if (!to) {
      setErr(`${c.runway ? `Runway ${c.runway}` : `Stand ${c.stand}`} isn't in ${chart.icao}'s layout.`);
      return;
    }
    plan({ to, via: v });
  };

  const route = b.taxi?.plan ?? g.plan;
  const prog = b.taxi?.progress ?? (g.plan && t ? taxiProgress(g.plan, t.lat, t.lon) : null);
  // Only on the ground and still at the airport: airborne, or kilometres away, the route simply doesn't apply.
  const offRoute = !!(prog && t?.onGround && prog.offRouteM > 40 && prog.offRouteM < 3000);
  const tracking = !!(prog && t?.onGround && !offRoute);

  return (
    <div className="gnd">
      <form
        className="card gnd__apt"
        onSubmit={(e) => {
          e.preventDefault();
          void ground.load(icao);
        }}
      >
        <label className="gnd__icao">
          <span>Airport</span>
          <input value={icao} onChange={(e) => setIcao(e.target.value.toUpperCase())} maxLength={4} placeholder="ICAO" autoCapitalize="characters" aria-label="Airport ICAO code" />
        </label>
        <button type="submit" className="btn btn--primary" disabled={!icao || g.loading}>
          {g.loading ? "Loading…" : "Show"}
        </button>
        {t && (
          <button
            type="button"
            className="btn"
            onClick={() =>
              void ground.nearest(t.lat, t.lon).then((a) => {
                if (!a) return setErr("No airport near your aircraft.");
                setIcao(a.icao);
                void ground.load(a.icao);
              })
            }
          >
            Nearest
          </button>
        )}
        {chart && (
          <button type="button" className={`btn btn--ghost${g.show ? " is-on" : ""}`} aria-pressed={g.show} onClick={() => ground.setShow(!g.show)}>
            {g.show ? "On map" : "Hidden"}
          </button>
        )}
        {chart && (
          <p className="muted gnd__meta">
            <b>{chart.icao}</b> {chart.name} · {chart.runways.length} runway{chart.runways.length === 1 ? "" : "s"} · {chart.parking.length} stands · {new Set(chart.names.filter(Boolean)).size} taxiways
            {chart.source === "mock" ? " · test layout" : " · from your simulator's scenery"}
            {" · "}
            <button type="button" className="linkish" onClick={() => void ground.load(chart.icao, true)}>
              reload
            </button>
          </p>
        )}
        {g.error && (
          <p className="setval__err" role="alert">
            {g.error}
          </p>
        )}
      </form>

      {tracking && prog?.next && (
        <section className="card gnd__guide" aria-live="polite">
          <div className={`gnd__arrow gnd__arrow--${prog.next.what === "turn" ? prog.next.turn : prog.next.what}`} aria-hidden="true">
            {prog.next.what === "turn" ? (prog.next.turn === "left" ? "↰" : prog.next.turn === "right" ? "↱" : "↑") : prog.next.what === "arrive" ? "■" : "⛔"}
          </div>
          <div>
            <b className="gnd__next">
              {prog.next.what === "turn"
                ? `${prog.next.turn === "ahead" ? "Continue onto" : `Turn ${prog.next.turn} onto`} ${prog.next.name}`
                : prog.next.what === "cross"
                  ? `Hold short of runway ${prog.next.name}`
                  : prog.next.what === "hold"
                    ? `Hold short: ${route?.destination}`
                    : `Arriving at ${route?.destination}`}
            </b>
            <span className="gnd__in">in {fmtDist(prog.next.inM)}</span>
            <small className="muted">
              {fmtDist(prog.remainingM)} to go{prog.next.what === "cross" ? " · cross only when cleared" : ""}
            </small>
          </div>
        </section>
      )}
      {offRoute && route && (
        <section className="card gnd__off" role="alert">
          <b>Off the planned route</b> ({fmtDist(prog!.offRouteM)} away).
          <button type="button" className="btn" onClick={() => plan({ fromHere: true })}>
            Re-plan from here
          </button>
        </section>
      )}

      {chart && (
        <section className="card">
          <h2 className="card__title">Taxi route</h2>
          {clearances.length > 0 && (
            <div className="gnd__atc">
              {clearances.map((m) => (
                <div key={m.id} className="gnd__clr">
                  <span>
                    <small className="muted">{m.from} said</small>
                    <q>{m.text}</q>
                  </span>
                  <button type="button" className="btn btn--primary" onClick={() => applyClearance(m.text)}>
                    Use
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="gnd__form">
            {!atAirport && (
              <label>
                <span>From stand</span>
                <select value={fromStand} onChange={(e) => setFromStand(Number(e.target.value))}>
                  <option value={-1}>—</option>
                  {stands.map((s) => (
                    <option key={s.i} value={s.i}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="seg gnd__to" role="group" aria-label="Taxi to">
              <button type="button" aria-pressed={destKind === "runway"} onClick={() => setDestKind("runway")}>
                Runway
              </button>
              <button type="button" aria-pressed={destKind === "parking"} onClick={() => setDestKind("parking")}>
                Stand
              </button>
            </div>
            {destKind === "runway" ? (
              <label>
                <span>Runway</span>
                <select value={runway} onChange={(e) => setRunway(e.target.value)}>
                  {ends.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                <span>Stand</span>
                <select value={stand} onChange={(e) => setStand(Number(e.target.value))}>
                  <option value={-1}>—</option>
                  {stands.map((s) => (
                    <option key={s.i} value={s.i}>
                      {s.name}
                      {s.kind !== "gate" ? ` (${s.kind})` : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="gnd__via">
              <span>Via (optional)</span>
              <input value={via} onChange={(e) => setVia(e.target.value.toUpperCase())} placeholder="B C1 A" autoCapitalize="characters" aria-label="Taxiways to follow, in order" />
            </label>
            <button type="button" className="btn btn--primary" onClick={() => plan()}>
              Plan route
            </button>
          </div>
          <details className="gnd__paste">
            <summary>Paste a taxi clearance</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                applyClearance(paste);
              }}
            >
              <textarea rows={2} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Taxi to holding point runway 27 via Bravo, Charlie one, Alpha" />
              <button type="submit" className="btn" disabled={!paste.trim()}>
                Read it
              </button>
            </form>
          </details>
          {err && (
            <p className="setval__err" role="alert">
              {err}
            </p>
          )}
          {route && (
            <div className="gnd__plan">
              {b.taxi?.source === "atc" && <p className="gnd__from">From {b.taxi.from ?? "ATC"}'s clearance</p>}
              <p className="gnd__text">{route.text}</p>
              <p className="muted">
                {fmtDist(route.distanceM)} · about {fmtMin(route.distanceM)} at 15 kt
                {route.crossings.length > 0 && <> · {route.crossings.length} runway crossing{route.crossings.length > 1 ? "s" : ""}</>}
                {b.taxi ? " · VBuddy guides you along it" : guided ? "" : " · pair this device to be guided along it"}
              </p>
              {route.unmatched.length > 0 && <p className="setval__err">Not found in the layout: {route.unmatched.join(", ")}. The route takes the nearest way instead.</p>}
              <div className="chips">
                <button type="button" className="btn" onClick={() => ground.fit()}>
                  Show on map
                </button>
                <button type="button" className="btn btn--ghost" onClick={clearRoute}>
                  Clear
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      {!chart && !g.loading && !g.error && <p className="muted">Shows the airport's taxiways, runways and stands from your simulator's scenery, plans a taxi route (or reads ATC's taxi clearance) and guides you along it.</p>}
    </div>
  );
}
