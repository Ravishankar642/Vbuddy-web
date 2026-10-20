import { useEffect, useState } from "react";
import type { FcuState, Telemetry } from "@vbuddy/protocol";
import { UpdateBanner } from "./components/AppCard";
import { AtcCard } from "./components/AtcCard";
import { PairThisDevice } from "./components/Cockpit";
import { CommsView } from "./components/CommsView";
import { playChime, unlockAudioOnFirstTouch } from "./lib/chime";
import { AtlasTab, FlightsTab, MeTab, SystemsTab } from "./components/Pages";
import { Shell, type Tab } from "./components/Shell";
import { Tile } from "./components/ui";
import { FlightHero } from "./components/Hero";
import { FlightPlate } from "./components/FlightPlate";
import { NotificationsPage, usePushResync } from "./components/NotifyCard";
import { setThemeCallsign } from "./lib/theme";
import { BriefView } from "./components/BriefView";
import { RatingBadge } from "./components/LandingView";
import { onAttention, useBridge, useBridgeActions, useNow } from "./lib/useBridge";
import { ago, coord, fixed, hdg, int, signed, signed1 } from "./lib/format";

/**
 * The sim's generic "autopilot master" is not driven by every add-on (the Fenix keeps its own), so when the aircraft's
 * own FCU is known its AP lights count too.
 */
function apState(t: Telemetry, fcu: FcuState | null): { on: boolean; text: string } {
  const l = fcu?.lights;
  if (l && (l.ap1 || l.ap2)) return { on: true, text: `Autopilot ${l.ap1 && l.ap2 ? "AP1 + AP2" : l.ap1 ? "AP1" : "AP2"}` };
  return t.ap.master ? { on: true, text: "Autopilot on" } : { on: false, text: "Autopilot off" };
}

function Instruments({ t, aircraft, fcu }: { t: Telemetry; aircraft: string; fcu: FcuState | null }) {
  const ap = apState(t, fcu);
  return (
    <>
      <FlightHero t={t} aircraft={aircraft} />
      <div className="chips" aria-label="Aircraft state">
        <span className={`chip-st${t.gearDown ? " is-on" : ""}`}><i />Gear {t.gearDown ? "down" : "up"}</span>
        <span className={`chip-st${t.flapsIndex > 0 ? " is-on" : ""}`}><i />Flaps {t.flapsIndex}</span>
        <span className={`chip-st${t.parkingBrake ? " is-warn" : ""}`}><i />Parking brake {t.parkingBrake ? "on" : "off"}</span>
        <span className={`chip-st${ap.on ? " is-on" : ""}`}><i />{ap.text}</span>
        {fcu && <span className={`chip-st${fcu.lights.athr ? " is-on" : ""}`}><i />Autothrust {fcu.lights.athr ? "on" : "off"}</span>}
        {t.simRate !== 1 && <span className="chip-st is-warn"><i />Sim rate ×{t.simRate}</span>}
      </div>
      <h2 className="sec">Autopilot selected</h2>
      <div className="mcp-strip">
        {fcu && fcu.power ? (
          <>
            <div className="mcp-strip__cell"><small>Speed{fcu.spdManaged ? " (managed)" : ""}</small><b>{fcu.spdDashed ? "---" : fcu.spdIsMach ? fcu.spd.toFixed(2) : int(fcu.spd)}</b></div>
            <div className="mcp-strip__cell"><small>Heading{fcu.hdgManaged ? " (managed)" : ""}</small><b>{fcu.hdgDashed ? "---" : hdg(fcu.hdg)}</b></div>
            <div className="mcp-strip__cell"><small>Altitude{fcu.altManaged ? " (managed)" : ""}</small><b>{int(fcu.alt)}</b></div>
            <div className="mcp-strip__cell"><small>{fcu.trkFpa ? "Flight path angle" : "Vertical speed"}</small><b>{fcu.vsDashed ? "---" : fcu.trkFpa ? signed1(fcu.vs / 1000) : signed(fcu.vs)}</b></div>
          </>
        ) : (
          <>
            <div className="mcp-strip__cell"><small>Speed</small><b>{int(t.ap.spdSel)}</b></div>
            <div className="mcp-strip__cell"><small>Heading</small><b>{hdg(t.ap.hdgSel)}</b></div>
            <div className="mcp-strip__cell"><small>Altitude</small><b>{int(t.ap.altSel)}</b></div>
            <div className="mcp-strip__cell"><small>Vertical speed</small><b>{signed(t.ap.vsSel)}</b></div>
          </>
        )}
      </div>
      <div className="grid" style={{ marginTop: 12 }}>
        <Tile label="Attitude" value={<>{signed(t.pitch)}° <span className="sep">/</span> {signed(t.bank)}°</>} sub="pitch / bank" />
        <Tile label="G load" value={fixed(t.gForce, 2)} unit="g" tone={t.gForce > 1.6 || t.gForce < 0.4 ? "warn" : undefined} />
        <Tile label="Position" value={<span className="coord">{coord(t.lat, true)}<br />{coord(t.lon, false)}</span>} sub={`Ground ${int(t.groundElev)} ft`} />
      </div>
    </>
  );
}

