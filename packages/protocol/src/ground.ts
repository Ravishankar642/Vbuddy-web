import { z } from "zod";

/*
 * VBuddy Ground: an airport's taxi network (from the simulator's own scenery), a taxi route through it, live guidance
 * along that route, and reading a taxi clearance ("taxi to holding point runway 27 via A, B, C1") into a route.
 *
 * Everything here is pure: the bridge builds a GroundChart from SimConnect's facility data, the app routes and guides
 * with it, and the tests check both without a simulator.
 */

/** Node kinds in GroundChart.nodes. */
export const GN_NORMAL = 0;
export const GN_HOLD = 1;
export const GN_ILS_HOLD = 2;
export const GN_PARKING = 3;
/** Edge kinds in GroundChart.edges. */
export const GE_TAXI = 0;
export const GE_RUNWAY = 1;
export const GE_PARKING = 2;

const RunwayEndSchema = z.object({ id: z.string().max(4), lat: z.number(), lon: z.number(), hdg: z.number() });
export const ParkingKindSchema = z.enum(["gate", "ramp", "cargo", "ga", "mil", "fuel", "other"]);

export const GroundChartSchema = z.object({
  icao: z.string().max(8),
  name: z.string().max(80),
  lat: z.number(),
  lon: z.number(),
  elevFt: z.number(),
  /** Where the layout came from: the simulator's scenery, or VBuddy's made-up test airport. */
  source: z.enum(["msfs", "mock"]),
  /** [lat, lon, kind]: GN_* kinds. */
  nodes: z.array(z.tuple([z.number(), z.number(), z.number().int()])).max(20_000),
  /** [from node, to node, name index (-1 = unnamed), GE_* kind, width m]. Undirected. */
  edges: z.array(z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int(), z.number()])).max(40_000),
  /** Taxiway names, indexed by edges' name index. */
  names: z.array(z.string().max(32)).max(4000),
  runways: z.array(z.object({ ends: z.tuple([RunwayEndSchema, RunwayEndSchema]), widthM: z.number(), lengthM: z.number() })).max(64),
  parking: z.array(z.object({ node: z.number().int(), name: z.string().max(16), kind: ParkingKindSchema, hdg: z.number(), radiusM: z.number() })).max(4000),
  /** [hold-short node, runway index]: which runway each hold-short point protects. */
  holds: z.array(z.tuple([z.number().int(), z.number().int()])).max(4000),
  builtAt: z.number(),
});
export type GroundChart = z.infer<typeof GroundChartSchema>;
export type RunwayEnd = z.infer<typeof RunwayEndSchema>;
export type ParkingKind = z.infer<typeof ParkingKindSchema>;

/* ------------------------------------------------------------------ geometry */

const rad = Math.PI / 180;
/** Metres per degree of latitude (close enough over an airport). */
const M_PER_DEG = 111_320;

/** A flat x/y (metres east / north) frame around a point: accurate to a few metres across an airport. */
export class LocalFrame {
  private k: number;
  constructor(
    readonly lat0: number,
    readonly lon0: number,
  ) {
    this.k = Math.cos(lat0 * rad);
  }
  xy(lat: number, lon: number): [number, number] {
    let dLon = lon - this.lon0;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    return [dLon * M_PER_DEG * this.k, (lat - this.lat0) * M_PER_DEG];
  }
  ll(x: number, y: number): [number, number] {
    return [this.lat0 + y / M_PER_DEG, this.lon0 + x / (M_PER_DEG * this.k)];
  }
}

/** Initial bearing a → b in degrees true, in a local frame (fine at airport scale). */
export function bearingXY(ax: number, ay: number, bx: number, by: number): number {
  return ((Math.atan2(bx - ax, by - ay) / rad) % 360 + 360) % 360;
}

/** Distance in metres between two lat/lon points (haversine). */
export function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const a = Math.sin(((bLat - aLat) * rad) / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Projection of p onto segment ab: the fraction along it (0..1) and the distance from it. */
function projectSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): { t: number; d: number; x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { t, d: Math.hypot(px - x, py - y), x, y };
}

