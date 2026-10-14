import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../log.js";

/**
 * Updates the way Cobalt's bridge does (its AutoUpdater, read from Cobalt Bridge 1.2.5):
 *  - check at start and every 6 hours; never in a development build; off with VBUDDY_NO_UPDATES=1;
 *  - a newer release is downloaded in the background, but not while the simulator is connected
 *    (the installer is large and MSFS streams scenery over the same line): it waits until the sim closes;
 *  - the download is verified (SHA-256 from the release's SHA256SUMS.txt) before it can be installed;
 *  - the person chooses Install now (on the PC) or later; failures are logged quietly, never nag.
 * Releases come from GitHub (Ravishankar642/Vbuddy-web by default): the newest release's tag is the version,
 * and its assets are the two installers (VBuddy-Setup-x.y.z.exe, VBuddy-Local-Setup-x.y.z.exe) and SHA256SUMS.txt.
 */
export const RECHECK_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_UPDATE_REPO = "Ravishankar642/Vbuddy-web";

export type UpdateStatus =
  | { kind: "off"; reason: string }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; checkedAt: number }
  | { kind: "waiting-for-sim"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string; checkedAt: number };

export interface UpdateState {
  current: string;
  status: UpdateStatus;
  text: string;
  version: string | null;
  notes: string | null;
  url: string | null;
}

interface Release {
  version: string;
  notes: string;
  url: string;
  installer: { name: string; url: string; size: number };
  sums: string | null;
}

export interface UpdaterOptions {
  current: string;
  edition: "cloud" | "local";
  /** Only a packaged install updates itself. */
  packaged: boolean;
  disabled: boolean;
  dir: string | null;
  repo?: string;
  api?: string;
  simConnected: () => boolean;
  log: Logger;
  fetchFn?: typeof fetch;
  /** Starts the installer (on Windows: elevated, detached, silent). */
  launch?: (file: string) => Promise<void>;
  now?: () => number;
}

/** "v1.2.3" / "1.2.3" -> [1,2,3]; anything else -> null. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** The installer for this edition among a release's files. */
export function pickInstaller(assets: Array<{ name: string }>, edition: "cloud" | "local"): string | null {
  const re = edition === "local" ? /^VBuddy-Local-Setup-[\d.]+\.exe$/i : /^VBuddy-Setup-[\d.]+\.exe$/i;
  return assets.find((a) => re.test(a.name))?.name ?? null;
}

/** The SHA-256 for a file name from a SHA256SUMS.txt ("<hex>  <name>" lines). */
export function sumFor(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2]!.trim() === name) return m[1]!.toLowerCase();
  }
  return null;
}

export class Updater {
  private status: UpdateStatus;
  private release: Release | null = null;
  private file: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private listeners = new Set<(s: UpdateState) => void>();
  private readonly fetchFn: typeof fetch;
  private readonly repo: string;
  private readonly api: string;
  private readonly now: () => number;

  constructor(private o: UpdaterOptions) {
    this.fetchFn = o.fetchFn ?? fetch;
    this.repo = o.repo ?? DEFAULT_UPDATE_REPO;
    this.api = (o.api ?? "https://api.github.com").replace(/\/+$/, "");
    this.now = o.now ?? Date.now;
    this.status = !o.packaged ? { kind: "off", reason: "Updates aren't used in a development build." } : o.disabled ? { kind: "off", reason: "Updates are turned off (VBUDDY_NO_UPDATES)." } : { kind: "idle" };
  }

  get enabled() {
    return this.status.kind !== "off";
  }

