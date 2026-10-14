import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { mapBus } from "../lib/mapbus";
import { MAP_STYLES, useMapStyle } from "../lib/mapstyle";
import { Grab, useAppHeight, useSheet, WIDE_PANEL_PX } from "./Sheet";
import { IconAtlas, IconBroadcast, IconChip, IconClose, IconFlight, IconGlobe, IconInbox, IconLayers, IconLocate, IconRefresh, IconSearch } from "./icons";

const MapView = lazy(() => import("./MapView"));

export type Tab = "flights" | "systems" | "inbox" | "atlas" | "search" | "me";
const TABS: Array<[Exclude<Tab, "search" | "me">, string, () => ReturnType<typeof IconFlight>]> = [
  ["flights", "Flights", IconFlight],
  ["systems", "Systems", IconChip],
  ["inbox", "Inbox", IconInbox],
  ["atlas", "Atlas", IconAtlas],
];

const isLocalHost = (h: string) => /^(localhost|127\.|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.endsWith(".local");

/** How the app reaches the PC, and what the simulator is doing. */
function bridgeStatus(b: BridgeSnapshot): { tone: "ok" | "warn" | "bad"; head: string; sub: string; retry: boolean } {
  const where = isLocalHost(window.location.hostname) ? "Local" : "Remote";
  if (b.link !== "open") return { tone: "bad", head: "Not connected", sub: b.link === "waiting" ? `Retrying in ${b.retryIn}s` : "Connecting…", retry: true };
  if (!b.sim?.connected) return { tone: "warn", head: where, sub: "Sim waiting", retry: false };
  if (b.sim.paused) return { tone: "ok", head: where, sub: "Sim paused", retry: false };
  return { tone: "ok", head: where, sub: b.sim.source === "mock" ? "Mock flight" : "Sim connected", retry: false };
}

interface ShellProps {
  b: BridgeSnapshot;
  tab: Tab;
  setTab: (t: Tab) => void;
  title: string;
  /** Buttons at the left of the sheet's title. */
  left?: ReactNode;
  /** Toasts and banners floating over the map. */
  overlay?: ReactNode;
  children: ReactNode;
}

/** The whole screen: a full-bleed map, round map buttons, a bridge status pill, and a bottom sheet with the page and the tab bar. */
export function Shell({ b, tab, setTab, title, left, overlay, children }: ShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const appHeight = useAppHeight();
  const sheet = useSheet(rootRef);
  const [mapStyle, cycleMapStyle] = useMapStyle();
  const [follow, setFollow] = useState(true);
  const [traffic, setTraffic] = useState(true);
  const [sectors, setSectors] = useState(true);
  const st = bridgeStatus(b);
  const locked = !!b.control?.locked;
  const inset = sheet.wide ? { bottom: 0, left: WIDE_PANEL_PX } : { bottom: sheet.height, left: 0 };
  const pick = (t: Tab) => {
    setTab(t);
    if (!sheet.wide && sheet.detent === "low") sheet.setDetent("mid");
  };
  const { wide, setDetent } = sheet;
  useEffect(() => {
    mapBus.lowerSheet = () => {
      if (!wide) setDetent("low");
    };
    return () => {
      mapBus.lowerSheet = () => {};
    };
  }, [wide, setDetent]);
  const styleLabel = MAP_STYLES.find(([k]) => k === mapStyle)![1];

  return (
    <div className="ms" ref={rootRef} style={{ ["--sheet-h" as string]: `${sheet.wide ? 0 : sheet.height}px`, ...(appHeight ? { height: appHeight } : {}) }}>
      <div className="ms__map">
        <Suspense fallback={null}>
          <MapView b={b} follow={follow} onFollow={setFollow} showTraffic={traffic} showSectors={sectors} inset={inset} mapStyle={mapStyle} />
        </Suspense>
      </div>

      <div className="ms__top">
        <button type="button" className="ms__pill" onClick={st.retry ? () => window.location.reload() : undefined} aria-label={`${st.head}. ${st.sub}`}>
          <i className={`ms__dot ms__dot--${st.tone}`} />
          <span className="ms__pillText">
            <span>
              <b>{st.head}</b> <em>Bridge</em>
            </span>
            <small>{st.sub}</small>
          </span>
          {st.retry && <IconRefresh />}
        </button>
        <div className="ms__fabs">
          <button type="button" className="ms__fab" onClick={cycleMapStyle} aria-label={`Map style: ${styleLabel}. Tap to change.`} title={`Map style: ${styleLabel}`}>
            <IconGlobe />
          </button>
          <button type="button" className={`ms__fab${traffic ? " is-on" : ""}`} aria-pressed={traffic} onClick={() => setTraffic(!traffic)} title="Network traffic">
            <IconBroadcast />
          </button>
          <button type="button" className={`ms__fab${sectors ? " is-on" : ""}`} aria-pressed={sectors} onClick={() => setSectors(!sectors)} title="ATC sectors and airports">
            <IconLayers />
          </button>
          <button type="button" className={`ms__fab${follow ? " is-on" : ""}`} aria-pressed={follow} onClick={() => setFollow(!follow)} title={follow ? "Following your aircraft" : "Follow your aircraft"}>
            <IconLocate on={follow} />
          </button>
        </div>
      </div>

      <div className="ms__over">{overlay}</div>

      <section className={`ms__sheet${sheet.drag !== null ? " is-dragging" : ""}`} style={sheet.wide ? undefined : { height: sheet.height }} aria-label={title}>
        <Grab s={sheet}>
          <header className="ms__head">
            <div className="ms__headL">{left}</div>
            <h1>{title}</h1>
            <button type="button" className="ms__avatar" onClick={() => setTab(tab === "me" ? "flights" : "me")} aria-label={tab === "me" ? "Close settings" : "Settings and notifications"}>
              {tab === "me" ? <IconClose /> : "V"}
              {!locked && b.link === "open" && tab !== "me" && <i />}
            </button>
          </header>
        </Grab>
        <div className="ms__body">{children}</div>
        <nav className="ms__tabs" aria-label="Sections">
          <div className="ms__tabPill">
            {TABS.map(([k, label, Icon]) => (
              <button key={k} type="button" aria-current={tab === k ? "page" : undefined} onClick={() => pick(k)}>
                <Icon />
                <span>{label}</span>
                {k === "inbox" && b.attentionUnread > 0 && <b className="ms__badge">{b.attentionUnread > 9 ? "9+" : b.attentionUnread}</b>}
              </button>
            ))}
          </div>
          <button type="button" className="ms__search" aria-current={tab === "search" ? "page" : undefined} aria-label="Search airports and your flight plan" onClick={() => pick("search")}>
            <IconSearch />
          </button>
        </nav>
      </section>
    </div>
  );
}
