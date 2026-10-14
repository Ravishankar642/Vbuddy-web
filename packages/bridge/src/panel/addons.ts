import type { ApButton, ApKnob, LightId } from "@vbuddy/protocol";

/**
 * How add-on aircraft are driven. They ignore the simulator's standard autopilot events, but each has its own way in:
 *  - PMDG 737: PMDG's published SDK events, sent through SimConnect as "#<number>" with a mouse-wheel flag; one
 *    wheel click turns the knob one detent. The numbers below are the SDK's event ids for the MCP selectors.
 *  - FlyByWire A32NX / A380X: custom "A32NX.FCU_*" SimConnect events.
 *  - iFly 737 MAX: the aircraft's own input events, found by name at run time.
 * The values the app shows are always the simulator's own, read back afterwards, so a wrong mapping shows up as
 * "didn't respond" instead of a false success.
 */
export type AddonKind = "fenix" | "pmdg737" | "fbw" | "ifly" | "airliner" | "study" | "none";

/** Which add-on this is, in the order Cobalt's bridge decides it (AircraftProfiles.detectAircraftProfile). */
export function addonOf(title: string): AddonKind {
  const t = title.toLowerCase();
  // Fenix only ships the A320 family; the vendor token is enough.
  if (t.includes("fenix") || t.includes("fnx")) return "fenix";
  if (t.includes("flybywire") || t.includes("fbw") || t.includes("a32nx") || t.includes("a380x")) return "fbw";
  // PMDG liveries are often titled just "737-800 PAX BW SC", with no maker name.
  if ((t.includes("pmdg") && /73\d/.test(t)) || (/\b73[6-9]-?[0-9]{3}\b|\b73[6-9]\b/.test(t) && !/max|ifly|asobo|fenix|boeing/.test(t))) return "pmdg737";
  // The default A320neo (Asobo, and iniBuilds' MSFS 2024 version for Asobo) follows the standard events.
  if (t.includes("asobo") || /a320\s?neo/.test(t)) return "none";
  if (t.includes("ifly") && (/73\d/.test(t) || t.includes("max"))) return "ifly";
  // iniBuilds A340 / A350 / A380 (titled just "A350-900 (Default Cabin)" and so on): their FCU and lights are the
  // simulator's input events (AIRLINER_FCU_*, AIRLINER_MCU_*), found in the aircraft scans.
  if (/\ba3(4|5|8)0-?\d{3}|\ba35k\b|inibuilds.*a3[458]0/.test(t)) return "airliner";
  // Study airliners that keep their FCU private: values can't be set from outside (Cobalt says so plainly too).
  if (/inibuilds|ini builds|a300|a310|toliss|flightsimlabs|fslabs/.test(t)) return "study";
  return "none";
}

// ---- iniBuilds A340 / A350 / A380: the simulator's input events (names from the aircraft scans) ------------------

