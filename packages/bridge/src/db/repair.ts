import type { Logger } from "../log.js";
import { isPlaceholder, nm } from "../sim/flight-gate.js";
import type { FlightDb } from "./flight-db.js";

/**
 * Cleans up flights recorded before VBuddy knew the menu from a flight (1.1 and older):
 *  - a flight that starts at the menu placeholder (0°N 90°E, 0°N 0°E) or in the MSFS 2024 hangar gets its real
 *    start, the first place the aircraft sat still, from its frames if they're still there; otherwise the start
 *    is cleared (unknown), so the SimBrief plan can stand in for it;
 *  - a "flight" that never went anywhere (a few minutes in the menu or at a gate) is hidden;
 *  - landings that are replays are moved aside: a second touchdown at the same spot, or one somewhere the
 *    aircraft can't have reached since the previous one. The flight's end is put back where it really landed.
 * Runs once per database (meta "repair-1").
 */
const KEY = "repair-1";
/** MSFS 2024 parks the aircraft at Boeing Field (KBFI) behind the menu. */
const HANGAR = { lat: 47.52, lon: -122.29 };
const nearHangar = (lat: number | null, lon: number | null) => lat !== null && lon !== null && nm(lat, lon, HANGAR.lat, HANGAR.lon) < 1;
const bogus = (lat: number | null, lon: number | null) => lat === null || lon === null || isPlaceholder(lat, lon);

export interface RepairReport {
  starts: number;
  hidden: number;
  landings: number;
}

export function repairFlights(db: FlightDb, log: Logger | null, force = false): RepairReport {
  const report: RepairReport = { starts: 0, hidden: 0, landings: 0 };
  if (!force && db.getMeta(KEY)) return report;
  const flights = db.allFlights();
  for (const f of flights) {
    if (f.hidden) continue;
    const dur = f.endedAt - f.startedAt;

    // --- where it really began
    let startLat = f.startLat;
    let startLon = f.startLon;
    if (bogus(startLat, startLon) || nearHangar(startLat, startLon)) {
      const pos = db.flightPositions(f.id, 20_000).filter(([, la, lo]) => !isPlaceholder(la, lo) && !nearHangar(la, lo));
      // the first place it stayed for ~10 samples
      let found: [number, number, number] | null = null;
      for (let i = 0; i + 10 < pos.length && !found; i++) {
        const a = pos[i]!;
        if (pos.slice(i, i + 10).every(([, la, lo]) => nm(a[1], a[2], la, lo) < 0.5)) found = [a[0], a[1], a[2]];
      }
      if (found) db.setFlightEnds(f.id, { startLat: found[1], startLon: found[2], startedAt: found[0] });
      else db.setFlightEnds(f.id, { startLat: null, startLon: null });
      startLat = found ? found[1] : null;
      startLon = found ? found[2] : null;
      report.starts++;
    }

    // --- replayed landings
    const landings = db.flightLandings(f.id);
    const kept: typeof landings = [];
    const gone: string[] = [];
    for (const l of landings) {
      const prev = kept[kept.length - 1];
      if (prev) {
        const d = nm(prev.lat, prev.lon, l.lat, l.lon);
        const hours = Math.max(1 / 3600, (l.ts - prev.ts) / 3_600_000);
        // A replay touches down at exactly the same point (to the metre); a real touch-and-go lands further along.
        const sameSpot = d < 0.03 && l.ts - prev.ts < 60 * 60_000;
        const impossible = d / hours > 700;
        if (sameSpot || impossible) {
          gone.push(l.id);
          continue;
        }
      }
      kept.push(l);
    }
    if (gone.length) {
      db.removeLandings(gone, "replay");
      report.landings += gone.length;
      const last = kept[kept.length - 1];
      if (last && f.endLat !== null && f.endLon !== null && nm(last.lat, last.lon, f.endLat, f.endLon) > 20) db.setFlightEnds(f.id, { endLat: last.lat, endLon: last.lon });
    }

    // --- nothing happened: a stretch in the menu or at a gate
    const moved = startLat !== null && startLon !== null && f.endLat !== null && f.endLon !== null ? nm(startLat, startLon, f.endLat, f.endLon) : 0;
    const neverFlew = f.maxAltFt < 1_500 || f.maxAltFt > 70_000;
    if (kept.length === 0 && ((dur < 5 * 60_000 && moved < 2) || (startLat === null && neverFlew && dur < 15 * 60_000))) {
      db.hideFlight(f.id);
      report.hidden++;
    }
  }
  db.setMeta(KEY, String(Date.now()));
  if (log && (report.starts || report.hidden || report.landings)) {
    log.info(`Flight log tidied: ${report.starts} start position(s) corrected, ${report.hidden} flight(s) that never went anywhere hidden, ${report.landings} replayed landing(s) set aside.`);
  }
  return report;
}

/**
 * Flights recorded by 2.0.0 and older could lose their SimBrief plan: when a flight began with a short stretch (a
 * respawn, a move to another gate), the plan was tied to that stretch, which was then hidden, and the real flight that
 * followed got nothing. The plan is moved to the next flight when it began within the hour, near where the stretch
 * began, and has no plan of its own. Runs once per database (meta "repair-plans-1").
 */
export function repairPlans(db: FlightDb, log: Logger | null, force = false): number {
  const KEY2 = "repair-plans-1";
  if (!force && db.getMeta(KEY2)) return 0;
  const flights = db.allFlights().sort((a, b) => a.startedAt - b.startedAt);
  let moved = 0;
  for (let i = 0; i < flights.length; i++) {
    const h = flights[i]!;
    if (!h.hidden || !h.planDep || !h.planArr) continue;
    for (let j = i + 1; j < flights.length; j++) {
      const f = flights[j]!;
      if (f.startedAt - h.endedAt > 3_600_000) break;
      if (f.hidden) continue;
      if (f.planDep) break;
      const near = h.startLat === null || h.startLon === null || f.startLat === null || f.startLon === null || nm(h.startLat, h.startLon, f.startLat, f.startLon) < 8;
      if (!near) break;
      db.setFlightPlan(f.id, h.planDep, h.planArr, { callsign: h.planCallsign ?? null, route: h.planRoute ?? null, distanceNm: h.planDistanceNm ?? null, eteMin: h.planEteMin ?? null, ofpId: h.planOfpId ?? null });
      f.planDep = h.planDep;
      moved++;
      break;
    }
  }
  db.setMeta(KEY2, String(Date.now()));
  if (moved) log?.info(`Gave ${moved} flight(s) back the SimBrief plan a short stretch before them had taken.`);
  return moved;
}
