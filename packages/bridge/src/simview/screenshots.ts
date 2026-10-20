import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.js";
import type { FrameSource } from "./capture.js";

/** Keep at most this many screenshots on the PC (the oldest go first). */
const KEEP = 200;
const NAME = /^VBuddy-\d{8}-\d{6}-[0-9a-f]{6}\.jpg$/;

/**
 * Full-size screenshots of the simulator, taken from the phone: saved on the PC (in VBuddy's data folder,
 * "screenshots") and handed to the phone to keep. The file name carries a random part, so it can't be guessed.
 */
export class Screenshots {
  constructor(
    private source: FrameSource,
    private dir: string | null,
    private log: Logger,
  ) {}

  available(): boolean {
    return typeof this.source.shot === "function";
  }

  async take(now = new Date()): Promise<{ ok: true; name: string; w: number; h: number; bytes: number } | { ok: false; error: string }> {
    if (!this.source.shot) return { ok: false, error: "Screenshots aren't available on this bridge." };
    if (!this.dir) return { ok: false, error: "Screenshots need VBuddy's data folder." };
    const r = await this.source.shot();
    if (!r.ok) return { ok: false, error: r.message };
    const p = (n: number) => String(n).padStart(2, "0");
    const name = `VBuddy-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${randomBytes(3).toString("hex")}.jpg`;
    const buf = Buffer.from(r.jpeg, "base64");
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, name), buf);
      this.prune();
    } catch (e) {
      return { ok: false, error: `Couldn't save the screenshot on the PC: ${(e as Error).message}` };
    }
    this.log.info(`Screenshot ${name} (${r.w} x ${r.h}, ${Math.round(buf.length / 1024)} KB)`);
    return { ok: true, name, w: r.w, h: r.h, bytes: buf.length };
  }

  /** The picture, if the name is one of ours. */
  read(name: string): Buffer | null {
    if (!this.dir || !NAME.test(name)) return null;
    const f = join(this.dir, name);
    try {
      return existsSync(f) ? readFileSync(f) : null;
    } catch {
      return null;
    }
  }

  private prune() {
    if (!this.dir) return;
    const files = readdirSync(this.dir).filter((n) => NAME.test(n));
    if (files.length <= KEEP) return;
    const byAge = files.map((n) => ({ n, t: statSync(join(this.dir!, n)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const f of byAge.slice(0, files.length - KEEP)) {
      try {
        unlinkSync(join(this.dir, f.n));
      } catch {
        /* in use: next time */
      }
    }
  }
}
