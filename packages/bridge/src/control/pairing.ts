import type { PairedDevice } from "@vbuddy/protocol";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../log.js";

export const CODE_TTL_MS = 10 * 60_000;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;
/** After this many wrong codes in total, the code is replaced (guessing 6 digits needs ~500k tries). */
const MAX_CODE_FAILS = 20;

interface StoredDevice extends PairedDevice {
  /** sha256 of the token; the token itself is never stored. */
  hash: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Who may send commands. A device pairs once with a short-lived 6-digit code
 * shown on the bridge PC and gets a long random token; only the token's hash
 * is kept on disk. Wrong codes are rate-limited per address.
 */
export class Pairing {
  private devices: StoredDevice[] = [];
  private code = "";
  private codeExpires = 0;
  private codeFails = 0;
  private fails = new Map<string, { n: number; until: number }>();
  private changeCbs: Array<() => void> = [];

  constructor(
    private file: string | null,
    private log: Logger,
    private now: () => number = Date.now,
  ) {
    this.load();
    this.rotate(false);
  }

  private load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as { devices?: StoredDevice[] };
      this.devices = (j.devices ?? []).filter((d) => typeof d.hash === "string" && typeof d.id === "string");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn(`Couldn't read paired devices (${(e as Error).message}); devices will need to pair again.`);
    }
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + ".tmp", JSON.stringify({ devices: this.devices }, null, 2));
      renameSync(this.file + ".tmp", this.file);
    } catch (e) {
      this.log.warn(`Couldn't save paired devices: ${(e as Error).message}`);
    }
  }

  onChange(cb: () => void) {
    this.changeCbs.push(cb);
  }
  private changed() {
    for (const cb of this.changeCbs) cb();
  }

  /** A new code; the old one stops working. */
  rotate(announce = true) {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.codeExpires = this.now() + CODE_TTL_MS;
    this.codeFails = 0;
    this.log.info(`Pairing code for a new device: ${this.code} (valid ${CODE_TTL_MS / 60_000} min). Enter it under Systems → Controls.`);
    if (announce) this.changed();
  }

  /** The current code, replacing it first if it has expired. */
  current() {
    if (this.now() >= this.codeExpires) this.rotate();
    return { code: this.code, expiresAt: this.codeExpires };
  }

  devicesList(): PairedDevice[] {
    return this.devices.map(({ hash: _h, ...d }) => d);
  }

  /** Checks a code; on success returns a new token for this device. */
  pair(code: string, deviceName: string, from: string): { ok: true; token: string; device: PairedDevice } | { ok: false; error: string } {
    const now = this.now();
    const f = this.fails.get(from);
    if (f && f.until > now) return { ok: false, error: `Too many wrong codes. Try again in ${Math.ceil((f.until - now) / 1000)} s.` };
    this.current();
    const a = Buffer.from(code.padEnd(6).slice(0, 6));
    const b = Buffer.from(this.code);
    if (!timingSafeEqual(a, b)) {
      const n = (f && f.until <= now && f.n >= MAX_FAILS ? 0 : (f?.n ?? 0)) + 1;
      this.fails.set(from, { n, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
      if (++this.codeFails >= MAX_CODE_FAILS) this.rotate();
      return { ok: false, error: "That code isn't right. Check the code shown on the bridge PC." };
    }
    this.fails.delete(from);
    const token = randomBytes(32).toString("base64url");
    const device: StoredDevice = { id: randomUUID(), name: deviceName.slice(0, 60), pairedAt: now, lastSeen: now, hash: sha(token) };
    this.devices.push(device);
    this.save();
    this.log.info(`Paired "${device.name}" (${from}).`);
    this.rotate(); // a code is good for one device
    return { ok: true, token, device: { id: device.id, name: device.name, pairedAt: device.pairedAt, lastSeen: device.lastSeen } };
  }

  /** The device this token belongs to, or null. */
  verify(token: string | undefined): PairedDevice | null {
    if (!token) return null;
    const h = sha(token);
    const d = this.devices.find((x) => timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
    if (!d) return null;
    d.lastSeen = this.now();
    return { id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen };
  }

  revoke(id: string) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== before) {
      this.save();
      this.log.info("A paired device was removed.");
      this.changed();
      return true;
    }
    return false;
  }

  /** Persist lastSeen times now and then. */
  flush() {
    this.save();
  }
}

/** Connections from the bridge PC itself are trusted (they could read the pairing code anyway). */
export function isLocalAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
