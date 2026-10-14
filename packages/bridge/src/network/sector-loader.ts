import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../log.js";
import { emptySectors, parseFirBoundaries, parseTraconBoundaries, parseVatspyDat, type SectorData } from "./sectors.js";

export const VATSPY_BASE = "https://github.com/vatsimnetwork/vatspy-data-project/releases/latest/download/";
export const TRACON_URL = "https://github.com/vatsimnetwork/simaware-tracon-project/releases/latest/download/TRACONBoundaries.geojson";

const FILES = {
  dat: "VATSpy.dat",
  fir: "Boundaries.geojson",
  tracon: "TRACONBoundaries.geojson",
} as const;

const REFRESH_MS = 24 * 3_600_000;

export interface LoaderOptions {
  dir: string;
  log: Logger;
  fetch?: typeof fetch;
  vatspyBase?: string;
  traconUrl?: string;
}

/**
 * Keeps a copy of the sector shapes on disk, refreshed once a day. If the
 * download fails the cached copy is used; with neither, ATC is still listed but
 * there are no shapes (so no boundary alerts).
 */
export class SectorLoader {
  private fetchFn: typeof fetch;
  constructor(private opts: LoaderOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  private url(kind: keyof typeof FILES) {
    return kind === "tracon" ? (this.opts.traconUrl ?? TRACON_URL) : (this.opts.vatspyBase ?? VATSPY_BASE) + FILES[kind];
  }

  /** Path to an up-to-date local copy, downloading if needed; null if there is none. */
  private async file(kind: keyof typeof FILES, force: boolean): Promise<string | null> {
    const path = join(this.opts.dir, FILES[kind]);
    const st = await stat(path).catch(() => null);
    if (st && !force && Date.now() - st.mtimeMs < REFRESH_MS) return path;
    try {
      const res = await this.fetchFn(this.url(kind), { signal: AbortSignal.timeout(60_000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length < 10) throw new Error("empty file");
      await mkdir(this.opts.dir, { recursive: true });
      await writeFile(path + ".tmp", body);
      await rename(path + ".tmp", path);
      return path;
    } catch (e) {
      if (st) {
        this.opts.log.warn(`Couldn't refresh ${FILES[kind]} (${(e as Error).message}); using the copy from ${new Date(st.mtimeMs).toLocaleDateString()}.`);
        return path;
      }
      this.opts.log.warn(`Couldn't download ${FILES[kind]} (${(e as Error).message}).`);
      return null;
    }
  }

  async load(force = false): Promise<SectorData | null> {
    const [dat, fir, tracon] = await Promise.all([this.file("dat", force), this.file("fir", force), this.file("tracon", force)]);
    if (!dat || !fir) return null;
    const data = emptySectors();
    try {
      parseVatspyDat(await readFile(dat, "utf8"), data);
      parseFirBoundaries(JSON.parse(await readFile(fir, "utf8")), data);
    } catch (e) {
      this.opts.log.warn(`Sector data is unreadable (${(e as Error).message}).`);
      return null;
    }
    if (tracon) {
      try {
        parseTraconBoundaries(JSON.parse(await readFile(tracon, "utf8")), data);
      } catch (e) {
        this.opts.log.warn(`Approach shapes are unreadable (${(e as Error).message}); approach areas will be circles.`);
      }
    }
    if (!data.firShapes.size) return null;
    this.opts.log.info(`Sector data: ${data.firShapes.size} FIR shapes, ${data.tracons.length} approach shapes, ${new Set(data.airports.values()).size} airports.`);
    return data;
  }
}