const angleDiff = (a: number, b: number) => ((b - a + 540) % 360) - 180;

/* ------------------------------------------------------------------ runway helpers */

/** "09L/27R" for a runway. */
export const runwayLabel = (r: GroundChart["runways"][number]) => `${r.ends[0].id}/${r.ends[1].id}`;

/** Normalises a runway name: "9l", "09 L", "RWY 27" -> "09L" / "27". */
export function normRunway(s: string): string {
  const m = /(\d{1,2})\s*([LRCWAB])?/i.exec(s.replace(/^\s*(RWY|RUNWAY)\s*/i, ""));
  if (!m) return s.trim().toUpperCase();
  return `${m[1]!.padStart(2, "0")}${(m[2] ?? "").toUpperCase()}`;
}

/** Finds a runway end by its name ("27R"): the runway index and which end (0/1). */
export function findRunwayEnd(chart: GroundChart, id: string): { runway: number; end: 0 | 1 } | null {
  const want = normRunway(id);
  for (let i = 0; i < chart.runways.length; i++) {
    const r = chart.runways[i]!;
    if (normRunway(r.ends[0].id) === want) return { runway: i, end: 0 };
    if (normRunway(r.ends[1].id) === want) return { runway: i, end: 1 };
  }
  return null;
}

/**
 * Which runway each hold-short point protects: the runway whose centreline is nearest (within 250 m of it and not far
 * beyond its ends). Points no runway is near are left out.
 */
export function assignHolds(chart: Pick<GroundChart, "nodes" | "runways" | "lat" | "lon">): Array<[number, number]> {
  const f = new LocalFrame(chart.lat, chart.lon);
  const rws = chart.runways.map((r) => ({ a: f.xy(r.ends[0].lat, r.ends[0].lon), b: f.xy(r.ends[1].lat, r.ends[1].lon), len: r.lengthM }));
  const out: Array<[number, number]> = [];
  chart.nodes.forEach(([lat, lon, kind], i) => {
    if (kind !== GN_HOLD && kind !== GN_ILS_HOLD) return;
    const [x, y] = f.xy(lat, lon);
    let best = -1;
    let bestD = 250;
    rws.forEach((r, ri) => {
      const p = projectSeg(x, y, r.a[0], r.a[1], r.b[0], r.b[1]);
      // Beyond an end, the distance from the end counts double: a hold short point for a crossing taxiway lies beside the runway.
      const beyond = (p.t === 0 || p.t === 1) ? p.d * 1.5 : p.d;
      if (beyond < bestD) {
        bestD = beyond;
        best = ri;
      }
    });
    if (best >= 0) out.push([i, best]);
  });
  return out;
}

/* ------------------------------------------------------------------ graph */

interface Adj {
  to: number;
  edge: number;
  len: number;
}

/** The chart as an adjacency list with edge lengths, cached per chart object. */
const graphs = new WeakMap<GroundChart, { frame: LocalFrame; xy: Array<[number, number]>; adj: Adj[][]; lens: number[] }>();
function graphOf(chart: GroundChart) {
  let g = graphs.get(chart);
  if (g) return g;
  const frame = new LocalFrame(chart.lat, chart.lon);
  const xy = chart.nodes.map(([lat, lon]) => frame.xy(lat, lon));
  const adj: Adj[][] = chart.nodes.map(() => []);
  const lens: number[] = [];
  chart.edges.forEach(([a, b], i) => {
    const pa = xy[a];
    const pb = xy[b];
    if (!pa || !pb || a === b) {
      lens.push(Infinity);
      return;
    }
    const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    lens.push(len);
    adj[a]!.push({ to: b, edge: i, len });
    adj[b]!.push({ to: a, edge: i, len });
  });
  g = { frame, xy, adj, lens };
  graphs.set(chart, g);
  return g;
}

