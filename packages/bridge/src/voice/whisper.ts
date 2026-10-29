import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { unzipSync } from "fflate";
import type { Logger } from "../log.js";

/*
 * Speech to text on this PC with whisper.cpp (MIT licence): VBuddy downloads the Windows build and an English model
 * the first time it is switched on, runs whisper-server on 127.0.0.1 only, and sends it each radio transmission as a
 * WAV. Nothing leaves the PC. VBUDDY_WHISPER_URL points VBuddy at a whisper-server that is already running instead
 * (another machine with a GPU, say).
 */

/**
 * The speech models, lightest first (names as whisper.cpp publishes them). The "-q5"/"-q8" ones are quantized: about a
 * third of the size and noticeably faster for nearly the same accuracy. large-v3-turbo is OpenAI's distilled
 * large-v3 (4 decoder layers instead of 32): close to the best accuracy at a fraction of the work, which is what
 * fast, clipped, accented VATSIM radio needs.
 */
export const WHISPER_MODELS = {
  "tiny.en-q5_1": { file: "ggml-tiny.en-q5_1.bin", mb: 31, note: "fastest, least accurate" },
  "tiny.en": { file: "ggml-tiny.en.bin", mb: 75, note: "fast, least accurate" },
  "base.en-q5_1": { file: "ggml-base.en-q5_1.bin", mb: 57, note: "light, for slower PCs" },
  "base.en": { file: "ggml-base.en.bin", mb: 142, note: "light" },
  "small.en-q5_1": { file: "ggml-small.en-q5_1.bin", mb: 181, note: "good, easy on most PCs" },
  "small.en": { file: "ggml-small.en.bin", mb: 466, note: "good" },
  "medium.en-q5_0": { file: "ggml-medium.en-q5_0.bin", mb: 514, note: "accurate, slower" },
  "large-v3-turbo-q5_0": { file: "ggml-large-v3-turbo-q5_0.bin", mb: 547, note: "recommended: near-best accuracy, still light" },
  "large-v3-turbo-q8_0": { file: "ggml-large-v3-turbo-q8_0.bin", mb: 834, note: "a little more accurate than q5, a little slower" },
  "large-v3-turbo": { file: "ggml-large-v3-turbo.bin", mb: 1624, note: "full size turbo, heavy" },
  "large-v3-q5_0": { file: "ggml-large-v3-q5_0.bin", mb: 1080, note: "the most accurate, slowest: a strong CPU only" },
} as const;
export const RECOMMENDED_MODEL: WhisperModel = "large-v3-turbo-q5_0";
export type WhisperModel = keyof typeof WHISPER_MODELS;
export const isWhisperModel = (m: unknown): m is WhisperModel => typeof m === "string" && m in WHISPER_MODELS;

/**
 * How much of the CPU the speech engine may use while the sim runs. light: 2 threads, below normal priority (the sim
 * always comes first); balanced: up to 4 threads, below normal; fast: up to 8 threads, normal priority.
 */
export type CpuUse = "light" | "balanced" | "fast";
export const isCpuUse = (c: unknown): c is CpuUse => c === "light" || c === "balanced" || c === "fast";
export function engineThreads(cpu: CpuUse, cores: number): number {
  const max = cpu === "light" ? 2 : cpu === "balanced" ? 4 : 8;
  return Math.max(1, Math.min(max, cores - 2));
}

/**
 * whisper.cpp's "latest" release (v1.9.5, say) often carries no files: the Windows builds are on the build-numbered
 * pre-releases next to it (b5454...). So the newest release that has the CPU build is looked up; if GitHub can't be
 * asked, a known good build is used.
 */
const RELEASES_API = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20";
const BIN_ASSET = "whisper-bin-x64.zip";
export const BIN_FALLBACK_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";

/** The download address of the newest whisper.cpp Windows CPU build, from GitHub's release list. */
export function pickBinUrl(releases: unknown): string | null {
  if (!Array.isArray(releases)) return null;
  const list = (releases as Array<{ draft?: boolean; published_at?: string; assets?: Array<{ name?: string; browser_download_url?: string }> }>)
    .filter((r) => !r.draft && Array.isArray(r.assets))
    .sort((a, b) => Date.parse(b.published_at ?? "") - Date.parse(a.published_at ?? ""));
  for (const r of list) {
    const a = r.assets!.find((x) => x.name === BIN_ASSET && typeof x.browser_download_url === "string");
    if (a) return a.browser_download_url!;
  }
  return null;
}
const MODEL_URL = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
const PORT = Number(process.env.VBUDDY_WHISPER_PORT) || 8911;

/** The encoder window (50 per second of audio) for a clip this long: a second of margin, at least 768, at most 1500. */
export function audioCtx(seconds: number): number {
  const want = Math.ceil(((Math.max(0, seconds) + 1) * 50) / 64) * 64;
  return Math.min(1500, Math.max(768, want));
}

export interface EngineStatus {
  state: "missing" | "downloading" | "starting" | "ready" | "error";
  message: string | null;
  progress: number | null;
}

