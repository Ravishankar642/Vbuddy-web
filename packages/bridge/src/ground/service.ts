import { mockGroundChart, type GroundChart } from "@vbuddy/protocol";
import { FacilityDataType, type ConnectionHandle, type RecvFacilityData } from "node-simconnect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.js";
import { buildChart, type RawLayout } from "./msfs-layout.js";

/** VBuddy's facility definition and request ids (well clear of the other modules'). */
const DEF_GROUND = 950;
const REQ_BASE = 9500;
const TIMEOUT_MS = 20_000;
/** A chart from the scenery is kept this long on disk; scenery rarely changes, and a new add-on airport is picked up after. */
const DISK_TTL_MS = 7 * 24 * 3_600_000;
/** An airport the sim has no layout for isn't asked again for a while. */
const MISS_TTL_MS = 10 * 60_000;

/** The facility definition: the airport and the five child lists, in the order the fields are read back. */
const FIELDS = [
  "OPEN AIRPORT", "LATITUDE", "LONGITUDE", "ALTITUDE", "NAME",
  "OPEN RUNWAY", "LATITUDE", "LONGITUDE", "HEADING", "LENGTH", "WIDTH", "PRIMARY_NUMBER", "PRIMARY_DESIGNATOR", "SECONDARY_NUMBER", "SECONDARY_DESIGNATOR", "CLOSE RUNWAY",
  "OPEN TAXI_POINT", "TYPE", "BIAS_X", "BIAS_Z", "CLOSE TAXI_POINT",
  "OPEN TAXI_PARKING", "TYPE", "NAME", "SUFFIX", "NUMBER", "HEADING", "RADIUS", "BIAS_X", "BIAS_Z", "CLOSE TAXI_PARKING",
  "OPEN TAXI_PATH", "TYPE", "WIDTH", "START", "END", "NAME_INDEX", "CLOSE TAXI_PATH",
  "OPEN TAXI_NAME", "NAME", "CLOSE TAXI_NAME",
  "CLOSE AIRPORT",
];

interface SimLike {
  onHandle(cb: (h: ConnectionHandle | null) => void): void;
  status(): { connected: boolean; simGen?: string };
}

/** Where a ground chart comes from. */
export interface GroundSource {
  chart(icao: string): Promise<GroundChart | null>;
}

/** Reads one airport's taxi layout from MSFS 2020 / 2024 through the SimConnect Facilities API. */
export class MsfsGround implements GroundSource {
  private handle: ConnectionHandle | null = null;
  private defined = false;
  private seq = 0;
  private pending = new Map<number, { raw: RawLayout; done: (r: RawLayout | null) => void; timer: NodeJS.Timeout; any: boolean }>();
  /** One request at a time: the sim answers a big airport in thousands of messages. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    sim: SimLike,
    private log: Logger,
    /** The raw facility data is saved next to the chart, so a layout that looks wrong can be checked. */
    private rawDir: string | null = null,
  ) {
    sim.onHandle((h) => {
      this.handle = h;
      this.defined = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.done(null);
        this.pending.delete(id);
      }
      if (!h) return;
      h.on("facilityData", (r) => this.onData(r));
      h.on("facilityDataEnd", (r) => this.onEnd(r.userRequestId));
    });
  }

  private define(h: ConnectionHandle) {
    if (this.defined) return;
    for (const f of FIELDS) h.addToFacilityDefinition(DEF_GROUND, f);
    this.defined = true;
  }

  chart(icao: string): Promise<GroundChart | null> {
    const run = this.queue.then(() => this.fetchRaw(icao));
    this.queue = run.catch(() => null);
    return run.then((raw) => {
      if (!raw) return null;
      if (this.rawDir) {
        try {
          mkdirSync(this.rawDir, { recursive: true });
          writeFileSync(join(this.rawDir, `${icao}.raw.json`), JSON.stringify(raw));
        } catch {
          /* only a debugging aid */
        }
      }
      if (!raw.points.length && !raw.runways.length) return null;
      const chart = buildChart(icao, raw);
      this.log.info(`${icao}: ${chart.runways.length} runway(s), ${chart.edges.length} taxi segment(s), ${chart.parking.length} stand(s), ${chart.names.length} taxiway name(s) from the scenery`);
      return chart;
    });
  }

  private fetchRaw(icao: string): Promise<RawLayout | null> {
    const h = this.handle;
    if (!h) return Promise.resolve(null);
    try {
      this.define(h);
    } catch (e) {
      this.log.warn(`Couldn't set up the airport layout request: ${(e as Error).message}`);
      return Promise.resolve(null);
    }
    const id = REQ_BASE + (this.seq++ % 400);
    return new Promise((done) => {
      const raw: RawLayout = { lat: 0, lon: 0, altM: 0, name: "", runways: [], points: [], parkings: [], paths: [], names: [] };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log.warn(`${icao}: the simulator didn't send the airport layout in ${TIMEOUT_MS / 1000} s.`);
        done(null);
      }, TIMEOUT_MS);
      this.pending.set(id, { raw, done, timer, any: false });
      try {
        h.requestFacilityData(DEF_GROUND, id, icao, "");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.log.warn(`${icao}: couldn't ask for the airport layout (${(e as Error).message}).`);
        done(null);
      }
    });
  }

  private onData(r: RecvFacilityData) {
    const p = this.pending.get(r.userRequestId);
    if (!p) return;
    p.any = true;
    const d = r.data;
    const raw = p.raw;
    try {
      switch (r.type) {
        case FacilityDataType.AIRPORT:
          raw.lat = d.readFloat64();
          raw.lon = d.readFloat64();
          raw.altM = d.readFloat64();
          raw.name = d.readString32();
          break;
        case FacilityDataType.RUNWAY:
          raw.runways.push({
            lat: d.readFloat64(),
            lon: d.readFloat64(),
            hdg: d.readFloat32(),
            lengthM: d.readFloat32(),
            widthM: d.readFloat32(),
            primaryNumber: d.readInt32(),
            primaryDesignator: d.readInt32(),
            secondaryNumber: d.readInt32(),
            secondaryDesignator: d.readInt32(),
          });
          break;
        case FacilityDataType.TAXI_POINT:
          raw.points[r.itemIndex] = { type: d.readInt32(), biasX: d.readFloat32(), biasZ: d.readFloat32() };
          break;
        case FacilityDataType.TAXI_PARKING:
          raw.parkings[r.itemIndex] = { type: d.readInt32(), name: d.readInt32(), suffix: d.readInt32(), number: d.readUint32(), hdg: d.readFloat32(), radiusM: d.readFloat32(), biasX: d.readFloat32(), biasZ: d.readFloat32() };
          break;
        case FacilityDataType.TAXI_PATH:
          raw.paths[r.itemIndex] = { type: d.readInt32(), widthM: d.readFloat32(), start: d.readInt32(), end: d.readInt32(), nameIndex: d.readUint32() };
          break;
        case FacilityDataType.TAXI_NAME:
          raw.names[r.itemIndex] = d.readString32();
          break;
      }
    } catch (e) {
      this.log.debug(`airport layout item skipped: ${(e as Error).message}`);
    }
  }

  private onEnd(reqId: number) {
    const p = this.pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    // Lists may arrive with gaps if an item failed to decode: fill them so indices still line up.
    const fill = <T>(a: T[], blank: T) => Array.from({ length: a.length }, (_, i) => a[i] ?? blank);
    const raw = p.raw;
    raw.points = fill(raw.points, { type: 0, biasX: 0, biasZ: 0 });
    raw.parkings = fill(raw.parkings, { type: 13, name: 0, suffix: 0, number: 0, hdg: 0, radiusM: 0, biasX: 0, biasZ: 0 });
    raw.paths = fill(raw.paths, { type: 0, widthM: 0, start: 0, end: 0, nameIndex: 0 });
    raw.names = fill(raw.names, "");
    p.done(p.any ? raw : null);
  }
}