const OLD_HASHES: Record<string, Tab> = { flight: "flights", map: "flights", cockpit: "systems", inbox: "comms", brief: "search", landing: "atlas", notifications: "alerts" };
const TAB_IDS: Tab[] = ["flights", "systems", "comms", "atlas", "search", "me", "alerts"];
const TITLES: Record<Tab, string> = { flights: "Flights", systems: "Systems", comms: "Comms", atlas: "Atlas", search: "Search", me: "Settings", alerts: "Notifications" };
const tabFromHash = (): Tab => {
  const h = window.location.hash.slice(1).split("/")[0] ?? "";
  return (TAB_IDS as string[]).includes(h) ? (h as Tab) : (OLD_HASHES[h] ?? "flights");
};

/** The tab lives in the URL hash so a reload (or a shared link) lands on the same one. */
function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [tab, (t) => (window.location.hash = `#${t}`)];
}

const TOAST_MS = 30_000;
const EVENT_TOAST_MS = 12_000;
const ATC_TOAST_MS = 25_000;
const FLIGHT_ALERT_MS = 30_000;

export function App() {
  const b = useBridge();
  const { dismissNewLanding, dismissAtcAlert, dismissFlightAlert, dismissFlightEvent, dismissAttention } = useBridgeActions();
  const [tab, setTab] = useTab();
  const now = useNow(500);
  const t = b.latest?.data ?? null;
  const age = b.latest ? now - b.latestAt : Infinity;

  // A landing that happens while you're on the Flight tab (or while the tablet was offline) gets a toast.
  const toast = tab === "flights" ? b.newLanding : null;
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(dismissNewLanding, TOAST_MS);
    return () => clearTimeout(id);
  }, [toast, dismissNewLanding]);

  // A chime for each ATC call or DM that arrives while the app is open; the badge and push cover the rest.
  useEffect(() => {
    unlockAudioOnFirstTouch();
    const off = onAttention(() => void playChime());
    return () => {
      off();
    };
  }, []);
  // Unread count on the home-screen icon where the browser supports it.
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try {
      if (b.attentionUnread > 0) void nav.setAppBadge?.(b.attentionUnread);
      else void nav.clearAppBadge?.();
    } catch {
      /* not supported */
    }
  }, [b.attentionUnread]);
  const msgToast = tab === "comms" ? null : b.lastAttention;

  // The app takes on the colours of the airline you're connected to VATSIM as.
  usePushResync(b);
  const vatsimCallsign = b.comms?.net.connected ? b.comms.net.callsign : null;
  useEffect(() => setThemeCallsign(vatsimCallsign), [vatsimCallsign]);

  // Takeoff, top of climb, the plan loaded and so on: a short note.
  const flightEvent = b.flightEvent;
  useEffect(() => {
    if (!flightEvent) return;
    const id = setTimeout(dismissFlightEvent, EVENT_TOAST_MS);
    return () => clearTimeout(id);
  }, [flightEvent, dismissFlightEvent]);
  useEffect(() => {
    if (!msgToast) return;
    const id = setTimeout(dismissAttention, 15_000);
    return () => clearTimeout(id);
  }, [msgToast, dismissAttention]);

  const atcAlert = b.atcAlert;
  useEffect(() => {
    if (!atcAlert) return;
    const id = setTimeout(dismissAtcAlert, ATC_TOAST_MS);
    return () => clearTimeout(id);
  }, [atcAlert, dismissAtcAlert]);

  const rawFlightAlert = b.flightAlert;
  // The autopilot-off warning is opt-in; everything else follows the app's normal alerts.
  const flightAlert = rawFlightAlert && rawFlightAlert.kind === "autopilot" && !b.push?.prefs.apOff ? null : rawFlightAlert;
  useEffect(() => {
    if (!flightAlert) return;
    void playChime();
    const id = setTimeout(dismissFlightAlert, FLIGHT_ALERT_MS);
    return () => clearTimeout(id);
  }, [flightAlert, dismissFlightAlert]);

  const overlay = (
    <>
      <UpdateBanner />
      {flightAlert && (
        <div className={`toast toast--${flightAlert.severity}`} role="alert">
          <span className="toast__icon" aria-hidden="true">
            {flightAlert.severity === "warning" ? "⚠" : "!"}
          </span>
          <span className="toast__text">
            <b>{flightAlert.title}</b>
            <span>{flightAlert.text}</span>
          </span>
          <button type="button" className="btn btn--ghost" aria-label="Dismiss" onClick={dismissFlightAlert}>
            ✕
          </button>
        </div>
      )}
      {flightEvent && (
        <div className={`toast toast--event${flightEvent.kind === "simLost" ? " toast--warning" : ""}`} role="status" aria-live="polite">
          <span className="toast__icon" aria-hidden="true">
            {flightEvent.kind === "takeoff" ? "↗" : flightEvent.kind === "gate" ? "■" : flightEvent.kind === "planLoaded" ? "☰" : flightEvent.kind === "simLost" ? "⚠" : "•"}
          </span>
          <span className="toast__text">
            <b>{flightEvent.title}</b>
            <span>{flightEvent.text}</span>
          </span>
          <button type="button" className="btn btn--ghost" aria-label="Dismiss" onClick={dismissFlightEvent}>
            ✕
          </button>
        </div>
      )}
      {atcAlert && (
        <div className="toast toast--atc" role="status" aria-live="polite">
          <span className="toast__icon" aria-hidden="true">
            {atcAlert.kind === "ahead" ? "↗" : "☎"}
          </span>
          <span className="toast__text">
            <b>{atcAlert.kind === "ahead" ? "Coming up" : atcAlert.kind === "unicom" ? "Leaving ATC coverage" : "New controller"}</b>
            <span>{atcAlert.text}</span>
          </span>
          <button type="button" className="btn btn--ghost" aria-label="Dismiss" onClick={dismissAtcAlert}>
            ✕
          </button>
        </div>
      )}
      {msgToast && (
        <div className="toast toast--atc" role="status" aria-live="polite">
          <span className="toast__icon" aria-hidden="true">
            ✉
          </span>
          <span className="toast__text">
            <b>{msgToast.kind === "private" ? `Message from ${msgToast.from}` : msgToast.from}</b>
            <span>{msgToast.text.length > 90 ? msgToast.text.slice(0, 90) + "…" : msgToast.text}</span>
          </span>
          <button type="button" className="btn btn--primary" onClick={() => { dismissAttention(); setTab("comms"); }}>
            Open
          </button>
          <button type="button" className="btn btn--ghost" aria-label="Dismiss" onClick={dismissAttention}>
            ✕
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <RatingBadge rating={toast.rating} />
          <span className="toast__text">
            <b>{int(toast.vsFpm)} fpm</b>
            <span>touchdown · {fixed(toast.gPeak, 2)} g</span>
          </span>
          <button type="button" className="btn btn--primary" onClick={() => setTab("atlas")}>
            View
          </button>
          <button type="button" className="btn btn--ghost" aria-label="Dismiss" onClick={dismissNewLanding}>
            ✕
          </button>
        </div>
      )}
    </>
  );

  const live = t ? (
    <div className={age > 3000 ? "stale" : undefined}>
      <FlightPlate b={b} />
      <Instruments t={t} aircraft={b.sim?.aircraftTitle ?? ""} fcu={b.cockpit} />
      <AtcCard b={b} compact />
    </div>
  ) : (
    <div className="empty">
      <b>No flight active</b>
      <br />
      {b.sim?.connected ? "Your sim is connected but isn't in a flight yet. Load an aircraft and the flight will show here automatically." : "Start Microsoft Flight Simulator and your flight will show here."}
    </div>
  );

  return (
    <Shell b={b} tab={tab} setTab={setTab} title={TITLES[tab]} overlay={overlay}>
      {b.control?.locked ? (
        <PairThisDevice gate />
      ) : tab === "flights" ? (
        <FlightsTab b={b} live={live} />
      ) : tab === "systems" ? (
        <SystemsTab b={b} />
      ) : tab === "comms" ? (
        <CommsView b={b} />
      ) : tab === "atlas" ? (
        <AtlasTab b={b} />
      ) : tab === "search" ? (
        <BriefView />
      ) : tab === "alerts" ? (
        <NotificationsPage b={b} />
      ) : (
        <MeTab b={b} openAlerts={() => setTab("alerts")} />
      )}
    </Shell>
  );
}
