import * as L from "leaflet";
import { GE_PARKING, GE_RUNWAY, GN_HOLD, GN_ILS_HOLD, LocalFrame, type GroundChart, type TaxiPlan } from "@vbuddy/protocol";
import { ground, type GroundState } from "../lib/ground";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Taxiway names show from this zoom, stand names from the next. */
const NAME_ZOOM = 15;
const STAND_ZOOM = 16;

/** Pixels per metre at this zoom and latitude (Web Mercator). */
const pxPerM = (zoom: number, lat: number) => (256 * 2 ** zoom) / (40_075_016 * Math.cos((lat * Math.PI) / 180));

/** Up to three places to write each taxiway name: along its longest pieces, well apart. */
function namePlaces(c: GroundChart): Array<{ name: string; at: [number, number] }> {
  const f = new LocalFrame(c.lat, c.lon);
  const xy = c.nodes.map(([la, lo]) => f.xy(la, lo));
  const by = new Map<number, Array<{ len: number; mid: [number, number]; m: [number, number] }>>();
  for (const [a, b, n, k] of c.edges) {
    if (n < 0 || k !== 0) continue;
    const pa = xy[a]!;
    const pb = xy[b]!;
    const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const m: [number, number] = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    const list = by.get(n) ?? [];
    list.push({ len, mid: f.ll(m[0], m[1]), m });
    by.set(n, list);
  }
  const out: Array<{ name: string; at: [number, number] }> = [];
  for (const [n, list] of by) {
    const name = c.names[n]?.trim();
    if (!name) continue;
    list.sort((x, y) => y.len - x.len);
    const picked: Array<[number, number]> = [];
    for (const e of list) {
      if (picked.length >= 3) break;
      if (picked.some((p) => Math.hypot(p[0] - e.m[0], p[1] - e.m[1]) < 600)) continue;
      picked.push(e.m);
      out.push({ name, at: e.mid });
    }
  }
  return out;
}

function runwayPolygon(c: GroundChart, r: GroundChart["runways"][number]): Array<[number, number]> {
  const f = new LocalFrame(c.lat, c.lon);
  const [ax, ay] = f.xy(r.ends[0].lat, r.ends[0].lon);
  const [bx, by] = f.xy(r.ends[1].lat, r.ends[1].lon);
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const nx = (-(by - ay) / len) * (r.widthM / 2);
  const ny = ((bx - ax) / len) * (r.widthM / 2);
  return [f.ll(ax + nx, ay + ny), f.ll(bx + nx, by + ny), f.ll(bx - nx, by - ny), f.ll(ax - nx, ay - ny)];
}

/**
 * Draws the Ground chart and the taxi route on the map, and keeps them in step with the shared Ground state.
 * Returns a function that removes everything.
 */
