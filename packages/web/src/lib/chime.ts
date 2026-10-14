/** A short two-note chime made with the Web Audio API (no sound file to load). */
const KEY = "vbuddy.chime";

let ctx: AudioContext | null = null;
let unlockBound = false;

export function chimeEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}
export function setChimeEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* not remembered */
  }
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  return ctx;
}

/** Browsers only allow sound after the person has touched the page once; do that quietly on the first tap. */
export function unlockAudioOnFirstTouch() {
  if (unlockBound) return;
  unlockBound = true;
  const go = () => {
    void audio()?.resume();
    window.removeEventListener("pointerdown", go);
    window.removeEventListener("keydown", go);
  };
  window.addEventListener("pointerdown", go);
  window.addEventListener("keydown", go);
}

/** Plays the chime. Returns false if the browser wouldn't (no sound allowed yet). */
export async function playChime(force = false): Promise<boolean> {
  if (!force && !chimeEnabled()) return false;
  const a = audio();
  if (!a) return false;
  try {
    if (a.state === "suspended") await a.resume();
  } catch {
    return false;
  }
  if (a.state !== "running") return false;
  const t0 = a.currentTime + 0.02;
  for (const [i, f] of [880, 1318.5].entries()) {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = "sine";
    o.frequency.value = f;
    const t = t0 + i * 0.16;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + 0.6);
  }
  return true;
}
