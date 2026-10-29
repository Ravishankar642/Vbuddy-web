import type { Landing, LegCommand, PlannedLeg, TelemetryFrame } from "@vbuddy/protocol";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../log.js";

/**
 * node:sqlite prints an "experimental" warning the first time it loads.
 * It is stable enough for this (built into Node, no native build step on
 * Windows), so the warning is dropped for that one import and nothing else.
 */
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  const orig = process.emitWarning;
  process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
    const msg = typeof w === "string" ? w : (w as Error | undefined)?.message;
    if (typeof msg === "string" && msg.includes("SQLite")) return;
    return (orig as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = orig;
  }
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- One row per flight: a stretch of continuous telemetry from one aircraft.
CREATE TABLE IF NOT EXISTS flights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  aircraft    TEXT    NOT NULL DEFAULT '',
  first_seq   INTEGER NOT NULL,
  last_seq    INTEGER NOT NULL,
  frames      INTEGER NOT NULL DEFAULT 0,
  start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
  max_alt_ft  REAL    NOT NULL DEFAULT 0,
  max_gs_kt   REAL    NOT NULL DEFAULT 0,
  distance_nm REAL,
  plan_dep    TEXT,
  plan_arr    TEXT
);
CREATE INDEX IF NOT EXISTS flights_started ON flights(started_at);