/** FCU buttons. A350/A380: AIRLINER_FCU_*; A340: AIRLINER_*_PUSH. Pressed like Cobalt presses an input event: 1, then 0. */
export const AIRLINER_BUTTON: Partial<Record<ApButton, RegExp[]>> = {
  cmd: [/^airliner_fcu_ap_1$/, /^airliner_ap1_push$/],
  fd: [/^airliner_fcu_fd$/, /^airliner_cpt_fd$/],
  athr: [/^airliner_fcu_athr$/, /^airliner_athr_push$/],
  app: [/^airliner_fcu_appr$/, /^airliner_appr_push$/],
  lnav: [/^airliner_fcu_loc$/, /^airliner_loc_push$/],
};
/** The full FCU, by the cockpit's button ids (the same FCU screen the Fenix uses). */
export const AIRLINER_FCU_BUTTON: Record<string, RegExp[]> = {
  ap1: [/^airliner_fcu_ap_1$/, /^airliner_ap1_push$/],
  ap2: [/^airliner_fcu_ap_2$/, /^airliner_ap2_push$/],
  athr: [/^airliner_fcu_athr$/, /^airliner_athr_push$/],
  loc: [/^airliner_fcu_loc$/, /^airliner_loc_push$/],
  appr: [/^airliner_fcu_appr$/, /^airliner_appr_push$/],
  exped: [/^airliner_fcu_exped$/, /^airliner_exped_push$/],
  spdMach: [/^airliner_fcu_spd_mach$/, /^airliner_spdmach$/],
  hdgTrk: [/^airliner_fcu_trk_fpa$/, /^airliner_hdvs$/],
  metric: [/^airliner_fcu_meter$/, /^airliner_metric$/],
  fd1: [/^airliner_fcu_fd$/, /^airliner_cpt_fd$/],
  ls1: [/^airliner_cpt_ls$/, /^airliner_efis_ls_left$/],
};
/** FCU knobs: turned by writing to the knob's input event; push / pull are their own events. */
export const AIRLINER_KNOB: Record<"spd" | "hdg" | "alt" | "vs", { turn: RegExp[]; push: RegExp[]; pull: RegExp[] }> = {
  spd: { turn: [/^airliner_fcu_spd_knob$/, /^airliner_mcu_speed$/], push: [/^airliner_fcu_spd_knob_push$/, /^airliner_mcu_speed_push$/], pull: [/^airliner_fcu_spd_knob_pull$/, /^airliner_mcu_speed_pull$/] },
  hdg: { turn: [/^airliner_fcu_hdg_knob$/, /^airliner_mcu_hdg$/], push: [/^airliner_fcu_hdg_knob_push$/, /^airliner_mcu_hdg_push$/], pull: [/^airliner_fcu_hdg_knob_pull$/, /^airliner_mcu_hdg_pull$/] },
  alt: { turn: [/^airliner_fcu_alt_knob$/, /^airliner_mcu_alt$/], push: [/^airliner_fcu_alt_knob_push$/, /^airliner_mcu_alt_push$/], pull: [/^airliner_fcu_alt_knob_pull$/, /^airliner_mcu_alt_pull$/] },
  vs: { turn: [/^airliner_fcu_vs_knob$/, /^airliner_mcu_vs$/], push: [/^airliner_fcu_vs_knob_push$/, /^airliner_mcu_vs_push$/], pull: [/^airliner_fcu_vs_knob_pull$/, /^airliner_mcu_vs_pull$/] },
};
/** Exterior light switches, with the positions to try for "on" (most likely first). The A380's switches go to 2. */
export const AIRLINER_LIGHT: Partial<Record<LightId, { names: RegExp[]; on: number[] }>> = {
  nav: { names: [/^airliner_lights_ext_nav$/, /^airliner_navlogo_toggle$/], on: [1, 2] },
  logo: { names: [/^airliner_lights_ext_logo$/, /^airliner_navlogo_toggle$/], on: [1, 2] },
  beacon: { names: [/^airliner_lights_ext_beacon$/, /^airliner_beacon_toggle$/], on: [1] },
  strobe: { names: [/^airliner_lights_ext_strobe$/, /^airliner_strobe_toggle$/], on: [2, 1] },
  landing: { names: [/^airliner_lights_ext_landing$/, /^airliner_ldglight_toggle$/], on: [1, 2] },
  taxi: { names: [/^airliner_lights_ext_nose$/, /^airliner_taxilight_toggle$/], on: [1, 2] },
  wing: { names: [/^airliner_lights_ext_wing$/, /^airliner_wing_toggle$/], on: [1] },
  recognition: { names: [/^airliner_lights_ext_turnoff$/, /^airliner_rwyturn_toggle$/], on: [1] },
};

/** Name of a study airliner for messages ("FSLabs A321neo"), from its title. */
export function studyName(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("fslabs") || t.includes("flightsimlabs")) return /a32[01]/.test(t) && !/a321/.test(t) ? "FSLabs A320" : /a319/.test(t) ? "FSLabs A319" : "FSLabs A321neo";
  if (t.includes("toliss")) return "ToLiss";
  if (t.includes("a300")) return "iniBuilds A300";
  if (t.includes("a310")) return "iniBuilds A310";
  return "This aircraft";
}

/** Why a study airliner can't be operated from VBuddy (Cobalt has the same limit and says so too). */
export function studyReadOnly(title: string): string {
  return `${studyName(title)} keeps its cockpit private, so VBuddy can't operate it from outside (Cobalt can't either). Use the cockpit itself; the values shown are what the aircraft reports to the simulator.`;
}

