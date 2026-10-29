import { ATC_VOCABULARY, spokenCallsign, type VoiceStatus } from "@vbuddy/protocol";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../log.js";
import { appTokens, ATC_APPS, isAtcAppKey, type AtcAppKey, type AudioSource, type OutputDevice } from "./loopback.js";
import { Segmenter, wav, type Clip } from "./vad.js";
import { isCpuUse, isWhisperModel, type CpuUse, type SpeechEngine, type WhisperModel } from "./whisper.js";

/** What is kept between runs (voice.json in the data folder). */
export interface VoiceSettings {
  enabled: boolean;
  /** apps: only the ATC apps' own sound (vPilot, SayIntentions...), nothing else; device: everything on one output. */
  source: "apps" | "device";
  /** The ATC apps listened to, with source "apps". */
  apps: AtcAppKey[];
  /** More program names to listen to, comma separated ("MyClient"). */
  extraApps: string;
  /** Part of the output device's name ("Headset"); "" = the default output device. */
  device: string;
  model: WhisperModel;
  /** Also turn what you say into text, from your microphone (your side of the conversation). */
  micEnabled: boolean;
  /** Part of the microphone's name; "" = the default microphone. */
  micDevice: string;
  /** How much CPU the speech engine may take while the sim runs. */
  cpu: CpuUse;
}
const ALL_APPS: AtcAppKey[] = ATC_APPS.map((a) => a.key);
const DEFAULTS: VoiceSettings = { enabled: false, source: "apps", apps: ALL_APPS, extraApps: "", device: "", model: "large-v3-turbo-q5_0", micEnabled: false, micDevice: "", cpu: "balanced" };
/** Recordings kept for playback in the app (memory only). */
const MAX_CLIPS = 40;
/** Transmissions waiting for the engine; older ones are dropped rather than falling minutes behind. */
const MAX_QUEUE = 10;
/** No ATC app for this long (and nothing heard): the speech engine is unloaded until one starts. */
const IDLE_MS = 2 * 60_000;

export interface Transcript {
  /** in: heard from ATC (the output device); out: said by you (the microphone). */
  dir: "in" | "out";
  text: string;
  clipId: string;
  at: number;
  /** Cut at the maximum length: the device may be carrying the sim's own sound too. */
  cut: boolean;
}

/**
 * VBuddy's live ATC voice to text: listens to one output device (where vPilot, BeyondATC or SayIntentions play ATC),
 * cuts it into transmissions, turns each into text with the speech engine on this PC, and hands the text on to Comms.
 */
export class VoiceService {
  private s: VoiceSettings;
  private seg: Segmenter | null = null;
  private micSeg: Segmenter | null = null;
  private queue: Array<Clip & { dir: "in" | "out" }> = [];
  private micProblem: string | null = null;
  private micListening = false;
  private working = false;
  private clips = new Map<string, Buffer>();
  private seq = 0;
  private cbs: Array<() => void> = [];
  private outCbs: Array<(t: Transcript) => void> = [];
  private problem: string | null = null;
  private listening = false;
  private cutsInARow = 0;
  /** The speech engine is unloaded (no ATC app running for a while) until there is something to hear. */
  private sleeping = false;
  private waking: Promise<boolean> | null = null;
  private lastHeard = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Transcription waits (landing: nothing heavy while the sim is busiest). */
  private held = false;
  private heldSince = 0;
  private releaseHold: (() => void) | null = null;
  /** Lite mode: the speech engine on 2 cores whatever the setting. */
  private liteCpu = false;

  constructor(
    private audio: AudioSource,
    private engine: SpeechEngine,
    private file: string | null,
    private log: Logger,
    /** Your callsign, to help the engine spell it (and nothing else from the flight). */
    private callsign: () => string | null = () => null,
    /** Your microphone, for your side of the conversation. */
    private mic: AudioSource | null = null,
    /** Only some apps' sound (Windows 10 2004 and later). */
    private appAudio: AudioSource | null = null,
  ) {
    this.s = this.load();
    engine.onStatus(() => this.changed());
    for (const a of [audio, appAudio])
      (a as { onDevice?: (cb: () => void) => void } | null)?.onDevice?.(() => {
        // An ATC app started: load the speech engine again so its first call isn't slow.
        if (this.sleeping && this.source().current()) void this.wake();
        this.changed();
      });
  }

