import { useEffect, useState } from "react";

/**
 * A photo of the aircraft for the Live page, the way a flight tracker shows one:
 *  1. by registration, from Planespotters.net (their terms: loaded by the browser straight from the address they
 *     give, with the photographer's name shown and linked to the photo's page);
 *  2. when there's no registration or no photo of it: a photo of the airline's aircraft of that type from
 *     Wikimedia Commons (with its author and licence).
 * Answers are kept on this device for a day.
 */
export interface AircraftPhoto {
  src: string;
  link: string;
  credit: string;
  /** "reg" = this very aircraft; "type" = the airline's aircraft of the same type. */
  kind: "reg" | "type";
}

/** ICAO type designators as people say them. */
export const TYPE_NAMES: Record<string, string> = {
  A318: "Airbus A318", A319: "Airbus A319", A320: "Airbus A320", A321: "Airbus A321",
  A19N: "Airbus A319neo", A20N: "Airbus A320neo", A21N: "Airbus A321neo",
  A332: "Airbus A330-200", A333: "Airbus A330-300", A338: "Airbus A330-800neo", A339: "Airbus A330-900neo",
  A342: "Airbus A340-200", A343: "Airbus A340-300", A345: "Airbus A340-500", A346: "Airbus A340-600",
  A359: "Airbus A350-900", A35K: "Airbus A350-1000", A388: "Airbus A380-800",
  BCS1: "Airbus A220-100", BCS3: "Airbus A220-300",
  B736: "Boeing 737-600", B737: "Boeing 737-700", B738: "Boeing 737-800", B739: "Boeing 737-900",
  B37M: "Boeing 737 MAX 7", B38M: "Boeing 737 MAX 8", B39M: "Boeing 737 MAX 9", B3XM: "Boeing 737 MAX 10",
  B744: "Boeing 747-400", B748: "Boeing 747-8", B74F: "Boeing 747-400F",
  B752: "Boeing 757-200", B753: "Boeing 757-300", B762: "Boeing 767-200", B763: "Boeing 767-300", B764: "Boeing 767-400",
  B772: "Boeing 777-200", B77L: "Boeing 777-200LR", B77W: "Boeing 777-300ER", B773: "Boeing 777-300", B778: "Boeing 777-8", B779: "Boeing 777-9",
  B788: "Boeing 787-8 Dreamliner", B789: "Boeing 787-9 Dreamliner", B78X: "Boeing 787-10 Dreamliner",
  E170: "Embraer E170", E75L: "Embraer E175", E175: "Embraer E175", E190: "Embraer E190", E195: "Embraer E195", E290: "Embraer E190-E2", E295: "Embraer E195-E2",
  AT72: "ATR 72", AT75: "ATR 72-500", AT76: "ATR 72-600", DH8D: "De Havilland Dash 8-400",
  CRJ7: "Bombardier CRJ700", CRJ9: "Bombardier CRJ900", CRJX: "Bombardier CRJ1000",
  MD11: "McDonnell Douglas MD-11", C919: "COMAC C919", A124: "Antonov An-124", C172: "Cessna 172", C208: "Cessna 208 Caravan", TBM9: "Daher TBM 900",
};

/** "Boeing 787-8 Dreamliner" → "Boeing 787" (what photo searches match best). */
const family = (name: string) => name.replace(/-\d+\w*|\s+Dreamliner|neo\b/gi, "").replace(/\s+MAX \d+/i, " MAX").trim();

/** Registration prefixes that are written with a hyphen (A7-BCE, VT-ANA, G-XWBA); US N-numbers, Japan and Korea aren't. */
const HYPHEN_PREFIX = ["A4O", "A6", "A7", "A9C", "AP", "B", "C", "CC", "CN", "CS", "D", "EC", "EI", "EP", "ET", "F", "G", "HB", "HS", "HZ", "I", "JY", "LN", "LV", "LX", "LZ", "OD", "OE", "OH", "OK", "OM", "OO", "OY", "PH", "PK", "PP", "PR", "PS", "PT", "RA", "RP", "S2", "S5", "SE", "SP", "SU", "SX", "TC", "TF", "TS", "UK", "UP", "UR", "VH", "VN", "VP", "VQ", "VT", "XA", "YA", "YI", "YK", "YR", "ZK", "ZS", "4R", "4X", "5Y", "7T", "9H", "9K", "9M", "9N", "9V"];

/** The ways to write a registration that are worth trying (as given, and with the country's hyphen). */
export function regVariants(raw: string): string[] {
  const r = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9-]{3,10}$/.test(r)) return [];
  const out = [r];
  if (!r.includes("-")) {
    // longest prefix that fits, leaving at least 2 characters after it
    const p = HYPHEN_PREFIX.filter((x) => r.startsWith(x) && r.length - x.length >= 2).sort((a, b) => b.length - a.length)[0];
    if (p) out.unshift(`${p}-${r.slice(p.length)}`);
  }
  return [...new Set(out)];
}

