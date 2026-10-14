import type { ReactNode } from "react";
import type { EngineGauge, SystemsSnapshot, Telemetry } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";

const D = "--";
const int = (v: number) => Math.round(v).toLocaleString();
const f1 = (v: number) => v.toFixed(1);
const deg = (v: number) => `${String(((Math.round(v) % 360) + 360) % 360).padStart(3, "0")}°`;
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v)).toLocaleString()}`;
const freq = (v: number) => (v > 0 ? v.toFixed(3) : D);
const xpdr = (v: number) => String(Math.round(v)).padStart(4, "0");
const onOff = (v: boolean) => (v ? "On" : "Off");
const clock = (sec: number) => (sec <= 0 ? D : sec >= 3600 ? `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m` : `${Math.max(1, Math.round(sec / 60))} min`);
const XPDR_STATE = ["Off", "Standby", "Test", "On", "Alt", "Ground"];
const PROFILE: Record<string, string> = {
  fenixA320: "Fenix A320: readouts from its own cockpit",
  fbwA32nx: "FlyByWire: FCU lights from its own cockpit",
  pmdg737: "PMDG 737",
  iFly737Max: "iFly 737 MAX",
  studyCustom: "Study aircraft: standard readouts",
};

/** Cobalt's flight phase chip. */
export function flightPhase(t: Telemetry | null, paused: boolean): string {
  if (!t) return D;
  if (paused) return "Paused";
  if (t.onGround) return t.gs < 2 ? "Parked" : t.gs < 35 ? "Taxi" : "Roll";
  if (t.vs > 400) return "Climb";
  if (t.vs < -400) return "Descent";
  return "Cruise";
}

export type SystemsSection = "overview" | "engines" | "autopilot" | "fuel" | "electrical" | "cabin";
export const SYSTEMS_SECTIONS: Array<[SystemsSection, string]> = [
  ["overview", "Overview"],
  ["engines", "Engines"],
  ["autopilot", "Autopilot"],
  ["fuel", "Fuel"],
  ["electrical", "Electrical"],
  ["cabin", "Cabin and weather"],
];

function Row({ k, v, on, warn }: { k: string; v: ReactNode; on?: boolean; warn?: boolean }) {
  return (
    <div className={`sv__row${on ? " sv__row--on" : ""}${warn ? " sv__row--warn" : ""}`}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
function Bar({ pct, label }: { pct: number; label: string }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return (
    <div className="sv__bar" role="meter" aria-label={label} aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${p}%` }} />
    </div>
  );
}
function Panel({ title, children, wide, chip }: { title: string; children: ReactNode; wide?: boolean; chip?: ReactNode }) {
  return (
    <section className={`card sv__panel${wide ? " sv__panel--wide" : ""}`}>
      <div className="sv__head">
        <h2 className="card__title">{title}</h2>
        {chip}
      </div>
      {children}
    </section>
  );
}
function Chips({ items }: { items: Array<[string, boolean, boolean?]> }) {
  return (
    <div className="sv__chips">
      {items.map(([label, on, alert]) => (
        <span key={label} className={`sv__chip${on ? (alert ? " sv__chip--alert" : " sv__chip--on") : ""}`}>
          {label}
        </span>
      ))}
    </div>
  );
}

/** The main gauge depends on the engine: N1 on jets, torque on turboprops, RPM on pistons (Cobalt's engine kinds). */
function lead(e: EngineGauge): { label: string; text: string; pct: number } {
  if (e.engineType === "turboprop") return { label: "Torque", text: `${f1(e.torquePct)}%`, pct: e.torquePct };
  if (e.engineType === "piston") return { label: "RPM", text: int(e.rpm), pct: (e.rpm / 2800) * 100 };
  return { label: "N1", text: `${f1(e.n1)}%`, pct: e.n1 };
}