  onChange(fn: (s: UpdateState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    if (!this.enabled) {
      this.o.log.info(`Updates: ${(this.status as { reason: string }).reason}`);
      return;
    }
    this.cleanOld();
    setTimeout(() => void this.check("start"), 15_000).unref();
    this.timer = setInterval(() => void this.check("periodic"), RECHECK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): UpdateState {
    return { current: this.o.current, status: this.status, text: this.text(), version: this.release?.version ?? null, notes: this.release?.notes ?? null, url: this.release?.url ?? null };
  }

  private set(s: UpdateStatus) {
    this.status = s;
    const st = this.state();
    this.o.log.info(`Update status: ${st.text}`);
    for (const l of this.listeners) l(st);
  }

  text(): string {
    const s = this.status;
    switch (s.kind) {
      case "off":
        return s.reason;
      case "idle":
        return "Not checked yet.";
      case "checking":
        return "Checking for updates…";
      case "current":
        return `VBuddy ${this.o.current} is the latest version.`;
      case "waiting-for-sim":
        return `VBuddy ${s.version} is available. It downloads when the simulator closes.`;
      case "downloading":
        return `Downloading VBuddy ${s.version}… ${s.percent}%`;
      case "ready":
        return `VBuddy ${s.version} is ready to install.`;
      case "installing":
        return `Installing VBuddy ${s.version}. VBuddy restarts when it's done.`;
      case "error":
        return s.message;
    }
  }

  /** The simulator connected or disconnected: a download that was waiting for it starts now. */
  simChanged() {
    if (this.status.kind === "waiting-for-sim" && !this.o.simConnected()) void this.download();
  }

  async check(reason = "manual"): Promise<UpdateState> {
    if (!this.enabled || this.busy) return this.state();
    if (this.status.kind === "ready" || this.status.kind === "installing" || this.status.kind === "downloading") return this.state();
    this.busy = true;
    this.set({ kind: "checking" });
    try {
      const res = await this.fetchFn(`${this.api}/repos/${this.repo}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": `VBuddy/${this.o.current}` }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) {
        this.release = null;
        this.set({ kind: "current", checkedAt: this.now() });
        return this.state();
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = (await res.json()) as { tag_name?: string; body?: string; html_url?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name: string; browser_download_url: string; size: number }> };
      const version = (r.tag_name ?? "").replace(/^v/i, "");
      if (r.draft || r.prerelease || !isNewer(version, this.o.current)) {
        this.release = null;
        this.set({ kind: "current", checkedAt: this.now() });
        return this.state();
      }
      const assets = r.assets ?? [];
      const name = pickInstaller(assets, this.o.edition);
      const asset = assets.find((a) => a.name === name);
      if (!asset) throw new Error(`release ${version} has no ${this.o.edition === "local" ? "home network " : ""}installer`);
      const sumsAsset = assets.find((a) => /^SHA256SUMS\.txt$/i.test(a.name));
      const sums = sumsAsset ? await (await this.fetchFn(sumsAsset.browser_download_url, { signal: AbortSignal.timeout(20_000) })).text() : null;
      this.release = { version, notes: (r.body ?? "").trim().slice(0, 1500), url: r.html_url ?? `https://github.com/${this.repo}/releases`, installer: { name: asset.name, url: asset.browser_download_url, size: asset.size }, sums };
      this.o.log.info(`Update: VBuddy ${version} is available (${reason} check)`);
      this.busy = false;
      if (this.o.simConnected()) this.set({ kind: "waiting-for-sim", version });
      else await this.download();
      return this.state();
    } catch (e) {
      this.o.log.info(`Update check failed: ${(e as Error).message}`);
      this.set({ kind: "error", message: friendly((e as Error).message), checkedAt: this.now() });
      return this.state();
    } finally {
      this.busy = false;
    }
  }

  private async download() {
    const rel = this.release;
    if (!rel || !this.o.dir || this.busy) {
      if (rel && !this.o.dir) this.set({ kind: "error", message: "No folder to download the update into.", checkedAt: this.now() });
      return;
    }
    this.busy = true;
    const dir = join(this.o.dir, "updates");
    mkdirSync(dir, { recursive: true });
    const final = join(dir, rel.installer.name);
    const part = `${final}.part`;
    try {
      const want = rel.sums ? sumFor(rel.sums, rel.installer.name) : null;
      if (!want) throw new Error("checksum missing: the release has no SHA256SUMS.txt entry for its installer");
      this.set({ kind: "downloading", version: rel.version, percent: 0 });
      const res = await this.fetchFn(rel.installer.url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
      const total = Number(res.headers.get("content-length")) || rel.installer.size || 0;
      const hash = createHash("sha256");
      let got = 0;
      let shown = 0;
      const body = Readable.fromWeb(res.body as never);
      body.on("data", (c: Buffer) => {
        hash.update(c);
        got += c.length;
        const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
        if (pct >= shown + 10) {
          shown = pct;
          this.set({ kind: "downloading", version: rel.version, percent: pct });
        }
      });
      await pipeline(body, createWriteStream(part));
      if (hash.digest("hex") !== want) {
        rmSync(part, { force: true });
        throw new Error("checksum mismatch: the downloaded file failed verification");
      }
      renameSync(part, final);
      this.file = final;
      this.set({ kind: "ready", version: rel.version });
    } catch (e) {
      rmSync(part, { force: true });
      this.o.log.info(`Update download failed: ${(e as Error).message}`);
      this.set({ kind: "error", message: friendly((e as Error).message), checkedAt: this.now() });
    } finally {
      this.busy = false;
    }
  }

  /** Runs the verified installer (Windows asks for permission on the PC); VBuddy is stopped by the installer and started again after. */
  async install(): Promise<string | void> {
    if (this.status.kind !== "ready" || !this.file || !this.release) return "There's no update ready to install.";
    if (!this.o.launch) return "Installing updates works on the Windows PC only.";
    const version = this.release.version;
    try {
      await this.o.launch(this.file);
      this.set({ kind: "installing", version });
    } catch (e) {
      this.set({ kind: "ready", version });
      return /cancel/i.test((e as Error).message) ? "Install cancelled. Windows needs your permission to update VBuddy." : `Couldn't start the installer: ${(e as Error).message}`;
    }
  }

  /** Old downloaded installers (from earlier updates) are removed at start. */
  private cleanOld() {
    if (!this.o.dir) return;
    const dir = join(this.o.dir, "updates");
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (statSync(p).isFile()) rmSync(p, { force: true });
      } catch {
        /* in use: next time */
      }
    }
  }
}

function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("checksum") || m.includes("verification")) return "The downloaded update failed verification. VBuddy will try again later.";
  if (/enotfound|econnrefused|etimedout|fetch failed|network|abort|timeout/.test(m)) return "Couldn't reach the update server. VBuddy will try again later.";
  if (m.includes("has no") && m.includes("installer")) return "The newest release has no installer for this edition yet.";
  if (m.includes("http 403")) return "GitHub is limiting update checks right now. VBuddy will try again later.";
  return "The update check didn't work. VBuddy will try again later.";
}

/** Windows: start the installer elevated (it needs administrator rights), silently, detached from VBuddy (which it stops). */
export function windowsLaunch(file: string): Promise<void> {
  return import("node:child_process").then(
    ({ spawn }) =>
      new Promise<void>((resolve, reject) => {
        const args = "'/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART'";
        const ps = `try { Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList ${args} -Verb RunAs -ErrorAction Stop; exit 0 } catch { Write-Output $_.Exception.Message; exit 1 }`;
        const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("error", reject);
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(out.trim() || `exit ${code}`))));
      }),
  );
}
