import { useEffect, useState, type ReactNode } from "react";
import { indicatedAlt, type Telemetry } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { int, signed } from "../lib/format";
import { CduView } from "./CduView";
import { useWakeLock } from "../lib/wake-lock";

export type ScreenKind = "pfd" | "mcdu" | "dash";
export const SCREENS: Array<[ScreenKind, string, string]> = [
  ["pfd", "Flight display", "Attitude, speed, altitude, vertical speed, heading and the autopilot targets."],
  ["mcdu", "MCDU / CDU", "The aircraft's FMS keypad and screen, full size."],
  ["dash", "My dashboard", "The tiles you choose, in your order."],
];

/* ---------------------------------------------------------------- dashboard tiles */

interface TileDef {
  id: string;
  label: string;
  value: (t: Telemetry, b: BridgeSnapshot) => string;
  unit?: string;
}
export const TILES: TileDef[] = [
  { id: "ias", label: "IAS", value: (t) => int(t.ias), unit: "kt" },
  { id: "gs", label: "Ground speed", value: (t) => int(t.gs), unit: "kt" },
  { id: "mach", label: "Mach", value: (t) => t.mach.toFixed(3) },
  { id: "alt", label: "Altitude", value: (t) => int(indicatedAlt(t)), unit: "ft" },
  { id: "agl", label: "Radio height", value: (t) => int(t.altAgl), unit: "ft" },
  { id: "vs", label: "Vertical speed", value: (t) => signed(t.vs), unit: "fpm" },
  { id: "hdg", label: "Heading", value: (t) => `${String(Math.round(t.hdgMag) % 360 || 360).padStart(3, "0")}°` },
  { id: "trk", label: "Track", value: (t) => `${String(Math.round(t.track) % 360 || 360).padStart(3, "0")}°` },
  { id: "g", label: "G load", value: (t) => t.gForce.toFixed(2) },
  { id: "tod", label: "To T/D", value: (_t, b) => (b.progress?.todNm != null && b.progress.todNm > 0 ? int(b.progress.todNm) : "–"), unit: "nm" },
  { id: "togo", label: "Distance to go", value: (_t, b) => (b.progress ? int(b.progress.remainingNm) : "–"), unit: "nm" },
  { id: "fuel", label: "Fuel", value: (_t, b) => (b.progress?.fuelKg != null ? int(b.progress.fuelKg) : "–"), unit: "kg" },
  { id: "landfuel", label: "Landing fuel", value: (_t, b) => (b.progress?.predLandingKg != null ? int(b.progress.predLandingKg) : "–"), unit: "kg" },
  { id: "wind", label: "Wind ahead", value: (_t, b) => (b.progress?.windRestKt != null ? signed(b.progress.windRestKt) : "–"), unit: "kt" },
  { id: "com1", label: "COM1", value: (_t, b) => (b.comms?.radios ? (b.comms.radios.com1.active / 1e6).toFixed(3) : "–") },
  { id: "xpdr", label: "Squawk", value: (_t, b) => b.comms?.xpdr?.code ?? "–" },
  { id: "flaps", label: "Flaps · gear", value: (t) => `${t.flapsIndex} · ${t.gearDown ? "DN" : "UP"}` },
  { id: "ap", label: "Autopilot", value: (t, b) => (t.ap.master || b.cockpit?.lights?.ap1 || b.cockpit?.lights?.ap2 ? "ON" : "OFF") },
];
const DASH_KEY = "vbuddy.dash";
const DEFAULT_DASH = ["ias", "alt", "vs", "hdg", "gs", "tod", "landfuel", "com1"];
export function readDash(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DASH_KEY) ?? "null") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && TILES.some((t) => t.id === x)) : DEFAULT_DASH;
  } catch {
    return DEFAULT_DASH;
  }
}
export function writeDash(ids: string[]) {
  try {
    localStorage.setItem(DASH_KEY, JSON.stringify(ids));
  } catch {
    /* this visit only */
  }
}

/* ---------------------------------------------------------------- flight display */

