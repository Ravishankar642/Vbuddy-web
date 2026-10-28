/*
 * Cutting radio transmissions out of a continuous audio stream (16 kHz, mono, 16-bit): a transmission starts when the
 * level rises well above the background. It ends when the radio goes dead (the push-to-talk released: listening to
 * the ATC apps alone, nothing at all plays between calls), after a short silence, or where, after a brief gap, a
 * different station starts talking (each transmitter comes in at its own level). Pure, so it is tested with made-up
 * audio.
 */

export const RATE = 16_000;
const FRAME = 320; // 20 ms

export interface Clip {
  samples: Int16Array;
  /** Wall-clock time of the first and last sample (ms). */
  startAt: number;
  endAt: number;
  /** Cut at the maximum length rather than ending in silence: a stream that never goes quiet. */
  cut: boolean;
}

export interface VadOptions {
  /** dB above the background noise that counts as speech. */
  onDb?: number;
  /** dB above the background below which speech has ended. */
  offDb?: number;
  /** Quietest level (dBFS) that can count as speech at all. */
  minDbfs?: number;
  /** Silence that ends a transmission. */
  hangMs?: number;
  /** Shortest transmission kept. */
  minMs?: number;
  /** Longest; a longer one is cut here. */
  maxMs?: number;
  /** Audio kept from before the start (the first syllable is often quieter). */
  preRollMs?: number;
  /** Below this (dBFS) the radio is dead: nothing is playing at all. */
  deadDbfs?: number;
  /** Dead air that ends a transmission straight away (the push-to-talk let go). */
  deadMs?: number;
  /** A gap at least this long may be the next station answering... */
  splitGapMs?: number;
  /** ...when the speech after it is this much louder or quieter than before it. */
  splitDb?: number;
  /** Speech after the gap listened to before deciding. */
  probeMs?: number;
}

const dbfs = (frame: Int16Array) => {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  const rms = Math.sqrt(sum / Math.max(1, frame.length)) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -120;
};

export class Segmenter {
  private o: Required<VadOptions>;
  private pending = new Int16Array(0);
  /** The background level, following quiet stretches. */
  private floor = -60;
  private speaking = false;
  private loud = 0;
  private quiet = 0;
  private pre: Int16Array[] = [];
  private cur: Int16Array[] = [];
  private curStart = 0;
  private curLen = 0;
  private lastLoudLen = 0;
  /** Frames of pre-roll at the start of the current transmission. */
  private preLen = 0;
  private clock = 0;
  /** Each frame's level in the current transmission. */
  private levels: number[] = [];
  private dead = 0;
  /** A gap that may separate two stations: where the speech before it ended, and where it started again. */
  private gap: { end: number; resume: number } | null = null;
  private cbs: Array<(c: Clip) => void> = [];

  constructor(o: VadOptions = {}) {
    this.o = { onDb: 12, offDb: 7, minDbfs: -48, hangMs: 650, minMs: 500, maxMs: 28_000, preRollMs: 250, deadDbfs: -75, deadMs: 120, splitGapMs: 250, splitDb: 6, probeMs: 300, ...o };
  }

  onClip(cb: (c: Clip) => void) {
    this.cbs.push(cb);
  }

  /** The current background level (dBFS), for the status line. */
  background() {
    return this.floor;
  }