/** The test flight's airport, wherever the test flight is. */
export class MockGround implements GroundSource {
  async chart(icao: string): Promise<GroundChart | null> {
    return mockGroundChart(icao.toUpperCase(), 19.0887, 72.8679, icao.toUpperCase() === "VABB" ? "Mumbai (VBuddy test layout)" : "VBuddy Test Field");
  }
}

/**
 * Ground charts for the app: from the simulator's scenery (or the test airport), kept in memory and on disk so an
 * airport is read from the sim only once a week. An airport the sim has no layout for is remembered for a while.
 */
export class GroundService {
  private mem = new Map<string, GroundChart>();
  private misses = new Map<string, number>();
  private inflight = new Map<string, Promise<GroundChart | null>>();

  constructor(
    private source: GroundSource,
    private log: Logger,
    private dir: string | null,
    private connected: () => boolean,
    private generation: () => string = () => "",
    private now: () => number = Date.now,
  ) {}

  private file(icao: string) {
    const gen = this.generation();
    return this.dir ? join(this.dir, `${icao}${gen ? `.${gen}` : ""}.json`) : null;
  }

  async get(icaoIn: string, refresh = false): Promise<{ chart: GroundChart | null; error?: string }> {
    const icao = icaoIn.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(icao)) return { chart: null, error: "That isn't an airport code." };
    const key = `${this.generation()}:${icao}`;
    if (!refresh) {
      const hit = this.mem.get(key);
      if (hit) return { chart: hit };
      const f = this.file(icao);
      if (f) {
        try {
          const c = JSON.parse(readFileSync(f, "utf8")) as GroundChart;
          if (c && this.now() - c.builtAt < DISK_TTL_MS) {
            this.mem.set(key, c);
            return { chart: c };
          }
        } catch {
          /* not saved yet */
        }
      }
      const miss = this.misses.get(key);
      if (miss && this.now() - miss < MISS_TTL_MS) return { chart: null, error: `The simulator has no taxiway layout for ${icao}.` };
    }
    if (!this.connected()) return { chart: null, error: "Start the simulator: the airport layout comes from its scenery." };
    let run = this.inflight.get(key);
    if (!run) {
      run = this.source.chart(icao).finally(() => this.inflight.delete(key));
      this.inflight.set(key, run);
    }
    const chart = await run.catch((e: Error) => {
      this.log.warn(`${icao}: airport layout failed (${e.message})`);
      return null;
    });
    if (!chart || (!chart.edges.length && !chart.runways.length)) {
      this.misses.set(key, this.now());
      return { chart: null, error: `The simulator has no taxiway layout for ${icao}.` };
    }
    this.mem.set(key, chart);
    if (this.mem.size > 30) this.mem.delete(this.mem.keys().next().value!);
    const f = this.file(icao);
    if (f && chart.source === "msfs") {
      try {
        mkdirSync(this.dir!, { recursive: true });
        writeFileSync(f, JSON.stringify(chart));
      } catch (e) {
        this.log.debug(`couldn't save the ${icao} layout: ${(e as Error).message}`);
      }
    }
    return { chart };
  }
}