const CACHE_KEY = "vbuddy.photos.v1";
const DAY = 24 * 3_600_000;
type Cached = Record<string, { at: number; photo: AircraftPhoto | null }>;
function readCache(): Cached {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Cached;
  } catch {
    return {};
  }
}
function remember(key: string, photo: AircraftPhoto | null) {
  try {
    const c = readCache();
    c[key] = { at: Date.now(), photo };
    const keys = Object.keys(c);
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete c[k];
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* kept for this visit only */
  }
}

/** The photo page's address names the airline ("…/a7-bce-qatar-airways-boeing-787-8…"): a registration from another airline is wrong for this flight. */
function sameAirline(link: string, airline: string | null): boolean {
  if (!airline) return true;
  const slug = link.toLowerCase();
  const words = airline.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["air", "airlines", "airways", "the"].includes(w));
  return words.length === 0 || words.some((w) => slug.includes(w));
}

async function byReg(reg: string, airline: string | null): Promise<AircraftPhoto | null> {
  for (const v of regVariants(reg)) {
    try {
      const r = await fetch(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(v)}`);
      if (!r.ok) continue;
      const j = (await r.json()) as { photos?: Array<{ thumbnail_large?: { src: string }; thumbnail?: { src: string }; link: string; photographer: string }> };
      const p = j.photos?.[0];
      const src = p?.thumbnail_large?.src ?? p?.thumbnail?.src;
      if (p && src && sameAirline(p.link, airline)) return { src, link: p.link, credit: p.photographer, kind: "reg" };
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

async function byType(airline: string, type: string): Promise<AircraftPhoto | null> {
  const name = TYPE_NAMES[type] ?? type;
  for (const q of [`${airline} ${family(name)}`, `${airline} ${name}`]) {
    const u = new URL("https://commons.wikimedia.org/w/api.php");
    for (const [k, v] of Object.entries({ action: "query", format: "json", origin: "*", generator: "search", gsrnamespace: "6", gsrsearch: `${q} filetype:bitmap`, gsrlimit: "12", prop: "imageinfo", iiprop: "url|size|extmetadata", iiurlwidth: "640" })) u.searchParams.set(k, v);
    try {
      const j = (await (await fetch(u)).json()) as { query?: { pages?: Record<string, { index: number; title: string; imageinfo?: Array<{ thumburl?: string; width: number; height: number; descriptionurl: string; extmetadata?: Record<string, { value: string }> }> }> } };
      const pages = Object.values(j.query?.pages ?? {}).sort((a, b) => a.index - b.index);
      // A landscape photo whose name mentions the airline (not a logo, a cabin or a diagram).
      const words = airline.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const pick = pages.find((p) => {
        const i = p.imageinfo?.[0];
        const t = p.title.toLowerCase();
        return i?.thumburl && i.width > i.height * 1.2 && words.some((w) => t.includes(w)) && !/logo|cabin|seat|interior|cockpit|diagram|livery drawing|\.svg/.test(t);
      });
      const info = pick?.imageinfo?.[0];
      if (pick && info?.thumburl) {
        const m = info.extmetadata ?? {};
        const who = stripHtml(m.Artist?.value ?? "") || "Wikimedia Commons";
        const lic = stripHtml(m.LicenseShortName?.value ?? "");
        return { src: info.thumburl, link: info.descriptionurl, credit: lic ? `${who} · ${lic}` : who, kind: "type" };
      }
    } catch {
      /* no fallback photo this time */
    }
  }
  return null;
}

/**
 * The photo for this aircraft, or null while looking / when there's none. `regs` are tried in order (VATSIM
 * remarks, SimBrief, the sim); a registration whose photo shows another airline is skipped.
 */
export function useAircraftPhoto(regs: Array<string | null | undefined>, airline: string | null, type: string | null): AircraftPhoto | null {
  const list = [...new Set(regs.filter((r): r is string => !!r && r.trim().length >= 3).map((r) => r.trim().toUpperCase()))];
  const key = `${list.join(",")}|${airline ?? ""}|${type ?? ""}`;
  const [photo, setPhoto] = useState<AircraftPhoto | null>(() => {
    const hit = readCache()[key];
    return hit && Date.now() - hit.at < DAY ? hit.photo : null;
  });
  useEffect(() => {
    const hit = readCache()[key];
    if (hit && Date.now() - hit.at < DAY) return setPhoto(hit.photo);
    if (!list.length && !(airline && type)) return setPhoto(null);
    let gone = false;
    void (async () => {
      let p: AircraftPhoto | null = null;
      for (const r of list) if (!p) p = await byReg(r, airline);
      p ??= airline && type ? await byType(airline, type) : null;
      remember(key, p);
      if (!gone) setPhoto(p);
    })();
    return () => {
      gone = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return photo;
}