  private cpu(): CpuUse {
    return this.liteCpu ? "light" : this.s.cpu;
  }

  /**
   * Holds transcription back (the landing): calls are kept and turned into text once released, or after 90 s at most.
   * The audio is still listened to, which costs next to nothing.
   */
  hold(on: boolean) {
    if (on === this.held) return;
    this.held = on;
    this.heldSince = Date.now();
    if (!on) {
      this.releaseHold?.();
      this.releaseHold = null;
    }
  }
  private waitHold(): Promise<void> {
    if (!this.held) return Promise.resolve();
    const left = Math.max(0, 90_000 - (Date.now() - this.heldSince));
    return new Promise((done) => {
      const t = setTimeout(() => {
        this.releaseHold = null;
        done();
      }, left);
      t.unref?.();
      this.releaseHold = () => {
        clearTimeout(t);
        done();
      };
    });
  }

  /** Lite mode on or off: the engine restarts on its new core count when it's running. */
  setLite(on: boolean) {
    if (on === this.liteCpu) return;
    this.liteCpu = on;
    if (this.s.enabled && !this.sleeping) void this.engine.prepare(this.s.model, false, this.cpu()).then(() => this.changed());
  }

  /** Unloads the engine when listening to the ATC apps and none has run for IDLE_MS (frees its memory). */
  private checkIdle() {
    if (this.sleeping || !this.s.enabled || this.s.source !== "apps" || !this.appAudio) return;
    if (this.source().current() || this.queue.length || this.working) return;
    if (Date.now() - this.lastHeard < IDLE_MS) return;
    this.sleeping = true;
    this.engine.stop();
    this.log.info("ATC voice: speech engine unloaded until an ATC app starts");
    this.changed();
  }
  private wake(): Promise<boolean> {
    if (!this.sleeping) return Promise.resolve(true);
    if (this.waking) return this.waking;
    this.waking = this.engine.prepare(this.s.model, false, this.cpu()).then((ok) => {
      this.waking = null;
      if (ok) {
        this.sleeping = false;
        this.lastHeard = Date.now();
        this.log.info("ATC voice: speech engine loaded again");
      }
      this.changed();
      return ok;
    });
    return this.waking;
  }

  /** What is listened to now: the ATC apps, or a whole output device. */
  private source(): AudioSource {
    return this.s.source === "apps" && this.appAudio ? this.appAudio : this.audio;
  }
  private target(): string {
    return this.s.source === "apps" && this.appAudio ? appTokens(this.s.apps, this.s.extraApps).join(",") : this.s.device;
  }

