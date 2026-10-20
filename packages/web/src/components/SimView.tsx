import { useEffect, useRef, useState } from "react";
import type { ChaseViewInfo, PanelCommand, SimViewState } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { useBridgeActions, watchSimView } from "../lib/useBridge";
import { apiFetch } from "../lib/api";
import { IconCamera } from "./icons";

type Shot = { name: string; url: string; file: File; w: number; h: number };

/**
 * A full-size screenshot of the simulator: taken on the PC (and kept there, in VBuddy's "screenshots" folder),
 * then shown here with a button to save it to this phone. Saving needs its own tap: phones only open the
 * share sheet (Save Image) straight after one.
 */
function Screenshot({ allowed }: { allowed: boolean }) {
  const { screenshot } = useBridgeActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shot, setShot] = useState<Shot | null>(null);
  useEffect(() => () => void (shot && URL.revokeObjectURL(shot.url)), [shot]);

  const take = async () => {
    setBusy(true);
    setError("");
    const r = await screenshot();
    if (!r.ok) {
      setBusy(false);
      return setError(r.error);
    }
    try {
      const res = await apiFetch(`/api/screenshots/${encodeURIComponent(r.name)}`);
      if (!res.ok) throw new Error(`the PC answered ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], r.name, { type: "image/jpeg" });
      setShot({ name: r.name, url: URL.createObjectURL(blob), file, w: r.w, h: r.h });
    } catch (e) {
      setError(`The screenshot was saved on the PC, but couldn't be loaded here: ${(e as Error).message}`);
    }
    setBusy(false);
  };
  const canShare = !!shot && typeof navigator.canShare === "function" && navigator.canShare({ files: [shot.file] });
  const save = async () => {
    if (!shot) return;
    if (canShare) {
      try {
        await navigator.share({ files: [shot.file], title: "VBuddy screenshot" });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = shot.url;
    a.download = shot.name;
    document.body.append(a);
    a.click();
    a.remove();
  };

  return (
    <div className="shot">
      <div className="shot__bar">
        <button type="button" className="btn btn--primary" disabled={!allowed || busy} onClick={() => void take()}>
          <IconCamera /> {busy ? "Taking screenshot…" : "Take screenshot"}
        </button>
        {!allowed && <span className="muted">Pair this device to take screenshots.</span>}
      </div>
      {error && (
        <p className="setval__err" role="status">
          {error}
        </p>
      )}
      {shot && (
        <figure className="shot__fig">
          <img src={shot.url} alt={`Screenshot, ${shot.w} by ${shot.h}`} />
          <figcaption>
            <span className="muted">
              {shot.w} × {shot.h} · {Math.round(shot.file.size / 1024)} KB · also saved on the PC
            </span>
            <span className="shot__actions">
              <button type="button" className="btn btn--primary" onClick={() => void save()}>
                {canShare ? "Save to phone" : "Download"}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setShot(null)}>
                Close
              </button>
            </span>
          </figcaption>
        </figure>
      )}
    </div>
  );
}

const WAITING: Record<SimViewState, string> = {
  starting: "Connecting to the sim view…",
  live: "",
  "no-window": "Microsoft Flight Simulator's window wasn't found on the PC.",
  minimized: "The simulator is minimized on the PC. Restore it to see it here.",
  unavailable: "The sim view isn't available right now.",
  "not-allowed": "Pair this device first (Systems → Controls) to see the sim.",
};

/** The live sim view: what the simulator window on the PC shows, about three times a second, with the camera controls under it. */
export function SimView({ b }: { b: BridgeSnapshot }) {
  const { panelCommand } = useBridgeActions();
  const [state, setState] = useState<SimViewState>("starting");
  const [message, setMessage] = useState("");
  const [src, setSrc] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const box = useRef<HTMLDivElement>(null);
  const times = useRef<number[]>([]);

  // Only watch while this page is on screen: the PC captures only while someone watches.
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  useEffect(() => {
    if (!visible || b.link !== "open") return;
    setState("starting");
    return watchSimView((e) => {
      if (e.kind === "status") {
        setState(e.state);
        setMessage(e.message);
        if (e.state !== "live") setSrc(null);
        return;
      }
      setState("live");
      setSrc(`data:image/jpeg;base64,${e.jpeg}`);
      const now = performance.now();
      const t = times.current.filter((x) => now - x < 3000);
      t.push(now);
      times.current = t;
      setFps(t.length / 3);
    });
  }, [visible, b.link]);

  const enabled = !!b.panel?.aircraft && !!b.control?.allowed && b.link === "open";
  // The simulator's own Cockpit / Outside views, for anyone without ChasePlane (hidden while ChasePlane answers with views).
  const [hasChase, setHasChase] = useState(false);
  const camera = b.panel?.sys?.camera;
  const sys = (id: Extract<PanelCommand, { op: "sys" }>["id"], value?: number) => void panelCommand({ op: "sys", id, value });
  const full = () => {
    const el = box.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <section className="card simview">
      <div className="simview__box" ref={box} onDoubleClick={full}>
        {src ? <img className="simview__img" src={src} alt="The simulator on your PC, live" /> : <p className="simview__wait">{b.link !== "open" ? "Waiting for the bridge…" : message || WAITING[state]}</p>}
        {src && (
          <span className="simview__badge" aria-live="off">
            Live · {fps.toFixed(1)} fps
          </span>
        )}
      </div>
      <div className="simview__bar">
        <span className="muted">About three pictures a second from the PC. On mobile data this uses roughly 10–20 MB a minute.</span>
        <button type="button" className="btn" onClick={full}>
          Full screen
        </button>
      </div>
      <Screenshot allowed={!!b.control?.allowed && b.link === "open"} />

      {!hasChase && (
        <div className="systems__group" role="group" aria-label="Camera view">
          <span className="systems__label">View</span>
          {(["Cockpit", "Outside"] as const).map((label, i) => (
            <button key={label} type="button" className={`btn${camera === i ? " btn--primary" : ""}`} aria-pressed={camera === i} disabled={!enabled} onClick={() => sys("camera", i)}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="systems__group systems__cam" role="group" aria-label="Move the view">
        <span className="systems__label">Move view</span>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("panLeft")} aria-label="Look left">◀</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("panUp")} aria-label="Look up">▲</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("panDown")} aria-label="Look down">▼</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("panRight")} aria-label="Look right">▶</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("zoomIn")} aria-label="Zoom in">＋</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("zoomOut")} aria-label="Zoom out">－</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("viewReset")}>Reset</button>
      </div>
      {!enabled && b.link === "open" && <p className="muted">Pair this device (Systems → Controls) to move the camera.</p>}
      <ChasePlaneViews b={b} onAvailable={setHasChase} />
    </section>
  );
}

