import { useState } from "react";
import type { ApButton, ApKnob, LightId, PanelCommand, PanelState } from "@vbuddy/protocol";
import type { CmdReply } from "../lib/bridge-client";
import { Knob } from "./Knob";
import { PanelButton, SetValue } from "./PanelParts";

type Run = (cmd: PanelCommand) => Promise<CmdReply>;
type Ap = NonNullable<PanelState["ap"]>;

/* ------------------------------------------------------------------ lights */

const LIGHT_LABELS: Array<[LightId, string]> = [
  ["landing", "LANDING"],
  ["taxi", "TAXI"],
  ["nav", "NAV"],
  ["beacon", "BEACON"],
  ["strobe", "STROBE"],
  ["wing", "WING"],
  ["logo", "LOGO"],
  ["recognition", "RECOG"],
  ["cabin", "CABIN"],
  ["panel", "PANEL"],
];

/** Exterior and interior lights, shown as the simulator reports them (so a light the aircraft ignores doesn't look on). */
export function LightsCard({ p, enabled, run }: { p: PanelState; enabled: boolean; run: Run }) {
  return (
    <section className="card lights" aria-label="Lights">
      <h2 className="card__title">Lights</h2>
      <div className="lights__grid">
        {LIGHT_LABELS.map(([id, label]) => (
          <PanelButton key={id} label={label} lit={p.lights[id]} disabled={!enabled} onPress={() => void run({ op: "light", id, on: !p.lights[id] })} />
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Boeing-style mode control panel */

const spdText = (a: Ap) => (a.machMode ? a.spd.toFixed(2).replace(/^0/, "") : String(Math.round(a.spd)).padStart(3, "0"));
const degText = (v: number) => String(Math.round(v) % 360 || 360).padStart(3, "0");
const altText = (a: Ap) => String(Math.round(a.alt)).padStart(5, "0");
const vsText = (a: Ap) => (a.vs ? `${a.vsFpm >= 0 ? "+" : "−"}${String(Math.abs(Math.round(a.vsFpm))).padStart(4, "0")}` : "-----");

function McpWindow({ id, label, text, hint, enabled, run, lit }: { id: ApKnob; label: string; text: string; hint: string; enabled: boolean; run: Run; lit?: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <section className={`fcum mcp__win mcp__win--${id}`} aria-label={label}>
      <div className="fcum__labels" aria-hidden="true">
        <span className="is-on">{label}</span>
      </div>
      <button type="button" className={`lcd${lit === false ? " lcd--dim" : ""}`} disabled={!enabled} onClick={() => setEditing(true)} aria-label={`${label} window. Tap to type a value.`}>
        <span className="lcd__val">{text}</span>
      </button>
      {editing && <SetValue label={label} hint={hint} onSet={(v) => run({ op: "set", ctl: id, value: v })} onClose={() => setEditing(false)} />}
      <Knob label={label} disabled={!enabled} onTurn={(clicks) => void run({ op: "turn", ctl: id, steps: clicks })} />
    </section>
  );
}

const BUTTONS: Array<[ApButton, string, keyof Ap]> = [
  ["speed", "SPEED", "speed"],
  ["lvlChg", "LVL CHG", "lvlChg"],
  ["hdgSel", "HDG SEL", "hdgSel"],
  ["lnav", "LNAV / VOR LOC", "lnav"],
  ["app", "APP", "app"],
  ["altHld", "ALT HLD", "altHld"],
  ["vs", "V/S", "vs"],
];

/**
 * Boeing-style mode control panel (737/747/777/787). Works with the simulator's standard autopilot, which is what
 * the default Boeings use; add-ons such as PMDG and iFly keep their own, so the bridge checks every press and the
 * panel says so when the aircraft ignores it.
 */
export function Mcp({ ap, enabled, run, generic }: { ap: Ap; enabled: boolean; run: Run; generic: boolean }) {
  return (
    <section className="mcp" aria-label={generic ? "Autopilot" : "Mode control panel"}>
      <div className="mcp__row">
        <McpWindow id="crs" label="COURSE" text={degText(ap.crs)} hint="e.g. 270" enabled={enabled} run={run} />
        <McpWindow id="spd" label="IAS / MACH" text={spdText(ap)} hint={ap.machMode ? "e.g. 0.78" : "e.g. 250"} enabled={enabled} run={run} lit={ap.speed || ap.lvlChg} />
        <McpWindow id="hdg" label="HEADING" text={degText(ap.hdg)} hint="e.g. 270" enabled={enabled} run={run} />
        <McpWindow id="alt" label="ALTITUDE" text={altText(ap)} hint="e.g. 12000 or FL350" enabled={enabled} run={run} />
        <McpWindow id="vs" label="VERT SPEED" text={vsText(ap)} hint="e.g. -1500" enabled={enabled} run={run} lit={ap.vs} />
      </div>
      <div className="mcp__buttons" role="group" aria-label="Autopilot buttons">
        <PanelButton label="A/T ARM" lit={ap.athr} disabled={!enabled} onPress={() => void run({ op: "press", ctl: "athr" })} />
        <PanelButton label="F/D" lit={ap.fd} disabled={!enabled} onPress={() => void run({ op: "press", ctl: "fd" })} />
        {BUTTONS.map(([ctl, label, flag]) => (
          <PanelButton key={ctl} label={label} lit={ap[flag] as boolean} disabled={!enabled} onPress={() => void run({ op: "press", ctl })} />
        ))}
        <PanelButton label="CMD A / B" lit={ap.master} disabled={!enabled} onPress={() => void run({ op: "press", ctl: "cmd" })} />
      </div>
    </section>
  );
}