-- The numbered telemetry stream. (session_id, seq) is exactly what a client resumes with.
CREATE TABLE IF NOT EXISTS frames (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  data       TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS frames_ts ON frames(ts);

CREATE TABLE IF NOT EXISTS landings (
  id        TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL,
  flight_id INTEGER,
  json      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS landings_ts ON landings(ts);

-- Flights the pilot plans to fly.
CREATE TABLE IF NOT EXISTS planned_legs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dep        TEXT    NOT NULL,
  arr        TEXT    NOT NULL,
  aircraft   TEXT    NOT NULL DEFAULT '',
  planned_at INTEGER,
  notes      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

export interface FlightRow {
  id: number;
  sessionId: string;
  startedAt: number;
  endedAt: number;
  source: string;
  aircraft: string;
  firstSeq: number;
  lastSeq: number;
  frames: number;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
  maxAltFt: number;
  maxGsKt: number;
  landings: number;
  /** Length of the flown route, worked out once the flight has ended and kept after the telemetry is pruned. Null until then. */
  distanceNm: number | null;
  /** The SimBrief plan's departure and arrival when the flight began (or when one was first filled in), or null if there was no plan. */
  planDep: string | null;
  planArr: string | null;
  /** More of that plan, when it was tied to the flight by VBuddy 1.2 or later. */
  planCallsign?: string | null;
  planRoute?: string | null;
  planDistanceNm?: number | null;
  planEteMin?: number | null;
  planOfpId?: string | null;
}

/** The parts of a SimBrief plan kept with a flight. */
export interface FlightPlanFields {
  dep: string;
  arr: string;
  callsign: string | null;
  route: string | null;
  distanceNm: number | null;
  eteMin: number | null;
  ofpId: string | null;
}

export interface FlightUpdate {
  endedAt: number;
  aircraft?: string;
  lastSeq: number;
  frames: number;
  endLat: number;
  endLon: number;
  maxAltFt: number;
  maxGsKt: number;
}

/** [timestamp ms, lat, lon, altitude ft MSL, ground speed kt, true heading] */
export type TrackPoint = [number, number, number, number, number, number];

type Row = Record<string, unknown>;

/**
 * The flight database: telemetry frames, flights and landings in one SQLite
 * file. Everything here is synchronous (node:sqlite); callers batch writes.
 */
export class FlightDb {
  private stmts = new Map<string, StatementSync>();

  private constructor(
    private db: DatabaseSync,
    readonly file: string,
  ) {}

  /**
   * Opens (creating if needed) the database. A file that is damaged beyond use is
   * moved aside and replaced, so a bad file can never stop the bridge from
   * starting. Returns null only if SQLite itself isn't available.
   */
  static async open(file: string, log: Logger): Promise<FlightDb | null> {
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = await loadSqlite();
    } catch (e) {
      log.warn(`SQLite isn't available in this Node.js (${(e as Error).message}). Update to Node.js 22.13 or newer. The flight log is off.`);
      return null;
    }
    const attempt = () => {
      if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
      const db = new sqlite.DatabaseSync(file);
      try {
        // journal_size_limit: the write-ahead log is cut back to 8 MB after each checkpoint (it grew past 100 MB).
        db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000; PRAGMA journal_size_limit = 8388608; PRAGMA temp_store = MEMORY;");
        db.exec(SCHEMA);
        // Databases made before the distance was kept get the column added.
        const cols = db.prepare("PRAGMA table_info(flights)").all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "distance_nm")) db.exec("ALTER TABLE flights ADD COLUMN distance_nm REAL");
        if (!cols.some((c) => c.name === "plan_dep")) db.exec("ALTER TABLE flights ADD COLUMN plan_dep TEXT");
        if (!cols.some((c) => c.name === "plan_arr")) db.exec("ALTER TABLE flights ADD COLUMN plan_arr TEXT");
        for (const [name, type] of [["plan_callsign", "TEXT"], ["plan_route", "TEXT"], ["plan_distance_nm", "REAL"], ["plan_ete_min", "REAL"], ["plan_ofp_id", "TEXT"], ["hidden", "INTEGER NOT NULL DEFAULT 0"]] as const) {
          if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE flights ADD COLUMN ${name} ${type}`);
        }
        // Landings VBuddy decided weren't real (replays, a parked aircraft): kept aside instead of deleted.
        db.exec("CREATE TABLE IF NOT EXISTS landings_removed (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, flight_id INTEGER, json TEXT NOT NULL, why TEXT)");
        const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
        if (v > SCHEMA_VERSION) throw new Error(`database is from a newer VBuddy (schema ${v})`);
        if (v < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        db.prepare("SELECT COUNT(*) FROM frames").get(); // touches the pages: damaged files fail here, not later
      } catch (e) {
        db.close();
        throw e;
      }
      return db;
    };
    try {
      return new FlightDb(attempt(), file);
    } catch (e) {
      if (file === ":memory:" || !existsSync(file)) {
        log.warn(`Couldn't open the flight log ${file}: ${(e as Error).message}. The flight log is off.`);
        return null;
      }
      const aside = `${file}.damaged-${Date.now()}`;
      try {
        renameSync(file, aside);
        for (const ext of ["-wal", "-shm"]) if (existsSync(file + ext)) renameSync(file + ext, aside + ext);
        log.warn(`The flight log ${file} couldn't be read (${(e as Error).message}). Moved it to ${aside} and started a new one.`);
        return new FlightDb(attempt(), file);
      } catch (e2) {
        log.warn(`Couldn't open the flight log: ${(e2 as Error).message}. The flight log is off.`);
        return null;
      }
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  /* ------------------------------------------------------------ meta */

  getMeta(key: string): string | null {
    const r = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  setMeta(key: string, value: string) {
    this.stmt("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /* ------------------------------------------------------------ frames */

  insertFrames(sessionId: string, frames: TelemetryFrame[]) {
    if (!frames.length) return;
    const ins = this.stmt("INSERT OR REPLACE INTO frames(session_id, seq, ts, data) VALUES(?, ?, ?, ?)");
    this.tx(() => {
      for (const f of frames) ins.run(sessionId, f.seq, f.ts, JSON.stringify(f.data));
    });
  }

  /** Frames with fromSeq <= seq <= toSeq, keeping every `stride`th one counted from fromSeq. Oldest first. */
  frames(sessionId: string, fromSeq: number, toSeq: number, stride = 1): TelemetryFrame[] {
    const rows = this.stmt(
      "SELECT seq, ts, data FROM frames WHERE session_id = ? AND seq BETWEEN ? AND ? AND ((seq - ?) % ?) = 0 ORDER BY seq",
    ).all(sessionId, fromSeq, toSeq, fromSeq, Math.max(1, stride)) as unknown as Array<{ seq: number; ts: number; data: string }>;
    const out: TelemetryFrame[] = [];
    for (const r of rows) {
      try {
        out.push({ seq: r.seq, ts: r.ts, data: JSON.parse(r.data) });
      } catch {
        /* a damaged row is a hole in the replay, not an error */
      }
    }
    return out;
  }

  /** Deletes telemetry older than the cutoff. Flights and landings are kept. Returns rows removed. */
  pruneFrames(olderThanTs: number): number {
    return Number(this.stmt("DELETE FROM frames WHERE ts < ?").run(olderThanTs).changes);
  }

  frameCount(): number {
    return Number((this.stmt("SELECT COUNT(*) AS n FROM frames").get() as { n: number }).n);
  }

  /* ------------------------------------------------------------ flights */

  openFlight(f: { sessionId: string; startedAt: number; source: string; aircraft: string; firstSeq: number; lat: number; lon: number }): number {
    const r = this.stmt(
      `INSERT INTO flights(session_id, started_at, ended_at, source, aircraft, first_seq, last_seq, frames, start_lat, start_lon, end_lat, end_lon)
       VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(f.sessionId, f.startedAt, f.startedAt, f.source, f.aircraft, f.firstSeq, f.firstSeq, f.lat, f.lon, f.lat, f.lon);
    return Number(r.lastInsertRowid);
  }

  updateFlight(id: number, u: FlightUpdate) {
    this.stmt(
      `UPDATE flights SET ended_at = ?, aircraft = COALESCE(?, aircraft), last_seq = ?, frames = ?, end_lat = ?, end_lon = ?,
         max_alt_ft = MAX(max_alt_ft, ?), max_gs_kt = MAX(max_gs_kt, ?) WHERE id = ?`,
    ).run(u.endedAt, u.aircraft ?? null, u.lastSeq, u.frames, u.endLat, u.endLon, u.maxAltFt, u.maxGsKt, id);
  }

  private mapFlight(r: Row): FlightRow {
    return {
      id: Number(r.id),
      sessionId: String(r.session_id),
      startedAt: Number(r.started_at),
      endedAt: Number(r.ended_at),
      source: String(r.source),
      aircraft: String(r.aircraft),
      firstSeq: Number(r.first_seq),
      lastSeq: Number(r.last_seq),
      frames: Number(r.frames),
      startLat: r.start_lat === null ? null : Number(r.start_lat),
      startLon: r.start_lon === null ? null : Number(r.start_lon),
      endLat: r.end_lat === null ? null : Number(r.end_lat),
      endLon: r.end_lon === null ? null : Number(r.end_lon),
      maxAltFt: Number(r.max_alt_ft),
      maxGsKt: Number(r.max_gs_kt),
      landings: Number(r.landings ?? 0),
      distanceNm: r.distance_nm === null || r.distance_nm === undefined ? null : Number(r.distance_nm),
      planDep: r.plan_dep ? String(r.plan_dep) : null,
      planArr: r.plan_arr ? String(r.plan_arr) : null,
      planCallsign: r.plan_callsign ? String(r.plan_callsign) : null,
      planRoute: r.plan_route ? String(r.plan_route) : null,
      planDistanceNm: r.plan_distance_nm === null || r.plan_distance_nm === undefined ? null : Number(r.plan_distance_nm),
      planEteMin: r.plan_ete_min === null || r.plan_ete_min === undefined ? null : Number(r.plan_ete_min),
      planOfpId: r.plan_ofp_id ? String(r.plan_ofp_id) : null,
    };
  }

  /** Remembers the plan this flight was flown against. Only the first plan is kept, unless `replace`. */
  setFlightPlan(id: number, dep: string, arr: string, more: Omit<FlightPlanFields, "dep" | "arr"> | null = null, replace = false) {
    this.stmt(
      `UPDATE flights SET plan_dep = ?, plan_arr = ?, plan_callsign = ?, plan_route = ?, plan_distance_nm = ?, plan_ete_min = ?, plan_ofp_id = ?
       WHERE id = ?${replace ? "" : " AND plan_dep IS NULL"}`,
    ).run(dep, arr, more?.callsign ?? null, more?.route ?? null, more?.distanceNm ?? null, more?.eteMin ?? null, more?.ofpId ?? null, id);
  }

  /** Takes a flight out of the lists (a stretch in the menu, a spawn that never went anywhere). It stays in the file. */
  hideFlight(id: number) {
    this.stmt("UPDATE flights SET hidden = 1 WHERE id = ?").run(id);
  }

  /** Every flight, oldest first, with what the repair needs. Includes hidden ones. */
  allFlights(): Array<FlightRow & { hidden: boolean }> {
    const rows = this.stmt("SELECT f.*, (SELECT COUNT(*) FROM landings l WHERE l.flight_id = f.id) AS landings FROM flights f ORDER BY f.started_at, f.id").all() as Row[];
    return rows.map((r) => ({ ...this.mapFlight(r), hidden: Number(r.hidden ?? 0) === 1 }));
  }

  setFlightEnds(id: number, p: { startLat?: number | null; startLon?: number | null; endLat?: number | null; endLon?: number | null; startedAt?: number }) {
    const f = this.flight(id);
    if (!f) return;
    // The distance flown is kept: the telemetry it was worked out from may be gone by now.
    this.stmt("UPDATE flights SET start_lat = ?, start_lon = ?, end_lat = ?, end_lon = ?, started_at = ? WHERE id = ?").run(
      p.startLat === undefined ? f.startLat : p.startLat,
      p.startLon === undefined ? f.startLon : p.startLon,
      p.endLat === undefined ? f.endLat : p.endLat,
      p.endLon === undefined ? f.endLon : p.endLon,
      p.startedAt ?? f.startedAt,
      id,
    );
  }

  /** [ts, lat, lon, onGround] of a flight's frames, oldest first, at most `limit`. */
  flightPositions(id: number, limit = 5000): Array<[number, number, number, boolean]> {
    const f = this.flight(id);
    if (!f) return [];
    const rows = this.stmt(
      "SELECT ts, json_extract(data,'$.lat') AS lat, json_extract(data,'$.lon') AS lon, json_extract(data,'$.onGround') AS g FROM frames WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq LIMIT ?",
    ).all(f.sessionId, f.firstSeq, f.lastSeq, limit) as Row[];
    return rows.map((r) => [Number(r.ts), Number(r.lat), Number(r.lon), !!r.g && r.g !== 0]);
  }

  /** The landings of one flight: id, time, position. */
  flightLandings(id: number): Array<{ id: string; ts: number; lat: number; lon: number }> {
    const rows = this.stmt("SELECT id, ts, json_extract(json,'$.lat') AS lat, json_extract(json,'$.lon') AS lon FROM landings WHERE flight_id = ? ORDER BY ts").all(id) as Row[];
    return rows.map((r) => ({ id: String(r.id), ts: Number(r.ts), lat: Number(r.lat), lon: Number(r.lon) }));
  }

  /** Moves landings into landings_removed (kept, but no longer listed). */
  removeLandings(ids: string[], why: string) {
    for (const id of ids) {
      this.stmt("INSERT OR IGNORE INTO landings_removed(id, ts, flight_id, json, why) SELECT id, ts, flight_id, json, ? FROM landings WHERE id = ?").run(why, id);
      this.stmt("DELETE FROM landings WHERE id = ?").run(id);
    }
  }

  setFlightDistance(id: number, nm: number) {
    this.stmt("UPDATE flights SET distance_nm = ? WHERE id = ?").run(nm, id);
  }

  /** Newest first. */
  flights(limit = 50): FlightRow[] {
    const rows = this.stmt(
      "SELECT f.*, (SELECT COUNT(*) FROM landings l WHERE l.flight_id = f.id) AS landings FROM flights f WHERE COALESCE(f.hidden, 0) = 0 ORDER BY f.started_at DESC, f.id DESC LIMIT ?",
    ).all(limit) as Row[];
    return rows.map((r) => this.mapFlight(r));
  }

  flight(id: number): FlightRow | null {
    const r = this.stmt("SELECT f.*, (SELECT COUNT(*) FROM landings l WHERE l.flight_id = f.id) AS landings FROM flights f WHERE f.id = ?").get(id) as Row | undefined;
    return r ? this.mapFlight(r) : null;
  }

  /** The flight's path, thinned to at most ~maxPoints. Null if there's no such flight. */
  track(id: number, maxPoints = 2000): TrackPoint[] | null {
    const f = this.flight(id);
    if (!f) return null;
    const n = f.lastSeq - f.firstSeq + 1;
    const stride = Math.max(1, Math.ceil(n / Math.max(2, maxPoints)));
    const rows = this.stmt(
      `SELECT ts, json_extract(data,'$.lat') AS lat, json_extract(data,'$.lon') AS lon, json_extract(data,'$.altMsl') AS alt,
              json_extract(data,'$.gs') AS gs, json_extract(data,'$.hdgTrue') AS hdg
       FROM frames WHERE session_id = ? AND seq BETWEEN ? AND ? AND ((seq - ?) % ?) = 0 ORDER BY seq`,
    ).all(f.sessionId, f.firstSeq, f.lastSeq, f.firstSeq, stride) as Row[];
    return rows.map((r) => [Number(r.ts), Number(r.lat), Number(r.lon), Math.round(Number(r.alt)), Math.round(Number(r.gs)), Math.round(Number(r.hdg))]);
  }

  /* ------------------------------------------------------------ landings */

  /** Returns false if the landing was already stored. */
  insertLanding(l: Landing, flightId: number | null): boolean {
    const r = this.stmt("INSERT OR IGNORE INTO landings(id, ts, flight_id, json) VALUES(?, ?, ?, ?)").run(l.id, l.ts, flightId, JSON.stringify(l));
    return Number(r.changes) > 0;
  }

  /** Raw landing JSON, oldest first, for the newest `limit` landings. The caller validates. */
  recentLandingJson(limit: number): string[] {
    const rows = this.stmt("SELECT json FROM (SELECT ts, json FROM landings ORDER BY ts DESC LIMIT ?) ORDER BY ts").all(limit) as Array<{ json: string }>;
    return rows.map((r) => r.json);
  }

  landingCount(): number {
    return Number((this.stmt("SELECT COUNT(*) AS n FROM landings").get() as { n: number }).n);
  }

  /* ------------------------------------------------------------ planned legs */

  private mapLeg(r: Row): PlannedLeg {
    return {
      id: Number(r.id),
      dep: String(r.dep),
      arr: String(r.arr),
      aircraft: String(r.aircraft),
      plannedAt: r.planned_at === null ? null : Number(r.planned_at),
      notes: String(r.notes),
      createdAt: Number(r.created_at),
    };
  }

  /** Soonest planned first; legs with no date come last, oldest entry first. */
  plannedLegs(): PlannedLeg[] {
    const rows = this.stmt("SELECT * FROM planned_legs ORDER BY planned_at IS NULL, planned_at, id").all() as Row[];
    return rows.map((r) => this.mapLeg(r));
  }

  /** Applies an add / update / delete. Returns false when an update or delete named a leg that isn't there. */
  applyLeg(c: LegCommand, now = Date.now()): boolean {
    if (c.op === "add") {
      this.stmt("INSERT INTO planned_legs(dep, arr, aircraft, planned_at, notes, created_at) VALUES(?, ?, ?, ?, ?, ?)").run(c.dep, c.arr, c.aircraft, c.plannedAt, c.notes, now);
      return true;
    }
    if (c.op === "update") {
      return Number(this.stmt("UPDATE planned_legs SET dep = ?, arr = ?, aircraft = ?, planned_at = ?, notes = ? WHERE id = ?").run(c.dep, c.arr, c.aircraft, c.plannedAt, c.notes, c.id).changes) > 0;
    }
    return Number(this.stmt("DELETE FROM planned_legs WHERE id = ?").run(c.id).changes) > 0;
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Keeps the file small: writes the log back into the database and empties it, and when more than a quarter of the
   * file (and over 16 MB) is space left by old telemetry, compacts it (well under a second for a typical log).
   * Returns what it did, for the log.
   */
  maintain(): { walTrimmed: boolean; vacuumed: boolean; freedMb: number } {
    let walTrimmed = false;
    let vacuumed = false;
    let freedMb = 0;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      walTrimmed = true;
    } catch {
      /* busy: next time */
    }
    try {
      const page = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
      const pages = (this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
      const free = (this.db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
      if (free * page > 16 * 1024 * 1024 && free > pages / 4) {
        this.stmts.clear();
        this.db.exec("VACUUM");
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        vacuumed = true;
        freedMb = Math.round((free * page) / 1024 / 1024);
      }
    } catch {
      /* in use: next time */
    }
    return { walTrimmed, vacuumed, freedMb };
  }

  close() {
    this.stmts.clear();
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* best effort */
    }
    this.db.close();
  }
}
