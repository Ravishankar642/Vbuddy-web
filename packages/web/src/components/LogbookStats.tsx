import { useMemo, useState } from "react";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { useSavedFlights, type SavedFlight } from "../lib/flights";
import { achievements, flightsCsv, landingsCsv, landingStats, RATING_ORDER, saveFile } from "../lib/logbook-stats";
import { int } from "../lib/format";

const TONE: Record<string, string> = { butter: "var(--good)", smooth: "var(--good)", normal: "var(--good)", firm: "var(--warning)", hard: "var(--serious)", severe: "var(--critical)" };

/** Logbook → Overview: landing statistics, badges and exports, all worked out on this device. */
export function LogbookStats({ b }: { b: BridgeSnapshot }) {
  const flightsRaw = useSavedFlights(b.link, b.landings.length);
  const flights: SavedFlight[] = Array.isArray(flightsRaw) ? flightsRaw : [];
  const s = useMemo(() => landingStats(b.landings), [b.landings]);
  const badges = useMemo(() => achievements(b.landings, flights, s), [b.landings, flights, s]);
  const [busy, setBusy] = useState(false);
  if (!s.count) return null;
  const trend = s.recentFpm !== null && s.previousFpm !== null ? s.recentFpm - s.previousFpm : null;
  const max = Math.max(1, ...RATING_ORDER.map((r) => s.byRating[r]));
  const exp = async (kind: "landings" | "flights" | "json") => {
    setBusy(true);
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (kind === "landings") await saveFile(`vbuddy-landings-${day}.csv`, "text/csv", landingsCsv(b.landings));
      else if (kind === "flights") await saveFile(`vbuddy-flights-${day}.csv`, "text/csv", flightsCsv(flights));
      else await saveFile(`vbuddy-logbook-${day}.json`, "application/json", JSON.stringify({ exportedAt: new Date().toISOString(), landings: b.landings, flights }, null, 1));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="card">
        <h2 className="card__title">Landing record</h2>
        <dl className="ms__stats ms__stats--6">
          <div>
            <dd>{s.avgFpm !== null ? int(s.avgFpm) : "–"}</dd>
            <dt>Average fpm</dt>
          </div>
          <div>
            <dd>{s.softest ? int(Math.abs(s.softest.vsFpm)) : "–"}</dd>
            <dt>Softest fpm</dt>
          </div>
          <div>
            <dd>{s.streak}</dd>
            <dt>Current run</dt>
          </div>
          <div>
            <dd>{s.bestStreak}</dd>
            <dt>Best run</dt>
          </div>
          <div>
            <dd>{trend === null ? "–" : `${trend <= 0 ? "−" : "+"}${int(Math.abs(trend))}`}</dd>
            <dt>Last 10 vs before</dt>
          </div>
          <div>
            <dd>{s.count}</dd>
            <dt>Landings</dt>
          </div>
        </dl>
        <p className="muted lb__note">
          A run counts landings in a row rated normal or better.{" "}
          {trend !== null && (trend < -10 ? "Your last 10 landings were softer than the 10 before." : trend > 10 ? "Your last 10 landings were firmer than the 10 before." : "Your last 10 landings were about the same as the 10 before.")}
        </p>
        <div className="lb__bars" role="img" aria-label="Landings by rating">
          {RATING_ORDER.map((r) => (
            <div key={r} className="lb__bar">
              <span className="lb__label">{r}</span>
              <i className="lb__fill" style={{ width: `${(s.byRating[r] / max) * 100}%`, background: TONE[r] }} />
              <b>{s.byRating[r]}</b>
            </div>
          ))}
        </div>
      </section>
      {s.byAircraft.length > 1 && (
        <section className="card">
          <h2 className="card__title">By aircraft</h2>
          <dl className="sv__list">
            {s.byAircraft.slice(0, 8).map((a) => (
              <div className="sv__row" key={a.name}>
                <dt>{a.name}</dt>
                <dd>
                  {a.count} · {int(a.avgFpm)} fpm avg
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <section className="card">
        <h2 className="card__title">Badges</h2>
        <ul className="lb__badges">
          {badges.map((a) => (
            <li key={a.id} className={a.earned ? "is-earned" : ""} title={a.text}>
              <b>{a.title}</b>
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2 className="card__title">Export</h2>
        <div className="lb__exports">
          <button type="button" className="btn" disabled={busy} onClick={() => void exp("landings")}>
            Landings (CSV)
          </button>
          <button type="button" className="btn" disabled={busy || !flights.length} onClick={() => void exp("flights")}>
            Flights (CSV)
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void exp("json")}>
            Everything (JSON)
          </button>
        </div>
      </section>
    </>
  );
}

/** The last 20 landings as bars (oldest on the left), coloured by rating, and how the last 10 compare with the 10 before. */
export function LandingTrend({ b }: { b: BridgeSnapshot }) {
  const ls = b.landings.filter((l) => !l.touchAndGo).slice(0, 20).reverse();
  const s = useMemo(() => landingStats(b.landings), [b.landings]);
  if (ls.length < 3) return null;
  const max = Math.max(300, ...ls.map((l) => Math.abs(l.vsFpm)));
  const W = 330;
  const H = 90;
  const bw = W / 20 - 4;
  const trend = s.recentFpm !== null && s.previousFpm !== null ? s.recentFpm - s.previousFpm : null;
  return (
    <section className="card lb__trend" aria-label={`Last ${ls.length} landings`}>
      <div className="lb__trendHead">
        <h2 className="card__title">Last {ls.length} landings</h2>
        {trend !== null && Math.abs(trend) >= 10 && <span className={trend < 0 ? "is-ok" : "is-warn"}>{int(Math.abs(trend))} fpm {trend < 0 ? "softer" : "firmer"}</span>}
        {s.avgFpm !== null && <span>avg {int(s.avgFpm)} fpm</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sink rate of each landing, oldest first">
        {ls.map((l, i) => {
          const h = Math.max(3, (Math.abs(l.vsFpm) / max) * (H - 4));
          return <rect key={l.id} x={i * (W / 20) + 2} y={H - h} width={bw} height={h} rx="3" style={{ fill: TONE[l.rating] }} />;
        })}
      </svg>
    </section>
  );
}

