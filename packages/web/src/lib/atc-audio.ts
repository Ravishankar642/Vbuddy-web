import { useSyncExternalStore } from "react";
import type { ChatMessage } from "@vbuddy/protocol";
import { apiFetch } from "./api";
import { audio } from "./chime";

/**
 * Hearing ATC on this device without pressing play: each new recording from VBuddy's voice to text plays as it
 * arrives, one after another. "mine" plays only the calls that use your callsign. Kept on this device.
 */
export type AutoPlay = "off" | "all" | "mine";
const KEY = "vbuddy.atc.autoplay";
/** More than this waiting and the oldest are skipped, so you hear what's current. */
const MAX_WAITING = 3;

const read = (): AutoPlay => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "all" || v === "mine" ? v : "off";
  } catch {
    return "off";
  }
};
let mode: AutoPlay = read();
let note: string | null = null;
let playingId: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

/** On the bridge PC itself the sound would play into the device being listened to, and be heard twice. */
export const onBridgePc = () => typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

export function setAutoPlay(next: AutoPlay) {
  mode = next;
  try {
    if (next === "off") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* this visit only */
  }
  if (next !== "off") void audio()?.resume().catch(() => undefined);
  else {
    queue.length = 0;
    current?.stop();
  }
  note = null;
  emit();
}

let snapshot: { mode: AutoPlay; note: string | null; playingId: string | null } = { mode, note, playingId };
export function useAutoPlay() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => {
      if (snapshot.mode !== mode || snapshot.note !== note || snapshot.playingId !== playingId) snapshot = { mode, note, playingId };
      return snapshot;
    },
  );
}

const seen = new Set<string>();
let primed = false;
const queue: ChatMessage[] = [];
let current: AudioBufferSourceNode | null = null;
let busy = false;

/** Give it the chat as it changes; it picks out new recordings to play. The first call only notes what's there. */
export function feedAutoPlay(chat: ChatMessage[]) {
  const fresh = chat.filter((m) => m.clip && !seen.has(m.id));
  for (const m of fresh) seen.add(m.id);
  if (!primed) {
    primed = true;
    return;
  }
  if (mode === "off" || onBridgePc()) return;
  for (const m of fresh) {
    if (m.dir !== "in" || m.source !== "voice") continue;
    if (mode === "mine" && !m.attention) continue;
    queue.push(m);
  }
  if (queue.length > MAX_WAITING) queue.splice(0, queue.length - MAX_WAITING);
  void next();
}

async function next() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length && mode !== "off") {
      const m = queue.shift()!;
      const a = audio();
      if (!a) return setNote("This browser can't play sound.");
      if (a.state === "suspended") await a.resume().catch(() => undefined);
      if (a.state !== "running") return setNote("Tap anywhere on the page once so the browser allows sound.");
      try {
        const r = await apiFetch(`/api/voice/clip/${encodeURIComponent(m.clip!)}`);
        if (!r.ok) continue;
        const buf = await a.decodeAudioData(await r.arrayBuffer());
        playingId = m.id;
        setNote(null);
        await new Promise<void>((done) => {
          const src = a.createBufferSource();
          src.buffer = buf;
          src.connect(a.destination);
          src.onended = () => done();
          current = src;
          src.start();
        });
      } catch {
        /* a recording that's gone: the next one */
      } finally {
        current = null;
        playingId = null;
        emit();
      }
    }
  } finally {
    busy = false;
  }
}
function setNote(n: string | null) {
  if (note === n) return;
  note = n;
  emit();
}
