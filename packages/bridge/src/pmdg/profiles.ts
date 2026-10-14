import type { ApButton, ApKnob, LightId } from "@vbuddy/protocol";

/**
 * What to look for in a PMDG SDK header. Names are matched, in order, against the event and field names the
 * installed header really contains, so a renamed or missing one shows up in the log instead of sending a wrong event.
 */
export type PmdgKind = "ng3" | "777x";

export interface FlagSpec {
  /** Field name patterns; the first one that exists is used. */
  fields: RegExp[];
  /** "any" = lit if any element is non-zero; a number = only that element. */
  index?: number | "any";
  /** True when 0 means on (PMDG numbers some switches backwards). */
  invert?: boolean;
}

export interface Profile {
  kind: PmdgKind;
  label: string;
  headerFile: string;
  struct: string;
  /** Used when the header doesn't spell the client data names. */
  dataName: string;
  controlName: string;
  isTitle(title: string): boolean;
  values: Record<"spd" | "hdg" | "alt" | "vs" | "crs", RegExp[]>;
  flags: Record<ApButton, FlagSpec>;
  press: Record<ApButton, RegExp[]>;
  knobs: Record<ApKnob, RegExp[]>;
  lights: Partial<Record<LightId, RegExp[]>>;
}

const mcp = (words: string) => new RegExp(`^EVT_MCP_.*(${words})`);
const knob = (words: string) => new RegExp(`^EVT_MCP_.*(${words}).*(SELECTOR|KNOB|WHEEL|DIAL)`);
const light = (words: string) => new RegExp(`^EVT_.*(LIGHT|LTS).*(${words})`);

/** Event names that are never a plain button press. */
export const NOT_A_BUTTON = /SELECTOR|KNOB|WHEEL|DIAL|ANNUN|GUARD|COVER|BRIGHT|DIM|TEST|_SET$|VALUE/;
/** Light events that are brightness knobs, covers and so on. */
export const NOT_A_LIGHT_SWITCH = /ANNUN|GUARD|COVER|BRIGHT|DIM|FLOOD|DOME|INST|STORM|MAP|TEST|EMER|SELECTOR|KNOB/;

const flag = (...fields: RegExp[]): FlagSpec => ({ fields });

const shared = {
  knobs: {
    spd: [/^EVT_MCP_(IAS_MACH|SPEED)_SELECTOR$/, knob("IAS|SPD|SPEED")],
    hdg: [/^EVT_MCP_HEADING_SELECTOR$/, knob("HEADING|HDG")],
    alt: [/^EVT_MCP_ALTITUDE_SELECTOR$/, knob("ALTITUDE|ALT")],
    vs: [/^EVT_MCP_VS_SELECTOR$/, knob("VS|VERT|FPA")],
    crs: [/^EVT_MCP_COURSE_SELECTOR_L$/, knob("COURSE|CRS")],
  },
  lights: {
    nav: [light("POS"), light("NAV")],
    strobe: [light("STROBE"), light("POS")],
    beacon: [light("ANT.?COL|BEACON")],
    // The 777 names them LANDING_*; the 737 has retractable (L/R_RETRACT) and fixed (L/R_FIXED) landing light switches.
    landing: [light("LAND"), light("(L|R)_(RETRACT|FIXED)")],
    taxi: [light("TAXI")],
    wing: [light("WING")],
    logo: [light("LOGO")],
    recognition: [light("TURN.?OFF|RWY|RUNWAY")],
  },
} satisfies Pick<Profile, "knobs" | "lights">;

