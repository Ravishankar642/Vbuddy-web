import { normaliseSpoken } from "./spoken.js";

/** One instruction picked out of an ATC message, with what the app can do with it. */
export interface ClearanceItem {
  kind: "level" | "altitude" | "heading" | "speed" | "frequency" | "squawk" | "qnh" | "direct";
  /** Short text for a chip: "FL350", "HDG 270", "124.350". */
  label: string;
  /** frequency: Hz for tuning; squawk: the code. */
  hz?: number;
  code?: string;
}

const once = <T extends { label: string }>(xs: T[]) => xs.filter((x, i) => xs.findIndex((y) => y.label === x.label) === i);

/**
 * Picks the instructions out of a controller's message (typed, or turned to text from voice): levels, altitudes,
 * headings, speeds, frequencies, squawk, QNH and directs. Conservative: only clear phrasings count.
 */
export function parseClearance(textIn: string): ClearanceItem[] {
  // As written (typed messages, "124.35"), and with spoken numbers turned into digits ("one two four decimal three five").
  const typed = ` ${textIn.toUpperCase().replace(/[,;]/g, " ").replace(/\s+/g, " ")} `;
  const spoken = ` ${normaliseSpoken(textIn.replace(/(\d)\.(\d)/g, "$1 DECIMAL $2")).join(" ")} `;
  return once([...parseText(typed), ...parseText(spoken)]);
}

function parseText(t: string): ClearanceItem[] {
  const out: ClearanceItem[] = [];
  for (const m of t.matchAll(/\b(?:CLIMB|DESCEND|MAINTAIN|CLEARED)\b[^.]{0,40}?\b(?:FLIGHT LEVEL|FL)\s?(\d{2,3})\b/g)) out.push({ kind: "level", label: `FL${m[1]!.padStart(3, "0")}` });
  for (const m of t.matchAll(/\b(?:CLIMB|DESCEND|MAINTAIN|CLEARED)\b[^.]{0,40}?\b(\d{1,2}[ ,]?\d{3})\s?(?:FEET|FT)\b/g)) out.push({ kind: "altitude", label: `${Number(m[1]!.replace(/\D/g, "")).toLocaleString("en-US")} ft` });
  for (const m of t.matchAll(/\bHEADING\s(\d{3})\b/g)) if (Number(m[1]) <= 360) out.push({ kind: "heading", label: `HDG ${m[1]}` });
  for (const m of t.matchAll(/\b(?:SPEED|REDUCE|INCREASE|MAINTAIN)\b[^.]{0,20}?\b(\d{3})\s?(?:KNOTS|KTS|KT)\b/g)) out.push({ kind: "speed", label: `${m[1]} kt` });
  for (const m of t.matchAll(/\b(?:CONTACT|MONITOR|FREQUENCY|CHANGE TO)\b[^.]{0,40}?\b(1[1-3]\d)(?:\.|\sDECIMAL\s|\sPOINT\s|\s)(\d{1,3})\b/g)) {
    const mhz = Number(`${m[1]}.${m[2]!.padEnd(3, "0")}`);
    if (mhz >= 118 && mhz < 137) out.push({ kind: "frequency", label: mhz.toFixed(3), hz: Math.round(mhz * 1000) * 1000 });
  }
  for (const m of t.matchAll(/\bSQUAWK\s([0-7]{4})\b/g)) out.push({ kind: "squawk", label: `Squawk ${m[1]}`, code: m[1]! });
  for (const m of t.matchAll(/\b(?:QNH|ALTIMETER)\s(\d{4})\b/g)) out.push({ kind: "qnh", label: `QNH ${m[1]}` });
  for (const m of t.matchAll(/\b(?:PROCEED\s)?DIRECT(?:\sTO)?\s([A-Z]{3,5})\b/g)) if (m[1] !== "TO") out.push({ kind: "direct", label: `DCT ${m[1]}` });
  return out;
}

/** What a pilot needs out of an ATIS: the letter, runways in use and QNH. */
export interface AtisInfo {
  code: string | null;
  runways: string[];
  qnh: string | null;
}

export function parseAtis(lines: string[], code: string | null = null): AtisInfo {
  const t = ` ${lines.join(" ").toUpperCase().replace(/\s+/g, " ")} `;
  const runways = new Set<string>();
  for (const m of t.matchAll(/\b(?:RWY|RUNWAY|RUNWAYS)S?\s(?:IN USE\s)?((?:\d{2}[LRC]?)(?:\s?(?:AND|&|\/|,)\s?\d{2}[LRC]?)*)/g)) for (const r of m[1]!.split(/\s?(?:AND|&|\/|,)\s?/)) runways.add(r.trim());
  const q = /\b(?:QNH|Q)\s?(\d{3,4})\b/.exec(t) ?? /\bALTIMETER\s?(\d{4})\b/.exec(t) ?? /\bA(\d{4})\b/.exec(t);
  const c = code ?? /\bINFORMATION\s([A-Z])\b/.exec(t)?.[1] ?? /\bATIS\s([A-Z])\b/.exec(t)?.[1] ?? null;
  return { code: c, runways: [...runways].slice(0, 4), qnh: q ? q[1]! : null };
}

/** A readback of the instructions, the way a pilot says it: "Descend FL240, heading 270, 124.900, Speedbird 123". */
export function readback(items: ClearanceItem[], callsign: string | null): string {
  const say = (i: ClearanceItem) =>
    i.kind === "heading" ? i.label.replace("HDG", "heading") : i.kind === "speed" ? i.label.replace("kt", "knots") : i.kind === "squawk" ? i.label.replace("Squawk", "squawk") : i.kind === "direct" ? i.label.replace("DCT", "direct") : i.label;
  const parts = items.map(say);
  if (!parts.length) return "";
  const first = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
  return [first, ...parts.slice(1), ...(callsign ? [callsign] : [])].join(", ");
}