export function attachGround(map: L.Map, el: HTMLElement, fitPadding: () => { tl: [number, number]; br: [number, number] }, stopFollowing: () => void): () => void {
  if (!map.getPane("ground")) {
    map.createPane("ground").style.zIndex = "380";
    map.createPane("groundLabels").style.zIndex = "390";
    map.getPane("groundLabels")!.style.pointerEvents = "none";
  }
  const renderer = L.canvas({ pane: "ground", padding: 0.3 });
  const chartLayer = L.layerGroup();
  const routeLayer = L.layerGroup();
  let shownChart: GroundChart | null = null;
  let shownPlan: TaxiPlan | null = null;
  let lastFit = 0;
  let taxi: L.Polyline | null = null;
  let park: L.Polyline | null = null;
  let widest = 23;

  const zoomClasses = () => {
    const z = map.getZoom();
    el.classList.toggle("map--gnd-names", z >= NAME_ZOOM);
    el.classList.toggle("map--gnd-stands", z >= STAND_ZOOM);
    if (shownChart && taxi) {
      const ppm = pxPerM(z, shownChart.lat);
      taxi.setStyle({ weight: Math.max(2, Math.min(40, widest * ppm)) });
      park?.setStyle({ weight: Math.max(1, Math.min(20, 12 * ppm)) });
    }
  };

  const drawChart = (c: GroundChart) => {
    chartLayer.clearLayers();
    for (const r of c.runways) {
      L.polygon(runwayPolygon(c, r), { renderer, pane: "ground", className: "gnd-rwy", color: "#5d6470", weight: 1, fillColor: "#3a3f47", fillOpacity: 0.95, interactive: false }).addTo(chartLayer);
      for (const e of r.ends) {
        L.marker([e.lat, e.lon], { pane: "groundLabels", interactive: false, keyboard: false, icon: L.divIcon({ className: "gnd-lbl-wrap", iconSize: [0, 0], html: `<span class="gnd-rwylbl">${esc(e.id)}</span>` }) }).addTo(chartLayer);
      }
    }
    const taxiSegs: Array<Array<[number, number]>> = [];
    const parkSegs: Array<Array<[number, number]>> = [];
    const widths: number[] = [];
    for (const [a, b, , k, w] of c.edges) {
      if (k === GE_RUNWAY) continue;
      const pa = c.nodes[a];
      const pb = c.nodes[b];
      if (!pa || !pb) continue;
      const seg: Array<[number, number]> = [
        [pa[0], pa[1]],
        [pb[0], pb[1]],
      ];
      if (k === GE_PARKING) parkSegs.push(seg);
      else {
        taxiSegs.push(seg);
        widths.push(w);
      }
    }
    widths.sort((x, y) => x - y);
    widest = widths.length ? Math.max(10, widths[Math.floor(widths.length / 2)]!) : 23;
    taxi = L.polyline(taxiSegs, { renderer, pane: "ground", className: "gnd-twy", color: "#8d7a3c", opacity: 0.85, lineCap: "round", interactive: false }).addTo(chartLayer);
    park = L.polyline(parkSegs, { renderer, pane: "ground", color: "#6b6f78", opacity: 0.8, interactive: false }).addTo(chartLayer);
    // Holding points.
    c.nodes.forEach(([la, lo, k]) => {
      if (k === GN_HOLD || k === GN_ILS_HOLD) L.circleMarker([la, lo], { renderer, pane: "ground", radius: 3, color: "#ff3b4e", weight: 2, fillColor: "#ff3b4e", fillOpacity: 1, interactive: false }).addTo(chartLayer);
    });
    // Stands: a dot, and the name from close in.
    for (const p of c.parking) {
      const n = c.nodes[p.node];
      if (!n) continue;
      L.circleMarker([n[0], n[1]], { renderer, pane: "ground", radius: 4, color: "#ffffff", weight: 1.5, fillColor: p.kind === "gate" ? "#3987e5" : p.kind === "cargo" ? "#e0a84f" : "#7b8794", fillOpacity: 1, interactive: false }).addTo(chartLayer);
      L.marker([n[0], n[1]], { pane: "groundLabels", interactive: false, keyboard: false, icon: L.divIcon({ className: "gnd-lbl-wrap", iconSize: [0, 0], html: `<span class="gnd-stand">${esc(p.name)}</span>` }) }).addTo(chartLayer);
    }
    for (const n of namePlaces(c)) {
      L.marker(n.at, { pane: "groundLabels", interactive: false, keyboard: false, icon: L.divIcon({ className: "gnd-lbl-wrap", iconSize: [0, 0], html: `<span class="gnd-name">${esc(n.name)}</span>` }) }).addTo(chartLayer);
    }
    zoomClasses();
  };

  const drawPlan = (p: TaxiPlan | null) => {
    routeLayer.clearLayers();
    if (!p || p.points.length < 2) return;
    L.polyline(p.points, { pane: "ground", renderer, color: "#000", weight: 9, opacity: 0.35, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(routeLayer);
    L.polyline(p.points, { pane: "ground", renderer, color: "#ff4fd8", weight: 5, opacity: 1, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(routeLayer);
    const end = p.points[p.points.length - 1]!;
    L.circleMarker(p.points[0]!, { renderer, pane: "ground", radius: 6, color: "#fff", weight: 2, fillColor: "#2fbf71", fillOpacity: 1, interactive: false }).addTo(routeLayer);
    L.circleMarker(end, { renderer, pane: "ground", radius: 7, color: "#fff", weight: 2, fillColor: "#ff4fd8", fillOpacity: 1, interactive: false }).addTo(routeLayer);
    for (const e of p.events) {
      if (e.what !== "cross") continue;
      const at = p.points[e.at];
      if (at) L.marker(at, { pane: "groundLabels", interactive: false, keyboard: false, icon: L.divIcon({ className: "gnd-lbl-wrap", iconSize: [0, 0], html: `<span class="gnd-cross">Cross ${esc(e.name)}</span>` }) }).addTo(routeLayer);
    }
  };

  const fit = (s: GroundState) => {
    const c = s.chart;
    if (!c) return;
    const pts: Array<[number, number]> = s.plan && s.plan.points.length > 1 ? s.plan.points : [...c.runways.flatMap((r) => r.ends.map((e) => [e.lat, e.lon] as [number, number])), ...c.nodes.map((n) => [n[0], n[1]] as [number, number])];
    if (!pts.length) return;
    stopFollowing();
    const pad = fitPadding();
    map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: pad.tl, paddingBottomRight: pad.br, maxZoom: 17 });
  };

  const sync = () => {
    const s = ground.get();
    const on = s.show && !!s.chart;
    if (on && !map.hasLayer(chartLayer)) chartLayer.addTo(map);
    if (!on && map.hasLayer(chartLayer)) chartLayer.remove();
    if (on && !map.hasLayer(routeLayer)) routeLayer.addTo(map);
    if (!on && map.hasLayer(routeLayer)) routeLayer.remove();
    if (s.chart && s.chart !== shownChart) {
      shownChart = s.chart;
      drawChart(s.chart);
    }
    if (s.plan !== shownPlan) {
      shownPlan = s.plan;
      drawPlan(s.plan);
    }
    if (on && s.fitSeq !== lastFit) {
      lastFit = s.fitSeq;
      fit(s);
    }
  };
  map.on("zoomend", zoomClasses);
  const off = ground.subscribe(sync);
  sync();
  return () => {
    off();
    map.off("zoomend", zoomClasses);
    chartLayer.remove();
    routeLayer.remove();
  };
}