/** A minimal binary heap of [cost, state]. */
class Heap {
  private a: Array<[number, number]> = [];
  get size() {
    return this.a.length;
  }
  push(c: number, s: number) {
    const a = this.a;
    a.push([c, s]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![0] <= a[i]![0]) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/* ------------------------------------------------------------------ taxi routing */

export type TaxiFrom = { kind: "position"; lat: number; lon: number; hdg?: number } | { kind: "parking"; index: number };
export type TaxiTo = { kind: "runway"; runway: string } | { kind: "parking"; index: number };

export interface TaxiLeg {
  /** Taxiway name, "" for an unnamed link, or the runway ("09/27") for a stretch along a runway. */
  name: string;
  kind: "taxi" | "runway" | "parking";
  lengthM: number;
  /** Index into the plan's points where this leg starts. */
  at: number;
}

export interface TaxiPlan {
  /** The route, from start to finish, as [lat, lon]. */
  points: Array<[number, number]>;
  /** Chart node at each point (-1 for the start point when it lies between nodes). */
  nodes: number[];
  legs: TaxiLeg[];
  distanceM: number;
  /** Named taxiways in order, without repeats: what ATC would say after "via". */
  via: string[];
  /** Runways crossed on the way ("09/27"). */
  crossings: string[];
  /** Where it ends: "holding point runway 27R" or "stand C22". */
  destination: string;
  /** The runway end the route ends at, when it goes to a runway. */
  runway: string | null;
  /** The clearance in words. */
  text: string;
  /** Via taxiways asked for that the route couldn't follow. */
  unmatched: string[];
  /** Turns onto a new taxiway and runway crossings, at a point index, in route order. */
  events: Array<{ at: number; what: "turn" | "cross"; name: string }>;
}

export type TaxiResult = ({ ok: true } & TaxiPlan) | { ok: false; error: string };

/** Taxiway names compared without spaces or case ("c 1" = "C1"). */
const normName = (s: string) => s.replace(/\s+/g, "").toUpperCase();

/** A parking spot's name as shown ("C22", "GATE 12", "RAMP 4"). */
export function parkingLabel(chart: GroundChart, index: number): string {
  return chart.parking[index]?.name ?? `#${index}`;
}

/**
 * The best taxi route from `from` to `to`, optionally following `via` taxiways in that order.
 *
 * Costs: taxiway length; runways are used for crossing and lining up, not taxiing along (four times the cost and
 * a fixed penalty); parking links only at the start or the destination. A requested via taxiway is entered in order;
 * a different named taxiway is allowed but costs a lot, so a slightly wrong name in the clearance still gives a route
 * (and says which names it couldn't follow). To a runway, the holding point nearest the threshold wins over one
 * further down the runway unless it is much longer to reach.
 */
export function planTaxi(chart: GroundChart, from: TaxiFrom, to: TaxiTo, viaIn: string[] = []): TaxiResult {
  const g = graphOf(chart);
  if (!chart.nodes.length || !chart.edges.length) return { ok: false, error: "This airport has no taxiways in the simulator's scenery." };
  const via = viaIn.map(normName).filter(Boolean);
  const nameOf = (e: number) => {
    const i = chart.edges[e]![2];
    return i >= 0 ? normName(chart.names[i] ?? "") : "";
  };

  // ---- start
  const N = chart.nodes.length;
  const START = N; // a virtual node for a start between nodes
  const startLinks: Adj[] = [];
  let startXY: [number, number];
  let startParking = -1;
  if (from.kind === "parking") {
    const p = chart.parking[from.index];
    if (!p) return { ok: false, error: "That stand isn't in this airport's layout." };
    startParking = p.node;
    startXY = g.xy[p.node]!;
    startLinks.push({ to: p.node, edge: -1, len: 0 });
  } else {
    startXY = g.frame.xy(from.lat, from.lon);
    // At a stand: start from it.
    let nearPark = -1;
    let nearParkD = Infinity;
    chart.parking.forEach((p) => {
      const q = g.xy[p.node]!;
      const d = Math.hypot(q[0] - startXY[0], q[1] - startXY[1]);
      if (d < p.radiusM + 15 && d < nearParkD) {
        nearParkD = d;
        nearPark = p.node;
      }
    });
    if (nearPark >= 0) {
      startParking = nearPark;
      startLinks.push({ to: nearPark, edge: -1, len: nearParkD });
    } else {
      // Otherwise onto the nearest taxiway (or runway) segment, joined to both of its ends.
      let best = -1;
      let bestD = Infinity;
      let bestT = 0;
      chart.edges.forEach(([a, b, , kind], i) => {
        if (kind === GE_PARKING) return;
        const pa = g.xy[a];
        const pb = g.xy[b];
        if (!pa || !pb) return;
        const p = projectSeg(startXY[0], startXY[1], pa[0], pa[1], pb[0], pb[1]);
        // Pointing along the segment helps when two run side by side.
        let d = p.d;
        if (from.hdg !== undefined) {
          const brg = bearingXY(pa[0], pa[1], pb[0], pb[1]);
          const off = Math.min(Math.abs(angleDiff(from.hdg, brg)), Math.abs(angleDiff(from.hdg, brg + 180)));
          d += off > 45 ? 8 : 0;
        }
        if (d < bestD) {
          bestD = d;
          best = i;
          bestT = p.t;
        }
      });
      if (best < 0 || bestD > 600) return { ok: false, error: "You're not near this airport's taxiways." };
      const [a, b] = chart.edges[best]!;
      const len = g.lens[best]!;
      startLinks.push({ to: a, edge: best, len: len * bestT + bestD }, { to: b, edge: best, len: len * (1 - bestT) + bestD });
    }
  }

  // ---- destination(s): node -> extra cost
  const targets = new Map<number, number>();
  let destination = "";
  let runwayId: string | null = null;
  let targetParking = -1;
  if (to.kind === "parking") {
    const p = chart.parking[to.index];
    if (!p) return { ok: false, error: "That stand isn't in this airport's layout." };
    targetParking = p.node;
    targets.set(p.node, 0);
    destination = `stand ${p.name}`;
  } else {
    const end = findRunwayEnd(chart, to.runway);
    if (!end) return { ok: false, error: `Runway ${normRunway(to.runway)} isn't at ${chart.icao}.` };
    const rw = chart.runways[end.runway]!;
    const thr = rw.ends[end.end];
    runwayId = thr.id;
    destination = `holding point runway ${thr.id}`;
    const [tx, ty] = g.frame.xy(thr.lat, thr.lon);
    const distToThr = (n: number) => Math.hypot(g.xy[n]![0] - tx, g.xy[n]![1] - ty);
    for (const [n, ri] of chart.holds) if (ri === end.runway) targets.set(n, distToThr(n) * 1.5);
    if (!targets.size) {
      // No holding points in the scenery: line up at the runway node nearest the threshold.
      const onRunway = new Set<number>();
      chart.edges.forEach(([a, b, , kind]) => {
        if (kind === GE_RUNWAY) {
          onRunway.add(a);
          onRunway.add(b);
        }
      });
      const a = g.xy;
      const ra = g.frame.xy(rw.ends[0].lat, rw.ends[0].lon);
      const rb = g.frame.xy(rw.ends[1].lat, rw.ends[1].lon);
      for (const n of onRunway) {
        const p = projectSeg(a[n]![0], a[n]![1], ra[0], ra[1], rb[0], rb[1]);
        if (p.d < rw.widthM) targets.set(n, distToThr(n) * 1.5);
      }
      destination = `runway ${thr.id}`;
    }
    if (!targets.size) return { ok: false, error: `No way onto runway ${thr.id} was found in the scenery.` };
  }

  // ---- Dijkstra over (node, via progress)
  const L = via.length + 1;
  const stateOf = (node: number, k: number) => node * L + k;
  const total = (N + 1) * L;
  const dist = new Float64Array(total).fill(Infinity);
  const prev = new Int32Array(total).fill(-1);
  const prevEdge = new Int32Array(total).fill(-1);
  const heap = new Heap();
  const s0 = stateOf(START, 0);
  dist[s0] = 0;
  heap.push(0, s0);
  const stepCost = (edge: number, len: number, k: number, toNode: number): { cost: number; k: number } => {
    if (edge < 0) return { cost: len, k };
    const kind = chart.edges[edge]![3];
    let cost = len;
    if (kind === GE_RUNWAY) cost = len * 4 + 150;
    if (kind === GE_PARKING) {
      const [a, b] = chart.edges[edge]!;
      const touchesEnd = a === startParking || b === startParking || a === targetParking || b === targetParking || toNode === targetParking;
      if (!touchesEnd) cost = len * 20 + 1000;
    }
    if (!via.length || kind !== GE_TAXI) return { cost, k };
    const name = nameOf(edge);
    if (!name) return { cost: cost * 1.2, k };
    if (k < via.length && name === via[k]) return { cost, k: k + 1 };
    if (k > 0 && name === via[k - 1]) return { cost, k };
    return { cost: cost * 8 + 400, k };
  };
  while (heap.size) {
    const [d, s] = heap.pop();
    if (d > dist[s]!) continue;
    const node = Math.floor(s / L);
    const k = s % L;
    const links = node === START ? startLinks : g.adj[node]!;
    for (const l of links) {
      const step = stepCost(l.edge, l.len, k, l.to);
      const ns = stateOf(l.to, step.k);
      const nd = d + step.cost;
      if (nd < dist[ns]!) {
        dist[ns] = nd;
        prev[ns] = s;
        prevEdge[ns] = l.edge;
        heap.push(nd, ns);
      }
    }
  }

  // ---- the best finish: all via taxiways entered if possible, else as many as possible
  let bestState = -1;
  let bestCost = Infinity;
  let reached = -1;
  for (let k = via.length; k >= 0 && bestState < 0; k--) {
    for (const [n, extra] of targets) {
      const s = stateOf(n, k);
      const c = dist[s]! + extra;
      if (c < bestCost) {
        bestCost = c;
        bestState = s;
        reached = k;
      }
    }
  }
  if (bestState < 0 || !Number.isFinite(bestCost)) return { ok: false, error: `There's no taxi route to ${destination} from here in the scenery.` };

  // ---- walk back
  const chain: Array<{ node: number; edge: number }> = [];
  for (let s = bestState; s >= 0 && s !== s0; s = prev[s]!) chain.push({ node: Math.floor(s / L), edge: prevEdge[s]! });
  chain.reverse();
  const start = g.frame.ll(startXY[0], startXY[1]);
  const points: Array<[number, number]> = [[start[0], start[1]]];
  const nodes: number[] = [-1];
  const legs: TaxiLeg[] = [];
  let distanceM = 0;
  let lastXY = startXY;
  for (const c of chain) {
    const n = chart.nodes[c.node]!;
    const xy = g.xy[c.node]!;
    const len = Math.hypot(xy[0] - lastXY[0], xy[1] - lastXY[1]);
    distanceM += len;
    const kindNum = c.edge >= 0 ? chart.edges[c.edge]![3] : GE_PARKING;
    const kind: TaxiLeg["kind"] = kindNum === GE_RUNWAY ? "runway" : kindNum === GE_PARKING ? "parking" : "taxi";
    const name = kind === "runway" ? runwayAt(chart, g.frame, xy) : c.edge >= 0 ? (chart.names[chart.edges[c.edge]![2]] ?? "").trim() : "";
    const prevLeg = legs[legs.length - 1];
    if (prevLeg && prevLeg.kind === kind && normName(prevLeg.name) === normName(name)) prevLeg.lengthM += len;
    else legs.push({ name, kind, lengthM: len, at: points.length - 1 });
    points.push([n[0], n[1]]);
    nodes.push(c.node);
    lastXY = xy;
  }
  // Drop a zero-length first point (start was a node).
  if (points.length > 1 && metresBetween(points[0]![0], points[0]![1], points[1]![0], points[1]![1]) < 0.5) {
    points.shift();
    nodes.shift();
    for (const l of legs) l.at = Math.max(0, l.at - 1);
  }

  const viaOut: string[] = [];
  for (const l of legs) if (l.kind === "taxi" && l.name && normName(l.name) !== normName(viaOut[viaOut.length - 1] ?? "")) viaOut.push(l.name);

  // Runway crossings, by geometry: in the scenery a taxiway usually crosses through a point on the runway's centreline,
  // so a route point inside a runway's strip (and not the final line-up point) is a crossing. The event sits at the
  // holding point just before it when there is one, where the pilot has to stop.
  const events: TaxiPlan["events"] = [];
  const crossings: string[] = [];
  const strips = chart.runways.map((r, i) => ({ i, a: g.frame.xy(r.ends[0].lat, r.ends[0].lon), b: g.frame.xy(r.ends[1].lat, r.ends[1].lon), half: Math.max(15, r.widthM / 2 + 5), label: runwayLabel(r) }));
  let inside = -1;
  points.forEach(([la, lo], i) => {
    const [x, y] = g.frame.xy(la, lo);
    const hit = strips.find((s) => {
      const p = projectSeg(x, y, s.a[0], s.a[1], s.b[0], s.b[1]);
      return p.d <= s.half && p.t > 0 && p.t < 1;
    });
    const lineUp = i === points.length - 1 && to.kind === "runway";
    if (hit && hit.i !== inside && !lineUp && i > 0) {
      let at = i;
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const n = nodes[j]!;
        if (n >= 0 && (chart.nodes[n]![2] === GN_HOLD || chart.nodes[n]![2] === GN_ILS_HOLD)) {
          at = j;
          break;
        }
      }
      events.push({ at, what: "cross", name: hit.label });
      if (!crossings.includes(hit.label)) crossings.push(hit.label);
    }
    inside = hit ? hit.i : -1;
  });
  legs.forEach((l, i) => {
    if (i === 0 || l.kind !== "taxi" || !l.name) return;
    const before = legs.slice(0, i).reverse().find((x) => x.kind === "taxi" && x.name);
    if (!before || normName(before.name) !== normName(l.name)) events.push({ at: l.at, what: "turn", name: l.name });
  });
  events.sort((a, b) => a.at - b.at);
  const unmatched = via.slice(reached);
  const text = clearanceText(destination, viaOut, crossings);
  return { ok: true, points, nodes, legs, distanceM, via: viaOut, crossings, destination, runway: runwayId, text, unmatched, events };
}

/** The runway a point lies on ("09/27"), or "runway" when it can't tell. */
function runwayAt(chart: GroundChart, f: LocalFrame, [x, y]: [number, number]): string {
  let best = "runway";
  let bestD = Infinity;
  for (const r of chart.runways) {
    const a = f.xy(r.ends[0].lat, r.ends[0].lon);
    const b = f.xy(r.ends[1].lat, r.ends[1].lon);
    const p = projectSeg(x, y, a[0], a[1], b[0], b[1]);
    if (p.d < bestD) {
      bestD = p.d;
      best = runwayLabel(r);
    }
  }
  return best;
}

/** "Taxi to holding point runway 27R via A, B, C1. Cross runway 09/27." */
export function clearanceText(destination: string, via: string[], crossings: string[]): string {
  let s = `Taxi to ${destination}${via.length ? ` via ${via.join(", ")}` : ""}.`;
  if (crossings.length) s += ` Cross runway${crossings.length > 1 ? "s" : ""} ${crossings.join(", ")}.`;
  return s;
}

/* ------------------------------------------------------------------ guidance */

export interface TaxiProgress {
  /** Metres from the route (large = off the route). */
  offRouteM: number;
  remainingM: number;
  /** What comes next, if anything before the end. */
  next: { what: "turn" | "cross" | "hold" | "arrive"; name: string; inM: number; turn: "left" | "right" | "ahead" } | null;
  /** Index of the leg you're on. */
  leg: number;
}

/** Where you are along a planned route and what to do next. */
export function taxiProgress(plan: Pick<TaxiPlan, "points" | "legs" | "destination" | "runway" | "events">, lat: number, lon: number): TaxiProgress {
  const pts = plan.points;
  if (pts.length < 2) return { offRouteM: 0, remainingM: 0, next: null, leg: 0 };
  const f = new LocalFrame(pts[0]![0], pts[0]![1]);
  const xy = pts.map(([a, b]) => f.xy(a, b));
  const cum: number[] = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1]! + Math.hypot(xy[i]![0] - xy[i - 1]![0], xy[i]![1] - xy[i - 1]![1]));
  const total = cum[cum.length - 1]!;
  const [px, py] = f.xy(lat, lon);
  let seg = 0;
  let bestD = Infinity;
  let along = 0;
  for (let i = 0; i < xy.length - 1; i++) {
    const p = projectSeg(px, py, xy[i]![0], xy[i]![1], xy[i + 1]![0], xy[i + 1]![1]);
    if (p.d < bestD - 0.01) {
      bestD = p.d;
      seg = i;
      along = cum[i]! + p.t * (cum[i + 1]! - cum[i]!);
    }
  }
  let leg = 0;
  for (let i = 0; i < plan.legs.length; i++) if (plan.legs[i]!.at <= seg) leg = i;
  const remainingM = Math.max(0, total - along);
  let next: TaxiProgress["next"] = null;
  for (const e of plan.events) {
    const inM = cum[e.at]! - along;
    // An event just passed (a few metres) still counts while you're on it; one well behind is done.
    if (inM < -8) continue;
    const before = xy[Math.max(0, e.at - 1)]!;
    const here = xy[e.at]!;
    const after = xy[Math.min(xy.length - 1, e.at + 1)]!;
    const d = angleDiff(bearingXY(before[0], before[1], here[0], here[1]), bearingXY(here[0], here[1], after[0], after[1]));
    const turn = e.at === 0 || Math.abs(d) < 25 ? "ahead" : d < 0 ? "left" : "right";
    next = { what: e.what, name: e.name, inM: Math.max(0, inM), turn };
    break;
  }
  if (!next) next = { what: plan.runway ? "hold" : "arrive", name: plan.destination, inM: remainingM, turn: "ahead" };
  return { offRouteM: bestD, remainingM, next, leg };
}