/** Turns speech into text. */
export interface SpeechEngine {
  status(): EngineStatus;
  onStatus(cb: () => void): void;
  /** Gets the engine ready (downloading what's missing, when allowed). */
  prepare(model: WhisperModel, download: boolean, cpu?: CpuUse): Promise<boolean>;
  transcribe(wav: Buffer, prompt: string): Promise<string | null>;
  stop(): void;
}

/** Things speech recognition writes for noise and silence. */
const NOISE = /^(\s*[[(].*[\])]\s*|\s*(thank you|thanks for watching|thank you for watching|you|bye|okay|so|uh|um|hmm)[.!]?\s*)$/i;
/** Cleans up a transcript, or null when it's only noise. */
export function cleanTranscript(text: string): string | null {
  const t = text.replace(/\s+/g, " ").replace(/^[\s"'-]+|[\s"']+$/g, "").trim();
  if (!t || NOISE.test(t) || !/[a-z0-9]/i.test(t)) return null;
  return t;
}

const isGgml = (file: string) => {
  try {
    const fd = openSync(file, "r");
    const b = Buffer.alloc(4);
    readSync(fd, b, 0, 4, 0);
    closeSync(fd);
    // "ggml" / "ggjt" magic, little endian.
    return b.readUInt32LE(0) === 0x67676d6c || b.readUInt32LE(0) === 0x67676a74 || b.toString("latin1") === "lmgg";
  } catch {
    return false;
  }
};

export class WhisperEngine implements SpeechEngine {
  private st: EngineStatus = { state: "missing", message: null, progress: null };
  private cbs: Array<() => void> = [];
  private proc: ChildProcess | null = null;
  private running: WhisperModel | null = null;
  private busy: Promise<boolean> | null = null;
  private external = process.env.VBUDDY_WHISPER_URL?.replace(/\/+$/, "") || null;

  constructor(
    private dir: string,
    private log: Logger,
    private fetchFn: typeof fetch = (u, i) => fetch(u, i),
  ) {}

  status() {
    return this.st;
  }
  onStatus(cb: () => void) {
    this.cbs.push(cb);
  }
  private set(p: Partial<EngineStatus>) {
    this.st = { ...this.st, ...p };
    for (const cb of this.cbs) cb();
  }

  private get binDir() {
    return join(this.dir, "bin");
  }
  /** whisper-server.exe in the extracted build (older builds called it server.exe). */
  private serverExe(): string | null {
    if (!existsSync(this.binDir)) return null;
    const walk = (d: string, depth: number): string | null => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (/^(whisper-server|server)(\.exe)?$/i.test(f) && statSync(p).isFile()) return p;
        if (depth < 3 && statSync(p).isDirectory()) {
          const hit = walk(p, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(this.binDir, 0);
  }
  private modelFile(m: WhisperModel) {
    return join(this.dir, "models", WHISPER_MODELS[m].file);
  }
  /** Is everything for this model already on the PC? */
  installed(m: WhisperModel) {
    return !!this.external || (!!this.serverExe() && existsSync(this.modelFile(m)) && isGgml(this.modelFile(m)));
  }

  private async download(url: string, to: string, label: string, weight: [number, number]): Promise<void> {
    const r = await this.fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`${label}: download failed (HTTP ${r.status})`);
    const total = Number(r.headers.get("content-length")) || 0;
    let got = 0;
    let last = 0;
    const tmp = `${to}.part`;
    mkdirSync(join(to, ".."), { recursive: true });
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, ctl) => {
        got += chunk.length;
        const now = Date.now();
        if (total && now - last > 500) {
          last = now;
          this.set({ progress: weight[0] + (weight[1] - weight[0]) * Math.min(1, got / total), message: `Downloading ${label}… ${Math.round(got / 1_048_576)} of ${Math.round(total / 1_048_576)} MB` });
        }
        ctl.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(r.body.pipeThrough(counter) as import("node:stream/web").ReadableStream), createWriteStream(tmp));
    renameSync(tmp, to);
  }

  private cpu: CpuUse = "balanced";
  private runningCpu: CpuUse | null = null;
  prepare(model: WhisperModel, download: boolean, cpu: CpuUse = "balanced"): Promise<boolean> {
    if (this.busy) return this.busy;
    this.cpu = cpu;
    this.busy = this.doPrepare(model, download).finally(() => (this.busy = null));
    return this.busy;
  }

  private async doPrepare(model: WhisperModel, download: boolean): Promise<boolean> {
    if (this.external) {
      this.set({ state: "ready", message: `Using the speech engine at ${this.external}.`, progress: null });
      return true;
    }
    if (this.proc && this.running === model && this.runningCpu === this.cpu && this.st.state === "ready") return true;
    try {
      if (!this.serverExe()) {
        if (!download) {
          this.set({ state: "missing", message: "The speech engine (whisper.cpp, about 5 MB) isn't downloaded yet.", progress: null });
          return false;
        }
        if (process.platform !== "win32") throw new Error("The built-in speech engine is for Windows; set VBUDDY_WHISPER_URL to a whisper-server instead.");
        this.set({ state: "downloading", message: "Downloading the speech engine…", progress: 0 });
        const zip = join(this.dir, "whisper-bin-x64.zip");
        let url = BIN_FALLBACK_URL;
        try {
          const r = await this.fetchFn(RELEASES_API, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) });
          if (r.ok) url = pickBinUrl(await r.json()) ?? url;
        } catch {
          /* GitHub's API unreachable: the known build */
        }
        this.log.info(`ATC voice: downloading the speech engine from ${url}`);
        try {
          await this.download(url, zip, "the speech engine", [0, 0.08]);
        } catch (e) {
          if (url === BIN_FALLBACK_URL) throw e;
          await this.download(BIN_FALLBACK_URL, zip, "the speech engine", [0, 0.08]);
        }
        const files = unzipSync(new Uint8Array(await import("node:fs/promises").then((f) => f.readFile(zip))));
        rmSync(this.binDir, { recursive: true, force: true });
        for (const [name, data] of Object.entries(files)) {
          if (name.endsWith("/") || name.includes("..")) continue;
          const out = join(this.binDir, name);
          mkdirSync(join(out, ".."), { recursive: true });
          writeFileSync(out, data);
        }
        rmSync(zip, { force: true });
        if (!this.serverExe()) throw new Error("the download didn't contain whisper-server.exe");
      }
      const mf = this.modelFile(model);
      if (!existsSync(mf) || !isGgml(mf)) {
        if (!download) {
          this.set({ state: "missing", message: `The ${model} speech model (${WHISPER_MODELS[model].mb} MB) isn't downloaded yet.`, progress: null });
          return false;
        }
        this.set({ state: "downloading", message: `Downloading the ${model} model…`, progress: 0.08 });
        await this.download(MODEL_URL(WHISPER_MODELS[model].file), mf, `the ${model} model`, [0.08, 1]);
        if (!isGgml(mf)) {
          rmSync(mf, { force: true });
          throw new Error("the model file isn't a whisper model");
        }
      }
      return await this.startServer(model);
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`ATC voice: ${msg}`);
      this.set({ state: "error", message: `Speech engine: ${msg}`, progress: null });
      return false;
    }
  }

  private async startServer(model: WhisperModel): Promise<boolean> {
    this.stop();
    const exe = this.serverExe()!;
    this.set({ state: "starting", message: "Starting the speech engine…", progress: null });
    const cpu = this.cpu;
    const threads = String(engineThreads(cpu, (await import("node:os")).cpus().length));
    const p = spawn(exe, ["-m", this.modelFile(model), "--host", "127.0.0.1", "--port", String(PORT), "-l", "en", "-nt", "-t", threads], { windowsHide: true, cwd: join(exe, "..") });
    this.proc = p;
    this.running = model;
    this.runningCpu = cpu;
    // Below normal priority, so a busy engine never costs the sim frames (light and balanced).
    if (cpu !== "fast" && p.pid) {
      try {
        (await import("node:os")).setPriority(p.pid, (await import("node:os")).constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* not allowed: normal priority */
      }
    }
    let err = "";
    p.stderr?.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-600)));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.running = null;
      this.set({ state: "error", message: `The speech engine stopped (code ${code}).${/VCRUNTIME|MSVCP|0xc0000135/i.test(err) ? " Install the Microsoft Visual C++ Redistributable (x64)." : ""}`, progress: null });
    });
    p.on("error", (e) => this.set({ state: "error", message: `The speech engine couldn't start: ${e.message}`, progress: null }));
    // Ready once it answers HTTP (a big model can take a while to load from disk).
    const waitS = WHISPER_MODELS[model].mb > 700 ? 120 : 45;
    for (let i = 0; i < waitS * 2; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (this.proc !== p) return false;
      try {
        await this.fetchFn(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) });
        this.set({ state: "ready", message: null, progress: null });
        this.log.info(`ATC voice: speech engine ready (whisper.cpp, ${model}, ${threads} threads, ${cpu} CPU use)`);
        return true;
      } catch {
        /* not up yet */
      }
    }
    this.set({ state: "error", message: `The speech engine didn't start in ${waitS} s. Try a smaller model.`, progress: null });
    this.stop();
    return false;
  }

  async transcribe(wav: Buffer, prompt: string): Promise<string | null> {
    if (this.st.state !== "ready") return null;
    const base = this.external ?? `http://127.0.0.1:${PORT}`;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "atc.wav");
    form.append("temperature", "0.0");
    // At most two more tries at a higher temperature when the first is unusable (whisper's default is five).
    form.append("temperature_inc", "0.4");
    // whisper pads every clip to 30 s; a radio call is a few seconds. Look at a window that fits it (never under
    // about 15 s, which keeps the accuracy): the encoder, most of the work, gets two to three times quicker.
    form.append("audio_ctx", String(audioCtx((wav.length - 44) / 32_000)));
    form.append("response_format", "json");
    if (prompt) form.append("prompt", prompt);
    try {
      const r = await this.fetchFn(`${base}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { text?: string };
      return typeof j.text === "string" ? cleanTranscript(j.text) : null;
    } catch {
      return null;
    }
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    this.running = null;
    this.runningCpu = null;
    if (p) p.kill();
  }
}
