import { useCallback, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ButtonId, CockpitCommand, FcuState, PushPullId } from "@vbuddy/protocol";
import type { BridgeSnapshot, CmdReply } from "../lib/bridge-client";
import { useBridgeActions, useNow } from "../lib/useBridge";
import { Knob } from "./Knob";
import { PanelButton, SetValue } from "./PanelParts";
import { LightsCard, Mcp } from "./PanelViews";
import { SystemsCard } from "./SystemsCard";

/** Not yet seen working on a real Fenix (see README); marked so the pilot knows to check. */
const UNVERIFIED_PP: PushPullId[] = ["spd", "hdg", "baro1"];
const UNVERIFIED_BTN: ButtonId[] = ["spdMach", "hdgTrk", "metric"];
const UNVERIFIED_NOTE = "Not confirmed on your Fenix yet. Tell me if it works.";

type Send = (cmd: CockpitCommand) => Promise<CmdReply>;

/* ------------------------------------------------------------------ window text, as the FCU shows it */

function spdText(s: FcuState) {
  if (s.spdDashed) return "---";
  return s.spdIsMach ? s.spd.toFixed(2).replace(/^0/, "") : String(Math.round(s.spd)).padStart(3, "0");
}
const hdgText = (s: FcuState) => (s.hdgDashed ? "---" : String(Math.round(s.hdg) % 360).padStart(3, "0"));
const altText = (s: FcuState) => String(Math.round(s.alt)).padStart(5, "0");
function vsText(s: FcuState): ReactNode {
  if (s.vsDashed) return "-----";
  if (s.trkFpa) return `${s.vs >= 0 ? "+" : "−"}${(Math.abs(s.vs) / 1000).toFixed(1)}`;
  const h = Math.round(Math.abs(s.vs) / 100);
  return (
    <>
      {s.vs >= 0 ? "+" : "−"}
      {String(h).padStart(2, "0")}
      <small>oo</small>
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

function useCommand(send: Send, onError: (e: string) => void) {
  return useCallback(
    async (cmd: CockpitCommand) => {
      const r = await send(cmd);
      if (!r.ok) onError(r.error);
      return r;
    },
    [send, onError],
  );
}

interface ModuleProps {
  id: "spd" | "hdg" | "alt" | "vs";
  labels: [string, string?];
  altLabel: boolean;
  text: ReactNode;
  managed: boolean;
  pullTitle: string;
  pushTitle: string;
  hint: string;
  enabled: boolean;
  run: (cmd: CockpitCommand) => Promise<CmdReply>;
}

/** One FCU window with its knob: tap the window to type a value. */
function FcuModule({ id, labels, altLabel, text, managed, pullTitle, pushTitle, hint, enabled, run }: ModuleProps) {
  const [editing, setEditing] = useState(false);
  const unverified = UNVERIFIED_PP.includes(id);
  return (
    <section className={`fcum fcum--${id}`} aria-label={labels.filter(Boolean).join(" / ")}>
      <div className="fcum__labels" aria-hidden="true">
        <span className={altLabel ? "" : "is-on"}>{labels[0]}</span>
        {labels[1] && <span className={altLabel ? "is-on" : ""}>{labels[1]}</span>}
      </div>
      <button type="button" className="lcd" onClick={() => enabled && setEditing(true)} disabled={!enabled} aria-label={`${(altLabel && labels[1]) || labels[0]} window. Tap to type a value.`}>
        <span className="lcd__val">{text}</span>
        <span className={`lcd__dot${managed ? " is-on" : ""}`} aria-label={managed ? "managed" : undefined} />
      </button>
      {editing && <SetValue label={(altLabel && labels[1]) || labels[0]} hint={hint} onSet={(v) => run({ op: "target", ctl: id, value: v })} onClose={() => setEditing(false)} />}
      <button type="button" className={`pp pp--pull${unverified ? " is-unverified" : ""}`} disabled={!enabled} title={unverified ? UNVERIFIED_NOTE : pullTitle} onClick={() => void run({ op: "pull", ctl: id })}>
        Pull <span className="pp__what">{pullTitle}</span>
      </button>
      <Knob label={labels[0]} disabled={!enabled} onTurn={(clicks) => void run({ op: "turn", ctl: id, clicks })} />
      <button type="button" className={`pp pp--push${unverified ? " is-unverified" : ""}`} disabled={!enabled} title={unverified ? UNVERIFIED_NOTE : pushTitle} onClick={() => void run({ op: "push", ctl: id })}>
        Push <span className="pp__what">{pushTitle}</span>
      </button>
    </section>
  );
}

const ND_MODES = ["LS", "VOR", "NAV", "ARC", "PLAN"];

function Efis({ s, enabled, run }: { s: FcuState; enabled: boolean; run: (c: CockpitCommand) => Promise<CmdReply> }) {
  const [inHg, setInHg] = useState(false);
  const press = (ctl: ButtonId) => void run({ op: "press", ctl });
  return (
    <section className="efis" aria-label="Captain's EFIS">
      <div className="efis__baro">
        <div className="fcum__labels" aria-hidden="true">
          <span className="is-on">QNH</span>
          <button type="button" className="unit" onClick={() => setInHg(!inHg)} aria-label={`Show baro in ${inHg ? "hectopascals" : "inches"}`}>
            {inHg ? "inHg" : "hPa"}
          </button>
        </div>
        <div className="lcd lcd--static">
          <span className="lcd__val">{inHg ? s.efis1.baroInHg.toFixed(2) : String(Math.round(s.efis1.baroHpa)).padStart(4, "0")}</span>
        </div>
        <button type="button" className="pp pp--pull is-unverified" disabled={!enabled} title={UNVERIFIED_NOTE} onClick={() => void run({ op: "pull", ctl: "baro1" })}>
          Pull <span className="pp__what">STD</span>
        </button>
        <Knob label="Baro" size={76} disabled={!enabled} onTurn={(clicks) => void run({ op: "turn", ctl: "baro1", clicks })} />
        <button type="button" className="pp pp--push is-unverified" disabled={!enabled} title={UNVERIFIED_NOTE} onClick={() => void run({ op: "push", ctl: "baro1" })}>
          Push <span className="pp__what">QNH</span>
        </button>
      </div>
      <div className="efis__nd">
        <div className="nd" role="radiogroup" aria-label="ND mode">
          {ND_MODES.map((m, i) => (
            <button key={m} type="button" role="radio" aria-checked={s.efis1.ndMode === i} disabled={!enabled} onClick={() => void run({ op: "ndMode", efis: 1, value: i })}>
              {m}
            </button>
          ))}
        </div>
        <div className="efis__btns">
          <PanelButton label="FD" onPress={() => press("fd1")} disabled={!enabled} small />
          <PanelButton label="LS" onPress={() => press("ls1")} disabled={!enabled} small />
          <PanelButton label="CSTR" onPress={() => press("cstr1")} disabled={!enabled} small />
          <PanelButton label="WPT" onPress={() => press("wpt1")} disabled={!enabled} small />
          <PanelButton label="VOR.D" onPress={() => press("vord1")} disabled={!enabled} small />
          <PanelButton label="NDB" onPress={() => press("ndb1")} disabled={!enabled} small />
          <PanelButton label="ARPT" onPress={() => press("arpt1")} disabled={!enabled} small />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ pairing */

export function PairThisDevice({ gate = false }: { gate?: boolean }) {
  const { pair } = useBridgeActions();
  const [code, setCode] = useState("");
  const [name, setName] = useState(() => (/iPad|Tablet|Android(?!.*Mobile)/i.test(navigator.userAgent) ? "Tablet" : /Mobi|iPhone/i.test(navigator.userAgent) ? "Phone" : "Browser"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setMsg("The code has 6 digits.");
    setBusy(true);
    const r = await pair(code, name.trim() || "Device");
    setBusy(false);
    setMsg(r.ok ? null : r.error);
    if (r.ok) setCode("");
  };
  return (
    <section className="card pairing">
      <h2 className="card__title">{gate ? "Pair this device" : "This device can only watch"}</h2>
      {gate ? (
        <p className="muted">You're connected through your relay, so this device has to be paired before it can see your flight. Enter the 6-digit code shown in the bridge window on your PC (or on the Systems → Controls of VBuddy opened on the PC). You only do this once per device.</p>
      ) : null}
      <p className="muted" hidden={gate}>To use the knobs and buttons from here, pair it once with the 6-digit code shown in the bridge window on your PC (or on this Systems → Controls when VBuddy is opened on the PC).</p>
      <form className="pairing__form" onSubmit={submit}>
        <label>
          Code
          <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} disabled={busy} />
        </label>
        <label>
          Name for this device
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
      {msg && (
        <p className="setval__err" role="alert">
          {msg}
        </p>
      )}
    </section>
  );
}

function PairingAdmin({ p }: { p: NonNullable<BridgeSnapshot["pairing"]> }) {
  const { revokeDevice, newPairingCode } = useBridgeActions();
  const now = useNow(1000);
  const left = Math.max(0, Math.round((p.expiresAt - now) / 1000));
  return (
    <section className="card pairing">
      <h2 className="card__title">Pair a phone or tablet</h2>
      <p className="muted">Open VBuddy on the device, go to Cockpit, and enter this code. It works once and changes every 10 minutes.</p>
      <div className="pairing__code" aria-label={`Pairing code ${p.code.split("").join(" ")}`}>
        {p.code.slice(0, 3)}
        <span aria-hidden="true"> </span>
        {p.code.slice(3)}
      </div>
      <p className="muted">
        Changes in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.{" "}
        <button type="button" className="linkish" onClick={newPairingCode}>
          New code now
        </button>
      </p>
      {p.devices.length > 0 && (
        <ul className="devices">
          {p.devices.map((d) => (
            <li key={d.id}>
              <span>
                <b>{d.name}</b>
                <span className="muted"> paired {new Date(d.pairedAt).toLocaleDateString()}</span>
              </span>
              <button type="button" className="btn btn--ghost" onClick={() => revokeDevice(d.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ the tab */

export function CockpitView({ b }: { b: BridgeSnapshot }) {
  const { command, cockpitRetry, panelCommand } = useBridgeActions();
  const [error, setError] = useState<string | null>(null);
  const errTimer = useRef<number | null>(null);
  const onError = useCallback((e: string) => {
    setError(e);
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = window.setTimeout(() => setError(null), 6000);
  }, []);
  const run = useCommand(command, onError);
  const runPanel = useCallback(
    async (cmd: Parameters<typeof panelCommand>[0]) => {
      const r = await panelCommand(cmd);
      if (!r.ok) onError(r.error);
      return r;
    },
    [panelCommand, onError],
  );
  const p = b.panel;
  const panelEnabled = !!p?.aircraft && !!b.control?.allowed && b.link === "open";
  const s = p?.family === "boeing" ? null : b.cockpit; // a Boeing has no Airbus FCU
  const c = b.control;
  const enabled = !!s && !!c?.allowed && b.link === "open" && s.power;

  const linkText = !c
    ? null
    : c.path === "none"
      ? "Commands: not reaching the aircraft"
      : `Commands via ${c.path === "mobiflight" ? "MobiFlight" : c.path === "simconnect" ? "SimConnect" : "mock"}${c.working === true ? ": working" : c.working === false ? ": not working" : ": not tested yet"}`;

  return (
    <div className="cockpit">
      {!s && !p?.aircraft ? (
        <div className="empty">
          <p className="empty__big">No aircraft loaded</p>
          <p>Load an aircraft in MSFS. Its controls appear here as soon as it's in the cockpit.</p>
        </div>
      ) : !s ? (
        <>
          <div className="cockpit__status">
            <span className="chip">{p!.aircraft}</span>
            <span className="chip">{p!.family === "airbus" ? "Airbus" : p!.family === "boeing" ? "Boeing" : "Other aircraft"}</span>
            {c?.reason === "paired" && <span className="chip">Paired as {c.deviceName}</span>}
          </div>
          {p!.note && <p className="banner">{p!.note}</p>}
          {p!.ap ? (
            <Mcp ap={p!.ap} enabled={panelEnabled} run={runPanel} generic={p!.family !== "boeing"} />
          ) : (
            <div className="empty">
              <p className="empty__big">This aircraft isn't reporting its autopilot</p>
              <p>The lights below still work. Autopilot controls need the aircraft to publish its autopilot to the simulator.</p>
            </div>
          )}
          <LightsCard p={p!} enabled={panelEnabled} run={runPanel} />
          <SystemsCard p={p!} enabled={panelEnabled} run={runPanel} />
          <div className="cockpit__err" aria-live="assertive">
            {error && <p className="banner">{error}</p>}
          </div>
        </>
      ) : (
        <>
          <div className="cockpit__status">
            {c?.allowed && linkText && (
              <span className={`chip${c.working === false || c.path === "none" ? " chip--warn" : ""}`}>{linkText}</span>
            )}
            {c?.allowed && (c.working === false || c.path === "none") && (
              <button type="button" className="btn" onClick={cockpitRetry}>
                Retry
              </button>
            )}
            {c?.reason === "paired" && <span className="chip">Paired as {c.deviceName}</span>}
          </div>
          {c?.detail && <p className="banner">{c.detail}</p>}
          <div className={`fcu${s.power ? "" : " fcu--off"}`}>
            <Efis s={s} enabled={enabled} run={run} />
            <div className="fcu__main">
              <FcuModule
                id="spd"
                labels={["SPD", "MACH"]}
                altLabel={s.spdIsMach}
                text={spdText(s)}
                managed={s.spdManaged}
                pullTitle="selected"
                pushTitle="managed"
                hint={s.spdIsMach ? "e.g. 0.78" : "e.g. 250"}
                enabled={enabled}
                run={run}
              />
              <FcuModule
                id="hdg"
                labels={["HDG", "TRK"]}
                altLabel={s.trkFpa}
                text={hdgText(s)}
                managed={s.hdgManaged}
                pullTitle="selected"
                pushTitle="managed"
                hint="e.g. 270"
                enabled={enabled}
                run={run}
              />
              <div className="fcu__buttons" role="group" aria-label="Autopilot buttons">
                <PanelButton label="LOC" lit={s.lights.loc} onPress={() => void run({ op: "press", ctl: "loc" })} disabled={!enabled} />
                <PanelButton label="AP1" lit={s.lights.ap1} onPress={() => void run({ op: "press", ctl: "ap1" })} disabled={!enabled} />
                <PanelButton label="AP2" lit={s.lights.ap2} onPress={() => void run({ op: "press", ctl: "ap2" })} disabled={!enabled} />
                <PanelButton label="A/THR" lit={s.lights.athr} onPress={() => void run({ op: "press", ctl: "athr" })} disabled={!enabled} />
                <PanelButton label="EXPED" lit={s.lights.exped} onPress={() => void run({ op: "press", ctl: "exped" })} disabled={!enabled} />
                <PanelButton label="APPR" lit={s.lights.appr} onPress={() => void run({ op: "press", ctl: "appr" })} disabled={!enabled} />
                <div className="fcu__small">
                  <PanelButton label="SPD MACH" small unverified={UNVERIFIED_BTN.includes("spdMach")} onPress={() => void run({ op: "press", ctl: "spdMach" })} disabled={!enabled} />
                  <PanelButton label="HDG-V/S TRK-FPA" small unverified={UNVERIFIED_BTN.includes("hdgTrk")} onPress={() => void run({ op: "press", ctl: "hdgTrk" })} disabled={!enabled} />
                  <PanelButton label="METRIC ALT" small unverified={UNVERIFIED_BTN.includes("metric")} onPress={() => void run({ op: "press", ctl: "metric" })} disabled={!enabled} />
                </div>
              </div>
              <FcuModule
                id="alt"
                labels={["ALT"]}
                altLabel={false}
                text={altText(s)}
                managed={s.altManaged}
                pullTitle="open climb/descent"
                pushTitle="managed"
                hint="e.g. 12000 or FL350"
                enabled={enabled}
                run={run}
              />
              <FcuModule
                id="vs"
                labels={["V/S", "FPA"]}
                altLabel={s.trkFpa}
                text={vsText(s)}
                managed={false}
                pullTitle="engage V/S"
                pushTitle="level off"
                hint="e.g. -1500"
                enabled={enabled}
                run={run}
              />
            </div>
            {!s.power && <p className="fcu__nopower">The FCU has no power.</p>}
          </div>
          <p className="muted cockpit__help">
            Knobs: tap the left half to turn down one click, the right half to turn up, hold to keep turning, or drag round the knob. Tap a window to type an exact value. Controls with a dotted outline haven't been confirmed on your Fenix yet.
          </p>
          {p?.aircraft && <LightsCard p={p} enabled={panelEnabled} run={runPanel} />}
          {p?.aircraft && <SystemsCard p={p} enabled={panelEnabled} run={runPanel} />}
          <div className="cockpit__err" aria-live="assertive">
            {error && <p className="banner">{error}</p>}
          </div>
        </>
      )}
      {c && !c.allowed && c.reason === "not-paired" && <PairThisDevice />}
      {b.pairing && <PairingAdmin p={b.pairing} />}
    </div>
  );
}