const km = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const r = Math.PI / 180;
  const x = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

/** ChasePlane's saved views as buttons: your aircraft's views, then the airport views where you are. */
function ChasePlaneViews({ b, onAvailable }: { b: BridgeSnapshot; onAvailable: (yes: boolean) => void }) {
  const { chaseCommand } = useBridgeActions();
  const [views, setViews] = useState<ChaseViewInfo[] | null>(null);
  const [airport, setAirport] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const allowed = !!b.control?.allowed && b.link === "open";

  const load = async () => {
    setError("");
    const r = await chaseCommand({ op: "views" });
    if (r.ok) {
      setViews(r.views ?? []);
      setAirport(r.airport ?? null);
    } else {
      setViews(null);
      setError(r.error);
    }
    onAvailable(r.ok && (r.views?.length ?? 0) > 0);
  };
  useEffect(() => {
    if (allowed) void load();
    // Load once when the page opens (and again after reconnecting); Refresh does the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

  if (!allowed) return null;
  // No ChasePlane on this PC: say nothing (the simulator's own views are above).
  if (!views && /isn't running/.test(error)) return null;
  const pos = b.latest?.data ?? null;
  const aircraft = (views ?? []).filter((v) => v.theme !== "WORLD_TOWER");
  const towers = (views ?? []).filter(
    (v) => v.theme === "WORLD_TOWER" && ((airport && v.icao === airport) || (!!pos && v.lat !== null && v.lon !== null && km(pos.lat, pos.lon, v.lat, v.lon) < 30)),
  );
  const pick = async (v: ChaseViewInfo) => {
    setBusy(v.guid);
    const r = await chaseCommand({ op: "set", guid: v.guid });
    setBusy(null);
    if (r.ok) {
      setCurrent(v.guid);
      setError("");
    } else setError(r.error);
  };
  const row = (label: string, list: ChaseViewInfo[]) =>
    list.length > 0 && (
      <div className="systems__group chase__row" role="group" aria-label={label}>
        <span className="systems__label">{label}</span>
        {list.map((v) => (
          <button key={v.guid} type="button" className={`btn${current === v.guid ? " btn--primary" : ""}`} aria-pressed={current === v.guid} disabled={busy !== null} onClick={() => void pick(v)}>
            {v.name}
          </button>
        ))}
      </div>
    );

  return (
    <div className="chase">
      <div className="chase__head">
        <h3 className="chase__title">ChasePlane views</h3>
        <button type="button" className="btn btn--ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && <p className="muted">{error}</p>}
      {views && views.length === 0 && !error && <p className="muted">ChasePlane has no saved views for this aircraft yet. Save some in ChasePlane, then Refresh.</p>}
      {row("Aircraft", aircraft)}
      {row(airport ? `At ${airport}` : "Airport", towers)}
    </div>
  );
}
