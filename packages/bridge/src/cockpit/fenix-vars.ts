import type { ButtonId, FcuState, KnobId, PushPullId } from "@vbuddy/protocol";

/**
 * Fenix A320 cockpit variables (L:vars). Status from the discovery run on
 * 12 Oct 2026 (fenix-report-2026-10-12T22-06-08.json, MSFS 2024):
 *   confirmed = changed while the control was operated
 *   assumed   = name from community configs, not yet seen to change on this PC
 *
 * How the Fenix works (confirmed unless noted):
 *   E_FCU_<knob>  click counter: +1 per click clockwise, -1 anticlockwise
 *   S_FCU_<knob>  push/pull counter: push = -1, pull = +1 (ALT and V/S confirmed; SPD, HDG, baro assumed)
 *   S_FCU_<btn>   press counter: +1 on press and +1 on release, so +2 per press
 *   N_FCU_*       numbers shown in the windows; I_FCU_* lights; B_FCU_* display states
 */
export const READ_VARS = [
  // windows
  "N_FCU_SPEED",
  "N_FCU_HEADING",
  "N_FCU_ALTITUDE",
  "N_FCU_VS",
  "B_FCU_SPEED_DASHED",
  "B_FCU_HEADING_DASHED", // assumed
  "B_FCU_VERTICALSPEED_DASHED",
  "B_FCU_SPEED_MACH", // assumed
  "B_FCU_TRKFPA", // assumed
  "B_FCU_POWER",
  "I_FCU_SPEED_MANAGED",
  "I_FCU_HEADING_MANAGED", // assumed
  "I_FCU_ALTITUDE_MANAGED", // assumed
  // lights
  "I_FCU_AP1",
  "I_FCU_AP2",
  "I_FCU_ATHR",
  "I_FCU_LOC", // assumed (never lit during discovery)
  "I_FCU_APPR", // assumed
  "I_FCU_EXPED",
  // EFIS 1
  "N_FCU_EFIS1_BARO_HPA",
  "N_FCU_EFIS1_BARO_INCH",
  "S_FCU_EFIS1_ND_MODE",
  // counters, read so every command can be checked
  "E_FCU_SPEED",
  "E_FCU_HEADING",
  "E_FCU_ALTITUDE",
  "E_FCU_VS",
  "E_FCU_EFIS1_BARO",
  "S_FCU_SPEED",
  "S_FCU_HEADING",
  "S_FCU_ALTITUDE",
  "S_FCU_VERTICAL_SPEED",
  "S_FCU_EFIS1_BARO_STD",
  "S_FCU_ALTITUDE_SCALE",
  "S_FCU_AP1",
  "S_FCU_AP2",
  "S_FCU_ATHR",
  "S_FCU_LOC",
  "S_FCU_APPR",
  "S_FCU_EXPED",
  "S_FCU_SPD_MACH",
  "S_FCU_HDGVS_TRKFPA",
  "S_FCU_METRIC_ALT",
  "S_FCU_EFIS1_FD",
  "S_FCU_EFIS1_LS",
  "S_FCU_EFIS1_CSTR",
  "S_FCU_EFIS1_WPT",
  "S_FCU_EFIS1_VORD",
  "S_FCU_EFIS1_NDB",
  "S_FCU_EFIS1_ARPT",
] as const;
export type FenixVar = (typeof READ_VARS)[number];
export type FenixValues = Record<FenixVar, number>;

export const KNOB_VAR: Record<KnobId, FenixVar> = {
  spd: "E_FCU_SPEED",
  hdg: "E_FCU_HEADING",
  alt: "E_FCU_ALTITUDE",
  vs: "E_FCU_VS",
  baro1: "E_FCU_EFIS1_BARO",
};
export const PUSHPULL_VAR: Record<PushPullId, FenixVar> = {
  spd: "S_FCU_SPEED",
  hdg: "S_FCU_HEADING",
  alt: "S_FCU_ALTITUDE",
  vs: "S_FCU_VERTICAL_SPEED",
  baro1: "S_FCU_EFIS1_BARO_STD",
};
export const BUTTON_VAR: Record<ButtonId, FenixVar> = {
  ap1: "S_FCU_AP1",
  ap2: "S_FCU_AP2",
  athr: "S_FCU_ATHR",
  loc: "S_FCU_LOC",
  appr: "S_FCU_APPR",
  exped: "S_FCU_EXPED",
  spdMach: "S_FCU_SPD_MACH",
  hdgTrk: "S_FCU_HDGVS_TRKFPA",
  metric: "S_FCU_METRIC_ALT",
  fd1: "S_FCU_EFIS1_FD",
  ls1: "S_FCU_EFIS1_LS",
  cstr1: "S_FCU_EFIS1_CSTR",
  wpt1: "S_FCU_EFIS1_WPT",
  vord1: "S_FCU_EFIS1_VORD",
  ndb1: "S_FCU_EFIS1_NDB",
  arpt1: "S_FCU_EFIS1_ARPT",
};
/** Controls not yet seen working on this PC; the cockpit marks them. */
export const ASSUMED = {
  pushPull: ["spd", "hdg", "baro1"] as PushPullId[],
  buttons: ["spdMach", "hdgTrk", "metric"] as ButtonId[],
};

export function toFcuState(v: FenixValues, altStep: number | null, aircraft: FcuState["aircraft"] = "fenix-a320"): FcuState {
  const b = (n: FenixVar) => v[n] !== 0;
  const spd = v.N_FCU_SPEED;
  return {
    aircraft,
    power: b("B_FCU_POWER"),
    spd,
    // N_FCU_SPEED carries the Mach number in Mach mode; below 10 can't be knots.
    spdIsMach: b("B_FCU_SPEED_MACH") || (spd > 0 && spd < 10),
    spdDashed: b("B_FCU_SPEED_DASHED"),
    spdManaged: b("I_FCU_SPEED_MANAGED"),
    hdg: v.N_FCU_HEADING,
    hdgDashed: b("B_FCU_HEADING_DASHED"),
    hdgManaged: b("I_FCU_HEADING_MANAGED"),
    trkFpa: b("B_FCU_TRKFPA"),
    alt: v.N_FCU_ALTITUDE,
    altManaged: b("I_FCU_ALTITUDE_MANAGED"),
    altStep,
    vs: v.N_FCU_VS,
    vsDashed: b("B_FCU_VERTICALSPEED_DASHED"),
    lights: { ap1: b("I_FCU_AP1"), ap2: b("I_FCU_AP2"), athr: b("I_FCU_ATHR"), loc: b("I_FCU_LOC"), appr: b("I_FCU_APPR"), exped: b("I_FCU_EXPED") },
    efis1: { baroHpa: v.N_FCU_EFIS1_BARO_HPA, baroInHg: v.N_FCU_EFIS1_BARO_INCH, ndMode: Math.round(v.S_FCU_EFIS1_ND_MODE) },
  };
}

export function emptyValues(): FenixValues {
  return Object.fromEntries(READ_VARS.map((n) => [n, 0])) as FenixValues;
}

export const isFenix = (title: string) => /fenix|fnx\s?32/i.test(title);
