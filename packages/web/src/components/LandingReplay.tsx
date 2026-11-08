import { useEffect, useMemo, useRef, useState } from "react";
import { LocalFrame, touchdownOnRunway, type GroundChart, type Landing, type RunwayTouchdown } from "@vbuddy/protocol";
import { apiFetch } from "../lib/api";
import { int, signed } from "../lib/format";

const W = 400;
const TOP_H = 120;
const SIDE_H = 120;
const rad = Math.PI / 180;

/** The runway layout of the airport a landing was at, loaded from the bridge (which keeps it once built). */
function useRunway(l: Landing, wait: boolean): { td: RunwayTouchdown | null; loading: boolean } {
  const [state, setState] = useState<{ id: string; td: RunwayTouchdown | null; loading: boolean }>({ id: "", td: null, loading: true });
  useEffect(() => {
    if (wait) return;
    let cancelled = false;
    setState({ id: l.id, td: null, loading: true });
    void (async () => {
      try {
        const n = (await (await apiFetch(`/api/ground/nearest?lat=${l.lat}&lon=${l.lon}`)).json()) as { airport?: { icao: string } | null };
        if (!n.airport) throw new Error("no airport");
        const g = (await (await apiFetch(`/api/ground/${encodeURIComponent(n.airport.icao)}`)).json()) as { chart?: GroundChart | null };
        const td = g.chart ? touchdownOnRunway(g.chart.runways, l.lat, l.lon, l.hdgTrue) : null;
        if (!cancelled) setState({ id: l.id, td, loading: false });
      } catch {
        if (!cancelled) setState({ id: l.id, td: null, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [l.id, wait]); // eslint-disable-line react-hooks/exhaustive-deps
  return state.id === l.id ? state : { td: null, loading: true };
}

/**
 * The last seconds of a landing, replayed: from above (over the runway, with the touchdown point) and from the side
 * (height over distance), with a play button and the numbers at each moment. All worked out on this device.
 */
export function LandingReplay({ landing, wait }: { landing: Landing; wait: boolean }) {
  const pts = landing.profile.filter((p) => p.lat !== undefined && p.lon !== undefined);
  const { td, loading } = useRunway(landing, wait || pts.length < 5);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);

  // Positions in runway terms: metres along the landing direction and to the right of it, from the threshold (or, without
  // a runway, from the touchdown point along the touchdown heading).
  const geo = useMemo(() => {
    const frame = td?.frame ?? new LocalFrame(landing.lat, landing.lon);
    const dir = td ? Math.atan2(td.far[0], td.far[1]) : landing.hdgTrue * rad;
    const ux = Math.sin(dir);
    const uy = Math.cos(dir);
    return pts.map((p) => {
      const [x, y] = frame.xy(p.lat!, p.lon!);
      return { along: x * ux + y * uy, right: x * uy - y * ux };
    });
  }, [td, landing.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) return;
    const start = performance.now();
    const t0 = pts[i]?.t ?? 0;
    const step = () => {
      const t = t0 + (performance.now() - start) / 1000;
      let j = i;
      while (j < pts.length - 1 && pts[j + 1]!.t <= t) j++;
      setI(j);
      if (j >= pts.length - 1) setPlaying(false);
      else raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pts.length < 5) return null;
  const p = pts[Math.min(i, pts.length - 1)]!;
  const g = geo[Math.min(i, geo.length - 1)]!;

  // Top view: along → x, right → y (exaggerated ×4 so a few metres show).
  const aMin = Math.min(...geo.map((q) => q.along), td ? -100 : Infinity);
  const aMax = Math.max(...geo.map((q) => q.along), td ? Math.min(td.lengthM, Math.max(...geo.map((q) => q.along)) + 300) : -Infinity);
  const X = (a: number) => 10 + ((a - aMin) / Math.max(1, aMax - aMin)) * (W - 20);
  const halfW = td ? td.widthM / 2 : 25;
  const latScale = (TOP_H / 2 - 12) / Math.max(halfW * 1.6, ...geo.map((q) => Math.abs(q.right)));
  const Y = (r: number) => TOP_H / 2 + r * latScale;
  const track = geo.map((q, k) => `${k ? "L" : "M"}${X(q.along).toFixed(1)},${Y(q.right).toFixed(1)}`).join(" ");
  const tdIdx = Math.max(0, pts.findIndex((q) => q.t >= 0));
  const tdG = geo[tdIdx]!;

  // Side view: height over the same distance.
  const hMax = Math.max(50, ...pts.map((q) => q.agl));
  const SY = (h: number) => SIDE_H - 14 - (Math.max(0, h) / hMax) * (SIDE_H - 26);
  const side = pts.map((q, k) => `${k ? "L" : "M"}${X(geo[k]!.along).toFixed(1)},${SY(q.agl).toFixed(1)}`).join(" ");

  return (
    <section className="card replay">
      <div className="replay__head">
        <h2 className="card__title">Replay</h2>
        <button type="button" className="btn" onClick={() => (playing ? setPlaying(false) : (i >= pts.length - 1 && setI(0), setPlaying(true)))}>
          {playing ? "Pause" : "Play"}
        </button>
      </div>
      {td ? (
        <p className="replay__td">
          Touched down on <b>{td.runway}</b>, <b>{int(td.fromThresholdM)} m</b> past the threshold, <b>{Math.abs(td.offsetM) < 0.5 ? "on the centreline" : `${Math.abs(td.offsetM).toFixed(1)} m ${td.offsetM > 0 ? "right" : "left"} of the centreline`}</b>, with {int(td.remainingM)} m of runway left.
        </p>
      ) : (
        <p className="muted replay__td">{loading ? "Finding the runway…" : "The runway layout isn't available for this airport, so the track is drawn from the touchdown point."}</p>
      )}
      <svg className="replay__svg" viewBox={`0 0 ${W} ${TOP_H}`} role="img" aria-label="Track over the runway, from above">
        {td && (
          <>
            <rect className="replay__rwy" x={X(0)} y={Y(-halfW)} width={Math.max(0, X(Math.min(td.lengthM, aMax)) - X(0))} height={Y(halfW) - Y(-halfW)} />
            <line className="replay__cl" x1={X(0)} x2={X(Math.min(td.lengthM, aMax))} y1={Y(0)} y2={Y(0)} />
            <line className="replay__thr" x1={X(0)} x2={X(0)} y1={Y(-halfW)} y2={Y(halfW)} />
            {[150, 300, 450, 600].map((m) => (
              <line key={m} className="replay__tdz" x1={X(m)} x2={X(m)} y1={Y(-halfW * 0.6)} y2={Y(halfW * 0.6)} />
            ))}
          </>
        )}
        <path className="replay__track" d={track} />
        <circle className="replay__tdpt" cx={X(tdG.along)} cy={Y(tdG.right)} r={4.5} />
        <circle className="replay__me" cx={X(g.along)} cy={Y(g.right)} r={5.5} />
      </svg>
      <svg className="replay__svg" viewBox={`0 0 ${W} ${SIDE_H}`} role="img" aria-label="Height over distance, from the side">
        <line className="replay__ground" x1={0} x2={W} y1={SY(0)} y2={SY(0)} />
        <path className="replay__track" d={side} />
        <circle className="replay__me" cx={X(g.along)} cy={SY(p.agl)} r={5.5} />
      </svg>
      <input className="replay__seek" type="range" min={0} max={pts.length - 1} value={i} onChange={(e) => (setPlaying(false), setI(Number(e.target.value)))} aria-label="Moment in the replay" />
      <dl className="replay__now">
        <div>
          <dt>Time</dt>
          <dd>{p.t >= 0 ? `+${p.t.toFixed(1)}` : p.t.toFixed(1)} s</dd>
        </div>
        <div>
          <dt>Height</dt>
          <dd>{int(p.agl)} ft</dd>
        </div>
        <div>
          <dt>Sink</dt>
          <dd>{signed(p.vs)} fpm</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{int(p.ias)} kt</dd>
        </div>
        <div>
          <dt>Pitch · bank</dt>
          <dd>
            {p.pitch.toFixed(1)}° · {(p.bank ?? 0).toFixed(1)}°
          </dd>
        </div>
        <div>
          <dt>G</dt>
          <dd>{p.g.toFixed(2)}</dd>
        </div>
      </dl>
    </section>
  );
}
