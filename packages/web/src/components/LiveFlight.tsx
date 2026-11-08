import { flightIdentity } from "../lib/identity";
import { useState, type ReactNode } from "react";
import { indicatedAlt, type FcuState, type Telemetry } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { coord, fixed, hdg, int, signed, signed1 } from "../lib/format";
import { LOGO_SOURCES, remainingNm, useLogo } from "./FlightPlate";
import { IconFlight } from "./icons";
import { ProfileChart } from "./ProfileChart";
import { ChecklistCard } from "./ChecklistCard";
import { flightPhase } from "./SystemsView";
import { useDestNet } from "../lib/dest-net";
import { useBridgeActions } from "../lib/useBridge";
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
  profile: <Ico d="M3 19h18M4 17l5-9h6l5 9M15 8l2-3" />,
  check: <Ico d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />,
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
  const who = flightIdentity(b);
  const callsign = who.callsign;
  const a = who.airline;
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
  const g = b.progress;
  const todFrac = g && g.todNm !== null && g.totalNm > 0 ? Math.max(0, Math.min(1, (g.alongNm + g.todNm) / g.totalNm)) : null;
  const hero = phaseHero({ t, phase: flightPhase(t, !!sim?.paused), etaMs, plan, g, takeoffAt, pcNow });

  const env = b.systems?.environment;
  const xpdr = b.comms?.xpdr;
  const atc = b.atc;
  const ap = apText(t, b.cockpit);
  const fcu = b.cockpit && b.cockpit.power ? b.cockpit : null;
  const dest = useDestNet(b.link, plan?.dep ?? null, plan?.arr ?? null);

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

      {/* --- the phase, and the one number that matters most in it */}
      <section className="lf__hero" aria-label="Phase and timing">
        <div className="lf__heroTop">
          <span className="lf__phase">{hero.phase}</span>
          <span>{hero.right}</span>
        </div>
        <div className="lf__heroBig">
          <b>{hero.big}</b>
          <span>{hero.caption}</span>
        </div>
        <div className="lf__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Progress along the route">
          <i className="lf__trackFill" style={{ width: `${progress * 100}%` }} />
          {todFrac !== null && <i className="lf__trackTod" style={{ left: `${todFrac * 100}%` }} />}
          <span className="lf__trackPlane" style={{ left: `${progress * 100}%` }} aria-hidden>
            <IconFlight />
          </span>
        </div>
        <div className="lf__trackEnds">
          <span title={plan?.depName ?? undefined}>{plan?.dep ?? "----"}</span>
          {todFrac !== null && (
            <span className="lf__trackTodLabel" style={{ left: `${todFrac * 100}%` }}>
              T/D
            </span>
          )}
          <span title={plan?.arrName ?? undefined}>{plan?.arr ?? "----"}</span>
        </div>
      </section>

      {/* --- four numbers */}
      <section className="lf__tiles" aria-label="Key numbers">
        <Tile label="Altitude" value={int(indicatedAlt(t))} unit="ft" sub={g?.altDevFt != null && !t.onGround ? (g.vertical === "high" ? `${int(g.altDevFt)} ft high` : g.vertical === "low" ? `${int(-g.altDevFt)} ft low` : "On the profile") : t.onGround ? `${int(t.groundElev)} ft field` : undefined} tone={g?.vertical === "high" || g?.vertical === "low" ? "warn" : undefined} />
        <Tile label="Ground speed" value={int(t.gs)} unit="kt" sub={g?.windRestKt != null && g.windRestKt !== 0 ? `${g.windRestKt > 0 ? "Tailwind" : "Headwind"} ${int(Math.abs(g.windRestKt))} kt ahead` : `IAS ${int(t.ias)} kt`} />
        <Tile label="Vertical speed" value={signed(t.vs)} unit="fpm" sub={Math.abs(t.vs) < 150 ? "Level" : t.vs > 0 ? "Climbing" : "Descending"} />
        {g?.predLandingKg != null ? (
          <Tile label="Landing fuel" value={int(g.predLandingKg)} unit="kg" sub={g.minLandingKg != null ? `${g.predLandingKg - g.minLandingKg >= 0 ? "+" : "−"}${int(Math.abs(g.predLandingKg - g.minLandingKg))} over min` : "At this rate"} tone={g.fuelState === "ok" ? "ok" : g.fuelState ? "warn" : undefined} />
        ) : (
          <Tile label="Distance" value={left !== null ? int(left) : "–"} unit={left !== null ? "nm" : undefined} sub={flown !== null ? `${int(flown)} nm flown` : "No flight plan"} />
        )}
      </section>

      {/* --- what's next: the next controller along the route */}
      {atc?.ahead?.station && (
        <section className="lf__next" aria-label="Next up">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0M12 15v5" />
            <circle cx="12" cy="13" r="1.5" />
          </svg>
          <div>
            <b>
              {atc.ahead.station.name} in {int(atc.ahead.distNm)} nm
            </b>
            <span>
              {atc.ahead.station.callsign} · {atc.ahead.station.freq} · about {Math.max(1, Math.round(atc.ahead.etaSec / 60))} min
            </span>
          </div>
          <TuneButton freq={atc.ahead.station.freq} enabled={!!b.control?.allowed} big />
        </section>
      )}
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

      <Section id="check" icon={I.check} title="Checklists">
        <div className="lf__wide">
          <ChecklistCard b={b} t={t} />
        </div>
      </Section>

      {plan?.profile && plan.profile.length > 1 && b.progress && <ProgressSection b={b} t={t} />}

      <Section id="alt" icon={I.alt} title="Altitude and vertical speed">
        <Cell label="Altitude" value={int(indicatedAlt(t))} unit="ft" />
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
        <Cell
          label="Next"
          value={atc?.ahead ? (atc.ahead.station ? atc.ahead.station.name : "UNICOM") : "–"}
          sub={
            atc?.ahead ? (
              <>
                {`${atc.ahead.distNm} nm · ${Math.max(1, Math.round(atc.ahead.etaSec / 60))} min`}
                {atc.ahead.station && <TuneButton freq={atc.ahead.station.freq} enabled={!!b.control?.allowed} />}
              </>
            ) : undefined
          }
        />
        {dest.atis && (
          <Cell
            label={`${plan?.arr ?? ""} ATIS`}
            value={dest.atis.code ? `Information ${dest.atis.code}` : "Online"}
            sub={
              <>
                {[dest.atis.runways.length ? `RWY ${dest.atis.runways.join(", ")}` : null, dest.atis.qnh ? `QNH ${dest.atis.qnh}` : null, dest.atis.freq].filter(Boolean).join(" · ")}
                <TuneButton freq={dest.atis.freq} enabled={!!b.control?.allowed} radio={2} />
              </>
            }
          />
        )}
        {dest.events.map((e) => (
          <Cell key={e.name + e.start} label="VATSIM event" value={e.name} sub={`${e.airports.filter((x) => x === plan?.dep || x === plan?.arr).join(", ")} · ${new Date(e.start).toISOString().slice(11, 16)}–${new Date(e.end).toISOString().slice(11, 16)}Z`} />
        ))}
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