export const PROFILES: Profile[] = [
  {
    kind: "ng3",
    label: "PMDG 737",
    headerFile: "PMDG_NG3_SDK.h",
    struct: "PMDG_NG3_Data",
    dataName: "PMDG_NG3_Data",
    controlName: "PMDG_NG3_Control",
    isTitle: (t) => /\b(B?737)[-\s]?[6-9]\d\d\b|\bBBJ\b|pmdg\s*737/i.test(t) && !/max|ifly|asobo|fenix/i.test(t),
    values: {
      spd: [/^MCP_IASMach$/],
      hdg: [/^MCP_Heading$/],
      alt: [/^MCP_Altitude$/],
      vs: [/^MCP_VertSpeed$/],
      crs: [/^MCP_Course$/],
    },
    flags: {
      cmd: { fields: [/^MCP_annunCMD_[AB]$/, /^MCP_annunCMD/], index: "any" },
      fd: { fields: [/^MCP_annunFD$/], index: 0 },
      athr: flag(/^MCP_ATArmSw$/, /^MCP_annunATArm$/),
      speed: flag(/^MCP_annunSPEED$/),
      lvlChg: flag(/^MCP_annunLVL_CHG$/),
      hdgSel: flag(/^MCP_annunHDG_SEL$/),
      lnav: flag(/^MCP_annunLNAV$/),
      app: flag(/^MCP_annunAPP$/),
      altHld: flag(/^MCP_annunALT_HOLD$/),
      vs: flag(/^MCP_annunVS$/),
    },
    press: {
      cmd: [/^EVT_MCP_CMD_A_SWITCH$/, mcp("CMD_A|AP_ENGAGE|AUTOPILOT")],
      fd: [/^EVT_MCP_FD_SWITCH_L$/, mcp("FD")],
      athr: [/^EVT_MCP_AT_ARM_SWITCH$/, mcp("AT_ARM|AUTOTHROTTLE|A_THR")],
      speed: [/^EVT_MCP_SPEED_SWITCH$/, mcp("SPEED|SPD")],
      lvlChg: [/^EVT_MCP_LVL_CHG_SWITCH$/, mcp("LVL_CHG|FLCH|LEVEL_CHANGE")],
      hdgSel: [/^EVT_MCP_HDG_SEL_SWITCH$/, mcp("HDG_SEL|HEADING_SEL|HDG_HOLD")],
      lnav: [/^EVT_MCP_LNAV_SWITCH$/, mcp("LNAV")],
      app: [/^EVT_MCP_APP_SWITCH$/, mcp("APP")],
      altHld: [/^EVT_MCP_ALT_HOLD_SWITCH$/, mcp("ALT_HOLD|ALT_HLD")],
      vs: [/^EVT_MCP_VS_SWITCH$/, mcp("VS_SW|VS_BUT|VS_HOLD")],
    },
    ...shared,
  },
  {
    kind: "777x",
    label: "PMDG 777",
    headerFile: "PMDG_777X_SDK.h",
    struct: "PMDG_777X_Data",
    dataName: "PMDG_777X_Data",
    controlName: "PMDG_777X_Control",
    isTitle: (t) => /\b777\b|\b77[WERLF]\b|pmdg\s*777/i.test(t) && !/asobo/i.test(t),
    values: {
      spd: [/^MCP_IASMach$/, /^MCP_.*(IAS|SPEED|SPD)/i],
      hdg: [/^MCP_Heading$/, /^MCP_.*(HDG|HEADING)(?!.*(blank|annun|sw))/i],
      alt: [/^MCP_Altitude$/, /^MCP_.*ALT(ITUDE)?(?!.*(blank|annun|sw|hold|intv))/i],
      vs: [/^MCP_VertSpeed$/, /^MCP_.*(VS|VERT)(?!.*(blank|annun|sw))/i],
      crs: [/^MCP_Course$/],
    },
    flags: {
      cmd: { fields: [/^MCP_annun_?(AP|CMD)/i, /^MCP_.*AP.*(engage|annun|light)/i], index: "any" },
      fd: { fields: [/^MCP_FD_Sw_On$/i, /^MCP_annun_?FD/i], index: 0 },
      athr: flag(/^MCP_ATArm_Sw_On$/i, /^MCP_annun_?(AT|ATHR|ATArm)/i),
      speed: flag(/^MCP_annun_?SPD/i, /^MCP_annun_?SPEED/i),
      lvlChg: flag(/^MCP_annun_?FLCH/i, /^MCP_annun_?LVL/i),
      hdgSel: flag(/^MCP_annun_?HDG/i),
      lnav: flag(/^MCP_annun_?LNAV/i),
      app: flag(/^MCP_annun_?APP/i),
      altHld: flag(/^MCP_annun_?ALT_?HOLD/i, /^MCP_annun_?ALT/i),
      vs: flag(/^MCP_annun_?(VS|FPA)/i),
    },
    press: {
      cmd: [mcp("AP_ENGAGE|AP_SWITCH|AP_BUTTON|AUTOPILOT|AP_L|CMD")],
      fd: [mcp("FD_SWITCH_L|FD_L|FD_SW|FD")],
      athr: [mcp("AT_ARM_SWITCH_L|AT_ARM_L|AT_ARM|ATHR|AUTOTHROTTLE")],
      speed: [mcp("SPEED_SWITCH|SPD_SWITCH|SPEED_PUSH|SPD_PUSH|SPEED_BUTTON")],
      lvlChg: [mcp("FLCH|LVL_CHG|FLIGHT_LEVEL")],
      hdgSel: [mcp("HDG_HOLD|HDG_SEL|HEADING_HOLD|HDG_SWITCH")],
      lnav: [mcp("LNAV")],
      app: [mcp("APP")],
      altHld: [mcp("ALT_HOLD|ALT_HLD")],
      vs: [mcp("VS_FPA_SWITCH|VS_SWITCH|VS_BUTTON|VS_SW")],
    },
    ...shared,
  },
];

/** Names matching the first pattern that matches anything, shortest first. Exact (`$`-anchored) patterns skip the exclusion. */
export function pickNames(names: string[], patterns: RegExp[], not: RegExp): string[] {
  for (const p of patterns) {
    const exact = p.source.endsWith("$");
    const hit = names.filter((n) => p.test(n) && (exact || !not.test(n)));
    if (hit.length) return hit.sort((a, b) => a.length - b.length || a.localeCompare(b));
  }
  return [];
}
