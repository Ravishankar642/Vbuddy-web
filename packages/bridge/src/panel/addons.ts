import type { ApButton, ApKnob } from "@vbuddy/protocol";

/**
 * How add-on aircraft are driven. They ignore the simulator's standard autopilot events, but each has its own way in:
 *  - PMDG 737: PMDG's published SDK events, sent through SimConnect as "#<number>" with a mouse-wheel flag; one
 *    wheel click turns the knob one detent. The numbers below are the SDK's event ids for the MCP selectors.
 *  - FlyByWire A32NX / A380X: custom "A32NX.FCU_*" SimConnect events.
 *  - iFly 737 MAX: the aircraft's own input events, found by name at run time.
 * The values the app shows are always the simulator's own, read back afterwards, so a wrong mapping shows up as
 * "didn't respond" instead of a false success.
 */
export type AddonKind = "pmdg737" | "fbw" | "ifly" | "none";

export function addonOf(title: string): AddonKind {
  const t = title.toLowerCase();
  // PMDG liveries are often titled just "737-800 PAX BW SC", with no maker name.
  if ((t.includes("pmdg") && /73\d/.test(t)) || (/\b73[6-9]-?[0-9]{3}\b|\b73[6-9]\b/.test(t) && !/max|ifly|asobo|fenix|boeing/.test(t))) return "pmdg737";
  if (t.includes("flybywire") || t.includes("fbw") || t.includes("a32nx") || t.includes("a380x")) return "fbw";
  if (t.includes("ifly") && (/73\d/.test(t) || t.includes("max"))) return "ifly";
  return "none";
}

// ---- PMDG 737 -------------------------------------------------------------------------------------------------

/** PMDG's third-party event ids start here (THIRD_PARTY_EVENT_ID_MIN in PMDG_NG3_SDK.h). */
const PMDG_EVENT_BASE = 0x11000;
/** Mouse flags that turn a PMDG knob one detent. */
export const PMDG_WHEEL_UP = 0x00004000;
export const PMDG_WHEEL_DOWN = 0x00002000;

export type SelectorKnob = "spd" | "hdg" | "alt" | "vs";
const PMDG_KNOBS: Record<SelectorKnob, { offset: number; step: number; max: number }> = {
  spd: { offset: 384, step: 1, max: 400 },
  hdg: { offset: 390, step: 1, max: 180 },
  alt: { offset: 400, step: 100, max: 500 },
  vs: { offset: 401, step: 100, max: 160 },
};

export const isSelectorKnob = (k: ApKnob): k is SelectorKnob => k === "spd" || k === "hdg" || k === "alt" || k === "vs";

/** Shortest turn (in detents, + = up) from one heading to another. */
function turn(current: number, target: number): number {
  return ((Math.round(target - current) + 540) % 360) - 180;
}

/**
 * Clicks needed to move a PMDG selector from `current` to `target`. In Mach mode the speed knob moves 0.01 a click.
 * Null when nothing needs to move. Capped so a bad starting value can never spin the knob for long.
 */
export function pmdgPlan(knob: SelectorKnob, current: number, target: number, mach = false): { event: string; flag: number; count: number } | null {
  const k = PMDG_KNOBS[knob];
  const step = knob === "spd" && mach ? 0.01 : k.step;
  const raw = knob === "hdg" ? turn(current, target) : Math.round((target - current) / step);
  const n = Math.max(-k.max, Math.min(k.max, raw));
  if (n === 0) return null;
  return { event: `#${PMDG_EVENT_BASE + k.offset}`, flag: n > 0 ? PMDG_WHEEL_UP : PMDG_WHEEL_DOWN, count: Math.abs(n) };
}

// ---- FlyByWire A32NX / A380X ---------------------------------------------------------------------------------

export const FBW_SET: Record<SelectorKnob, string> = {
  spd: "A32NX.FCU_SPD_SET",
  hdg: "A32NX.FCU_HDG_SET",
  alt: "A32NX.FCU_ALT_SET",
  vs: "A32NX.FCU_VS_SET",
};
export const FBW_ALT_INCREMENT = "A32NX.FCU_ALT_INCREMENT_SET";
/** Buttons as the pilot would press them on the FCU. The Boeing-style names map onto the nearest FCU gesture. */
export const FBW_BUTTON: Partial<Record<ApButton, string>> = {
  cmd: "A32NX.FCU_AP_1_PUSH",
  athr: "A32NX.FCU_ATHR_PUSH",
  app: "A32NX.FCU_APPR_PUSH",
  lnav: "A32NX.FCU_HDG_PUSH", // managed lateral navigation
  hdgSel: "A32NX.FCU_HDG_PULL", // selected heading
  altHld: "A32NX.FCU_ALT_PUSH", // level off at the selected altitude
  vs: "A32NX.FCU_VS_PULL", // engage V/S
  speed: "A32NX.FCU_SPD_PULL", // selected speed
};

