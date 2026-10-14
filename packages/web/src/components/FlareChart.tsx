import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { FlareSample, Landing } from "@vbuddy/protocol";
import { fixed, int, signed, signed1 } from "../lib/format";

/**
 * Approach/flare/rollout trace for one landing: height, vertical speed and
 * pitch as three stacked single-axis panels sharing one time axis (never one
 * dual-axis plot). t = 0 is first contact. Touch or hover scrubs; arrow keys
 * work too; a table view shows the same numbers.
 */

const WINDOWS = [5, 10, 20] as const;
const ML = 46; // room for y tick labels
const MR = 12;
const PLOT_H = 84;
const TITLE_H = 18;
const GAP = 12;
const BLOCK = TITLE_H + PLOT_H + GAP;
const AXIS_H = 46;

type Key = "agl" | "vs" | "pitch";
const PANELS: Array<{ key: Key; title: string; unit: string; fmt: (v: number) => string }> = [
  { key: "agl", title: "Height above runway", unit: "ft", fmt: (v) => int(v) },
  { key: "vs", title: "Vertical speed", unit: "fpm", fmt: (v) => signed(v) },
  { key: "pitch", title: "Pitch", unit: "°", fmt: (v) => signed1(v) },
];

/** Round-number axis: returns bounds that include [lo, hi] and about `n` ticks. */
function niceScale(lo: number, hi: number, n = 3) {
  if (!(hi > lo)) {
    hi = lo + 1;
  }
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 1000; v += step) ticks.push(Math.abs(v) < step / 1000 ? 0 : v);
  return { min, max, ticks };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.floor(el.getBoundingClientRect().width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function nearest(samples: FlareSample[], t: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(samples[lo - 1]!.t - t) <= Math.abs(samples[lo]!.t - t)) return lo - 1;
  return lo;
}