/* ------------------------------------------------------------------ reading a clearance */

const PHONETIC: Record<string, string> = {
  ALPHA: "A", ALFA: "A", BRAVO: "B", CHARLIE: "C", DELTA: "D", ECHO: "E", FOXTROT: "F", GOLF: "G", HOTEL: "H", INDIA: "I", JULIET: "J", JULIETT: "J",
  KILO: "K", LIMA: "L", MIKE: "M", NOVEMBER: "N", OSCAR: "O", PAPA: "P", QUEBEC: "Q", ROMEO: "R", SIERRA: "S", TANGO: "T", UNIFORM: "U",
  VICTOR: "V", WHISKEY: "W", WHISKY: "W", XRAY: "X", "X-RAY": "X", YANKEE: "Y", ZULU: "Z",
};
const DIGIT: Record<string, string> = { ZERO: "0", ONE: "1", TWO: "2", THREE: "3", TREE: "3", FOUR: "4", FIVE: "5", FIFE: "5", SIX: "6", SEVEN: "7", EIGHT: "8", NINE: "9", NINER: "9" };
const SIDE: Record<string, string> = { LEFT: "L", RIGHT: "R", CENTER: "C", CENTRE: "C" };
/** Words that end the list of taxiways. */
const STOP = new Set(["HOLD", "HOLDING", "CROSS", "CROSSING", "RUNWAY", "CONTACT", "MONITOR", "THEN", "TO", "FOR", "GIVE", "WAY", "BEHIND", "EXPECT", "SQUAWK", "ON", "AT", "WHEN", "READY", "REPORT", "STAND", "GATE", "PARKING", "APRON", "INTERSECTION"]);