function Pfd({ t, b }: { t: Telemetry; b: BridgeSnapshot }) {
  const fcu = b.cockpit && b.cockpit.power ? b.cockpit : null;
  const pitchPx = 4; // px per degree
  const spdSel = fcu ? (fcu.spdDashed ? "---" : fcu.spdIsMach ? fcu.spd.toFixed(2) : int(fcu.spd)) : int(t.ap.spdSel);
  const altSel = int(fcu ? fcu.alt : t.ap.altSel);
  const hdgSel = fcu ? (fcu.hdgDashed ? "---" : String(Math.round(fcu.hdg)).padStart(3, "0")) : String(Math.round(t.ap.hdgSel)).padStart(3, "0");
  const ap = t.ap.master || !!fcu?.lights?.ap1 || !!fcu?.lights?.ap2;
  return (
    <div className="pfd">
      <div className="pfd__fma">
        <span className={ap ? "is-on" : ""}>AP {ap ? "ON" : "OFF"}</span>
        <span>SPD {spdSel}</span>
        <span>HDG {hdgSel}</span>
        <span>ALT {altSel}</span>
      </div>
      <div className="pfd__main">
        <div className="pfd__tape">
          <small>IAS</small>
          <b>{int(t.ias)}</b>
          <span>M {t.mach.toFixed(2)}</span>
        </div>
        <svg className="pfd__adi" viewBox="-100 -100 200 200" role="img" aria-label={`Pitch ${t.pitch.toFixed(0)} degrees, bank ${t.bank.toFixed(0)} degrees`}>
          <defs>
            <clipPath id="adiClip">
              <circle r="96" />
            </clipPath>
          </defs>
          <g clipPath="url(#adiClip)">
            <g transform={`rotate(${-t.bank}) translate(0 ${t.pitch * pitchPx})`}>
              <rect x="-300" y="-600" width="600" height="600" fill="#2f7fd6" />
              <rect x="-300" y="0" width="600" height="600" fill="#8a5a3c" />
              <line x1="-300" x2="300" y1="0" y2="0" stroke="#fff" strokeWidth="1.5" />
              {[-20, -10, 10, 20].map((d) => (
                <g key={d}>
                  <line x1={-(Math.abs(d) === 10 ? 22 : 34)} x2={Math.abs(d) === 10 ? 22 : 34} y1={-d * pitchPx} y2={-d * pitchPx} stroke="#fff" strokeWidth="1.2" />
                  <text x="40" y={-d * pitchPx + 4} fill="#fff" fontSize="10">
                    {Math.abs(d)}
                  </text>
                </g>
              ))}
            </g>
          </g>
          <circle r="96" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2" />
          <path d="M-60 0 H-22 V8 M60 0 H22 V8" fill="none" stroke="#ffd34d" strokeWidth="4" strokeLinejoin="round" />
          <rect x="-3" y="-3" width="6" height="6" fill="#ffd34d" />
          <path d="M0 -96 l-6 10 h12 z" fill="#ffd34d" transform={`rotate(${-t.bank})`} />
        </svg>
        <div className="pfd__tape">
          <small>ALT</small>
          <b>{int(indicatedAlt(t))}</b>
          <span className={Math.abs(t.vs) > 150 ? "is-on" : ""}>{signed(t.vs)} fpm</span>
        </div>
      </div>
      <div className="pfd__hdg">
        <small>HDG</small>
        <b>{String(Math.round(t.hdgMag) % 360 || 360).padStart(3, "0")}°</b>
        <span>GS {int(t.gs)} · TRK {String(Math.round(t.track) % 360 || 360).padStart(3, "0")}°</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the screen */

/**
 * A second device as one instrument, full screen: open #screen/pfd, #screen/mcdu or #screen/dash. The screen stays
 * awake while it's shown. Everything is drawn on the device from the data the app already gets.
 */
export function InstrumentScreen({ b, kind }: { b: BridgeSnapshot; kind: ScreenKind }) {
  useWakeLock(true);
  const t = b.latest?.data ?? null;
  const [dash, setDash] = useState(readDash);
  useEffect(() => {
    const on = () => setDash(readDash());
    window.addEventListener("vbuddy-settings", on);
    return () => window.removeEventListener("vbuddy-settings", on);
  }, []);
  let body: ReactNode;
  if (kind === "mcdu") body = <CduView b={b} />;
  else if (!t) body = <p className="muted is__wait">Waiting for the simulator…</p>;
  else if (kind === "pfd") body = <Pfd t={t} b={b} />;
  else
    body = (
      <div className="is__dash">
        {dash.map((id) => {
          const d = TILES.find((x) => x.id === id)!;
          return (
            <div key={id} className="is__tile">
              <small>{d.label}</small>
              <b>
                {d.value(t, b)}
                {d.unit && <i> {d.unit}</i>}
              </b>
            </div>
          );
        })}
      </div>
    );
  return (
    <div className={`is is--${kind}`}>
      <a className="is__back" href="#me" aria-label="Back to the app">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </a>
      {b.link !== "open" && <div className="is__link">Reconnecting to the PC…</div>}
      {body}
    </div>
  );
}