/** What to tell the pilot when a study airliner ignores outside value changes (Cobalt's wording, shortened). */
export const STUDY_NOTE = "Set this on the cockpit FCU: aircraft like the iniBuilds A300/A310, ToLiss and FSLabs ignore outside value changes.";

// ---- Fenix A320 (Cobalt's FENIX_SWITCH_LVARS and fenixControlPlan) ---------------------------------------------

export const FENIX_SWITCH = {
  speedbrake: "A_FC_SPEEDBRAKE",
  parkingBrake: "S_MIP_PARKING_BRAKE",
  seatbelts: "S_OH_SIGNS",
  probeHeat: "S_OH_PROBE_HEAT",
  apuMaster: "S_OH_ELEC_APU_MASTER",
  apuStart: "S_OH_ELEC_APU_START",
  beacon: "S_OH_EXT_LT_BEACON",
  strobe: "S_OH_EXT_LT_STROBE",
  navLogo: "S_OH_EXT_LT_NAV_LOGO",
  landingLeft: "S_OH_EXT_LT_LANDING_L",
  landingRight: "S_OH_EXT_LT_LANDING_R",
  nose: "S_OH_EXT_LT_NOSE",
} as const;

/** Fenix light switches: the L:vars to write and the switch positions for on and off (strobe ON = 2, landing ON = 2 / OFF = 1). */
export const FENIX_LIGHT: Partial<Record<LightId, { lvars: string[]; on: number; off: number }>> = {
  beacon: { lvars: [FENIX_SWITCH.beacon], on: 1, off: 0 },
  strobe: { lvars: [FENIX_SWITCH.strobe], on: 2, off: 0 },
  nav: { lvars: [FENIX_SWITCH.navLogo], on: 1, off: 0 },
  logo: { lvars: [FENIX_SWITCH.navLogo], on: 1, off: 0 },
  landing: { lvars: [FENIX_SWITCH.landingLeft, FENIX_SWITCH.landingRight], on: 2, off: 1 },
  taxi: { lvars: [FENIX_SWITCH.nose], on: 1, off: 0 },
};

/** Fenix switches shown under Systems: L:var and positions. The speed brake lever's ARM position is 0 (Cobalt: arm -> 0, disarm -> 1). */
export const FENIX_SYS = {
  spoilersArm: { lvar: FENIX_SWITCH.speedbrake, on: 0, off: 1 },
  parkingBrake: { lvar: FENIX_SWITCH.parkingBrake, on: 1, off: 0 },
  seatbelts: { lvar: FENIX_SWITCH.seatbelts, on: 1, off: 0 },
  pitotHeat: { lvar: FENIX_SWITCH.probeHeat, on: 1, off: 0 },
} as const;
/** Cobalt: APU MASTER on, wait 1.5 s, press START. */
export const FENIX_APU_START_DELAY_MS = 1500;

// ---- Fenix RMP radios (Cobalt: rmpChannelIndex / rmpTuneClicks) ------------------------------------------------

