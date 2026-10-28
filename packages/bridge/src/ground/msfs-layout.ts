import { assignHolds, GE_PARKING, GE_RUNWAY, GE_TAXI, GN_HOLD, GN_ILS_HOLD, GN_NORMAL, GN_PARKING, LocalFrame, type GroundChart, type ParkingKind } from "@vbuddy/protocol";

/*
 * Turning the simulator's airport facility data (SimConnect Facilities API: AIRPORT with its RUNWAY, TAXI_POINT,
 * TAXI_PARKING, TAXI_PATH and TAXI_NAME children) into a VBuddy GroundChart. Pure, so it can be tested with made-up
 * layouts; the SimConnect side is in msfs-ground.ts.
 */

export interface RawRunway {
  lat: number;
  lon: number;
  /** True heading of the primary end. */
  hdg: number;
  lengthM: number;
  widthM: number;
  primaryNumber: number;
  primaryDesignator: number;
  secondaryNumber: number;
  secondaryDesignator: number;
}
export interface RawPoint {
  type: number;
  /** Metres from the airport reference point (see orientation below). */
  biasX: number;
  biasZ: number;
}
export interface RawParking {
  type: number;
  name: number;
  suffix: number;
  number: number;
  hdg: number;
  radiusM: number;
  biasX: number;
  biasZ: number;
}
export interface RawPath {
  type: number;
  widthM: number;
  start: number;
  end: number;
  nameIndex: number;
}
export interface RawLayout {
  lat: number;
  lon: number;
  altM: number;
  name: string;
  runways: RawRunway[];
  points: RawPoint[];
  parkings: RawParking[];
  paths: RawPath[];
  names: string[];
}

/* SDK enums (TAXI_PATH TYPE, TAXI_POINT TYPE, TAXI_PARKING TYPE / NAME, runway NUMBER / DESIGNATOR). */
const PATH_TAXI = 1;
const PATH_RUNWAY = 2;
const PATH_PARKING = 3;
const PATH_PATH = 4;
const POINT_HOLD = new Set([2, 5]);
const POINT_ILS_HOLD = new Set([4, 6]);
const PARK_VEHICLE = 13;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const DESIGNATOR = ["", "L", "R", "C", "W", "A", "B"];

/** Runway number + designator as painted: 9 + LEFT -> "09L"; 37 (NORTH) -> "N". */
export function runwayId(number: number, designator: number): string {
  const n = number >= 1 && number <= 36 ? String(number).padStart(2, "0") : number >= 37 && number <= 44 ? COMPASS[number - 37]! : "";
  return n + (DESIGNATOR[designator] ?? "");
}

/** What a parking spot is called in the sim (and on the airport's charts, usually): "C22", "Gate 12", "Stand 5". */
export function parkingName(name: number, suffix: number, number: number): string {
  const letter = (v: number) => (v >= 12 && v <= 37 ? String.fromCharCode(65 + v - 12) : "");
  const suf = letter(suffix);
  if (name >= 12 && name <= 37) return `${letter(name)}${number || ""}${suf}`;
  if (name === 10) return `Gate ${number}${suf}`;
  if (name === 11) return `Dock ${number}${suf}`;
  if (name >= 2 && name <= 9) return `${COMPASS[name - 2]} ${number}${suf}`;
  return `Stand ${number}${suf}`;
}

export function parkingKind(type: number): ParkingKind {
  if (type >= 8 && type <= 10) return "gate";
  if (type === 15) return "gate";
  if (type >= 1 && type <= 4) return "ga";
  if (type === 14) return "ga";
  if (type === 5) return "cargo";
  if (type === 6 || type === 7) return "mil";
  if (type === 12) return "fuel";
  return "other";
}

/** The four ways the scenery's metre offsets could map onto east / north; the right one is found against the runways. */
const ORIENTATIONS: Array<(x: number, z: number) => [number, number]> = [
  (x, z) => [x, z],
  (x, z) => [z, x],
  (x, z) => [x, -z],
  (x, z) => [-x, z],
];

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/**
 * Picks how the offsets map onto the ground: the taxi points that runway paths join lie on a runway's centreline,
 * so the mapping that puts them closest to the real runways is the right one. Without runway paths, the holding
 * points (which sit 50–150 m from a centreline) decide. Returns the index into ORIENTATIONS.
 */
export function pickOrientation(raw: RawLayout): number {
  const f = new LocalFrame(raw.lat, raw.lon);
  const rws = raw.runways.map((r) => {
    const [cx, cy] = f.xy(r.lat, r.lon);
    const h = (r.hdg * Math.PI) / 180;
    const dx = (Math.sin(h) * r.lengthM) / 2;
    const dy = (Math.cos(h) * r.lengthM) / 2;
    return [cx - dx, cy - dy, cx + dx, cy + dy] as const;
  });
  if (!rws.length) return 0;
  const onRunway = new Set<number>();
  for (const p of raw.paths) if (p.type === PATH_RUNWAY) onRunway.add(p.start).add(p.end);
  const probe = onRunway.size ? [...onRunway] : raw.points.map((p, i) => (POINT_HOLD.has(p.type) || POINT_ILS_HOLD.has(p.type) ? i : -1)).filter((i) => i >= 0);
  const target = onRunway.size ? 0 : 90;
  if (!probe.length) return 0;
  let best = 0;
  let bestScore = Infinity;
  ORIENTATIONS.forEach((o, oi) => {
    let sum = 0;
    let n = 0;
    for (const i of probe.slice(0, 400)) {
      const p = raw.points[i];
      if (!p) continue;
      const [x, y] = o(p.biasX, p.biasZ);
      const d = Math.min(...rws.map((r) => segDist(x, y, r[0], r[1], r[2], r[3])));
      sum += Math.min(2000, Math.abs(d - target));
      n++;
    }
    const score = n ? sum / n : Infinity;
    if (score < bestScore - 0.5) {
      bestScore = score;
      best = oi;
    }
  });
  return best;
}

