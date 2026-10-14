import { useCallback, useEffect, useState } from "react";
import type { AirportBrief, Briefing, DecodedMetar, FlightCategory } from "@vbuddy/protocol";
import { apiFetch } from "../lib/api";
import { int } from "../lib/format";

const ROLE: Record<AirportBrief["role"], string> = { origin: "Departure", destination: "Arrival", alternate: "Alternate", other: "Looked up" };
const CAT_TEXT: Record<FlightCategory, string> = { VFR: "VFR", MVFR: "Marginal VFR", IFR: "IFR", LIFR: "Low IFR" };

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + "Z";
const dur = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
const kgText = (kg: number | null, units: "kg" | "lbs") => (kg === null ? "–" : units === "lbs" ? `${int(kg / 0.45359237)} lb` : `${int(kg)} kg`);

function windText(m: DecodedMetar): string {
  if (m.windKt === null) return "Calm";
  const dir = m.windDir === "VRB" ? "Variable" : m.windDir === null ? "" : `${String(m.windDir).padStart(3, "0")}°`;
  return `${dir} ${m.windKt} kt${m.gustKt ? `, gusts ${m.gustKt}` : ""}`.trim();
}
const visText = (m: DecodedMetar) => (m.visM === null ? "–" : m.visM >= 9999 ? "10 km or more" : m.visM >= 5000 ? `${(m.visM / 1000).toFixed(1)} km` : `${int(m.visM)} m`);
const cloudsText = (m: DecodedMetar) => (m.clouds.length ? m.clouds.map((c) => `${c.cover} ${c.baseFt === null ? "" : int(c.baseFt)}${c.type ?? ""}`.trim()).join(", ") : "No significant cloud");
const qnhText = (m: DecodedMetar) => (m.qnhHpa === null ? "–" : `${m.qnhHpa} hPa / ${(m.qnhHpa / 33.8639).toFixed(2)} inHg`);

function Cat({ c }: { c: FlightCategory | null }) {
  if (!c) return null;
  return (
    <span className={`cat cat--${c.toLowerCase()}`} title={CAT_TEXT[c]}>
      {c}
    </span>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function Airport({ a, now }: { a: AirportBrief; now: number }) {
  const m = a.metar;
  const [taf, setTaf] = useState(false);
  const age = m?.observedAt ? Math.max(0, Math.round((now - m.observedAt) / 60000)) : null;
  return (
    <section className="card brief-ap">
      <div className="brief-ap__head">
        <div>
          <div className="brief-ap__role">{ROLE[a.role]}</div>
          <h2 className="brief-ap__icao">{a.icao}</h2>
          {a.name && <div className="muted">{a.name}</div>}
        </div>
        <Cat c={m?.category ?? null} />
      </div>
      <dl className="kvs">
        {a.plannedRunway && <Row k="Planned runway" v={a.plannedRunway} />}
        {a.elevationFt !== null && <Row k="Elevation" v={`${int(a.elevationFt)} ft`} />}
        {m && (
          <>
            <Row k="Wind" v={windText(m)} />
            <Row k="Visibility" v={visText(m)} />
            <Row k="Cloud" v={cloudsText(m)} />
            {m.weather.length > 0 && <Row k="Weather" v={m.weather.join(" ")} />}
            <Row k="Temp / dew point" v={m.tempC === null ? "–" : `${m.tempC}° / ${m.dewC ?? "–"}°C`} />
            <Row k="QNH" v={qnhText(m)} />
          </>
        )}
      </dl>
      {m ? (
        <>
          <p className="metar">{m.raw}</p>
          {age !== null && <p className="muted brief-age">Observed {hhmm(m.observedAt!)}, {age < 90 ? `${age} min ago` : `${Math.round(age / 60)} h ago`}</p>}
        </>
      ) : (
        <p className="muted">{a.weatherError ?? "No weather yet."}</p>
      )}
      {a.taf && (
        <>
          <button type="button" className="btn btn--ghost" aria-expanded={taf} onClick={() => setTaf(!taf)}>
            {taf ? "Hide forecast (TAF)" : "Show forecast (TAF)"}
          </button>
          {taf && <p className="metar">{a.taf}</p>}
        </>
      )}
    </section>
  );
}

export function BriefView() {
  const [data, setData] = useState<Briefing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [icao, setIcao] = useState("");
  const [lookup, setLookup] = useState("");

  const load = useCallback(
    async (refresh: boolean, extra = lookup) => {
      setBusy(true);
      try {
        const q = new URLSearchParams();
        if (refresh) q.set("refresh", "1");
        if (extra) q.set("icao", extra);
        const r = await apiFetch(`/api/briefing${q.size ? `?${q}` : ""}`);
        if (!r.ok) throw new Error(r.status === 401 ? "Pair this device first (Systems → Controls)." : `HTTP ${r.status}`);
        setData((await r.json()) as Briefing);
        setErr(null);
      } catch (e) {
        setErr(`Couldn't load the briefing (${(e as Error).message}).`);
      } finally {
        setBusy(false);
      }
    },
    [lookup],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const o = data?.ofp ?? null;
  const now = data?.fetchedAt ?? Date.now();

  return (
    <div className="brief">
      <form
        className="card brief-find"
        onSubmit={(e) => {
          e.preventDefault();
          const v = icao.trim().toUpperCase();
          if (/^[A-Z][A-Z0-9]{3}$/.test(v)) setLookup(v);
        }}
      >
        <label htmlFor="brief-icao" className="card__title">
          Look up an airport
        </label>
        <div className="brief-find__row">
          <input id="brief-icao" className="input" value={icao} onChange={(e) => setIcao(e.target.value)} maxLength={4} placeholder="ICAO, e.g. EGLL" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
          <button type="submit" className="btn btn--primary">
            Look up
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void load(true)}>
            {busy ? "Loading…" : "Refresh"}
          </button>
        </div>
      </form>

      {err && <div className="card brief-note">{err}</div>}
      {data?.error && <div className="card brief-note">{data.error}</div>}

      {o && (
        <section className="card">
          <h2 className="card__title">Flight plan{o.callsign ? ` · ${o.callsign}` : ""}</h2>
          <dl className="kvs">
            {o.aircraft && <Row k="Aircraft" v={o.aircraft} />}
            {o.departAt !== null && <Row k="Off blocks" v={hhmm(o.departAt)} />}
            {o.eteMin !== null && <Row k="Time en route" v={dur(o.eteMin)} />}
            {o.distanceNm !== null && <Row k="Distance" v={`${int(o.distanceNm)} nm`} />}
            {o.cruiseFt !== null && <Row k="Cruise" v={o.cruiseFt >= 18000 ? `FL${Math.round(o.cruiseFt / 100)}` : `${int(o.cruiseFt)} ft`} />}
            <Row k="Block fuel" v={kgText(o.blockFuelKg, o.units)} />
            <Row k="Trip fuel" v={kgText(o.tripFuelKg, o.units)} />
            <Row k="Takeoff weight" v={kgText(o.takeoffWeightKg, o.units)} />
            {o.pax !== null && <Row k="Passengers" v={String(o.pax)} />}
          </dl>
          {o.route && <p className="metar">{o.route}</p>}
        </section>
      )}

      {data?.airports.map((a) => <Airport key={a.icao} a={a} now={now} />)}
      {!data && !err && <div className="empty">Loading the briefing…</div>}
    </div>
  );
}