function EngineCard({ e, i, detail }: { e: EngineGauge; i: number; detail: boolean }) {
  const g = lead(e);
  return (
    <div className={`sv__eng${e.running ? " is-running" : ""}`}>
      <div className="sv__engHead">
        <small>Engine {i}</small>
        <span className={`sv__run${e.running ? " is-on" : ""}`}>{e.running ? "Running" : "Off"}</span>
      </div>
      <b className="sv__engBig">{g.text}</b>
      <small className="muted">
        {g.label} · {int(e.fuelFlow)} gph
      </small>
      <Bar pct={g.pct} label={`Engine ${i} ${g.label}`} />
      {detail && (
        <dl className="sv__list">
          {e.engineType === "turboprop" && <Row k="Propeller" v={`${int(e.rpm)} rpm`} />}
          {e.engineType !== "piston" && <Row k="N1" v={`${f1(e.n1)}%`} />}
          {e.engineType !== "piston" && <Row k="N2" v={`${f1(e.n2)}%`} />}
          <Row k="EGT" v={`${int(e.egt)} °C`} />
          <Row k="Oil pressure" v={`${int(e.oilPressure)} psi`} />
          <Row k="Oil temperature" v={`${int(e.oilTemp)} °C`} />
          {e.engineType === "jet" && <Row k="Vibration" v={e.vibration.toFixed(1)} warn={e.vibration > 4} />}
          <Row k="Anti-ice" v={onOff(e.antiIce)} on={e.antiIce} />
        </dl>
      )}
    </div>
  );
}

function engines(s: SystemsSnapshot): EngineGauge[] {
  return [s.engines.eng1, s.engines.eng2, s.engines.eng3, s.engines.eng4].slice(0, Math.max(1, Math.min(4, s.engines.count)));
}

const AP_MODES: Array<[keyof SystemsSnapshot["autopilot"], string]> = [
  ["apMaster", "AP"],
  ["fdActive", "FD"],
  ["apAltHold", "ALT"],
  ["apHDGHold", "HDG"],
  ["apSpdHold", "SPD"],
  ["apVSHold", "VS"],
  ["apFLCActive", "FLC"],
  ["apNAVHold", "NAV"],
  ["apAPRHold", "APR"],
  ["apGSHold", "GS"],
  ["apWingLeveler", "LVL"],
  ["autothrottleActive", "ATHR"],
];

function Autopilot({ s, airbus }: { s: SystemsSnapshot; airbus: boolean }) {
  const a = s.autopilot;
  const m = (sel: boolean) => (airbus ? (sel ? "" : " (managed)") : "");
  return (
    <>
      <Chips items={AP_MODES.map(([k, l]) => [l, a[k] as boolean])} />
      <dl className="sv__list">
        <Row k={`Speed${m(a.fcuSpeedSelected)}`} v={a.apMachHold ? `M ${a.apMachTarget.toFixed(2)}` : `${int(a.apSpdTarget)} kt`} />
        <Row k={`Heading${m(a.fcuHeadingSelected)}`} v={deg(a.apHDGTarget)} />
        <Row k={`Altitude${m(a.fcuAltSelected)}`} v={`${int(a.apAltTarget)} ft`} />
        <Row k="Vertical speed" v={`${signed(a.apVSTarget)} fpm`} />
        <Row k="Autothrottle" v={a.autothrottleActive ? "Active" : a.autothrottleArmed ? "Armed" : "Off"} on={a.autothrottleActive || a.autothrottleArmed} />
      </dl>
    </>
  );
}