  private load(): VoiceSettings {
    if (!this.file) return { ...DEFAULTS };
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as Partial<VoiceSettings>;
      return {
        enabled: j.enabled === true,
        source: j.source === "device" ? "device" : "apps",
        apps: Array.isArray(j.apps) ? j.apps.filter(isAtcAppKey) : ALL_APPS,
        extraApps: typeof j.extraApps === "string" ? j.extraApps.slice(0, 200) : "",
        device: typeof j.device === "string" ? j.device.slice(0, 120) : "",
        model: isWhisperModel(j.model) ? j.model : DEFAULTS.model,
        micEnabled: j.micEnabled === true,
        micDevice: typeof j.micDevice === "string" ? j.micDevice.slice(0, 120) : "",
        cpu: isCpuUse(j.cpu) ? j.cpu : DEFAULTS.cpu,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }
  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.s));
    } catch (e) {
      this.log.warn(`Couldn't save the voice settings: ${(e as Error).message}`);
    }
  }

  settings(): VoiceSettings {
    return { ...this.s };
  }
  devices(): Promise<OutputDevice[]> {
    return this.audio.devices();
  }
  micDevices(): Promise<OutputDevice[]> {
    return this.mic ? this.mic.devices() : Promise.resolve([]);
  }
  onChange(cb: () => void) {
    this.cbs.push(cb);
  }
  onTranscript(cb: (t: Transcript) => void) {
    this.outCbs.push(cb);
  }
  private changed() {
    for (const cb of this.cbs) cb();
  }

  status(): VoiceStatus {
    const e = this.engine.status();
    const apps = this.s.source === "apps" && !!this.appAudio;
    const cur = this.source().current();
    const base = { device: apps ? cur || "ATC apps" : (cur ?? (this.s.device || null)), model: this.s.model, progress: e.progress };
    if (!this.s.enabled) return { state: "off", message: null, ...base, progress: null };
    if (e.state === "missing") return { state: "setup", message: e.message ?? "The speech engine needs downloading.", ...base };
    if (e.state === "downloading") return { state: "starting", message: e.message, ...base };
    if (e.state === "error") return { state: "error", message: e.message, ...base };
    if (this.problem) return { state: "error", message: this.problem, ...base };
    if (e.state === "starting" || !this.listening) return { state: "starting", message: e.message ?? "Starting…", ...base };
    const hint = apps
      ? this.appsNote(cur)
      : this.cutsInARow >= 3
        ? "Hearing sound without a break: the sim plays on this device too. Set Listen to: ATC apps only."
        : null;
    const micNote = this.s.micEnabled ? (this.micProblem ? `Microphone: ${this.micProblem}` : this.micListening ? `Your side too, from ${this.mic?.current() ?? "the microphone"}.` : null) : null;
    return { state: "listening", message: [hint, micNote].filter(Boolean).join(" ") || null, ...base };
  }

  private appsNote(cur: string | null): string | null {
    const probs = (this.appAudio as { problems?: Map<string, string> } | null)?.problems;
    const bad = probs && probs.size ? `Couldn't listen to ${[...probs.keys()].join(", ")} on its own: that needs Windows 10 version 2004 or later. Pick Listen to: a whole output device instead.` : null;
    if (cur) return bad;
    const names = ATC_APPS.filter((a) => this.s.apps.includes(a.key)).map((a) => a.name);
    const extra = this.s.extraApps.trim();
    const all = [...names, ...(extra ? [extra] : [])];
    return bad ?? (all.length ? `Waiting for ${all.join(", ")} to start. Only their sound is turned into text.` : "No ATC apps chosen to listen to.");
  }

  /** Change the settings from the VBuddy window. `download` allows fetching the engine and model. */
  async configure(p: Partial<VoiceSettings> & { download?: boolean }): Promise<string | void> {
    if (p.model !== undefined && !isWhisperModel(p.model)) return "Unknown speech model.";
    if (p.cpu !== undefined && !isCpuUse(p.cpu)) return "Unknown CPU setting.";
    const next: VoiceSettings = {
      enabled: p.enabled ?? this.s.enabled,
      source: p.source === "device" || p.source === "apps" ? p.source : this.s.source,
      apps: Array.isArray(p.apps) ? p.apps.filter(isAtcAppKey) : this.s.apps,
      extraApps: typeof p.extraApps === "string" ? p.extraApps.slice(0, 200) : this.s.extraApps,
      device: typeof p.device === "string" ? p.device.slice(0, 120) : this.s.device,
      model: p.model ?? this.s.model,
      micEnabled: p.micEnabled ?? this.s.micEnabled,
      micDevice: typeof p.micDevice === "string" ? p.micDevice.slice(0, 120) : this.s.micDevice,
      cpu: p.cpu ?? this.s.cpu,
    };
    const restart = next.source !== this.s.source || next.apps.join() !== this.s.apps.join() || next.extraApps !== this.s.extraApps || next.cpu !== this.s.cpu || next.device !== this.s.device || next.model !== this.s.model || next.enabled !== this.s.enabled || next.micEnabled !== this.s.micEnabled || next.micDevice !== this.s.micDevice;
    this.s = next;
    this.save();
    if (!next.enabled) {
      this.stop();
      this.changed();
      return;
    }
    if (restart || p.download) await this.start(p.download === true);
    this.changed();
  }

  /** Starts listening if switched on (at bridge start too; downloads only when asked from the window). */
  async start(download = false) {
    if (!this.s.enabled) return;
    this.stopAudio();
    this.problem = null;
    this.changed();
    this.sleeping = false;
    this.lastHeard = Date.now();
    const ok = await this.engine.prepare(this.s.model, download, this.cpu());
    if (!ok || !this.s.enabled) return this.changed();
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => this.checkIdle(), 30_000);
      this.idleTimer.unref?.();
    }
    this.seg = new Segmenter();
    this.seg.onClip((c) => this.enqueue(c, "in"));
    this.startMic();
    const src = this.source();
    if (src !== this.audio) this.audio.stop();
    if (src !== this.appAudio) this.appAudio?.stop();
    src.start(
      this.target(),
      (samples, at) => {
        if (!this.listening) {
          this.listening = true;
          this.changed();
        }
        this.seg?.push(samples, at);
      },
      (why) => {
        this.listening = false;
        if (why !== "stopped" && this.s.enabled) {
          this.problem = why;
          this.log.warn(`ATC voice: ${why}`);
          // Try again in a while (a headset unplugged and plugged back in).
          setTimeout(() => {
            if (this.s.enabled && this.problem === why) void this.start(false);
          }, 15_000).unref();
        }
        this.changed();
      },
    );
  }

  /** Your side: the microphone, cut into what you say the same way. */
  private startMic() {
    this.mic?.stop();
    this.micSeg = null;
    this.micListening = false;
    this.micProblem = null;
    if (!this.mic || !this.s.micEnabled) return;
    this.micSeg = new Segmenter();
    this.micSeg.onClip((c) => this.enqueue(c, "out"));
    this.mic.start(
      this.s.micDevice,
      (samples, at) => {
        if (!this.micListening) {
          this.micListening = true;
          this.changed();
        }
        this.micSeg?.push(samples, at);
      },
      (why) => {
        this.micListening = false;
        if (why !== "stopped") this.micProblem = why;
        this.changed();
      },
    );
  }

  private stopAudio() {
    this.audio.stop();
    this.appAudio?.stop();
    this.mic?.stop();
    this.micSeg = null;
    this.micListening = false;
    this.seg = null;
    this.listening = false;
    this.queue = [];
  }
  stop() {
    this.stopAudio();
    this.engine.stop();
    this.sleeping = false;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private enqueue(c: Clip, dir: "in" | "out") {
    if (dir === "in") {
      this.cutsInARow = c.cut ? this.cutsInARow + 1 : 0;
      if (this.cutsInARow === 3) this.changed();
    }
    this.queue.push({ ...c, dir });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    void this.work();
  }

  /** The prompt that helps the engine: aviation words, and how your callsign is said. */
  prompt(): string {
    const cs = this.callsign();
    const sp = cs ? spokenCallsign(cs) : null;
    return `${ATC_VOCABULARY}${sp ? ` Callsign ${[...sp.words.map((w) => w.charAt(0) + w.slice(1).toLowerCase()), sp.suffix].join(" ")}.` : ""}`;
  }

  private async work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        await this.waitHold();
        this.lastHeard = Date.now();
        if (this.sleeping && !(await this.wake())) {
          this.queue = [];
          break;
        }
        const c = this.queue.shift()!;
        const audio = wav(c.samples);
        const text = await this.engine.transcribe(audio, this.prompt());
        if (!text) continue;
        const clipId = `v${++this.seq}`;
        this.clips.set(clipId, audio);
        if (this.clips.size > MAX_CLIPS) this.clips.delete(this.clips.keys().next().value!);
        for (const cb of this.outCbs) cb({ dir: c.dir, text, clipId, at: c.startAt, cut: c.cut });
      }
    } finally {
      this.working = false;
    }
  }

  /** A recording, for /api/voice/clip/<id>. */
  clip(id: string): Buffer | null {
    return this.clips.get(id) ?? null;
  }
}

/** The test flight's ears: a pretend controller every so often, without any audio. */
export class MockVoiceFeed {
  private timer: NodeJS.Timeout | null = null;
  private i = 0;
  constructor(private emit: (t: Transcript) => void, private callsign: () => string) {}
  private lines = () => {
    const cs = this.callsign();
    const sp = spokenCallsign(cs);
    const said = sp ? `${sp.words.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ")} ${sp.suffix.split("").join(" ")}` : cs;
    return [
      `${said}, taxi to holding point runway two seven right via Bravo, Charlie two, Alpha, November three, hold short runway two seven left.`,
      `Emirates five two one, climb flight level three five zero.`,
      `${said}, contact Mumbai Control one three two decimal seven, good day.`,
      `Indigo six one two, descend flight level two four zero.`,
    ];
  };
  start(everyMs = 35_000) {
    this.stop();
    this.timer = setInterval(() => {
      const l = this.lines();
      this.emit({ dir: "in", text: l[this.i++ % l.length]!, clipId: "", at: Date.now(), cut: false });
    }, everyMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
