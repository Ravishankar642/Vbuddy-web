import { useEffect, useState } from "react";
import type { LandingRating, LandingSummary } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { fixed, int, signed, signed1, sinceText, when } from "../lib/format";
import { useBridgeActions, useNow } from "../lib/useBridge";
import { FlareChart } from "./FlareChart";
import { Flag, Tile } from "./ui";

const RATING: Record<LandingRating, { label: string; icon: string }> = {
  butter: { label: "Butter", icon: "★" },
  smooth: { label: "Smooth", icon: "✓" },
  normal: { label: "Normal", icon: "✓" },
  firm: { label: "Firm", icon: "!" },
  hard: { label: "Hard", icon: "▲" },
  severe: { label: "Severe", icon: "✕" },
};

/** Status colour + icon + word, so the rating never relies on colour alone. */
export function RatingBadge({ rating, small }: { rating: LandingRating; small?: boolean }) {
  const r = RATING[rating];
  return (
    <span className={`rating rating--${rating}${small ? " rating--sm" : ""}`}>
      <span className="rating__icon" aria-hidden="true">
        {r.icon}
      </span>
      {r.label}
    </span>
  );
}

const PAGE = 20;

function History({ items, selected, onSelect }: { items: LandingSummary[]; selected: string; onSelect: (id: string) => void }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <section className="card">
      <h2 className="card__title">Landing log</h2>
      <ul className="hist">
        {items.slice(0, shown).map((l) => (
          <li key={l.id}>
            <button type="button" className={`hist__row${l.id === selected ? " is-sel" : ""}`} aria-current={l.id === selected} onClick={() => onSelect(l.id)}>
              <span className="hist__main">
                <span className="hist__when">{when(l.ts)}</span>
                <span className="hist__ac">
                  {l.aircraftTitle || "Unknown aircraft"}
                  {l.source === "mock" ? " (mock)" : ""}
                  {l.touchAndGo ? " · touch-and-go" : ""}
                  {l.bounces ? ` · ${l.bounces} bounce${l.bounces > 1 ? "s" : ""}` : ""}
                </span>
              </span>
              <span className="hist__nums">
                <b>{int(l.vsFpm)}</b> fpm · <b>{fixed(l.gPeak, 2)}</b> g
              </span>
              <RatingBadge rating={l.rating} small />
            </button>
          </li>
        ))}
      </ul>
      {items.length > shown && (
        <button type="button" className="btn" onClick={() => setShown(shown + PAGE)}>
          Show more ({items.length - shown})
        </button>
      )}
    </section>
  );
}

