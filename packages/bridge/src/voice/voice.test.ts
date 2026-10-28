import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../log.js";
import { CommsService } from "../comms/service.js";
import { MockRadios } from "../comms/mock-radios.js";
import { RATE, Segmenter, wav, type Clip } from "./vad.js";
import { cleanTranscript, type EngineStatus, type SpeechEngine } from "./whisper.js";
import { VoiceService } from "./service.js";
import type { AudioSource } from "./loopback.js";
import { parseComms, parseFlightJson, SayIntentionsLink } from "../atcapps/sayintentions.js";
import { BeyondAtcLog, parseBatcLine } from "../atcapps/beyondatc.js";

const log = logger("test");

/** Background hiss with radio calls (a 400 Hz tone) at the given seconds. */
function audio(totalS: number, calls: Array<[number, number]>): Int16Array {
  const out = new Int16Array(totalS * RATE);
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = i / RATE;
    const noise = ((seed / 0x7fffffff) * 2 - 1) * 60;
    const on = calls.some(([a, b]) => t >= a && t < b);
    out[i] = Math.round(noise + (on ? Math.sin(2 * Math.PI * 400 * t) * 9000 : 0));
  }
  return out;
}

test("transmissions are cut out of the stream at their silences", () => {
  const seg = new Segmenter();
  const clips: Clip[] = [];
  seg.onClip((c) => clips.push(c));
  const a = audio(12, [
    [1, 3.5],
    [5, 6],
    [8, 8.2], // too short to be a call
  ]);
  for (let i = 0; i < a.length; i += 1600) seg.push(a.subarray(i, i + 1600), 1000 + (i / RATE) * 1000);
  assert.equal(clips.length, 2);
  const s0 = (clips[0]!.startAt - 1000) / 1000;
  const d0 = clips[0]!.samples.length / RATE;
  assert.ok(s0 > 0.6 && s0 < 1.05, `start ${s0}`);
  assert.ok(d0 > 2.4 && d0 < 3.2, `length ${d0}`);
  assert.equal(clips[0]!.cut, false);
});

test("a stream that never goes quiet is cut at the maximum length", () => {
  const seg = new Segmenter({ maxMs: 3000 });
  const clips: Clip[] = [];
  seg.onClip((c) => clips.push(c));
  seg.push(audio(8, [[0.5, 8]]), 0);
  assert.ok(clips.length >= 2);
  assert.ok(clips.every((c) => c.cut));
});

test("WAV header and noise filtering", () => {
  const w = wav(new Int16Array(16000));
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.length, 44 + 32000);
  assert.equal(cleanTranscript(" [BLANK_AUDIO] "), null);
  assert.equal(cleanTranscript("Thank you."), null);
  assert.equal(cleanTranscript(' "Speedbird 123, climb flight level 350."  '), "Speedbird 123, climb flight level 350.");
});

class FakeAudio implements AudioSource {
  feed: ((s: Int16Array, at: number) => void) | null = null;
  started: string | null = null;
  current() {
    return this.started;
  }
  devices() {
    return Promise.resolve([{ name: "Headset", default: false }]);
  }
  start(device: string, on: (s: Int16Array, at: number) => void) {
    this.started = device || "default";
    this.feed = on;
  }
  stop() {
    this.feed = null;
    this.started = null;
  }
}
class FakeEngine implements SpeechEngine {
  st: EngineStatus = { state: "missing", message: null, progress: null };
  prompts: string[] = [];
  status() {
    return this.st;
  }
  onStatus() {}
  async prepare(_m: string, download: boolean) {
    if (!download && this.st.state === "missing") return false;
    this.st = { state: "ready", message: null, progress: null };
    return true;
  }
  async transcribe(_w: Buffer, prompt: string) {
    this.prompts.push(prompt);
    return "Speedbird one two three, contact tower one one eight decimal seven.";
  }
  stop() {}
}

test("voice to text: off until switched on and set up, then each transmission becomes a radio message that gets your attention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-voice-"));
  const a = new FakeAudio();
  const e = new FakeEngine();
  const comms = new CommsService(new MockRadios(), log);
  comms.setExtras(() => ({}), () => "BAW123");
  const v = new VoiceService(a, e, join(dir, "voice.json"), log, () => comms.myCallsign());
  assert.equal(v.status().state, "off");
  await v.configure({ enabled: true, device: "Headset" });
  assert.equal(v.status().state, "setup"); // nothing downloaded yet, and not asked to
  await v.configure({ download: true });
  assert.equal(a.started, "Headset");
  const got: string[] = [];
  v.onTranscript((t) => got.push(comms.addExternal({ source: "voice", text: t.text, from: "EGLL_TWR", clip: t.clipId }).thread));
  a.feed!(audio(6, [[1, 3]]), Date.now());
  for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1);
  assert.equal(v.status().state, "listening");
  assert.match(e.prompts[0]!, /Callsign Speedbird 123/);
  const msg = comms.history().at(-1)!;
  assert.equal(msg.source, "voice");
  assert.equal(msg.attention, true);
  assert.ok(msg.thread.startsWith("freq:"));
  assert.ok(v.clip(msg.clip!)!.length > 44);
  // Settings survive a restart.
  const again = new VoiceService(new FakeAudio(), new FakeEngine(), join(dir, "voice.json"), log);
  assert.deepEqual(again.settings(), { enabled: true, device: "Headset", model: "base.en" });
  await v.configure({ enabled: false });
  assert.equal(a.started, null);
});

