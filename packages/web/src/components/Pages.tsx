import { CduView } from "./CduView";
import { useEffect, useState, type ReactNode } from "react";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { mapBus } from "../lib/mapbus";
import { setThemePref, useAirlineTheme, useTheme, type ThemePref } from "../lib/theme";
import { int } from "../lib/format";
import { AtcCard, NetworkChip } from "./AtcCard";
import { AppCard } from "./AppCard";
import { CockpitView, PairThisDevice } from "./Cockpit";
import { EfbView } from "./EfbView";
import { SimView } from "./SimView";
import { AtlasPage, MyFlights } from "./FlightsPages";
import { NotifyCard } from "./NotifyCard";
import { ZuluClock } from "./StatusBar";
import { SYSTEMS_SECTIONS, SystemsView, type SystemsSection } from "./SystemsView";

/** Horizontal choice of pages inside a tab, like the segmented control at the top of the Flights sheet. */
export function Segments<T extends string>({ value, onChange, items, pills }: { value: T; onChange: (v: T) => void; items: Array<[T, string]>; pills?: boolean }) {
  return (
    <div className={pills ? "ms__pills" : "ms__seg"} role="tablist">
      {items.map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Traffic({ b }: { b: BridgeSnapshot }) {
  const t = b.latest?.data;
  const rad = Math.PI / 180;
  const away = (p: { lat: number; lon: number; distNm: number }) => {
    if (!t) return p.distNm;
    const a = Math.sin(((p.lat - t.lat) * rad) / 2) ** 2 + Math.cos(t.lat * rad) * Math.cos(p.lat * rad) * Math.sin(((p.lon - t.lon) * rad) / 2) ** 2;
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
  };
  const nearby = (b.traffic?.pilots ?? [])
    .map((p) => ({ p, d: away(p) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 15);
  return (
    <>
      <div className="ms__chips">
        <NetworkChip b={b} />
      </div>
      <AtcCard b={b} />
      {nearby.length > 0 && (
        <section className="card">
          <h2 className="card__title">Nearest traffic{t ? "" : " (to the map centre)"}</h2>
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Callsign</th>
                <th scope="col">Type</th>
                <th scope="col">Route</th>
                <th scope="col" className="num">Alt ft</th>
                <th scope="col" className="num">nm</th>
              </tr>
            </thead>
            <tbody>
              {nearby.map(({ p, d }) => (
                <tr key={p.callsign}>
                  <td>
                    <button type="button" className="linkish" onClick={() => mapBus.focus(p.callsign)}>
                      {p.callsign}
                    </button>
                  </td>
                  <td>{p.type ?? "–"}</td>
                  <td>{p.dep || p.arr ? `${p.dep ?? "?"}–${p.arr ?? "?"}` : "–"}</td>
                  <td className="num">{int(p.alt)}</td>
                  <td className="num">{int(d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

type FlightsSeg = "live" | "mine" | "traffic";
const segFromHash = (): FlightsSeg => {
  const s = window.location.hash.split("/")[1];
  return s === "mine" || s === "traffic" ? s : "live";
};
/** Flights: the flight in progress, your saved flights, and the network around you. */
export function FlightsTab({ b, live }: { b: BridgeSnapshot; live: ReactNode }) {
  const [seg, setSeg] = useState<FlightsSeg>(segFromHash);
  // The VBuddy window on the PC picks the page with #flights/mine and so on.
  useEffect(() => {
    const on = () => setSeg(segFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <>
      <Segments
        value={seg}
        onChange={setSeg}
        items={[
          ["live", "Live"],
          ["mine", "My flights"],
          ["traffic", "Traffic"],
        ]}
      />
      {seg === "live" ? live : seg === "mine" ? <MyFlights b={b} /> : <Traffic b={b} />}
    </>
  );
}

/** The Fenix EFB only means something in the Fenix. */
const isFenix = (b: BridgeSnapshot) => /fenix|fnx/i.test(b.sim?.aircraftTitle ?? "") || b.cockpit?.aircraft === "fenix-a320" || b.cockpit?.aircraft === "mock";
type SysSeg = SystemsSection | "controls" | "view" | "efb" | "cdu";
const sysFromHash = (): SysSeg => {
  const s = window.location.hash.split("/")[1];
  return s === "efb" || s === "controls" || s === "view" || s === "cdu" ? s : "overview";
};
/** Systems: what the aircraft is doing, and the controls. */
export function SystemsTab({ b }: { b: BridgeSnapshot }) {
  const [picked, setSeg] = useState<SysSeg>(sysFromHash);
  const fenix = isFenix(b);
  const cdu = !!b.panel?.cdu;
  const seg: SysSeg = (picked === "efb" && !fenix) || (picked === "cdu" && !cdu) ? "overview" : picked;
  // The VBuddy window on the PC picks Systems or EFB with the hash.
  useEffect(() => {
    const on = () => window.location.hash.startsWith("#systems") && setSeg(sysFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <>
      <Segments<SysSeg> pills value={seg} onChange={setSeg} items={[...SYSTEMS_SECTIONS, ["controls", "Controls"], ["view", "Sim view"], ...(fenix ? ([["efb", "Fenix EFB"]] as Array<[SysSeg, string]>) : []), ...(cdu ? ([["cdu", "CDU"]] as Array<[SysSeg, string]>) : [])]} />
      {seg === "controls" ? <CockpitView b={b} /> : seg === "view" ? <SimView b={b} /> : seg === "efb" ? <EfbView /> : seg === "cdu" ? <CduView b={b} /> : <SystemsView b={b} section={seg} />}
    </>
  );
}

type LogSeg = "overview" | "mine";
const logFromHash = (): LogSeg => {
  const [tab, seg] = window.location.hash.slice(1).split("/");
  return seg === "mine" || (tab === "flights" && seg === "mine") ? "mine" : "overview";
};
/** Logbook: your record at a glance and every landing, and the flights you've flown and plan to fly. */
export function AtlasTab({ b }: { b: BridgeSnapshot }) {
  const [seg, setSeg] = useState<LogSeg>(logFromHash);
  useEffect(() => {
    const on = () => window.location.hash.startsWith("#atlas") && setSeg(logFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return (
    <>
      <Segments<LogSeg>
        value={seg}
        onChange={setSeg}
        items={[
          ["overview", "Overview"],
          ["mine", "My flights"],
        ]}
      />
      {seg === "mine" ? <MyFlights b={b} /> : <AtlasPage b={b} />}
    </>
  );
}

type CommsSeg = "radio" | "traffic";
/** Comms: radios, messages and ACARS, and the network traffic and ATC around you. */
export function CommsTab({ b, comms }: { b: BridgeSnapshot; comms: ReactNode }) {
  const [seg, setSeg] = useState<CommsSeg>(() => (window.location.hash.split("/")[1] === "traffic" ? "traffic" : "radio"));
  return (
    <>
      <Segments<CommsSeg>
        value={seg}
        onChange={setSeg}
        items={[
          ["radio", "Radio and messages"],
          ["traffic", "Traffic"],
        ]}
      />
      {seg === "traffic" ? <Traffic b={b} /> : comms}
    </>
  );
}

const THEMES: Array<[ThemePref, string]> = [
  ["system", "Same as device"],
  ["light", "Light"],
  ["dark", "Dark"],
];
/** Settings and notifications, behind the round button at the top right of the sheet. */
export function MeTab({ b, openAlerts }: { b: BridgeSnapshot; openAlerts: () => void }) {
  const theme = useTheme();
  const airline = useAirlineTheme();
  const now = b.latest ? Date.now() - b.latestAt : null;
  const control = b.control;
  return (
    <>
      {control && !control.allowed && control.reason === "not-paired" && <PairThisDevice />}
      <section className="card">
        <h2 className="card__title">Appearance</h2>
        <Segments<ThemePref> value={theme.pref} onChange={setThemePref} items={THEMES} />
        <label className="sw" style={{ marginTop: 12 }}>
          <span className="sw__text">
            <b>Airline colours</b>
            <small>{airline.airline ? `Now: ${airline.airline.name}.` : "When you connect to VATSIM with an airline callsign (QTR123, IGO45…), the app takes on its colours."}</small>
          </span>
          <input type="checkbox" role="switch" checked={airline.on} onChange={(e) => airline.set(e.target.checked)} />
          <i aria-hidden />
        </label>
        <p className="muted ms__clock">
          Zulu time <ZuluClock />
        </p>
      </section>
      {!control?.locked && <NotifyCard b={b} open={openAlerts} />}
      <AppCard />
      <section className="card">
        <h2 className="card__title">Map credits</h2>
        <p className="muted">
          Map imagery and labels © Esri and their data providers. Online ATC sectors: VATSpy data (CC BY-SA 4.0) and SimAware TRACON. Map by Leaflet.
        </p>
      </section>
      <section className="card">
        <h2 className="card__title">Connection</h2>
        <dl className="sv__list">
          <div className="sv__row"><dt>Data</dt><dd>{now === null ? "–" : `${Math.round(now / 1000)} s ago`}</dd></div>
          <div className="sv__row"><dt>Update rate</dt><dd>{b.telemetryHz || "–"} Hz</dd></div>
          <div className="sv__row"><dt>Missed frames</dt><dd>{b.missedFrames}</dd></div>
          <div className="sv__row"><dt>Reconnects</dt><dd>{b.reconnects}</dd></div>
          {b.sim?.simName && <div className="sv__row"><dt>Simulator</dt><dd>{b.sim.simName}</dd></div>}
          {b.bridgeVersion && <div className="sv__row"><dt>Bridge</dt><dd>v{b.bridgeVersion}</dd></div>}
        </dl>
      </section>
    </>
  );
}