export function LandingView({ b }: { b: BridgeSnapshot }) {
  const { requestLanding, dismissNewLanding } = useBridgeActions();
  const now = useNow(30_000);
  const [picked, setPicked] = useState<string | null>(null);

  // A fresh landing takes over the view, and its toast has done its job.
  useEffect(() => {
    if (b.newLanding) {
      setPicked(b.newLanding.id);
      dismissNewLanding();
    }
  }, [b.newLanding, dismissNewLanding]);

  const sel = b.landings.find((l) => l.id === picked) ?? b.landings[0];
  const full = sel ? b.details[sel.id] : undefined;
  useEffect(() => {
    if (sel && !full && b.link === "open") requestLanding(sel.id);
  }, [sel?.id, full, b.link, requestLanding]);

  if (!sel) {
    return (
      <div className="empty">
        <p className="empty__big">No landings yet</p>
        <p>The moment your wheels touch the runway, the touchdown rate, G load and flare trace show up here.</p>
        {b.sim?.source === "mock" && <p className="muted">Using the mock flight: the first landing comes a few minutes in. Try the bridge with --mock-quick for one every 2 minutes.</p>}
      </div>
    );
  }

  const { flare, wind } = sel;
  const gone = sel.ts > now ? 0 : now - sel.ts;

  return (
    <div className="landing">
      {b.landingsFromCache && <div className="banner">Showing the landing log saved on this device. It updates when the bridge is reachable.</div>}
      <section className="card debrief">
        <div className="debrief__head">
          <RatingBadge rating={sel.rating} />
          <span className="debrief__when">
            {sinceText(gone, sel.ts)} · {when(sel.ts)}
          </span>
        </div>
        <div className="hero" aria-label={`Touchdown at ${sel.vsFpm} feet per minute`}>
          {int(sel.vsFpm)}
          <span className="hero__unit">fpm</span>
        </div>
        <div className="debrief__ac">
          {sel.aircraftTitle || "Unknown aircraft"}
          {sel.source === "mock" ? " (mock flight)" : ""}
        </div>
        <div className="flags">
          {sel.ratedBy === "g" && <Flag on>Rated by G load</Flag>}
          {sel.touchAndGo && <Flag on>Touch-and-go</Flag>}
          {sel.bounces > 0 && <Flag on>{sel.bounces} bounce{sel.bounces > 1 ? "s" : ""}</Flag>}
          {sel.lowConfidence && <Flag on={false}>Sparse data: approximate</Flag>}
        </div>
        <p className="debrief__note">
          {sel.vsSource === "sim"
            ? "Descent rate is the simulator's own touchdown measurement."
            : "Descent rate is estimated from the last moments before contact (the simulator's own value wasn't available)."}
          {sel.vsSource === "sim" && sel.vsEstimateFpm !== null && Math.abs(sel.vsEstimateFpm - sel.vsFpm) > 60 && ` Frame data shows ${int(sel.vsEstimateFpm)} fpm.`}
        </p>
      </section>

      <div className="grid">
        <Tile label="Peak G" value={fixed(sel.gPeak, 2)} unit="g" tone={sel.gPeak > 1.6 ? "warn" : undefined} />
        <Tile label="Pitch at contact" value={`${signed1(sel.pitch)}°`} sub={`bank ${signed1(sel.bank)}°`} />
        <Tile label="Airspeed" value={int(sel.iasKt)} unit="kt" sub={`ground speed ${int(sel.gsKt)} kt`} />
        <Tile
          label="Bounces"
          value={sel.bounces}
          sub={sel.bounces ? `highest ${fixed(sel.bounceMaxFt, 1)} ft` : "clean touchdown"}
          tone={sel.bounces ? "warn" : undefined}
        />
        <Tile
          label="Crosswind"
          value={wind ? int(Math.abs(wind.crosswindKt)) : "—"}
          unit={wind ? "kt" : undefined}
          sub={
            wind
              ? `${Math.abs(wind.crosswindKt) < 0.5 ? "no crosswind" : wind.crosswindKt > 0 ? "from the right" : "from the left"} · ${
                  wind.headwindKt >= 0 ? "head" : "tail"
                }wind ${int(Math.abs(wind.headwindKt))} kt`
              : "wind not available"
          }
        />
        <Tile
          label="Heading"
          value={String(sel.hdgTrue % 360 || 360).padStart(3, "0")}
          unit="°T"
          sub={wind ? `wind ${String(wind.fromDeg).padStart(3, "0")}° at ${int(wind.speedKt)} kt` : undefined}
        />
        <section className="tile tile--wide">
          <h2 className="tile__label">Sink rate through the flare</h2>
          <dl className="kv">
            <div>
              <dt>At 50 ft</dt>
              <dd>{flare.sinkAt50 === null ? "—" : `${signed(flare.sinkAt50)} fpm`}</dd>
            </div>
            <div>
              <dt>At 30 ft</dt>
              <dd>{flare.sinkAt30 === null ? "—" : `${signed(flare.sinkAt30)} fpm`}</dd>
            </div>
            <div>
              <dt>At 10 ft</dt>
              <dd>{flare.sinkAt10 === null ? "—" : `${signed(flare.sinkAt10)} fpm`}</dd>
            </div>
            <div>
              <dt>Touchdown</dt>
              <dd>
                <b>{signed(sel.vsFpm)} fpm</b>
              </dd>
            </div>
          </dl>
          <div className="tile__sub">
            {flare.peakSinkFpm !== null && flare.easedByFpm !== null
              ? `Peak sink ${signed(flare.peakSinkFpm)} fpm at ${int(flare.peakSinkAtFt ?? 0)} ft; the flare eased it by ${int(flare.easedByFpm)} fpm.`
              : "No approach data below 100 ft."}
            {flare.pitchChange !== null && ` Pitch ${flare.pitchChange >= 0 ? "up" : "down"} ${fixed(Math.abs(flare.pitchChange), 1)}° from 50 ft.`}
          </div>
        </section>
      </div>

      {full ? (
        <FlareChart landing={full} />
      ) : (
        <section className="card">
          <p className="muted">{b.link === "open" ? "Loading the flare trace…" : "The flare trace needs a connection to the bridge."}</p>
        </section>
      )}

      <History items={b.landings} selected={sel.id} onSelect={setPicked} />
    </div>
  );
}