test("SayIntentions: flight.json gives the key and callsign; the conversation comes in order, pilot then ATC", () => {
  assert.equal(parseFlightJson({}), null);
  assert.deepEqual(parseFlightJson({ flight_details: { api_key: "abc", callsign: "baw123", flight_id: 9 } }), { apiKey: "abc", callsign: "BAW123", flightId: "9" });
  const lines = parseComms(
    {
      comm_history: [
        { id: 2, frequency: "118.700", station_name: "Heathrow Tower", incoming_message_english: "Tower, Speedbird 123 ready", outgoing_message_english: "Speedbird 123, cleared for takeoff", stamp_zulu: "2026-10-28T10:00:00Z" },
        { id: 1, frequency: "121.900", station_name: "Heathrow Ground", outgoing_message: "Speedbird 123, taxi to holding point runway 27R via A", stamp_zulu: "2026-10-28T09:55:00Z" },
      ],
    },
    "BAW123",
  );
  assert.deepEqual(lines.map((l) => [l.id, l.dir, l.from]), [[1, "in", "Heathrow Ground"], [2, "out", "BAW123"], [2, "in", "Heathrow Tower"]]);
  assert.equal(lines[0]!.freqHz, 121_900_000);
});

test("SayIntentions link: needs a flight and a developer key, then only new lines come through", async () => {
  const calls: string[] = [];
  let history: unknown[] = [{ id: 1, station_name: "Ground", outgoing_message: "old" }];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes("43117")) return new Response(JSON.stringify({ flight_details: { api_key: "k1", callsign: "QTR7" } }));
    assert.equal(new Headers(init?.headers).get("x-developer-key"), "dev-12345678");
    return new Response(JSON.stringify({ comm_history: history }));
  }) as typeof fetch;
  let key = "";
  const link = new SayIntentionsLink(() => key, log, fake, null);
  const got: string[] = [];
  link.onLine((l) => got.push(l.text));
  link.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(link.status().state, "waiting");
  assert.equal(link.callsign(), "QTR7");
  key = "dev-12345678";
  link.changed();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(link.status().state, "live");
  assert.deepEqual(got, []); // the flight so far isn't repeated
  history = [{ id: 2, station_name: "Tower", outgoing_message_english: "Qatari 7, line up" }];
  link.changed();
  await new Promise((r) => setTimeout(r, 30));
  link.stop();
  assert.deepEqual(got, ["Qatari 7, line up"]);
  assert.ok(calls.some((u) => u.includes("since_id=1")));
});

test("BeyondATC log lines: speakers and words are found, the rest of the log is left alone", () => {
  assert.deepEqual(parseBatcLine("[12:01:02] Tower: Speedbird 123, cleared to land runway 27"), { dir: "in", from: "Tower", text: "Speedbird 123, cleared to land runway 27", freqHz: null });
  assert.deepEqual(parseBatcLine("Heathrow Ground (121.900): Speedbird 123, taxi via A"), { dir: "in", from: "Heathrow Ground", text: "Speedbird 123, taxi via A", freqHz: 121_900_000 });
  assert.equal(parseBatcLine("Pilot: ready for departure")?.dir, "out");
  assert.equal(parseBatcLine('{"speaker":"ATC","text":"Climb FL350","frequency":"132.700"}')?.freqHz, 132_700_000);
  assert.equal(parseBatcLine("UnityEngine.Debug: Loading shader"), null);
  assert.equal(parseBatcLine("Audio device: Speakers"), null);
  assert.equal(parseBatcLine(""), null);
});

test("BeyondATC log: read from the end as it grows, and from the start when BeyondATC begins a new one", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-batc-"));
  const f = join(dir, "Player.log");
  writeFileSync(f, "Tower: an old flight\n");
  const b = new BeyondAtcLog(() => true, log, f);
  const got: string[] = [];
  b.onLine((l) => got.push(l.text));
  b.tick();
  assert.deepEqual(got, []);
  appendFileSync(f, "Ground: Speedbird 123, taxi via A\nsome engine noise\n");
  b.tick();
  assert.deepEqual(got, ["Speedbird 123, taxi via A"]);
  assert.equal(b.status().state, "live");
  writeFileSync(f, "Tower: new log\n");
  b.tick();
  assert.deepEqual(got, ["Speedbird 123, taxi via A", "new log"]);
  const off = new BeyondAtcLog(() => false, log, f);
  off.tick();
  assert.equal(off.status().state, "off");
});