  /** Feed audio; `at` is the wall-clock time of the first sample. */
  push(samples: Int16Array, at: number) {
    if (!this.pending.length) this.clock = at;
    const all = new Int16Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) {
      this.frame(all.subarray(i, i + FRAME).slice(), this.clock);
      this.clock += (FRAME / RATE) * 1000;
    }
    this.pending = all.slice(i);
  }

  private frame(f: Int16Array, at: number) {
    const level = dbfs(f);
    const frameMs = (FRAME / RATE) * 1000;
    const on = level > Math.max(this.o.minDbfs, this.floor + this.o.onDb);
    const stillOn = level > Math.max(this.o.minDbfs - 6, this.floor + this.o.offDb);
    if (!this.speaking) {
      // The background follows quiet frames: quickly down, slowly up.
      if (!on) this.floor = level < this.floor ? this.floor * 0.7 + level * 0.3 : this.floor + Math.min(0.15, (level - this.floor) * 0.02);
      this.pre.push(f);
      const keep = Math.ceil(this.o.preRollMs / frameMs) + 3;
      if (this.pre.length > keep) this.pre.shift();
      this.loud = on ? this.loud + 1 : 0;
      if (this.loud >= 3) {
        this.speaking = true;
        this.cur = [...this.pre];
        this.levels = this.cur.map(dbfs);
        this.curLen = this.cur.length;
        // The three frames that started it are speech; the rest of the pre-roll isn't.
        this.preLen = Math.max(0, this.cur.length - 3);
        this.curStart = at - (this.cur.length - 1) * frameMs;
        this.lastLoudLen = this.curLen;
        this.pre = [];
        this.quiet = 0;
        this.dead = 0;
        this.gap = null;
      }
      return;
    }
    this.cur.push(f);
    this.levels.push(level);
    this.curLen++;
    if (stillOn) {
      // Speech again after a gap long enough to be another station: listen a little, then compare.
      if (this.quiet * frameMs >= this.o.splitGapMs && !this.gap) this.gap = { end: this.lastLoudLen, resume: this.curLen - 1 };
      this.quiet = 0;
      this.lastLoudLen = this.curLen;
    } else this.quiet++;
    this.dead = level < this.o.deadDbfs ? this.dead + 1 : 0;
    const lenMs = this.curLen * frameMs;
    if (this.dead * frameMs >= this.o.deadMs) return this.finish(at, false);
    if (this.quiet * frameMs >= this.o.hangMs) return this.finish(at, false);
    if (lenMs >= this.o.maxMs) return this.finish(at, true);
    if (this.gap && (this.curLen - this.gap.resume) * frameMs >= this.o.probeMs) {
      const g = this.gap;
      this.gap = null;
      const before = this.speechLevel(this.preLen, g.end);
      const after = this.speechLevel(g.resume, this.curLen);
      if (before !== null && after !== null && Math.abs(before - after) >= this.o.splitDb) this.split(g.end, g.resume);
    }
  }

  /** The typical level of the speech between two frames (the median of its loud frames), if there is enough of it. */
  private speechLevel(from: number, to: number): number | null {
    const gate = Math.max(this.o.minDbfs, this.floor + this.o.onDb);
    const l = this.levels.slice(from, to).filter((x) => x > gate).sort((a, b) => a - b);
    return l.length >= 5 ? l[Math.floor(l.length / 2)]! : null;
  }

  /** Two stations in one: what came before the gap goes out as its own transmission, the rest carries on. */
  private split(end: number, resume: number) {
    const frameMs = (FRAME / RATE) * 1000;
    const tail = Math.ceil(150 / frameMs);
    const first = this.cur.slice(0, Math.min(resume, end + tail));
    if ((end - this.preLen) * frameMs >= this.o.minMs) this.emit(first, this.curStart, false);
    const start = Math.max(end, resume - Math.ceil(this.o.preRollMs / frameMs));
    this.cur = this.cur.slice(start);
    this.levels = this.levels.slice(start);
    this.curStart += start * frameMs;
    this.curLen = this.cur.length;
    this.preLen = resume - start;
    this.lastLoudLen = this.curLen;
  }

  private emit(frames: Int16Array[], startAt: number, cut: boolean) {
    const frameMs = (FRAME / RATE) * 1000;
    const samples = new Int16Array(frames.length * FRAME);
    frames.forEach((fr, i) => samples.set(fr, i * FRAME));
    const clip: Clip = { samples, startAt, endAt: startAt + frames.length * frameMs, cut };
    for (const cb of this.cbs) cb(clip);
  }

  private finish(at: number, cut: boolean) {
    const frameMs = (FRAME / RATE) * 1000;
    // Trim the trailing silence, keeping a little.
    const keep = cut ? this.curLen : Math.min(this.curLen, this.lastLoudLen + Math.ceil(150 / frameMs));
    const frames = this.cur.slice(0, keep);
    const loud = this.lastLoudLen - this.preLen;
    this.speaking = false;
    this.cur = [];
    this.levels = [];
    this.loud = 0;
    this.quiet = 0;
    this.dead = 0;
    this.gap = null;
    // Judged on the loud part only, not the pre-roll and the silence after.
    if (loud * frameMs >= this.o.minMs) this.emit(frames, this.curStart, cut);
    void at;
  }
}

/** A WAV file (PCM 16-bit mono) for the speech engine and for playback. */
export function wav(samples: Int16Array, rate = RATE): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