export interface ParsedClearance {
  /** "27R", when the clearance names the runway to taxi to. */
  runway: string | null;
  via: string[];
  /** Runways to hold short of ("09"). */
  holdShort: string[];
  /** A stand or gate it names ("C22"). */
  stand: string | null;
}

function tokens(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/X-RAY/g, "XRAY")
    .replace(/[,.;:!?()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** "TWO SEVEN LEFT" / "27L" / "27 LEFT" starting at i: the runway and how many tokens it used. */
function readRunway(t: string[], i: number): { id: string; used: number } | null {
  let digits = "";
  let j = i;
  while (j < t.length && digits.length < 2) {
    const w = t[j]!;
    if (/^\d{1,2}[LRC]?$/.test(w)) {
      const m = /^(\d{1,2})([LRC])?$/.exec(w)!;
      digits += m[1]!;
      j++;
      if (m[2]) return { id: normRunway(digits + m[2]), used: j - i };
      break;
    }
    if (DIGIT[w] !== undefined) {
      digits += DIGIT[w];
      j++;
      continue;
    }
    break;
  }
  if (!digits) return null;
  if (j < t.length && SIDE[t[j]!]) return { id: normRunway(digits + SIDE[t[j]!]!), used: j - i + 1 };
  return { id: normRunway(digits), used: j - i };
}

/**
 * Reads a taxi clearance as ATC says it (spoken or typed, phonetic or not):
 * "Speedbird 123, taxi to holding point runway two seven left via Alpha, Bravo, Charlie one, hold short runway zero niner."
 */
export function parseTaxiClearance(text: string): ParsedClearance {
  const t = tokens(text);
  const out: ParsedClearance = { runway: null, via: [], holdShort: [], stand: null };
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!;
    if (w === "RUNWAY" || w === "RWY") {
      const r = readRunway(t, i + 1);
      if (!r) continue;
      // "hold short (of) runway 09" and "cross runway 09" are not where you taxi to; "holding point runway 27" is.
      const before = t.slice(Math.max(0, i - 3), i).join(" ");
      if (/\bSHORT( OF)?$/.test(before)) {
        if (!out.holdShort.includes(r.id)) out.holdShort.push(r.id);
      } else if (/\bCROSS(ING)?$/.test(before)) {
        /* a crossing: the route finds it */
      } else if (!out.runway) out.runway = r.id;
      i += r.used;
    } else if ((w === "STAND" || w === "GATE") && t[i + 1]) {
      const parts: string[] = [];
      let j = i + 1;
      while (j < t.length && parts.length < 4) {
        const x = t[j]!;
        if (PHONETIC[x]) parts.push(PHONETIC[x]!);
        else if (DIGIT[x] !== undefined) parts.push(DIGIT[x]!);
        else if (/^[A-Z]?\d{1,3}[A-Z]?$/.test(x)) parts.push(x);
        else break;
        j++;
      }
      if (parts.length) out.stand = parts.join("");
      i = j - 1;
    } else if (w === "VIA") {
      let j = i + 1;
      let cur = "";
      const flush = () => {
        if (cur && !out.via.includes(cur)) out.via.push(cur);
        cur = "";
      };
      while (j < t.length && !STOP.has(t[j]!)) {
        const x = t[j]!;
        if (x === "AND") {
          flush();
        } else if (PHONETIC[x]) {
          flush();
          cur = PHONETIC[x]!;
        } else if (DIGIT[x] !== undefined && cur) {
          cur += DIGIT[x];
        } else if (/^[A-Z]{1,2}\d{0,2}$/.test(x) && !/^(THE|VIA|OF)$/.test(x)) {
          flush();
          cur = x;
        } else if (/^\d{1,2}$/.test(x) && cur) {
          cur += x;
        } else break;
        j++;
      }
      flush();
      i = j - 1;
    }
  }
  return out;
}

/** Does this radio call look like a taxi clearance? */
export const isTaxiClearance = (text: string) => /\bTAXI\b/i.test(text) && (/\bVIA\b/i.test(text) || /\bRUNWAY\b|\bRWY\b|\bSTAND\b|\bGATE\b/i.test(text));
