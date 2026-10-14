/** Small spherical-earth helpers. Accuracy is far better than the sector data needs. */

const R_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function distNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Point reached from (lat, lon) after `dist` nm on initial bearing `brg` (degrees true). */
export function destination(lat: number, lon: number, brg: number, dist: number): [number, number] {
  const d = dist / R_NM;
  const p1 = rad(lat);
  const b = rad(brg);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = rad(lon) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

/** Ring of [lon, lat] points, GeoJSON order. */
export type Ring = Array<[number, number]>;
/** Polygon = outer ring followed by holes. */
export type Poly = Ring[];

export interface Area {
  polys: Poly[];
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
}

function bboxOf(polys: Poly[]): Area["bbox"] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of polys)
    for (const [x, y] of p[0] ?? []) {
      if (x < a) a = x;
      if (y < b) b = y;
      if (x > c) c = x;
      if (y > d) d = y;
    }
  return [a, b, c, d];
}

export function makeArea(polys: Poly[]): Area {
  return { polys, bbox: bboxOf(polys) };
}

/** From a GeoJSON Polygon or MultiPolygon geometry; null for anything else. */
export function areaFromGeometry(g: unknown): Area | null {
  const geo = g as { type?: string; coordinates?: unknown };
  const isRing = (r: unknown): r is Ring => Array.isArray(r) && r.length >= 3 && r.every((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number");
  const isPoly = (p: unknown): p is Poly => Array.isArray(p) && p.length > 0 && p.every(isRing);
  if (geo?.type === "Polygon" && isPoly(geo.coordinates)) return makeArea([geo.coordinates]);
  if (geo?.type === "MultiPolygon" && Array.isArray(geo.coordinates)) {
    const polys = geo.coordinates.filter(isPoly);
    return polys.length ? makeArea(polys) : null;
  }
  return null;
}

export function mergeAreas(areas: Area[]): Area {
  return makeArea(areas.flatMap((a) => a.polys));
}

/** Even-odd ray cast. */
function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inArea(a: Area, lat: number, lon: number): boolean {
  const [x0, y0, x1, y1] = a.bbox;
  if (lon < x0 || lon > x1 || lat < y0 || lat > y1) return false;
  for (const p of a.polys) {
    if (!inRing(lon, lat, p[0]!)) continue;
    let hole = false;
    for (let h = 1; h < p.length; h++) if (inRing(lon, lat, p[h]!)) hole = true;
    if (!hole) return true;
  }
  return false;
}

/** Rough size in square degrees (scaled by latitude), used only to rank "more specific" sectors. */
export function areaSize(a: Area): number {
  const [x0, y0, x1, y1] = a.bbox;
  return (x1 - x0) * (y1 - y0) * Math.cos(rad((y0 + y1) / 2));
}

/** A circle as a polygon, for approach areas that have no published shape. */
export function circleArea(lat: number, lon: number, radiusNm: number, points = 48): Area {
  const ring: Ring = [];
  for (let i = 0; i <= points; i++) {
    const [la, lo] = destination(lat, lon, (i * 360) / points, radiusNm);
    ring.push([lo, la]);
  }
  return makeArea([[ring]]);
}
