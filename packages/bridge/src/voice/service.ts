import { ATC_VOCABULARY, spokenCallsign, type VoiceStatus } from "@vbuddy/protocol";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../log.js";
import type { AudioSource, OutputDevice } from "./loopback.js";
import { Segmenter, wav, type Clip } from "./vad.js";
import { isCpuUse, isWhisperModel, type CpuUse, type SpeechEngine, type WhisperModel } from "./whisper.js";

/** What is kept between runs (voice.json in the data folder). */
export interface VoiceSettings {
  enabled: boolean;
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
const DEFAULTS: VoiceSettings = { enabled: false, device: "", model: "large-v3-turbo-q5_0", micEnabled: false, micDevice: "", cpu: "balanced" };
/** Recordings kept for playback in the app (memory only). */
const MAX_CLIPS = 40;
/** Transmissions waiting for the engine; older ones are dropped rather than falling minutes behind. */
const MAX_QUEUE = 6;

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

  constructor(
    private audio: AudioSource,
    private engine: SpeechEngine,
    private file: string | null,
    private log: Logger,
    /** Your callsign, to help the engine spell it (and nothing else from the flight). */
    private callsign: () => string | null = () => null,
    /** Your microphone, for your side of the conversation. */
    private mic: AudioSource | null = null,
  ) {
    this.s = this.load();
    engine.onStatus(() => this.changed());
  }

  private load(): VoiceSettings {
    if (!this.file) return { ...DEFAULTS };
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as Partial<VoiceSettings>;
      return {
        enabled: j.enabled === true,
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
    const base = { device: this.audio.current() ?? (this.s.device || null), model: this.s.model, progress: e.progress };
    if (!this.s.enabled) return { state: "off", message: null, ...base, progress: null };
    if (e.state === "missing") return { state: "setup", message: e.message ?? "The speech engine needs downloading.", ...base };
    if (e.state === "downloading") return { state: "starting", message: e.message, ...base };
    if (e.state === "error") return { state: "error", message: e.message, ...base };
    if (this.problem) return { state: "error", message: this.problem, ...base };
    if (e.state === "starting" || !this.listening) return { state: "starting", message: e.message ?? "Starting…", ...base };
    const hint = this.cutsInARow >= 3 ? "Hearing sound without a break: if the sim plays on this device too, give vPilot its own output (a headset) and pick that." : null;
    const micNote = this.s.micEnabled ? (this.micProblem ? `Microphone: ${this.micProblem}` : this.micListening ? `Your side too, from ${this.mic?.current() ?? "the microphone"}.` : null) : null;
    return { state: "listening", message: [hint, micNote].filter(Boolean).join(" ") || null, ...base };
  }

  /** Change the settings from the VBuddy window. `download` allows fetching the engine and model. */
  async configure(p: Partial<VoiceSettings> & { download?: boolean }): Promise<string | void> {
    if (p.model !== undefined && !isWhisperModel(p.model)) return "Unknown speech model.";
    if (p.cpu !== undefined && !isCpuUse(p.cpu)) return "Unknown CPU setting.";
    const next: VoiceSettings = {
      enabled: p.enabled ?? this.s.enabled,
      device: typeof p.device === "string" ? p.device.slice(0, 120) : this.s.device,
      model: p.model ?? this.s.model,
      micEnabled: p.micEnabled ?? this.s.micEnabled,
      micDevice: typeof p.micDevice === "string" ? p.micDevice.slice(0, 120) : this.s.micDevice,
      cpu: p.cpu ?? this.s.cpu,
    };
    const restart = next.cpu !== this.s.cpu || next.device !== this.s.device || next.model !== this.s.model || next.enabled !== this.s.enabled || next.micEnabled !== this.s.micEnabled || next.micDevice !== this.s.micDevice;
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
    const ok = await this.engine.prepare(this.s.model, download, this.s.cpu);
    if (!ok || !this.s.enabled) return this.changed();
    this.seg = new Segmenter();
    this.seg.onClip((c) => this.enqueue(c, "in"));
    this.startMic();
    this.audio.start(
      this.s.device,
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