/** The value to send for a FlyByWire knob. The altitude and V/S knobs work in hundreds; headings wrap. */
export function fbwValue(knob: SelectorKnob, v: number, mach: boolean): number {
  switch (knob) {
    case "hdg":
      return ((Math.round(v) % 360) + 360) % 360;
    case "alt":
    case "vs":
      return Math.round(v / 100) * 100;
    default:
      return mach ? Math.round(v * 100) : Math.round(v);
  }
}

// ---- iFly 737 MAX ---------------------------------------------------------------------------------------------

/** Names of iFly's own input events for the buttons, matched loosely (lower case). Unconfirmed: checked by read-back. */
export const IFLY_BUTTON: Partial<Record<ApButton, RegExp[]>> = {
  cmd: [/(mcp|ap).*(cmd_a|cmd\b|engage|master).*(switch|button|push)?/, /autopilot.*master/],
  fd: [/(mcp|ap).*(fd|flight_dir|flightdirector)/],
  athr: [/(mcp|ap).*(at_arm|autothrottle|a_t|athr)/],
  speed: [/(mcp|ap).*(spd|speed).*(switch|button|hold)/],
  lvlChg: [/(mcp|ap).*(lvl_?chg|level_?change|flch)/],
  hdgSel: [/(mcp|ap).*(hdg|heading).*(sel|hold|switch|button)/],
  lnav: [/(mcp|ap).*(lnav|nav).*(switch|button|hold)/],
  app: [/(mcp|ap).*(app|appr|approach).*(switch|button|hold)/],
  altHld: [/(mcp|ap).*alt.*(hold|switch|button)/],
  vs: [/(mcp|ap).*(vs|vert).*(switch|button|hold)/],
};
export const IFLY_KNOB: Record<SelectorKnob, { set: RegExp[]; inc: RegExp[]; dec: RegExp[]; step: number; max: number }> = {
  alt: {
    set: [/(mcp|ap|autopilot).*alt.*(set|value)/, /alt.*(sel|selector).*set/],
    inc: [/(mcp|ap|autopilot|alt).*alt.*(inc|up)/, /alt.*(sel|selector|knob).*(inc|up)/],
    dec: [/(mcp|ap|autopilot|alt).*alt.*(dec|down)/, /alt.*(sel|selector|knob).*(dec|down)/],
    step: 100,
    max: 500,
  },
  hdg: {
    set: [/(mcp|ap|autopilot).*(hdg|heading).*(set|value)/],
    inc: [/(mcp|ap|autopilot).*(hdg|heading).*(inc|up)/, /(hdg|heading).*(sel|selector|knob).*(inc|up)/],
    dec: [/(mcp|ap|autopilot).*(hdg|heading).*(dec|down)/, /(hdg|heading).*(sel|selector|knob).*(dec|down)/],
    step: 1,
    max: 180,
  },
  spd: {
    set: [/(mcp|ap|autopilot).*(spd|speed|ias).*(set|value)/],
    inc: [/(mcp|ap|autopilot).*(spd|speed|ias).*(inc|up)/, /(spd|speed|ias).*(sel|selector|knob).*(inc|up)/],
    dec: [/(mcp|ap|autopilot).*(spd|speed|ias).*(dec|down)/, /(spd|speed|ias).*(sel|selector|knob).*(dec|down)/],
    step: 1,
    max: 400,
  },
  vs: {
    set: [/(mcp|ap|autopilot).*(vs|vert).*(set|value)/],
    inc: [/(mcp|ap|autopilot).*(vs|vert).*(inc|up)/, /(vs|vert).*(sel|selector|knob).*(inc|up)/],
    dec: [/(mcp|ap|autopilot).*(vs|vert).*(dec|down)/, /(vs|vert).*(sel|selector|knob).*(dec|down)/],
    step: 100,
    max: 160,
  },
};

/** First name that fits one of the patterns. */
export function matchName(names: Iterable<string>, patterns: RegExp[] | undefined): string | null {
  if (!patterns) return null;
  const list = [...names];
  for (const p of patterns) for (const n of list) if (p.test(n.toLowerCase())) return n;
  return null;
}

/** Detents from `current` to `target` for an inc/dec pair; null if there is nothing to do. */
export function incDecClicks(knob: SelectorKnob, current: number, target: number): number {
  const k = IFLY_KNOB[knob];
  const raw = knob === "hdg" ? turn(current, target) : Math.round((target - current) / k.step);
  return Math.max(-k.max, Math.min(k.max, raw));
}
