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

/** Calls as [start, end, loudness]; `hiss` false is the ATC apps alone: nothing at all between calls. */
function calls(totalS: number, list: Array<[number, number, number]>, hiss = true): Int16Array {
  const out = new Int16Array(totalS * RATE);
  let seed = 11;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = i / RATE;
    const c = list.find(([a, b]) => t >= a && t < b);
    // Speech-like: a tone that swells and fades a few times a second, with the station's own radio noise.
    const env = c ? 0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * t) : 0;
    const noise = hiss || c ? ((seed / 0x7fffffff) * 2 - 1) * 60 : 0;
    out[i] = Math.round(noise + (c ? Math.sin(2 * Math.PI * 400 * t) * c[2] * env : 0));
  }
  return out;
}
const cutUp = (a: Int16Array) => {
  const seg = new Segmenter();
  const clips: Clip[] = [];
  seg.onClip((c) => clips.push(c));
  for (let i = 0; i < a.length; i += 1600) seg.push(a.subarray(i, i + 1600), (i / RATE) * 1000);
  return clips;
};

test("the next station straight after the push-to-talk is let go is its own transmission", () => {
  // Listening to the ATC apps: 200 ms of nothing between a pilot and the controller.
  const clips = cutUp(calls(8, [[1, 3, 9000], [3.2, 5.5, 9000]], false));
  assert.equal(clips.length, 2);
  assert.ok(clips[0]!.samples.length / RATE < 2.5, `first ${clips[0]!.samples.length / RATE}`);
});

test("a different station after a short gap is split off, the same one pausing isn't", () => {
  // A loud controller, 350 ms, then a quiet pilot: two calls even with the radio hiss in between.
  assert.equal(cutUp(calls(9, [[1, 3.5, 9000], [3.85, 6, 2200]])).length, 2);
  // One controller taking a breath for 400 ms.
  assert.equal(cutUp(calls(9, [[1, 3.5, 9000], [3.9, 6, 8000]])).length, 1);
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
  assert.deepEqual(again.settings(), { enabled: true, source: "apps", apps: ["vpilot", "xpilot", "altitude", "swift", "sayintentions", "beyondatc"], extraApps: "", device: "Headset", model: "large-v3-turbo-q5_0", micEnabled: false, micDevice: "", cpu: "balanced" });
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

test("the speech engine comes from the newest release that has the Windows build, not the empty 'latest' one", async () => {
  const { pickBinUrl } = await import("./whisper.js");
  const rel = [
    { tag_name: "v1.9.5", draft: false, published_at: "2026-10-06T17:39:17Z", assets: [] },
    { tag_name: "b5454", draft: false, prerelease: true, published_at: "2026-10-06T16:51:27Z", assets: [{ name: "whisper-bin-Win32.zip", browser_download_url: "x32" }, { name: "whisper-bin-x64.zip", browser_download_url: "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip" }] },
    { tag_name: "b5130", draft: false, published_at: "2026-09-11T05:29:10Z", assets: [{ name: "whisper-bin-x64.zip", browser_download_url: "older" }] },
  ];
  assert.equal(pickBinUrl(rel), "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip");
  assert.equal(pickBinUrl([{ draft: false, assets: [] }]), null);
  assert.equal(pickBinUrl({ message: "rate limited" }), null);
});

test("your side too: with the microphone on, what you say becomes an outgoing message", async () => {
  const a = new FakeAudio();
  const mic = new FakeAudio();
  const e = new FakeEngine();
  e.st = { state: "ready", message: null, progress: null };
  const v = new VoiceService(a, e, null, log, () => "BAW123", mic);
  await v.configure({ enabled: true, micEnabled: true, micDevice: "Headset Mic" });
  assert.equal(mic.started, "Headset Mic");
  const got: Array<"in" | "out"> = [];
  v.onTranscript((t) => got.push(t.dir));
  mic.feed!(audio(5, [[1, 2.5]]), Date.now());
  for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, ["out"]);
  const comms = new CommsService(new MockRadios(), log);
  const m = comms.addExternal({ source: "voice", dir: "out", text: "Ground, Speedbird 123 request taxi", from: "BAW123" });
  assert.equal(m.dir, "out");
  assert.equal(m.attention, false);
  await v.configure({ micEnabled: false });
  assert.equal(mic.started, null);
});

test("engine threads follow the CPU setting and leave the sim two cores", async () => {
  const { engineThreads } = await import("./whisper.js");
  assert.equal(engineThreads("light", 16), 2);
  assert.equal(engineThreads("balanced", 16), 4);
  assert.equal(engineThreads("fast", 16), 8);
  assert.equal(engineThreads("fast", 6), 4);
  assert.equal(engineThreads("balanced", 2), 1);
});

test("voice to text listens to the ATC apps only by default, or a whole device when chosen", async () => {
  const { appTokens } = await import("./loopback.js");
  assert.deepEqual(appTokens(["vpilot", "sayintentions"], "MyClient.exe, vPilot"), ["vPilot", "SayIntentions", "MyClient"]);
  const dir = mkdtempSync(join(tmpdir(), "vb-voice-apps-"));
  const dev = new FakeAudio();
  const apps = new FakeAudio();
  const e = new FakeEngine();
  e.st = { state: "ready", message: null, progress: null };
  const v = new VoiceService(dev, e, join(dir, "voice.json"), log, () => null, null, apps);
  await v.configure({ enabled: true, apps: ["vpilot", "beyondatc"] });
  assert.equal(apps.started, "vPilot,BeyondATC");
  assert.equal(dev.started, null);
  await v.configure({ source: "device", device: "Headset" });
  assert.equal(dev.started, "Headset");
  assert.equal(apps.started, null);
});

test("during the landing transcription waits, then catches up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-voice-hold-"));
  const a = new FakeAudio();
  const e = new FakeEngine();
  e.st = { state: "ready", message: null, progress: null };
  const v = new VoiceService(a, e, join(dir, "voice.json"), log, () => "BAW123");
  await v.configure({ enabled: true, device: "Headset" });
  const got: string[] = [];
  v.onTranscript((t) => got.push(t.text));
  v.hold(true);
  a.feed!(audio(6, [[1, 3]]), Date.now());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got.length, 0);
  v.hold(false);
  for (let i = 0; i < 20 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1);
  v.stop();
});