const r7 = (v: number) => Math.round(v * 1e7) / 1e7;

/** A GroundChart from the simulator's facility data. Nodes nothing uses are left out, to keep it small. */
export function buildChart(icao: string, raw: RawLayout, now = Date.now()): GroundChart {
  const f = new LocalFrame(raw.lat, raw.lon);
  const orient = ORIENTATIONS[pickOrientation(raw)]!;
  const pos = (x: number, z: number): [number, number] => {
    const [e, n] = orient(x, z);
    const [la, lo] = f.ll(e, n);
    return [r7(la), r7(lo)];
  };
  // All points, then all parkings (a PARKING path's END is a parking index).
  const allNodes: Array<[number, number, number]> = raw.points.map((p) => {
    const kind = POINT_HOLD.has(p.type) ? GN_HOLD : POINT_ILS_HOLD.has(p.type) ? GN_ILS_HOLD : GN_NORMAL;
    return [...pos(p.biasX, p.biasZ), kind];
  });
  const parkBase = allNodes.length;
  for (const p of raw.parkings) allNodes.push([...pos(p.biasX, p.biasZ), GN_PARKING]);

  const rawEdges: Array<[number, number, number, number, number]> = [];
  for (const p of raw.paths) {
    let kind: number;
    if (p.type === PATH_TAXI || p.type === PATH_PATH) kind = GE_TAXI;
    else if (p.type === PATH_RUNWAY) kind = GE_RUNWAY;
    else if (p.type === PATH_PARKING) kind = GE_PARKING;
    else continue; // closed, vehicle, road, painted line
    const a = p.start;
    const b = kind === GE_PARKING ? parkBase + p.end : p.end;
    if (kind === GE_PARKING && raw.parkings[p.end]?.type === PARK_VEHICLE) continue;
    if (!allNodes[a] || !allNodes[b] || a === b) continue;
    const name = kind === GE_TAXI && p.nameIndex >= 0 && p.nameIndex < raw.names.length && raw.names[p.nameIndex]!.trim() ? p.nameIndex : -1;
    rawEdges.push([a, b, name, kind, Math.round(p.widthM * 10) / 10]);
  }

  // Keep only nodes something uses, renumbered.
  const used = new Set<number>();
  for (const [a, b] of rawEdges) used.add(a).add(b);
  raw.parkings.forEach((p, i) => p.type !== PARK_VEHICLE && used.add(parkBase + i));
  const remap = new Map<number, number>();
  const nodes: GroundChart["nodes"] = [];
  [...used].sort((x, y) => x - y).forEach((old) => {
    remap.set(old, nodes.length);
    nodes.push(allNodes[old]!);
  });
  const edges: GroundChart["edges"] = rawEdges.map(([a, b, n, k, w]) => [remap.get(a)!, remap.get(b)!, n, k, w]);
  const parking: GroundChart["parking"] = [];
  raw.parkings.forEach((p, i) => {
    if (p.type === PARK_VEHICLE) return;
    parking.push({ node: remap.get(parkBase + i)!, name: parkingName(p.name, p.suffix, p.number), kind: parkingKind(p.type), hdg: Math.round(((p.hdg % 360) + 360) % 360), radiusM: Math.round(p.radiusM) });
  });

  const runways: GroundChart["runways"] = raw.runways.map((r) => {
    const [cx, cy] = f.xy(r.lat, r.lon);
    const h = (r.hdg * Math.PI) / 180;
    const dx = (Math.sin(h) * r.lengthM) / 2;
    const dy = (Math.cos(h) * r.lengthM) / 2;
    const [aLat, aLon] = f.ll(cx - dx, cy - dy);
    const [bLat, bLon] = f.ll(cx + dx, cy + dy);
    const hdg = ((r.hdg % 360) + 360) % 360;
    return {
      ends: [
        { id: runwayId(r.primaryNumber, r.primaryDesignator) || "?", lat: r7(aLat), lon: r7(aLon), hdg: Math.round(hdg) },
        { id: runwayId(r.secondaryNumber, r.secondaryDesignator) || "?", lat: r7(bLat), lon: r7(bLon), hdg: Math.round((hdg + 180) % 360) },
      ],
      widthM: Math.round(r.widthM),
      lengthM: Math.round(r.lengthM),
    };
  });

  const chart: GroundChart = {
    icao: icao.toUpperCase(),
    name: raw.name.trim().slice(0, 80),
    lat: r7(raw.lat),
    lon: r7(raw.lon),
    elevFt: Math.round(raw.altM * 3.28084),
    source: "msfs",
    nodes,
    edges,
    names: raw.names.map((n) => n.trim().slice(0, 32)),
    runways,
    parking,
    holds: [],
    builtAt: now,
  };
  chart.holds = assignHolds(chart);
  return chart;
}
