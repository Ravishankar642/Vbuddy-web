import { useEffect, useState } from "react";
import { UpdateBanner } from "./components/AppCard";
import { PairThisDevice } from "./components/Cockpit";
import { CommsView } from "./components/CommsView";
import { playChime, unlockAudioOnFirstTouch } from "./lib/chime";
import { AtlasTab, CommsTab, MeTab, SystemsTab } from "./components/Pages";
import { Shell, type Tab } from "./components/Shell";
import { LiveFlight } from "./components/LiveFlight";
import { NotificationsPage, usePushResync } from "./components/NotifyCard";
import { setThemeCallsign } from "./lib/theme";
import { BriefView } from "./components/BriefView";
import { GroundView } from "./components/GroundView";
import { RatingBadge } from "./components/LandingView";
import { onAttention, useBridge, useBridgeActions, useNow } from "./lib/useBridge";
import { ago, coord, fixed, hdg, int, signed, signed1 } from "./lib/format";

const OLD_HASHES: Record<string, Tab> = { flight: "flights", map: "flights", cockpit: "systems", inbox: "comms", brief: "search", landing: "atlas", notifications: "alerts" };
const TAB_IDS: Tab[] = ["flights", "ground", "systems", "comms", "atlas", "search", "me", "alerts"];
const TITLES: Record<Tab, string> = { flights: "Flights", ground: "Ground", systems: "Systems", comms: "Comms", atlas: "Logbook", search: "Search", me: "Settings", alerts: "Notifications" };
const tabFromHash = (): Tab => {
  const [h = "", seg] = window.location.hash.slice(1).split("/");
  // My flights and Traffic used to be pages of the Flights tab.
  if (h === "flights" && seg === "mine") return "atlas";
  if (h === "flights" && seg === "traffic") return "comms";
  if (h === "logbook") return "atlas";
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
      <LiveFlight b={b} t={t} now={now} />
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
        live
      ) : tab === "ground" ? (
        <GroundView b={b} />
      ) : tab === "systems" ? (
        <SystemsTab b={b} />
      ) : tab === "comms" ? (
        <CommsTab b={b} comms={<CommsView b={b} />} />
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
