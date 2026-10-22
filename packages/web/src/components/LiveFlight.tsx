import { useState, type ReactNode } from "react";
import type { FcuState, Telemetry } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { airlineOf } from "../lib/airlines";
import { coord, fixed, hdg, int, signed, signed1 } from "../lib/format";
import { LOGO_SOURCES, remainingNm, useLogo } from "./FlightPlate";
import { IconFlight } from "./icons";
import { TYPE_NAMES, useAircraftPhoto } from "../lib/aircraft-photo";

const hhmm = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** QTR1175 → QR1175: the airline's IATA code with the callsign's flight number. */
function flightNumber(callsign: string, iata: string | undefined): string | null {
  const m = /^[A-Z]{3}(\w+)$/.exec(callsign);
  return iata && m ? `${iata}${m[1]}` : null;
}

/** The sim's autopilot master, or the aircraft's own AP lights (the Fenix keeps its own). */
function apText(t: Telemetry, fcu: FcuState | null): { on: boolean; text: string } {
  const l = fcu?.lights;
  if (l && (l.ap1 || l.ap2)) return { on: true, text: l.ap1 && l.ap2 ? "AP1 + AP2" : l.ap1 ? "AP1" : "AP2" };
  return t.ap.master ? { on: true, text: "On" } : { on: false, text: "Off" };
}

function Cell({ label, value, unit, sub, warn }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; warn?: boolean }) {
  return (
    <div className={`lf__cell${warn ? " is-warn" : ""}`}>
      <small>{label}</small>
      <b>
        {value}
        {unit && <i> {unit}</i>}
      </b>
      {sub && <span>{sub}</span>}
    </div>
  );
}

