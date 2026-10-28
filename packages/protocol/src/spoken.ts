import { PHONETIC_WORDS, TELEPHONY } from "./telephony.js";

/*
 * Spotting your callsign in spoken ATC, as speech recognition writes it down: "Speedbird one two three", "speed bird
 * 123", "Qatari twelve thirty four", "November three alpha bravo". The transcript is normalised (number words to
 * digits, phonetic words to letters, runs of digits and letters joined) and compared with what ATC would say.
 */

const UNITS: Record<string, number> = { ZERO: 0, OH: 0, ONE: 1, TWO: 2, THREE: 3, TREE: 3, FOUR: 4, FOWER: 4, FIVE: 5, FIFE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, NINER: 9 };
const TEENS: Record<string, number> = { TEN: 10, ELEVEN: 11, TWELVE: 12, THIRTEEN: 13, FOURTEEN: 14, FIFTEEN: 15, SIXTEEN: 16, SEVENTEEN: 17, EIGHTEEN: 18, NINETEEN: 19 };
const TENS: Record<string, number> = { TWENTY: 20, THIRTY: 30, FORTY: 40, FIFTY: 50, SIXTY: 60, SEVENTY: 70, EIGHTY: 80, NINETY: 90 };
const LETTER_OF: Record<string, string> = Object.fromEntries(Object.entries(PHONETIC_WORDS).map(([l, w]) => [w, l]));
LETTER_OF.ALFA = "A";
LETTER_OF.JULIET = "J";
LETTER_OF.WHISKY = "W";
LETTER_OF["X-RAY"] = "X";

/**
 * Normalised words: upper case, number words as digits ("twelve thirty four" -> "1234"), phonetic words as letters,
 * and runs of digits / single letters joined into one word ("1 2 alpha bravo" -> "12AB").
 */
export function normaliseSpoken(text: string, keep: ReadonlySet<string> = new Set()): string[] {
  const raw = text
    .toUpperCase()
    .replace(/X-RAY/g, "XRAY")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Number words to digit strings: "one" -> "1", "twelve" -> "12", "thirty four" -> "34", "hundred" -> "00".
  const words: Array<{ w: string; code: boolean }> = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i]!;
    if (UNITS[w] !== undefined) words.push({ w: String(UNITS[w]), code: true });
    else if (TEENS[w] !== undefined) words.push({ w: String(TEENS[w]), code: true });
    else if (TENS[w] !== undefined) {
      const next = raw[i + 1];
      if (next && UNITS[next] !== undefined && UNITS[next]! > 0) {
        words.push({ w: String(TENS[w]! + UNITS[next]!), code: true });
        i++;
      } else words.push({ w: String(TENS[w]), code: true });
    } else if (w === "HUNDRED") words.push({ w: "00", code: true });
    else if (w === "THOUSAND") words.push({ w: "000", code: true });
    else if (keep.has(w)) words.push({ w, code: false });
    else if (LETTER_OF[w]) words.push({ w: LETTER_OF[w]!, code: true });
    else if (/^\d+[A-Z]{0,2}$/.test(w) || /^[A-Z]$/.test(w)) words.push({ w, code: true });
    else words.push({ w, code: false });
  }
  const out: string[] = [];
  let run = "";
  for (const x of words) {
    if (x.code) run += x.w;
    else {
      if (run) out.push(run);
      run = "";
      out.push(x.w);
    }
  }
  if (run) out.push(run);
  return out;
}

/** How ATC says a callsign: the airline's telephony words and the flight number ("SPEEDBIRD", "123"); or a registration spelled out. */
export function spokenCallsign(callsign: string): { words: string[]; suffix: string } | null {
  const cs = callsign.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cs.length < 2) return null;
  const m = /^([A-Z]{3})(\d[A-Z0-9]*)$/.exec(cs);
  if (m) {
    const tel = TELEPHONY[m[1]!];
    return { words: tel ? tel.split(" ") : [m[1]!], suffix: m[2]! };
  }
  // A registration (N123AB, G-ABCD, A7BCE): all of it spelled out; ATC may shorten it to the last characters.
  return { words: [], suffix: cs };
}

/** Words a joined telephony designator is spoken as ("AIRINDIA" is said "Air India"). */
function splitKnown(w: string): string[] {
  const parts: string[] = [];
  for (const p of ["AIR", "INDIA", "CHINA", "JAPAN", "KOREAN", "FRANCE", "MAROC", "ALGERIE", "MAURITIUS", "BALTIC", "NOSTRUM", "LINES", "SHUTTLE", "EXPRESS", "WINGS", "CARGO", "JET"]) {
    if (w.includes(p)) parts.push(p, w.replace(p, ""));
  }
  return parts.filter(Boolean);
}

/** Edit distance, for telephony words speech recognition gets nearly right ("Speedbird" / "Speed Bird" / "Speedbirds"). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}
const close = (a: string, b: string) => a === b || (b.length >= 4 && distance(a, b) <= Math.max(1, Math.floor(b.length / 4)));

/**
 * Does this transcript address (or mention) `callsign`? The flight number must be exact; the airline's name may be a
 * little off, may be split or joined ("SPEED BIRD"), and a registration may be shortened to its last three characters
 * once the controller has said it in full.
 */
export function mentionsCallsign(text: string, callsign: string | null | undefined): boolean {
  if (!callsign) return false;
  const want = spokenCallsign(callsign);
  if (!want) return false;
  // The airline's own words stay words: "Air India" mustn't become "AIR I", nor "Delta" a "D".
  const keep = new Set(want.words.flatMap((w) => [w, ...splitKnown(w)]));
  const t = normaliseSpoken(text, keep);
  if (!want.words.length) {
    const s = want.suffix;
    return t.some((w) => w === s || (s.length > 4 && w === s.slice(-3)) || (s.length >= 5 && w === s.slice(1)));
  }
  const name = want.words.join("");
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== want.suffix) continue;
    // The airline name in the 1-3 words before the number, joined or not.
    for (let n = 1; n <= 3 && i - n >= 0; n++) {
      if (close(t.slice(i - n, i).join(""), name)) return true;
    }
    // "Speedbird 123" written as one word.
    if (i > 0 && close(t[i - 1]!, name)) return true;
  }
  // "SPEEDBIRD123" as one word.
  return t.some((w) => w.endsWith(want.suffix) && close(w.slice(0, -want.suffix.length), name));
}