const kg = (n: number | null) => (n === null ? "–" : int(n));
const signedFt = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${int(Math.abs(n))}`;

/** Flight progress: the vertical profile against the plan, the top of descent, and fuel against the plan. */
function ProgressSection({ b, t }: { b: BridgeSnapshot; t: Telemetry }) {
  const g = b.progress!;
  const profile = b.plan!.profile!;
  const alt = indicatedAlt(t);
  const vert = g.vertical === "high" ? "High on the descent" : g.vertical === "low" ? "Low on the descent" : g.altDevFt === null ? "On the ground" : "On the profile";
  const tod = g.todNm === null ? null : g.todNm > 0 ? `${int(g.todNm)} nm` : "Passed";
  const fuelWarn = g.fuelState === "low" || g.fuelState === "critical";
  return (
    <Section id="profile" icon={I.profile} title="Profile and fuel">
      <div className="lf__wide">
        <ProfileChart profile={profile} progress={g} altFt={alt} />
      </div>
      <Cell label="Planned altitude" value={g.plannedAltFt !== null ? int(g.plannedAltFt) : "–"} unit="ft" sub={g.altDevFt !== null ? `${signedFt(g.altDevFt)} ft · ${vert}` : vert} warn={g.vertical === "high" || g.vertical === "low"} />
      <Cell label="Top of descent" value={tod ?? "–"} sub={g.nextFix ? `Next ${g.nextFix}${g.nextFixNm !== null ? ` · ${int(g.nextFixNm)} nm` : ""}` : undefined} />
      <Cell label="Fuel" value={kg(g.fuelKg)} unit="kg" sub={g.plannedFuelKg !== null ? `Plan ${int(g.plannedFuelKg)} kg${g.fuelDevKg !== null ? ` (${g.fuelDevKg >= 0 ? "+" : "−"}${int(Math.abs(g.fuelDevKg))})` : ""}` : "No fuel plan"} />
      <Cell
        label="Landing fuel"
        value={kg(g.predLandingKg)}
        unit="kg"
        sub={g.minLandingKg !== null ? `${g.fuelState === "critical" ? "Into final reserve" : g.fuelState === "low" ? "Below" : "Min"} reserve + alternate ${int(g.minLandingKg)} kg` : "Predicted at this rate"}
        warn={fuelWarn}
      />
      {g.windRestKt != null && <Cell label="Wind ahead" value={g.windRestKt === 0 ? "Calm" : `${int(Math.abs(g.windRestKt))}`} unit={g.windRestKt === 0 ? undefined : "kt"} sub={g.windRestKt > 0 ? "Tailwind, rest of the route" : g.windRestKt < 0 ? "Headwind, rest of the route" : "Rest of the route"} />}
      {g.offRouteNm > 5 && <Cell label="Off the route" value={int(g.offRouteNm)} unit="nm" sub="Distances follow the plan's route" warn={g.offRouteNm > 25} />}
    </Section>
  );
}

/** Puts a station's frequency in COM1 (or COM2 for an ATIS), one tap. */
function TuneButton({ freq, enabled, radio = 1, big }: { freq: string; enabled: boolean; radio?: 1 | 2; big?: boolean }) {
  const { commsCommand } = useBridgeActions();
  const [state, setState] = useState<"idle" | "ok" | string>("idle");
  const mhz = Number(freq);
  if (!enabled || !(mhz >= 118 && mhz < 137)) return null;
  return (
    <button
      type="button"
      className={big ? "lf__tuneBig" : "clr__chip is-act lf__tune"}
      onClick={() =>
        void commsCommand({ op: "com", radio, action: "active", hz: Math.round(mhz * 1000) * 1000 }).then((r) => setState(r.ok ? "ok" : r.error))
      }
    >
      {state === "ok" ? `COM${radio} set` : state === "idle" ? `Tune COM${radio}` : "Couldn't tune"}
    </button>
  );
}

function Tile({ label, value, unit, sub, tone }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: "ok" | "warn" }) {
  return (
    <div className="lf__tile">
      <small>{label}</small>
      <b>
        {value}
        {unit && <i> {unit}</i>}
      </b>
      {sub && <span className={tone ? `is-${tone}` : undefined}>{sub}</span>}
    </div>
  );
}

const zuluHm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + "z";

/** The hero card's words for each phase: the number that matters most then, and what it means. */
function phaseHero(x: { t: Telemetry; phase: string; etaMs: number | null; plan: BridgeSnapshot["plan"]; g: BridgeSnapshot["progress"]; takeoffAt: number | null; pcNow: number }) {
  const { t, phase, etaMs, plan, g, takeoffAt, pcNow } = x;
  const fl = indicatedAlt(t) >= 10_000 ? `FL${Math.round(indicatedAlt(t) / 100)}` : `${int(indicatedAlt(t))} ft`;
  const lands = etaMs !== null ? `Lands ${zuluHm(pcNow + etaMs)}` : plan?.eteMin ? `${hhmm(plan.eteMin * 60_000)} planned` : "";
  if (t.onGround) {
    if (takeoffAt && t.gs < 40) return { phase: phase.toUpperCase(), right: plan ? `${plan.dep} → ${plan.arr}` : "", big: "Landed", caption: `after ${hhmm(pcNow - takeoffAt)} in the air` };
    return { phase: phase.toUpperCase(), right: lands, big: plan?.eteMin ? hhmm(plan.eteMin * 60_000) : "--:--", caption: plan ? `planned flight time to ${plan.arr}` : "No flight plan loaded" };
  }
  const todMin = g && g.todNm !== null && g.todNm > 0 && t.gs > 50 ? (g.todNm / t.gs) * 60 : null;
  if (todMin !== null && phase !== "Descent") return { phase: `${phase.toUpperCase()} · ${fl}`, right: lands, big: hhmm(todMin * 60_000), caption: `to top of descent · ${int(g!.todNm!)} nm` };
  if (etaMs !== null) return { phase: `${phase.toUpperCase()} · ${fl}`, right: plan ? `${plan.dep} → ${plan.arr}` : "", big: hhmm(etaMs), caption: `to ${plan?.arr ?? "arrival"} · ${lands.replace("Lands ", "lands ")}` };
  return { phase: `${phase.toUpperCase()} · ${fl}`, right: "", big: int(t.gs) + " kt", caption: "No flight plan: load one in SimBrief" };
}