/** A section that opens and closes, with a coloured bar like a flight tracker's. Its state is kept on this device. */
function Section({ id, icon, title, children, open: defOpen = true }: { id: string; icon: ReactNode; title: string; children: ReactNode; open?: boolean }) {
  const key = `vbuddy.live.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defOpen : v === "1";
    } catch {
      return defOpen;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? "0" : "1");
    } catch {
      /* for this visit only */
    }
  };
  return (
    <section className={`lf__sec${open ? " is-open" : ""}`}>
      <button type="button" className="lf__bar" aria-expanded={open} onClick={toggle}>
        <span className="lf__barIcon" aria-hidden>
          {icon}
        </span>
        <span className="lf__barTitle">{title}</span>
        <svg className="lf__chev" viewBox="0 0 24 24" aria-hidden>
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="lf__grid">{children}</div>}
    </section>
  );
}

const Ico = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const I = {
  info: <Ico d="M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" />,
  alt: <Ico d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4M3 12h4M17 12h4" />,
  speed: <Ico d="M4 15a8 8 0 1 1 16 0M12 15l4-5M10 19h4" />,
  wind: <Ico d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7" />,
  tower: <Ico d="M9 21l1-9h4l1 9M8 12h8M10 12V8h4v4M7 5l5-2 5 2v3H7z" />,
  source: <Ico d="M5 19a8 8 0 0 1 0-11M8.5 15.5a3.5 3.5 0 0 1 0-4M12 13h.01M13 21l-1-8M16.5 6a8 8 0 0 1 2.5 8" />,
  ap: <Ico d="M4 7h16M4 12h16M4 17h16M8 5v4M15 10v4M10 15v4" />,
};

/**
 * The Live page, laid out like a flight tracker's flight card: who you are (callsign, flight number, type,
 * airline and logo), where you're going (the airports, how far along, when you left and when you'll be there),
 * then the numbers in sections that open and close.
 */
export function LiveFlight({ b, t, now }: { b: BridgeSnapshot; t: Telemetry; now: number }) {
  const net = b.comms?.net;
  const plan = b.plan;
  const callsign = (net?.connected ? net.callsign : null) ?? plan?.callsign ?? null;
  const a = airlineOf(callsign);
  const ownLogo = useLogo(a?.icao ?? null);
  const sources = [...(ownLogo ? [ownLogo] : []), ...(a ? LOGO_SOURCES.map((f) => f(a.iata)) : [])];
  const [failed, setFailed] = useState<string[]>([]);
  const logo = sources.find((u) => !failed.includes(u)) ?? null;

  const sim = b.sim;
  const type = sim?.atcModel || plan?.aircraft || null;
  // The registration: filed on VATSIM (REG/ in the remarks), in the SimBrief plan, or the sim's own.
  const planReg = plan?.matched ? (plan.reg ?? null) : null;
  const reg = sim?.vatsimReg || planReg || sim?.atcId || null;
  const photo = useAircraftPhoto([sim?.vatsimReg, planReg, sim?.atcId], a?.name ?? null, type);
  const typeName = type ? (TYPE_NAMES[type] ?? type) : null;
  const fno = callsign ? flightNumber(callsign, a?.iata) : null;

  // Times: the PC's clock, moved on by how long ago the last frame arrived here.
  const pcNow = b.latest ? b.latest.ts + (now - b.latestAt) : now;
  const takeoffAt = sim?.flight?.takeoffAt ?? null;
  const total = plan && plan.fixes.length > 1 ? remainingNm(plan.fixes, plan.fixes[0]!.lat, plan.fixes[0]!.lon) : (plan?.distanceNm ?? null);
  const left = plan && plan.fixes.length > 1 ? remainingNm(plan.fixes, t.lat, t.lon) : null;
  const progress = total && left !== null ? Math.max(0, Math.min(1, 1 - left / total)) : 0;
  const flown = total && left !== null ? Math.max(0, total - left) : null;
  const etaMs = left !== null && !t.onGround && t.gs > 50 ? (left / t.gs) * 3_600_000 : null;

  const env = b.systems?.environment;
  const xpdr = b.comms?.xpdr;
  const atc = b.atc;
  const ap = apText(t, b.cockpit);
  const fcu = b.cockpit && b.cockpit.power ? b.cockpit : null;

  return (
    <div className="lf">
      {/* --- who */}
      <header className={`lf__head${photo ? " has-photo" : ""}`}>
        <div className="lf__who">
          <div className="lf__id">
            <b className="lf__cs">{callsign ?? reg ?? "Your flight"}</b>
            {fno && <span className="lf__chip">{fno}</span>}
            {type && <span className="lf__chip lf__chip--type">{type}</span>}
          </div>
          <span className="lf__airline">
            {logo ? (
              <img className="lf__mini" src={logo} alt="" referrerPolicy="no-referrer" onError={() => setFailed((f) => [...f, logo])} />
            ) : a ? (
              <i className="lf__mini lf__mini--code">{a.iata}</i>
            ) : null}
            {a?.name ?? (net?.connected ? "On VATSIM" : sim?.aircraftTitle || "Not connected to VATSIM")}
          </span>
        </div>
        {photo ? (
          <a className="lf__photo" href={photo.link} target="_blank" rel="noopener">
            <img src={photo.src} alt={`${a?.name ?? ""} ${typeName ?? ""}${photo.kind === "reg" && reg ? ` ${reg}` : ""}`.trim()} referrerPolicy="strict-origin-when-cross-origin" />
            <span className="lf__credit">© {photo.credit}</span>
          </a>
        ) : (
          <div className="lf__logo">{logo ? <img src={logo} alt={a ? `${a.name} logo` : ""} referrerPolicy="no-referrer" onError={() => setFailed((f) => [...f, logo])} /> : <span>{a?.iata ?? callsign?.slice(0, 3) ?? "VB"}</span>}</div>
        )}
      </header>

      {/* --- where */}
      <div className="lf__main">
        <section className="lf__route" aria-label="Route">
          <div className="lf__ends">
            <div className="lf__apt">
              <b>{plan?.dep ?? "----"}</b>
              <small>{plan?.depName ?? "Departure"}</small>
            </div>
            <span className={`lf__plane${t.onGround ? "" : " is-air"}`} aria-hidden>
              <IconFlight />
            </span>
            <div className="lf__apt lf__apt--r">
              <b>{plan?.arr ?? "----"}</b>
              <small>{plan?.arrName ?? "Arrival"}</small>
            </div>
          </div>
          <div className="lf__prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Progress along the route">
            <i style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="lf__times">
            <span>{takeoffAt ? `Departed ${hhmm(pcNow - takeoffAt)} ago` : t.onGround ? "Not departed yet" : "Airborne"}</span>
            <span>{etaMs !== null ? `Arriving in ${hhmm(etaMs)}` : plan ? (t.onGround && takeoffAt ? "Landed" : `${plan.eteMin ? hhmm(plan.eteMin * 60_000) : "--:--"} planned`) : "No flight plan"}</span>
          </div>
        </section>
        <div className="lf__side">
          <Cell label="Altitude" value={int(t.altMsl)} unit="ft" />
          <Cell label="Ground speed" value={int(t.gs)} unit="kts" />
        </div>
      </div>

      <div className="lf__strip">
        <span title={sim?.aircraftTitle}>{typeName ?? (sim?.aircraftTitle || "Unknown aircraft")}</span>
        {reg && (
          <span>
            <small>REG.</small> {reg}
          </span>
        )}
      </div>
      {plan && !plan.matched && <p className="lf__note">This SimBrief plan ({plan.dep} → {plan.arr}) doesn't start where this flight began.</p>}

      {/* --- the numbers */}
      <Section id="info" icon={I.info} title={`More ${fno ?? callsign ?? "flight"} information`}>
        <Cell label="Aircraft type" value={type ?? "–"} sub={typeName ?? sim?.aircraftTitle} />
        <Cell label="Registration" value={reg ?? "–"} sub={reg ? (sim?.vatsimReg === reg ? "From your VATSIM flight plan" : planReg === reg ? "From SimBrief" : "From the simulator") : "Add REG/ to your VATSIM remarks"} />
        <Cell label="Flight plan" value={plan ? `${plan.dep} → ${plan.arr}` : "–"} sub={plan ? [plan.cruiseFt ? `FL${Math.round(plan.cruiseFt / 100)}` : null, plan.distanceNm ? `${int(plan.distanceNm)} nm` : null].filter(Boolean).join(" · ") : "Load one in SimBrief"} />
        <Cell label="In the simulator" value={sim?.aircraftTitle || "–"} />
        {photo && <Cell label="Photo" value={photo.kind === "reg" ? "This aircraft" : `A ${a?.name ?? ""} ${typeName ?? ""}`.trim()} sub={photo.kind === "reg" ? "Planespotters.net" : "Wikimedia Commons"} />}
        <Cell label="Distance" value={left !== null ? int(left) : "–"} unit={left !== null ? "nm to go" : undefined} sub={flown !== null ? `${int(flown)} nm flown` : undefined} />
      </Section>

      <Section id="alt" icon={I.alt} title="Altitude and vertical speed">
        <Cell label="Altitude" value={int(t.altMsl)} unit="ft" />
        <Cell label="Vertical speed" value={signed(t.vs)} unit="fpm" warn={Math.abs(t.vs) > 4000} />
        <Cell label="Above ground" value={int(t.altAgl)} unit="ft" sub={`Ground ${int(t.groundElev)} ft`} />
        <Cell label="Track" value={`${hdg(t.track)}°`} sub={`Heading ${hdg(t.hdgMag)}° mag`} />
      </Section>

      <Section id="speed" icon={I.speed} title="Speed">
        <Cell label="Ground speed" value={int(t.gs)} unit="kts" />
        <Cell label="True airspeed" value={int(t.tas)} unit="kts" />
        <Cell label="Indicated airspeed" value={int(t.ias)} unit="kts" />
        <Cell label="Mach" value={fixed(t.mach, 3)} unit="Ma" />
      </Section>

      <Section id="wind" icon={I.wind} title="Wind and temperature">
        <Cell label="Wind" value={env ? `${hdg(env.windDir)}° / ${int(env.windSpeed)}` : "N/A"} unit={env ? "kts" : undefined} />
        <Cell label="Temperature" value={env ? `${int(env.oat)}°C` : "N/A"} />
        <Cell label="Attitude" value={`${signed(t.pitch)}° / ${signed(t.bank)}°`} sub="pitch / bank" />
        <Cell label="G load" value={fixed(t.gForce, 2)} unit="g" warn={t.gForce > 1.6 || t.gForce < 0.4} />
      </Section>

      <Section id="atc" icon={I.tower} title="Airspace">
        <Cell label="ATC now" value={atc?.current ? atc.current.name : net?.connected ? "UNICOM" : "–"} sub={atc?.current ? `${atc.current.callsign} · ${atc.current.freq}` : net?.connected ? "122.800" : "Not on VATSIM"} />
        <Cell label="Next" value={atc?.ahead ? (atc.ahead.station ? atc.ahead.station.name : "UNICOM") : "–"} sub={atc?.ahead ? `${atc.ahead.distNm} nm · ${Math.max(1, Math.round(atc.ahead.etaSec / 60))} min` : undefined} />
      </Section>

      <Section id="ap" icon={I.ap} title="Autopilot and aircraft">
        <Cell label="Autopilot" value={ap.text} sub={fcu?.lights.athr !== undefined ? `A/THR ${fcu.lights.athr ? "on" : "off"}` : undefined} />
        <Cell label="Selected" value={fcu ? `${fcu.spdDashed ? "---" : fcu.spdIsMach ? fcu.spd.toFixed(2) : int(fcu.spd)} · ${fcu.hdgDashed ? "---" : hdg(fcu.hdg)}` : `${int(t.ap.spdSel)} · ${hdg(t.ap.hdgSel)}`} sub="speed · heading" />
        <Cell label="Selected altitude" value={int(fcu ? fcu.alt : t.ap.altSel)} unit="ft" sub={fcu ? (fcu.vsDashed ? "V/S ---" : fcu.trkFpa ? `FPA ${signed1(fcu.vs / 1000)}` : `V/S ${signed(fcu.vs)}`) : `V/S ${signed(t.ap.vsSel)}`} />
        <Cell label="Gear · flaps" value={`${t.gearDown ? "Down" : "Up"} · ${t.flapsIndex}`} sub={`Parking brake ${t.parkingBrake ? "set" : "off"}${t.simRate !== 1 ? ` · sim rate ×${t.simRate}` : ""}`} warn={t.parkingBrake && !t.onGround} />
      </Section>

      <Section id="source" icon={I.source} title={`Data source — ${sim?.source === "mock" ? "VBuddy test flight" : (sim?.simName ?? "Microsoft Flight Simulator")}`} open={false}>
        <Cell label="Squawk" value={xpdr ? xpdr.code : "–"} sub={xpdr ? (xpdr.ident ? "IDENT" : xpdr.mode === "alt" ? "Mode C" : xpdr.mode === "stby" ? "Standby" : xpdr.mode === "off" ? "Off" : "") : undefined} />
        <Cell label="Update rate" value={b.telemetryHz || "–"} unit="Hz" sub={b.missedFrames ? `${b.missedFrames} frames missed` : "No frames missed"} />
        <Cell label="Latitude" value={fixed(t.lat, 4)} sub={coord(t.lat, true)} />
        <Cell label="Longitude" value={fixed(t.lon, 4)} sub={coord(t.lon, false)} />
      </Section>
    </div>
  );
}
