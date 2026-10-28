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

export const WHISPER_MODELS = {
  "tiny.en": { file: "ggml-tiny.en.bin", mb: 75, note: "fastest, least accurate" },
  "base.en": { file: "ggml-base.en.bin", mb: 142, note: "a good balance (recommended)" },
  "small.en": { file: "ggml-small.en.bin", mb: 466, note: "most accurate, needs a fast CPU" },
} as const;
export type WhisperModel = keyof typeof WHISPER_MODELS;
export const isWhisperModel = (m: unknown): m is WhisperModel => typeof m === "string" && m in WHISPER_MODELS;

const BIN_URL = "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip";
const MODEL_URL = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
const PORT = Number(process.env.VBUDDY_WHISPER_PORT) || 8911;

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
  prepare(model: WhisperModel, download: boolean): Promise<boolean>;
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

  prepare(model: WhisperModel, download: boolean): Promise<boolean> {
    if (this.busy) return this.busy;
    this.busy = this.doPrepare(model, download).finally(() => (this.busy = null));
    return this.busy;
  }

  private async doPrepare(model: WhisperModel, download: boolean): Promise<boolean> {
    if (this.external) {
      this.set({ state: "ready", message: `Using the speech engine at ${this.external}.`, progress: null });
      return true;
    }
    if (this.proc && this.running === model && this.st.state === "ready") return true;
    try {
      if (!this.serverExe()) {
        if (!download) {
          this.set({ state: "missing", message: "The speech engine (whisper.cpp, about 5 MB) isn't downloaded yet.", progress: null });
          return false;
        }
        if (process.platform !== "win32") throw new Error("The built-in speech engine is for Windows; set VBUDDY_WHISPER_URL to a whisper-server instead.");
        this.set({ state: "downloading", message: "Downloading the speech engine…", progress: 0 });
        const zip = join(this.dir, "whisper-bin-x64.zip");
        await this.download(BIN_URL, zip, "the speech engine", [0, 0.08]);
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
    const threads = String(Math.max(2, Math.min(8, (await import("node:os")).cpus().length - 2)));
    const p = spawn(exe, ["-m", this.modelFile(model), "--host", "127.0.0.1", "--port", String(PORT), "-l", "en", "-nt", "-t", threads], { windowsHide: true, cwd: join(exe, "..") });
    this.proc = p;
    this.running = model;
    let err = "";
    p.stderr?.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-600)));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.running = null;
      this.set({ state: "error", message: `The speech engine stopped (code ${code}).${/VCRUNTIME|MSVCP|0xc0000135/i.test(err) ? " Install the Microsoft Visual C++ Redistributable (x64)." : ""}`, progress: null });
    });
    p.on("error", (e) => this.set({ state: "error", message: `The speech engine couldn't start: ${e.message}`, progress: null }));
    // Ready once it answers HTTP.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (this.proc !== p) return false;
      try {
        await this.fetchFn(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) });
        this.set({ state: "ready", message: null, progress: null });
        this.log.info(`ATC voice: speech engine ready (whisper.cpp, ${model}, ${threads} threads)`);
        return true;
      } catch {
        /* not up yet */
      }
    }
    this.set({ state: "error", message: "The speech engine didn't start in 30 s.", progress: null });
    this.stop();
    return false;
  }

  async transcribe(wav: Buffer, prompt: string): Promise<string | null> {
    if (this.st.state !== "ready") return null;
    const base = this.external ?? `http://127.0.0.1:${PORT}`;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "atc.wav");
    form.append("temperature", "0.0");
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
    if (p) p.kill();
  }
}
