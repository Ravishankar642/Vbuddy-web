import { useEffect, useRef, useState } from "react";
import { APPROACH_LIMITS, checkGate, indicatedAlt, pathAngle, type Telemetry } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { int, signed } from "../lib/format";

/** On approach: low, descending, gear down. Left again above 2,500 ft (a go-around) or on the ground. */
function onApproach(t: Telemetry): boolean {
  return !t.onGround && t.altAgl < 2000 && t.vs < -300 && t.gearDown;
}

/** Feet per nautical mile on a 3° path. */
const FT_PER_NM = 318;

/**
 * Approach mode: a focused screen that opens by itself on final and closes when the wheels touch (the landing report
 * takes over). Big radio height and sink, where you are against a 3° path, and the stabilised-approach checks as they
 * stand right now. Worked out on this device from the data the app already gets.
 */
export function ApproachMode({ b, t }: { b: BridgeSnapshot; t: Telemetry }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const ias = useRef<Array<{ at: number; kt: number }>>([]);

  useEffect(() => {
    const now = Date.now();
    ias.current.push({ at: now, kt: t.ias });
    while (ias.current.length && now - ias.current[0]!.at > 10_000) ias.current.shift();
    if (t.onGround || t.altAgl > 2500) {
      setOpen(false);
      setDismissed(false);
    } else if (!dismissed && onApproach(t)) setOpen(true);
  }, [t, dismissed]);

  if (!open) return null;
  const g = b.progress;
  const plan = b.plan;
  const gate = checkGate(t.altAgl > 1000 ? 1000 : 500, Date.now(), { gearDown: t.gearDown, flapsIndex: t.flapsIndex, vs: t.vs, gs: t.gs, bank: t.bank, iasRecent: ias.current.map((s) => s.kt) });
  const targetSink = -t.gs * 5.31; // 3° at this ground speed
  const angle = pathAngle(t.vs, t.gs);
  // Distance to go along the plan, when it's the airport we're landing at (close in); else only the descent angle is used.
  const toGo = g && g.remainingNm < 20 && g.offRouteNm < 10 ? g.remainingNm : null;
  const ideal = toGo !== null ? toGo * FT_PER_NM : null;
  const dev = ideal !== null ? t.altAgl - ideal : null;
  const pathText = dev === null ? (angle !== null ? `${angle.toFixed(1)}°` : "–") : Math.abs(dev) < 150 ? "ON PATH" : dev > 0 ? `${int(dev)} FT HIGH` : `${int(-dev)} FT LOW`;
  const pathOk = dev === null ? angle !== null && angle >= APPROACH_LIMITS.pathMinDeg && angle <= APPROACH_LIMITS.pathMaxDeg : Math.abs(dev) < 300;

  // Side view: 0..6 nm from the runway, 0..2,000 ft.
  const W = 358;
  const H = 120;
  const maxNm = 6;
  const X = (nm: number) => W - 54 - (Math.min(maxNm, Math.max(0, nm)) / maxNm) * (W - 70);
  const Y = (ft: number) => H - 16 - (Math.min(2000, Math.max(0, ft)) / 2000) * (H - 26);
  const meX = X(toGo ?? (t.altAgl / FT_PER_NM));
  const meY = Y(t.altAgl);

  return (
    <div className="apm" role="dialog" aria-label="Approach mode">
      <div className="apm__head">
        <div>
          <small>FINAL APPROACH</small>
          <b>{plan?.arr ?? "Approach"}</b>
        </div>
        <button type="button" className="apm__close" aria-label="Close approach mode" onClick={() => (setDismissed(true), setOpen(false))}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="apm__big">
        <div>
          <small>RADIO HEIGHT</small>
          <b>{int(t.altAgl)}</b>
          <span>ft{toGo !== null ? ` · ${toGo.toFixed(1)} nm to go` : ""}</span>
        </div>
        <div>
          <small>SINK RATE</small>
          <b className={-t.vs > APPROACH_LIMITS.sinkFpm ? "is-bad" : "is-ok"}>{signed(t.vs)}</b>
          <span>fpm · 3° is {int(targetSink)}</span>
        </div>
      </div>

      <section className="apm__card" aria-label="Descent path">
        <div className="apm__row">
          <small>DESCENT PATH</small>
          <small className={pathOk ? "is-ok" : "is-bad"}>
            {angle !== null ? `${angle.toFixed(1)}° · ` : ""}
            {pathText}
          </small>
        </div>
        <svg className="apm__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Side view: ${pathText}`}>
          <line x1="0" y1={Y(0)} x2={W} y2={Y(0)} className="apm__ground" />
          <rect x={W - 54} y={Y(0) - 4} width="50" height="8" rx="2" className="apm__rwy" />
          <path d={`M${X(maxNm)} ${Y(maxNm * FT_PER_NM)} L ${X(0)} ${Y(0)}`} className="apm__ideal" />
          <circle cx={meX} cy={meY} r="7" className={pathOk ? "apm__me" : "apm__me is-bad"} />
        </svg>
      </section>

      <section className="apm__card" aria-label="Stabilised approach">
        <div className="apm__row">
          <small>{t.altAgl > 1000 ? "BEFORE THE 1,000 FT GATE" : "BEFORE THE 500 FT GATE"}</small>
          <span className={gate.stable ? "apm__tag is-ok" : "apm__tag is-bad"}>{gate.stable ? "STABLE" : "NOT STABLE"}</span>
        </div>
        <div className="apm__checks">
          {gate.checks.map((c) => (
            <div key={c.key} className={c.ok ? "" : "is-bad"}>
              <small>{c.label}</small>
              <b>{c.value}</b>
            </div>
          ))}
        </div>
      </section>

      <div className="apm__small">
        <div>
          <small>IAS</small>
          <b>{int(t.ias)}</b>
        </div>
        <div>
          <small>GS</small>
          <b>{int(t.gs)}</b>
        </div>
        <div>
          <small>ALT</small>
          <b>{int(indicatedAlt(t))}</b>
        </div>
      </div>
    </div>
  );
}