export const FENIX_RMP: Record<1 | 2, { outer: string; inner: string; xfer: string }> = {
  1: { outer: "E_PED_RMP1_OUTER", inner: "E_PED_RMP1_INNER", xfer: "S_PED_RMP1_XFER" },
  2: { outer: "E_PED_RMP2_OUTER", inner: "E_PED_RMP2_INNER", xfer: "S_PED_RMP2_XFER" },
};
/** Channel number within the MHz (8.33 kHz naming: four channels per 25 kHz). */
export function rmpChannelIndex(mhz: number): number {
  const khz = ((Math.round(mhz * 1000) % 1000) + 1000) % 1000;
  const block = Math.floor(khz / 25);
  const sub = Math.min(3, Math.round((khz % 25) / 5));
  return block * 4 + sub;
}
export function rmpWholeMhz(mhz: number): number {
  return Math.floor(Math.round(mhz * 1000) / 1000);
}
/** Outer knob: 1 MHz a click. Inner: one channel a click (or four in 25 kHz spacing). */
export function rmpTuneClicks(current: number, target: number, channelsPerClick: number): { outer: number; inner: number } {
  return { outer: rmpWholeMhz(target) - rmpWholeMhz(current), inner: Math.round((rmpChannelIndex(target) - rmpChannelIndex(current)) / channelsPerClick) };
}
export function comFrequencyMatches(readMhz: number, targetMhz: number): boolean {
  return Math.abs(readMhz - targetMhz) < 0.004;
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
  lvlChg: "A32NX.FCU_ALT_PUSH", // Cobalt's VNAV/level change on the FCU
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
  // Cobalt's INPUT_EVENT_MODE_MATCH, per button (VBuddy's LVL CHG is Cobalt's "vnav" command).
  cmd: [/(mcp|ap).*(cmd_a|cmd\b|engage|master).*(switch|button|push)?/, /autopilot.*master/],
  fd: [/(mcp|ap).*(fd|flight_dir|flightdirector).*(switch|l|left)?/],
  athr: [/(mcp|ap).*(at_arm|autothrottle|a_t|athr).*(switch|arm)?/],
  speed: [/(mcp|ap).*(spd|speed|flch|lvl_chg|level_change).*(switch|button|hold)/],
  lvlChg: [/(mcp|ap).*vnav.*(switch|button)?/],
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

// ---- Airbus FCU push / pull (Cobalt: executeFcuPushPull) -------------------------------------------------------

export type FcuKnob = "spd" | "hdg" | "alt" | "vs";
/** FlyByWire's own push/pull events. */
export const FBW_PUSH_PULL: Record<FcuKnob, { push: string; pull: string }> = {
  spd: { push: "A32NX.FCU_SPD_PUSH", pull: "A32NX.FCU_SPD_PULL" },
  hdg: { push: "A32NX.FCU_HDG_PUSH", pull: "A32NX.FCU_HDG_PULL" },
  alt: { push: "A32NX.FCU_ALT_PUSH", pull: "A32NX.FCU_ALT_PULL" },
  vs: { push: "A32NX.FCU_VS_PUSH", pull: "A32NX.FCU_VS_PULL" },
};
/** The default A320neo: slot index 2 = managed (push), 1 = selected (pull). */
export const SLOT_INDEX_EVENT: Record<FcuKnob, string> = {
  spd: "SPEED_SLOT_INDEX_SET",
  hdg: "HEADING_SLOT_INDEX_SET",
  alt: "ALTITUDE_SLOT_INDEX_SET",
  vs: "VS_SLOT_INDEX_SET",
};
/** Fenix knob gestures: -1 push, +1 pull on the knob's counter (as the cockpit FCU module does). */
export const FENIX_PUSH_PULL: Record<FcuKnob, string> = { spd: "S_FCU_SPEED", hdg: "S_FCU_HEADING", alt: "S_FCU_ALTITUDE", vs: "S_FCU_VERTICAL_SPEED" };
/** FlyByWire FCU lights and managed dots, read once a second (FlyByWire doesn't copy them into the standard variables). */
export const FBW_LIGHTS = ["A32NX_FCU_AP_1_LIGHT_ON", "A32NX_FCU_ATHR_LIGHT_ON", "A32NX_FCU_LOC_LIGHT_ON", "A32NX_FCU_APPR_LIGHT_ON", "A32NX_FCU_AFS_DISPLAY_SPD_MACH_MANAGED", "A32NX_FCU_AFS_DISPLAY_HDG_TRK_MANAGED", "A32NX_FCU_AFS_DISPLAY_LVL_CH_MANAGED"] as const;
/** Fenix managed dots (Cobalt: FENIX_FCU_ANNUNCIATOR_LVARS). */
export const FENIX_MANAGED_DOT: Partial<Record<FcuKnob, string>> = { spd: "I_FCU_SPEED_MANAGED", hdg: "I_FCU_HEADING_MANAGED", alt: "I_FCU_ALTITUDE_MANAGED" };

/** A key event's parameter is an unsigned 32-bit number on the wire: negatives (V/S -1500) are sent as two's complement (Cobalt: encodeEventDword). */
export function eventDword(value: number): number {
  return (Math.round(value) & 0xffffffff) >>> 0;
}
