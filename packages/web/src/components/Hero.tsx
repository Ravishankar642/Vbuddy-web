import { useRef } from "react";
import type { Telemetry } from "@vbuddy/protocol";
import { fixed, hdg, int, signed } from "../lib/format";

/** A heading dial: the ring turns so your heading is always at the top. */
export function Compass({ heading }: { heading: number }) {
  // Keep turning the short way round (359 -> 1 must not spin the dial back through 180 degrees).
  const angle = useRef(heading);
  const prev = useRef(heading);
  angle.current += ((heading - prev.current + 540) % 360) - 180;
  prev.current = heading;
  const ticks = [];
  for (let d = 0; d < 360; d += 10) {
    const major = d % 30 === 0;
    ticks.push(<line key={d} x1="100" y1={major ? 12 : 15} x2="100" y2={major ? 24 : 21} stroke="currentColor" strokeWidth={major ? 2.2 : 1.2} transform={`rotate(${d} 100 100)`} opacity={major ? 0.9 : 0.5} />);
  }
  const labels: Array<[number, string]> = [[0, "N"], [90, "E"], [180, "S"], [270, "W"]];
  return (
    <svg className="compass" viewBox="0 0 200 200" role="img" aria-label={`Heading ${hdg(heading)} degrees magnetic`} style={{ color: "#fff" }}>
      <circle cx="100" cy="100" r="92" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.28)" />
      <g className="compass__ring" style={{ transform: `rotate(${-angle.current}deg)` }}>
        {ticks}
        {labels.map(([d, l]) => (
          <text key={l} x="100" y="40" transform={`rotate(${d} 100 100)`}>
            <tspan transform={`rotate(0)`}>{l}</tspan>
          </text>
        ))}
      </g>
      <path d="M100 4 L108 18 L92 18 Z" fill="#ffd08a" />
      <text className="compass__hdg" x="100" y="96">{hdg(heading)}</text>
      <text className="compass__unit" x="100" y="124">MAGNETIC</text>
    </svg>
  );
}

/** The one big card on the Flight tab: altitude first, then speed, vertical speed and ground speed, with the heading dial. */
export function FlightHero({ t, aircraft }: { t: Telemetry; aircraft: string }) {
  const vsWarn = Math.abs(t.vs) > 4000;
  return (
    <section className="fhero" aria-label="Primary flight data">
      <div className="fhero__top">
        <span className="fhero__ac">{aircraft || "No aircraft"}</span>
        <span className="fhero__state">{t.onGround ? "On the ground" : "Airborne"}</span>
      </div>
      <div className="fhero__alt">
        <small>Altitude</small>
        <b>
          {int(t.altMsl)}
          <i>ft</i>
        </b>
        <span>{int(t.altAgl)} ft above ground</span>
      </div>
      <Compass heading={t.hdgMag} />
      <div className="fhero__row">
        <div className="fhero__cell">
          <small>Airspeed</small>
          <b>
            {int(t.ias)}
            <i>kt</i>
          </b>
          <span>
            TAS {int(t.tas)} · M{fixed(t.mach, 2)}
          </span>
        </div>
        <div className={`fhero__cell${vsWarn ? " fhero__cell--warn" : ""}`}>
          <small>Vertical speed</small>
          <b>
            {signed(t.vs)}
            <i>fpm</i>
          </b>
          <span>Pitch {signed(t.pitch)}°</span>
        </div>
        <div className="fhero__cell">
          <small>Ground speed</small>
          <b>
            {int(t.gs)}
            <i>kt</i>
          </b>
          <span>Track {hdg(t.track)}°</span>
        </div>
      </div>
    </section>
  );
}
