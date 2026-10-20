/**
 * Airlines by ICAO code, with the colours the app takes on when you connect to VATSIM with one of their callsigns
 * (QTR123 = Qatar Airways). `brand` is the airline's main colour; `second` its second one (used for the planned
 * route on the map); `neutral` makes the surfaces plain black / white / grey instead of tinted with the brand colour.
 */
export interface Airline {
  name: string;
  iata: string;
  brand: string;
  second?: string;
  neutral?: boolean;
}

export const AIRLINES: Record<string, Airline> = {
  // Middle East
  QTR: { name: "Qatar Airways", iata: "QR", brand: "#5c0632", second: "#a7a9ac" },
  UAE: { name: "Emirates", iata: "EK", brand: "#00843d", second: "#d71921", neutral: true },
  ETD: { name: "Etihad Airways", iata: "EY", brand: "#8c6b2f", second: "#3b3b3b" },
  GFA: { name: "Gulf Air", iata: "GF", brand: "#7a1f3d", second: "#c8a45d" },
  OMA: { name: "Oman Air", iata: "WY", brand: "#00737a", second: "#c7a76c" },
  SVA: { name: "Saudia", iata: "SV", brand: "#006c4f", second: "#c9a227" },
  FDB: { name: "flydubai", iata: "FZ", brand: "#1b2a5b", second: "#f26722" },
  ABY: { name: "Air Arabia", iata: "G9", brand: "#d6003b", second: "#6d6e71" },
  KAC: { name: "Kuwait Airways", iata: "KU", brand: "#0b3b8c", second: "#3fa9f5" },
  RJA: { name: "Royal Jordanian", iata: "RJ", brand: "#2b2b2b", second: "#b8975a", neutral: true },
  MEA: { name: "Middle East Airlines", iata: "ME", brand: "#00703c", second: "#d71920" },
  ELY: { name: "El Al", iata: "LY", brand: "#003a8c", second: "#8fb3e0" },
  THY: { name: "Turkish Airlines", iata: "TK", brand: "#c8102e", second: "#5f6a72" },
  PGT: { name: "Pegasus", iata: "PC", brand: "#f9b000", second: "#6b1f6e" },
  // South Asia
  IGO: { name: "IndiGo", iata: "6E", brand: "#001b94", second: "#4f8dfd" },
  AIC: { name: "Air India", iata: "AI", brand: "#c8102e", second: "#4b0f2e" },
  AXB: { name: "Air India Express", iata: "IX", brand: "#e2521e", second: "#00757f" },
  VTI: { name: "Vistara", iata: "UK", brand: "#5f2a5f", second: "#c4a15a" },
  AKJ: { name: "Akasa Air", iata: "QP", brand: "#ff6d38", second: "#5b2a86" },
  SEJ: { name: "SpiceJet", iata: "SG", brand: "#d71920", second: "#f9a51b" },
  ALK: { name: "SriLankan Airlines", iata: "UL", brand: "#0b3b72", second: "#e5a823" },
  PIA: { name: "PIA", iata: "PK", brand: "#00664f", second: "#b3a369" },
  BBC: { name: "Biman Bangladesh", iata: "BG", brand: "#00704a", second: "#d1232a" },
  RNA: { name: "Nepal Airlines", iata: "RA", brand: "#c8102e", second: "#003893" },
  // East and South-East Asia, Oceania
  SIA: { name: "Singapore Airlines", iata: "SQ", brand: "#13284c", second: "#f0ab00" },
  CPA: { name: "Cathay Pacific", iata: "CX", brand: "#006564", second: "#a6a8ab" },
  JAL: { name: "Japan Airlines", iata: "JL", brand: "#c8102e", second: "#4d4d4d", neutral: true },
  ANA: { name: "All Nippon Airways", iata: "NH", brand: "#13448f", second: "#00a3e0" },
  KAL: { name: "Korean Air", iata: "KE", brand: "#00256c", second: "#4aa3df" },
  AAR: { name: "Asiana Airlines", iata: "OZ", brand: "#5c5c5c", second: "#c8102e", neutral: true },
  CCA: { name: "Air China", iata: "CA", brand: "#c8102e", second: "#4d4d4d" },
  CES: { name: "China Eastern", iata: "MU", brand: "#1d2a6b", second: "#e60012" },
  CSN: { name: "China Southern", iata: "CZ", brand: "#004a97", second: "#e60012" },
  HDA: { name: "Hong Kong Airlines", iata: "HX", brand: "#c8102e", second: "#9b8355" },
  EVA: { name: "EVA Air", iata: "BR", brand: "#00704a", second: "#f39200" },
  CAL: { name: "China Airlines", iata: "CI", brand: "#1d3c78", second: "#d4547b" },
  MAS: { name: "Malaysia Airlines", iata: "MH", brand: "#003a70", second: "#e2231a" },
  AXM: { name: "AirAsia", iata: "AK", brand: "#e2001a", second: "#5a5a5a" },
  THA: { name: "Thai Airways", iata: "TG", brand: "#4e2a84", second: "#c4007a" },
  GIA: { name: "Garuda Indonesia", iata: "GA", brand: "#00799c", second: "#8dc63f" },
  PAL: { name: "Philippine Airlines", iata: "PR", brand: "#00338d", second: "#e31837" },
  HVN: { name: "Vietnam Airlines", iata: "VN", brand: "#006885", second: "#c8a45d" },
  VJC: { name: "VietJet", iata: "VJ", brand: "#e21b22", second: "#fbd000" },
  QFA: { name: "Qantas", iata: "QF", brand: "#e0001b", second: "#5c5c5c" },
  VOZ: { name: "Virgin Australia", iata: "VA", brand: "#5b2c86", second: "#e31c24" },
  ANZ: { name: "Air New Zealand", iata: "NZ", brand: "#1a1a1a", second: "#00a6b6", neutral: true },
  // Europe
  BAW: { name: "British Airways", iata: "BA", brand: "#075aaa", second: "#eb2226" },
  VIR: { name: "Virgin Atlantic", iata: "VS", brand: "#da0530", second: "#5b2a6e" },
  EZY: { name: "easyJet", iata: "U2", brand: "#ff6600", second: "#4d4d4d" },
  RYR: { name: "Ryanair", iata: "FR", brand: "#073590", second: "#f1c933" },
  WZZ: { name: "Wizz Air", iata: "W6", brand: "#c6007e", second: "#2e2c8c" },
  DLH: { name: "Lufthansa", iata: "LH", brand: "#05164d", second: "#ffad00" },
  EWG: { name: "Eurowings", iata: "EW", brand: "#a5004a", second: "#7a7a7a" },
  SWR: { name: "Swiss", iata: "LX", brand: "#e2001a", second: "#5c5c5c", neutral: true },
  AUA: { name: "Austrian Airlines", iata: "OS", brand: "#e30613", second: "#5c5c5c", neutral: true },
  AFR: { name: "Air France", iata: "AF", brand: "#002157", second: "#e4002b" },
  KLM: { name: "KLM", iata: "KL", brand: "#00a1de", second: "#003082" },
  IBE: { name: "Iberia", iata: "IB", brand: "#d7192d", second: "#ffcc00" },
  VLG: { name: "Vueling", iata: "VY", brand: "#ffcc00", second: "#5a5a5a", neutral: true },
  TAP: { name: "TAP Air Portugal", iata: "TP", brand: "#e2001a", second: "#8dc63f" },
  ITY: { name: "ITA Airways", iata: "AZ", brand: "#1a3c8e", second: "#4cb8e8" },
  SAS: { name: "SAS", iata: "SK", brand: "#000a8c", second: "#a3a3a3" },
  FIN: { name: "Finnair", iata: "AY", brand: "#0b1560", second: "#5ac8fa" },
  NAX: { name: "Norwegian", iata: "DY", brand: "#d81939", second: "#003251" },
  ICE: { name: "Icelandair", iata: "FI", brand: "#002b5c", second: "#f3c300" },
  EIN: { name: "Aer Lingus", iata: "EI", brand: "#006272", second: "#8dc63f" },
  AEE: { name: "Aegean", iata: "A3", brand: "#0a3a7a", second: "#d4a017" },
  LOT: { name: "LOT Polish", iata: "LO", brand: "#11397e", second: "#a6a8ab" },
  CSA: { name: "Czech Airlines", iata: "OK", brand: "#004b93", second: "#d7141a" },
  BEL: { name: "Brussels Airlines", iata: "SN", brand: "#003d6b", second: "#e2001a" },
  CFG: { name: "Condor", iata: "DE", brand: "#f2b300", second: "#3b3b3b", neutral: true },
  AFL: { name: "Aeroflot", iata: "SU", brand: "#00256c", second: "#e31e24" },
  // Americas
  AAL: { name: "American Airlines", iata: "AA", brand: "#0078d2", second: "#c30019" },
  DAL: { name: "Delta", iata: "DL", brand: "#003a70", second: "#c8102e" },
  UAL: { name: "United", iata: "UA", brand: "#002244", second: "#0060a9" },
  SWA: { name: "Southwest", iata: "WN", brand: "#304cb2", second: "#ffbf27" },
  JBU: { name: "JetBlue", iata: "B6", brand: "#003876", second: "#0099d8" },
  ASA: { name: "Alaska Airlines", iata: "AS", brand: "#01426a", second: "#48a9c5" },
  FFT: { name: "Frontier", iata: "F9", brand: "#00704a", second: "#a6a6a6" },
  NKS: { name: "Spirit", iata: "NK", brand: "#ffd200", second: "#1a1a1a", neutral: true },
  HAL: { name: "Hawaiian", iata: "HA", brand: "#5b2a86", second: "#d6006d" },
  ACA: { name: "Air Canada", iata: "AC", brand: "#d22630", second: "#1a1a1a", neutral: true },
  WJA: { name: "WestJet", iata: "WS", brand: "#00a5b5", second: "#1c3f6e" },
  AMX: { name: "Aeroméxico", iata: "AM", brand: "#0b2343", second: "#e60f27" },
  VOI: { name: "Volaris", iata: "Y4", brand: "#a12f86", second: "#00a5b5" },
  LAN: { name: "LATAM", iata: "LA", brand: "#1b0088", second: "#ed1650" },
  TAM: { name: "LATAM Brasil", iata: "JJ", brand: "#1b0088", second: "#ed1650" },
  AVA: { name: "Avianca", iata: "AV", brand: "#da291c", second: "#4d4d4d" },
  CMP: { name: "Copa Airlines", iata: "CM", brand: "#00205b", second: "#9b8441" },
  GLO: { name: "GOL", iata: "G3", brand: "#ff7020", second: "#5c5c5c" },
  AZU: { name: "Azul", iata: "AD", brand: "#002f87", second: "#00a3e0" },
  ARG: { name: "Aerolíneas Argentinas", iata: "AR", brand: "#0a3f7a", second: "#68b6e5" },
  // Africa
  ETH: { name: "Ethiopian Airlines", iata: "ET", brand: "#2b7c3c", second: "#fcd116" },
  KQA: { name: "Kenya Airways", iata: "KQ", brand: "#c8102e", second: "#1a1a1a" },
  SAA: { name: "South African Airways", iata: "SA", brand: "#00335f", second: "#e2a225" },
  MSR: { name: "EgyptAir", iata: "MS", brand: "#0a2c5a", second: "#c8a24c" },
  RAM: { name: "Royal Air Maroc", iata: "AT", brand: "#c8102e", second: "#007a3d" },
  RWD: { name: "RwandAir", iata: "WB", brand: "#00a3e0", second: "#ffd100" },
};

/** The airline in a VATSIM callsign (QTR123, IGO6E45 → QTR, IGO), if it's one VBuddy knows. */
export function airlineOf(callsign: string | null | undefined): (Airline & { icao: string }) | null {
  const m = /^([A-Z]{3})[0-9]/.exec((callsign ?? "").toUpperCase().trim());
  if (!m) return null;
  const a = AIRLINES[m[1]!];
  return a ? { ...a, icao: m[1]! } : null;
}