/** Everything the aircraft is doing, read the same way for every aircraft. */
export function SystemsView({ b, section = "overview" }: { b: BridgeSnapshot; section?: SystemsSection }) {
  const s = b.systems;
  const t = b.latest?.data ?? null;
  if (!b.sim?.connected && !s) return <div className="empty">No simulator connected. Systems will appear here when the sim is live.</div>;
  if (!s) return <div className="empty">Reading the aircraft's systems…</div>;
  const phase = flightPhase(t, !!b.sim?.paused);
  const phaseChip = <span className="sv__phase">{phase}</span>;
  const eng = engines(s);
  const airbus = /airbus|a3[1-8]\d|fenix|fbw|a32nx/i.test(b.sim?.aircraftTitle ?? "") || s.profile === "fenixA320" || s.profile === "fbwA32nx";
  const w = s.warnings;
  const warnChips: Array<[string, boolean, boolean]> = [
    ["Master warning", w.masterWarning, true],
    ["Master caution", w.masterCaution, false],
    ["Stall", w.stallWarning, true],
    ["Overspeed", w.overspeedWarning, true],
  ];
  const fuelPct = s.fuel.capacity > 0 ? (s.fuel.totalGal / s.fuel.capacity) * 100 : 0;
  const kg = s.fuel.totalLbs * 0.45359237;
  const sf = s.surfaces;
  const nav = s.navigation;
  const doorsOpen = [s.doors.door1, s.doors.door2, s.doors.door3, s.doors.door4];

  const fuelPanel = (
    <Panel title="Fuel" chip={<span className="sv__phase">{Math.round(fuelPct)}%</span>}>
      <Bar pct={fuelPct} label="Fuel remaining" />
      <dl className="sv__list">
        <Row k="Total" v={`${int(s.fuel.totalLbs)} lb · ${int(kg)} kg`} />
        <Row k="Gallons" v={`${int(s.fuel.totalGal)} gal`} />
        <Row k="Left" v={`${f1(s.fuel.left)} gal`} />
        <Row k="Right" v={`${f1(s.fuel.right)} gal`} />
        <Row k="Centre" v={`${f1(s.fuel.center)} gal`} />
        <Row k="Capacity" v={`${int(s.fuel.capacity)} gal`} />
        <Row k="Burn" v={`${int(eng.reduce((n, e) => n + e.fuelFlow, 0) * s.fuel.weightPerGal)} lb/h`} />
        <Row k="Gross weight" v={`${int(s.weight.grossWeight)} lb`} />
      </dl>
    </Panel>
  );

  const surfaces = (
    <Panel title="Surfaces">
      <dl className="sv__list">
        <Row k="Flaps" v={sf.flapsDetents > 0 ? `${sf.flapsHandle === 0 ? "Up" : `${sf.flapsHandle} of ${sf.flapsDetents}`} · ${Math.round(sf.flapsLeft)}%` : `${Math.round(sf.flapsLeft)}%`} />
        <Row k="Spoilers" v={`${Math.round(sf.spoilers)}%${sf.spoilersArmed ? " · Armed" : ""}`} on={sf.spoilersArmed} />
        <Row k="Gear" v={sf.gearHandle ? (sf.gearExtended >= 99 ? "Down" : `Extending ${Math.round(sf.gearExtended)}%`) : sf.gearExtended <= 1 ? "Up" : `Retracting ${Math.round(sf.gearExtended)}%`} on={sf.gearHandle} />
        <Row k="Gear left / nose / right" v={`${sf.gearLeft} / ${sf.gearNose} / ${sf.gearRight}%`} />
        <Row k="Parking brake" v={sf.parkingBrake ? "Set" : "Off"} on={sf.parkingBrake} />
      </dl>
    </Panel>
  );

  const radios = (
    <Panel title="Radios and navigation">
      <dl className="sv__list">
        <Row k="COM 1" v={`${freq(nav.com1Active)} / ${freq(nav.com1Standby)}`} />
        <Row k="COM 2" v={`${freq(nav.com2Active)} / ${freq(nav.com2Standby)}`} />
        <Row k="NAV 1" v={freq(nav.nav1Active)} />
        <Row k="Squawk" v={`${xpdr(nav.xpdrCode)} · ${XPDR_STATE[nav.xpdrState] ?? D}`} />
        <Row k="Altimeter" v={`${f1(nav.baroMb)} hPa`} />
        <Row k="Next waypoint" v={nav.wpNextId ? `${nav.wpNextId} · ${f1(nav.wpDistanceNm)} nm · ${clock(nav.wpEteSec)}` : D} />
        <Row k="Destination" v={clock(nav.destEteSec)} />
        {nav.wpCount > 0 && <Row k="Flight plan" v={`Leg ${nav.wpIndex} of ${nav.wpCount}`} />}
      </dl>
    </Panel>
  );

  const electrical = (
    <Panel title="Electrical and hydraulics">
      <dl className="sv__list">
        <Row k="Main bus" v={`${f1(s.electrical.busVoltage)} V`} />
        <Row k="Battery" v={`${f1(s.electrical.batteryVoltage)} V`} />
        <Row k="External power" v={onOff(s.electrical.extPower)} on={s.electrical.extPower} />
        <Row k="APU" v={onOff(s.electrical.apuSwitch)} on={s.electrical.apuSwitch} />
        <Row k="APU generator" v={onOff(s.electrical.apuGenActive)} on={s.electrical.apuGenActive} />
        <Row k="Hydraulics 1 / 2" v={`${int(s.electrical.hydPressure1)} / ${int(s.electrical.hydPressure2)} psi`} />
      </dl>
    </Panel>
  );

  const cabin = (
    <>
      <Panel title="Pressurization">
        <dl className="sv__list">
          <Row k="Cabin altitude" v={`${int(s.pressurization.cabinAlt)} ft`} warn={s.pressurization.cabinAlt > 10000} />
          <Row k="Cabin rate" v={`${signed(s.pressurization.cabinRate)} fpm`} />
          <Row k="Differential" v={`${f1(s.pressurization.diffPressure)} psi`} />
        </dl>
      </Panel>
      <Panel title="Doors and warnings">
        <Chips items={doorsOpen.map((o, i) => [`Door ${i + 1} ${o ? "open" : "closed"}`, o])} />
        <Chips items={warnChips} />
      </Panel>
      <Panel title="Lights">
        <Chips items={(["beacon", "nav", "strobe", "landing", "taxi", "logo", "cabin"] as const).map((k) => [k[0]!.toUpperCase() + k.slice(1), s.lights[k]])} />
      </Panel>
      <Panel title="Environment and cabin">
        <dl className="sv__list">
          <Row k="Outside air" v={`${f1(s.environment.oat)} °C`} />
          <Row k="Wind" v={`${deg(s.environment.windDir)} / ${int(s.environment.windSpeed)} kt`} />
          <Row k="Sea-level pressure" v={`${f1(s.environment.qnh)} hPa`} />
          <Row k="Pitot heat" v={onOff(s.systems.pitotHeat)} on={s.systems.pitotHeat} />
          <Row k="Seat belt sign" v={onOff(s.systems.seatbeltSign)} on={s.systems.seatbeltSign} />
          <Row k="Sim rate" v={`${f1(s.meta.simRate)}×`} />
        </dl>
      </Panel>
    </>
  );

  const alarms = warnChips.filter(([, on]) => on);
  return (
    <div className="sv">
      {alarms.length > 0 && (
        <section className="card sv__alerts" role="alert">
          <strong>{alarms.map(([l]) => l).join(" · ")}</strong>
        </section>
      )}
      {section === "overview" && (
        <>
          <section className="card sv__panel sv__panel--wide sv__aircraft">
            <b>{b.sim?.aircraftTitle || "Aircraft"}</b>
            {PROFILE[s.profile] && <small className="muted">{PROFILE[s.profile]}</small>}
          </section>
          <Panel title="Instruments" wide chip={phaseChip}>
            <div className="sv__tiles">
              <div><b>{t ? int(t.ias) : D}</b><small>kt IAS</small></div>
              <div><b>{t ? int(t.altMsl) : D}</b><small>ft MSL</small></div>
              <div><b>{t ? deg(t.hdgMag) : D}</b><small>HDG</small></div>
              <div><b>{t ? signed(t.vs) : D}</b><small>fpm</small></div>
              <div><b>{t ? t.mach.toFixed(3) : D}</b><small>Mach</small></div>
              <div><b>{t ? int(t.gs) : D}</b><small>kt GS</small></div>
              {eng.slice(0, 2).map((e, i) => (
                <div key={i}>
                  <b>{lead(e).text}</b>
                  <small>
                    {lead(e).label} {eng.length === 2 ? (i ? "R" : "L") : i + 1}
                  </small>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Sim rate" wide chip={<span className="sv__big">{f1(s.meta.simRate)}×</span>}>
            {s.meta.maxSimRate > 1 && <p className="muted sv__note">Up to {s.meta.maxSimRate}× used on this flight.</p>}
          </Panel>
          <Panel title="Engines" wide>
            <div className="sv__engs">{eng.map((e, i) => <EngineCard key={i} e={e} i={i + 1} detail={false} />)}</div>
          </Panel>
          <Panel title="Autopilot">
            <Autopilot s={s} airbus={airbus} />
          </Panel>
          {fuelPanel}
          {surfaces}
          {radios}
          {electrical}
          {cabin}
        </>
      )}
      {section === "engines" && (
        <Panel title="Engines" wide chip={phaseChip}>
          <div className="sv__engs">{eng.map((e, i) => <EngineCard key={i} e={e} i={i + 1} detail />)}</div>
        </Panel>
      )}
      {section === "autopilot" && (
        <>
          <Panel title="Autopilot" wide>
            <Autopilot s={s} airbus={airbus} />
          </Panel>
          {surfaces}
          {radios}
        </>
      )}
      {section === "fuel" && fuelPanel}
      {section === "electrical" && electrical}
      {section === "cabin" && cabin}
    </div>
  );
}
