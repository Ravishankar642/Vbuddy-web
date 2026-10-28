import { assignHolds, GE_PARKING, GE_RUNWAY, GE_TAXI, GN_HOLD, GN_NORMAL, GN_PARKING, LocalFrame, type GroundChart } from "./ground.js";

/**
 * VBuddy's made-up test airport, for the test flight and the tests: two parallel runways (09L/27R north, 09R/27L
 * south), taxiway A between them, taxiway B along the apron, and six gates G1–G6 south of B. From the gates, the
 * northern runway can only be reached by crossing the southern one (on C1 or C2).
 *
 *            09L ====N1==========N2==========N3==== 27R      (y = 0)
 *                    |           |           |
 *       A  o----o----o----o----o----o----o----o----o----o    (y = -300)
 *                          |C1               |C2
 *            09R ======================================= 27L (y = -600)
 *                          |C1               |C2
 *       B       o----o----o----o----o----o----o----o----o    (y = -800)
 *                    G1   G2   G3   G4   G5   G6              (y = -950)
 */
export function mockGroundChart(icao = "VBDY", lat = 19.0887, lon = 72.8679, name = "VBuddy Test Field"): GroundChart {
  const f = new LocalFrame(lat, lon);
  const nodes: GroundChart["nodes"] = [];
  const edges: GroundChart["edges"] = [];
  const names = ["A", "B", "N1", "N2", "N3", "C1", "C2"];
  const nm = (n: string) => names.indexOf(n);
  const at = new Map<string, number>();
  const node = (x: number, y: number, kind = GN_NORMAL) => {
    const k = `${x},${y}`;
    const hit = at.get(k);
    if (hit !== undefined) return hit;
    const [la, lo] = f.ll(x, y);
    nodes.push([la, lo, kind]);
    at.set(k, nodes.length - 1);
    return nodes.length - 1;
  };
  const edge = (a: number, b: number, name: string, kind = GE_TAXI, w = 23) => edges.push([a, b, name ? nm(name) : -1, kind, w]);

  // Runways along their centrelines.
  const r1 = [-1500, 0, 1500].map((x) => node(x, 0));
  edge(r1[0]!, r1[1]!, "", GE_RUNWAY, 45);
  edge(r1[1]!, r1[2]!, "", GE_RUNWAY, 45);
  const r2 = [-1200, -600, 600, 1200].map((x) => node(x, -600));
  for (let i = 0; i < r2.length - 1; i++) edge(r2[i]!, r2[i + 1]!, "", GE_RUNWAY, 45);

  // Taxiway A and B.
  const ax: number[] = [];
  for (let x = -1500; x <= 1500; x += 300) ax.push(x);
  for (let i = 0; i < ax.length - 1; i++) edge(node(ax[i]!, -300), node(ax[i + 1]!, -300), "A");
  const bx: number[] = [];
  for (let x = -1200; x <= 1200; x += 300) bx.push(x);
  for (let i = 0; i < bx.length - 1; i++) edge(node(bx[i]!, -800), node(bx[i + 1]!, -800), "B");

  // N1–N3 from A to the northern runway, with a holding point.
  for (const [x, n] of [[-1500, "N1"], [0, "N2"], [1500, "N3"]] as const) {
    const h = node(x, -90, GN_HOLD);
    edge(node(x, -300), h, n);
    edge(h, node(x, 0), n);
  }
  // C1, C2 from A across the southern runway to B, a holding point on each side.
  for (const [x, n] of [[-600, "C1"], [600, "C2"]] as const) {
    const hn = node(x, -510, GN_HOLD);
    const hs = node(x, -690, GN_HOLD);
    edge(node(x, -300), hn, n);
    edge(hn, node(x, -600), n);
    edge(node(x, -600), hs, n);
    edge(hs, node(x, -800), n);
  }

  // Gates south of B.
  const parking: GroundChart["parking"] = [];
  [-900, -600, -300, 0, 300, 600].forEach((x, i) => {
    const p = node(x, -950, GN_PARKING);
    edge(node(x, -800), p, "", GE_PARKING, 20);
    parking.push({ node: p, name: `G${i + 1}`, kind: "gate", hdg: 0, radiusM: 30 });
  });

  const end = (x: number, y: number, id: string, hdg: number) => {
    const [la, lo] = f.ll(x, y);
    return { id, lat: la, lon: lo, hdg };
  };
  const runways: GroundChart["runways"] = [
    { ends: [end(-1500, 0, "09L", 90), end(1500, 0, "27R", 270)], widthM: 45, lengthM: 3000 },
    { ends: [end(-1200, -600, "09R", 90), end(1200, -600, "27L", 270)], widthM: 45, lengthM: 2400 },
  ];
  const chart: GroundChart = { icao, name, lat, lon, elevFt: 39, source: "mock", nodes, edges, names, runways, parking, holds: [], builtAt: 0 };
  chart.holds = assignHolds(chart);
  return chart;
}
