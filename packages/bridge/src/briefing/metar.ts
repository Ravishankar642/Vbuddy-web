import type { DecodedMetar, FlightCategory } from "@vbuddy/protocol";


const WX_CODES = /^(?:[-+]|VC)?(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+$/;

const WX_WORDS: Record<string, string> = {
  MI: "shallow", PR: "partial", BC: "patches of", DR: "drifting", BL: "blowing", SH: "showers of", TS: "thunderstorm", FZ: "freezing",
  DZ: "drizzle", RA: "rain", SN: "snow", SG: "snow grains", IC: "ice crystals", PL: "ice pellets", GR: "hail", GS: "small hail", UP: "precipitation",
  BR: "mist", FG: "fog", FU: "smoke", VA: "volcanic ash", DU: "dust", SA: "sand", HZ: "haze", PY: "spray", PO: "dust whirls", SQ: "squalls", FC: "funnel cloud", SS: "sandstorm", DS: "duststorm",
};

export function describeWeather(code: string): string {
  let rest = code;
  let prefix = "";
  if (rest.startsWith("-")) (prefix = "light "), (rest = rest.slice(1));
  else if (rest.startsWith("+")) (prefix = "heavy "), (rest = rest.slice(1));
  else if (rest.startsWith("VC")) (prefix = "nearby "), (rest = rest.slice(2));
  const words: string[] = [];
  for (let i = 0; i + 1 < rest.length + 1; i += 2) {
    const w = WX_WORDS[rest.slice(i, i + 2)];
    if (w) words.push(w);
  }
  return prefix + words.join(" ");
}

/** US standard: the lower of visibility and ceiling decides. */
export function flightCategory(visM: number | null, ceilingFt: number | null): FlightCategory | null {
  if (visM === null && ceilingFt === null) return null;
  const miles = visM === null ? Infinity : visM / 1609.34;
  const ceil = ceilingFt === null ? Infinity : ceilingFt;
  if (miles < 1 || ceil < 500) return "LIFR";
  if (miles < 3 || ceil < 1000) return "IFR";
  if (miles <= 5 || ceil <= 3000) return "MVFR";
  return "VFR";
}

function temp(s: string): number | null {
  if (!s) return null;
  const n = Number(s.replace(/^M/, ""));
  return Number.isFinite(n) ? (s.startsWith("M") ? -n : n) : null;
}

/** `now` lets the day/time group be placed in the right month. */
export function parseMetar(rawIn: string, now = Date.now()): DecodedMetar {
  const raw = rawIn.replace(/\s+/g, " ").trim();
  const out: DecodedMetar = { raw, station: "", observedAt: null, windDir: null, windKt: null, gustKt: null, visM: null, ceilingFt: null, clouds: [], tempC: null, dewC: null, qnhHpa: null, weather: [], category: null };
  const tokens = raw.split(" ");
  let i = 0;
  if (tokens[i] === "METAR" || tokens[i] === "SPECI") i++;
  if (/^[A-Z][A-Z0-9]{3}$/.test(tokens[i] ?? "")) out.station = tokens[i++]!;
  const stop = tokens.findIndex((t) => t === "RMK" || t === "TEMPO" || t === "BECMG");
  const body = stop >= 0 ? tokens.slice(i, stop) : tokens.slice(i);

  for (let k = 0; k < body.length; k++) {
    const t = body[k]!;
    let m: RegExpExecArray | null;
    if ((m = /^(\d{2})(\d{2})(\d{2})Z$/.exec(t))) {
      const d = new Date(now);
      let cand = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Number(m[1]), Number(m[2]), Number(m[3]));
      if (cand > now + 36 * 3600e3) {
        // the report is from last month
        cand = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, Number(m[1]), Number(m[2]), Number(m[3]));
      }
      out.observedAt = cand;
    } else if ((m = /^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(t))) {
      const k2 = m[4] === "MPS" ? 1.94384 : 1;
      out.windDir = m[1] === "VRB" ? "VRB" : Number(m[1]);
      out.windKt = Math.round(Number(m[2]) * k2);
      out.gustKt = m[3] ? Math.round(Number(m[3]) * k2) : null;
      if (out.windKt === 0 && out.gustKt === null) out.windDir = null;
    } else if (/^\d{3}V\d{3}$/.test(t)) {
      /* variable wind sector: ignored */
    } else if (t === "CAVOK") {
      out.visM = 9999;
    } else if (/^\d{4}$/.test(t) && out.visM === null && k > 0) {
      out.visM = Number(t);
    } else if ((m = /^(M?)(\d+)?(?:(\d)\/(\d))?SM$/.exec(t)) || (/^\d$/.test(t) && /^\d\/\dSM$/.test(body[k + 1] ?? ""))) {
      // US statute miles, possibly "1 1/2SM" split over two tokens
      let miles = 0;
      if (/^\d$/.test(t)) {
        const f = /^(\d)\/(\d)SM$/.exec(body[k + 1]!)!;
        miles = Number(t) + Number(f[1]) / Number(f[2]);
        k++;
      } else if (m) {
        miles = (m[2] ? Number(m[2]) : 0) + (m[3] ? Number(m[3]) / Number(m[4]) : 0);
      }
      out.visM = Math.round(miles * 1609.34);
      if (out.visM >= 9656) out.visM = 9999;
    } else if ((m = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU)?$/.exec(t))) {
      const base = m[2] === "///" ? null : Number(m[2]) * 100;
      out.clouds.push({ cover: m[1] as DecodedMetar["clouds"][number]["cover"], baseFt: base, ...(m[3] ? { type: m[3] } : {}) });
      if ((m[1] === "BKN" || m[1] === "OVC" || m[1] === "VV") && base !== null && (out.ceilingFt === null || base < out.ceilingFt)) out.ceilingFt = base;
    } else if (t === "NSC" || t === "NCD" || t === "SKC" || t === "CLR") {
      /* no cloud */
    } else if ((m = /^(M?\d{1,2})\/(M?\d{1,2})?$/.exec(t))) {
      out.tempC = temp(m[1]!);
      out.dewC = m[2] ? temp(m[2]) : null;
    } else if ((m = /^Q(\d{4})$/.exec(t))) {
      out.qnhHpa = Number(m[1]);
    } else if ((m = /^A(\d{4})$/.exec(t))) {
      out.qnhHpa = Math.round((Number(m[1]) / 100) * 33.8639);
    } else if (WX_CODES.test(t)) {
      out.weather.push(t);
    }
  }
  if (out.visM === null && body.includes("CAVOK")) out.visM = 9999;
  out.category = flightCategory(out.visM, out.ceilingFt);
  return out;
}