export function FlareChart({ landing }: { landing: Landing }) {
  const [win, setWin] = useState<(typeof WINDOWS)[number]>(10);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [idx, setIdx] = useState<number | null>(null);
  const [boxRef, width] = useWidth<HTMLDivElement>();

  const samples = useMemo(() => landing.profile.filter((s) => s.t >= -win), [landing, win]);
  // The scrubber index refers to `samples`; drop it whenever they change.
  useEffect(() => setIdx(null), [landing.id, win]);

  const tdIndex = useMemo(() => {
    let best = 0;
    samples.forEach((s, i) => {
      if (Math.abs(s.t) < Math.abs(samples[best]!.t)) best = i;
    });
    return best;
  }, [samples]);

  const t0 = samples[0]?.t ?? -win;
  const t1 = samples[samples.length - 1]?.t ?? 0;

  const scales = useMemo(() => {
    const out = {} as Record<Key, ReturnType<typeof niceScale>>;
    for (const p of PANELS) {
      const vals = samples.map((s) => s[p.key]);
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      if (p.key === "agl") lo = Math.min(lo, 0);
      else if (p.key === "vs") hi = Math.max(hi, 0);
      else {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      out[p.key] = niceScale(lo, hi, 3);
    }
    return out;
  }, [samples]);

  if (samples.length < 2) return <p className="muted">Not enough data to draw this landing.</p>;

  const active = idx ?? tdIndex;
  const scrubbing = idx !== null;
  const cur = samples[active]!;
  // Until the reader scrubs, the readout is the record's own touchdown numbers (same as the headline),
  // not the first on-ground frame, whose vertical speed is already ~0.
  const shown = scrubbing
    ? cur
    : { ...cur, t: 0, agl: 0, vs: landing.vsFpm, pitch: landing.pitch, ias: landing.iasKt, g: landing.gPeak, onGround: true };
  const plotW = Math.max(40, width - ML - MR);
  const X = (t: number) => ML + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const Y = (key: Key, v: number, block: number) => {
    const sc = scales[key];
    return block * BLOCK + TITLE_H + PLOT_H - ((v - sc.min) / (sc.max - sc.min || 1)) * PLOT_H;
  };
  const H = PANELS.length * BLOCK + AXIS_H - GAP + 6;

  const tickStep = win <= 5 ? 1 : win <= 10 ? 2 : 5;
  const xTicks: number[] = [];
  for (let t = Math.ceil(t0 / tickStep) * tickStep; t <= t1 + 1e-6; t += tickStep) xTicks.push(Math.round(t * 100) / 100);

  const scrub = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left - ML) / plotW) * (t1 - t0);
    setIdx(nearest(samples, Math.min(t1, Math.max(t0, t))));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") setIdx(Math.max(0, active - step));
    else if (e.key === "ArrowRight") setIdx(Math.min(samples.length - 1, active + step));
    else if (e.key === "Home") setIdx(0);
    else if (e.key === "End") setIdx(samples.length - 1);
    else if (e.key === "Escape") setIdx(null);
    else return;
    e.preventDefault();
  };

  const tableRows = useMemo(() => {
    const rows: FlareSample[] = [];
    let last = -Infinity;
    for (const s of samples) {
      if (s.t - last >= 0.5 - 1e-6 || s.t === 0) {
        rows.push(s);
        last = s.t;
      }
    }
    return rows;
  }, [samples]);

  const summary =
    `Landing trace from ${Math.abs(t0).toFixed(0)} seconds before touchdown to ${t1.toFixed(0)} seconds after. ` +
    `Touchdown at ${landing.vsFpm} feet per minute.`;

  return (
    <section className="card chart">
      <div className="chart__bar">
        <h2 className="card__title">Flare trace</h2>
        <div className="seg" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button key={w} type="button" aria-pressed={win === w} onClick={() => setWin(w)}>
              {w} s
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>
            Chart
          </button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
            Table
          </button>
        </div>
      </div>

      {view === "chart" ? (
        <>
          <div className="readout" aria-live="off">
            <span className="readout__t">
              {!scrubbing ? "touchdown" : `${shown.t > 0 ? "+" : ""}${fixed(shown.t, 1)} s`}
              {scrubbing && shown.onGround ? " · ground" : ""}
            </span>
            <span>
              <b>{int(shown.agl)}</b> ft
            </span>
            <span>
              <b>{signed(shown.vs)}</b> fpm
            </span>
            <span>
              <b>{signed1(shown.pitch)}</b>°
            </span>
            <span>
              <b>{int(shown.ias)}</b> kt
            </span>
            <span>
              <b>{fixed(shown.g, 2)}</b> g
            </span>
          </div>

          <div ref={boxRef} className="chart__box">
            {width > 0 && (
              <svg
                width={width}
                height={H}
                className="chart__svg"
                role="img"
                aria-label={summary}
                tabIndex={0}
                onPointerMove={scrub}
                onPointerDown={scrub}
                onPointerLeave={(e) => e.pointerType === "mouse" && setIdx(null)}
                onKeyDown={onKey}
              >
                {/* after contact: a faint wash */}
                {t1 > 0 && <rect x={X(0)} y={0} width={X(t1) - X(0)} height={H - AXIS_H + 6} className="chart__ground" />}

                {PANELS.map((p, b) => {
                  const sc = scales[p.key];
                  const top = b * BLOCK + TITLE_H;
                  const line = samples.map((s, i) => `${i ? "L" : "M"}${X(s.t).toFixed(1)} ${Y(p.key, s[p.key], b).toFixed(1)}`).join("");
                  const base = Y(p.key, p.key === "agl" ? 0 : sc.min, b);
                  const zeroY = sc.min <= 0 && sc.max >= 0 ? Y(p.key, 0, b) : null;
                  return (
                    <g key={p.key}>
                      <text x={ML} y={b * BLOCK + 12} className="chart__title">
                        {p.title} <tspan className="chart__unit">{p.unit}</tspan>
                      </text>
                      {sc.ticks.map((v) => (
                        <g key={v}>
                          <line x1={ML} x2={ML + plotW} y1={Y(p.key, v, b)} y2={Y(p.key, v, b)} className="chart__grid" />
                          <text x={ML - 6} y={Y(p.key, v, b) + 3.5} textAnchor="end" className="chart__tick">
                            {p.key === "pitch" ? int(v) : p.fmt(v).replace("+", "")}
                          </text>
                        </g>
                      ))}
                      {zeroY !== null && <line x1={ML} x2={ML + plotW} y1={zeroY} y2={zeroY} className="chart__axis" />}
                      {p.key === "agl" && (
                        <path d={`${line}L${X(t1).toFixed(1)} ${base.toFixed(1)}L${X(t0).toFixed(1)} ${base.toFixed(1)}Z`} className="chart__area" />
                      )}
                      <path d={line} className="chart__line" />
                      {/* the touchdown rate from the record, as a ringed marker with one direct label */}
                      {p.key === "vs" && t0 <= 0 && t1 >= 0 && (
                        <g>
                          <circle cx={X(0)} cy={Y("vs", landing.vsFpm, b)} r={5} className="chart__dot" />
                          <text
                            x={X(0) - 10}
                            y={Math.min(top + PLOT_H - 4, Y("vs", landing.vsFpm, b) + 15)}
                            textAnchor="end"
                            className="chart__label"
                          >
                            {int(landing.vsFpm)} fpm
                          </text>
                        </g>
                      )}
                      {/* scrubber dot */}
                      {scrubbing && <circle cx={X(cur.t)} cy={Y(p.key, cur[p.key], b)} r={4} className="chart__dot chart__dot--scrub" />}
                    </g>
                  );
                })}

                {/* touchdown marker and scrubber crosshair */}
                {t0 <= 0 && t1 >= 0 && <line x1={X(0)} x2={X(0)} y1={0} y2={H - AXIS_H + 6} className="chart__td" />}
                {t0 <= 0 && t1 >= 0 && (
                  <text x={X(0) + 5} y={12} className="chart__tdlabel">
                    touchdown
                  </text>
                )}
                {scrubbing && <line x1={X(cur.t)} x2={X(cur.t)} y1={TITLE_H - 4} y2={H - AXIS_H + 6} className="chart__cross" />}

                {/* shared time axis */}
                <g>
                  <line x1={ML} x2={ML + plotW} y1={H - AXIS_H + 6} y2={H - AXIS_H + 6} className="chart__axis" />
                  {xTicks.map((t) => (
                    <text key={t} x={X(t)} y={H - AXIS_H + 21} textAnchor="middle" className="chart__tick">
                      {t > 0 ? `+${t}` : t}
                    </text>
                  ))}
                  <text x={ML + plotW / 2} y={H - 3} textAnchor="middle" className="chart__unit">
                    seconds from touchdown
                  </text>
                </g>
              </svg>
            )}
          </div>
          <p className="chart__hint">Touch or hover the chart to read values. Arrow keys work too.</p>
        </>
      ) : (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>Time (s)</th>
                <th>Height (ft)</th>
                <th>V/S (fpm)</th>
                <th>Pitch (°)</th>
                <th>IAS (kt)</th>
                <th>G</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((s) => (
                <tr key={s.t} className={s.t === 0 ? "is-td" : undefined}>
                  <td>{s.t === 0 ? "0 (touchdown)" : s.t > 0 ? `+${fixed(s.t, 1)}` : fixed(s.t, 1)}</td>
                  <td>{int(s.agl)}</td>
                  <td>{signed(s.vs)}</td>
                  <td>{signed1(s.pitch)}</td>
                  <td>{int(s.ias)}</td>
                  <td>{fixed(s.g, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
