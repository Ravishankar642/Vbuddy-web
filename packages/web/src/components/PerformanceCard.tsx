import { useState } from "react";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { useBridgeActions } from "../lib/useBridge";
import { Toggle } from "./NotifyCard";

/** Changes a bridge setting from this device, with the switch moving at once and an error if it didn't take. */
export function useBridgeSetting() {
  const { bridgeSetting } = useBridgeActions();
  const [busy, setBusy] = useState<"voice" | "lite" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = async (what: "voice" | "lite", on: boolean) => {
    setBusy(what);
    setErr(null);
    const r = await bridgeSetting(what, on);
    setBusy(null);
    if (!r.ok) setErr(r.error);
  };
  return { busy, err, set };
}

/** The ATC voice to text switch: turns the bridge's transcription (and its speech engine) on or off. */
export function VoiceSwitch({ b, hint }: { b: BridgeSnapshot; hint?: string }) {
  const v = b.comms?.voice;
  const { busy, err, set } = useBridgeSetting();
  const allowed = !!b.control?.allowed;
  if (!v) return null;
  const on = v.state !== "off";
  return (
    <>
      <Toggle
        label="ATC voice to text"
        hint={hint ?? (allowed ? (on ? "Turns what ATC says into text on the PC. Off frees the PC's speech engine completely." : "Off: nothing is listened to or transcribed on the PC.") : "Pair this device to change it.")}
        on={on}
        disabled={!allowed || busy === "voice"}
        onChange={(x) => void set("voice", x)}
      />
      {err && <p className="muted">{err}</p>}
    </>
  );
}

/** Settings → Performance: Lite mode, voice to text, and what the bridge is doing to stay light right now. */
export function PerformanceCard({ b }: { b: BridgeSnapshot }) {
  const p = b.perf;
  const { busy, err, set } = useBridgeSetting();
  const allowed = !!b.control?.allowed;
  if (!p) return null;
  const now = p.landing ? "Landing: the bridge asks the sim for as little as possible and holds transcription until you've slowed down." : p.lite ? "Lite mode is on." : "Running normally.";
  return (
    <section className="card">
      <h2 className="card__title">Performance on the PC</h2>
      <Toggle
        label="Lite mode"
        hint="The least work for the PC while everything still works: fewer samples from the sim, the app updated twice a second, lighter gauge reads, and the speech engine on 2 cores."
        on={p.lite}
        disabled={!allowed || busy === "lite"}
        onChange={(x) => void set("lite", x)}
      />
      <VoiceSwitch b={b} />
      {err && <p className="muted">{err}</p>}
      <p className="muted">
        {now} When no app is on screen and the VBuddy window is closed or in the tray, only the essentials run: recording the flight, landings, alerts and
        notifications.
      </p>
      {!allowed && <p className="muted">Pair this device to change these.</p>}
    </section>
  );
}
