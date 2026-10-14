import { useNow } from "../lib/useBridge";
import type { BridgeSnapshot } from "../lib/bridge-client";

const two = (n: number) => String(n).padStart(2, "0");

/** Zulu (UTC) time from this device's clock, HH:MM:SSz. */
export function zulu(ms: number, seconds = true): string {
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${seconds ? ":" + two(d.getUTCSeconds()) : ""}z`;
}

export function ZuluClock() {
  const now = useNow(1000);
  return (
    <time className="zulu" dateTime={new Date(now).toISOString()} title="UTC (Zulu), from this device's clock">
      {zulu(now)}
    </time>
  );
}

/** Whether you are on VATSIM, from vPilot through the VBuddy Link plugin. */
export function VatsimPill({ b }: { b: BridgeSnapshot }) {
  const net = b.comms?.net;
  let tone = "idle";
  let text = "VATSIM –";
  let title = "Waiting for the bridge";
  if (net) {
    if (!net.pluginLinked) {
      text = "vPilot not linked";
      title = "The VBuddy Link plugin in vPilot isn't connected to the bridge.";
    } else if (net.connected) {
      tone = "ok";
      text = `VATSIM ${net.callsign ?? ""}${net.observer ? " (obs)" : ""}`.trim();
      title = "Connected to VATSIM";
    } else {
      tone = "partial";
      text = "VATSIM off";
      title = "vPilot is linked but not connected to VATSIM";
    }
  }
  return (
    <div className={`pill pill--${tone}`} title={title}>
      <i />
      {text}
    </div>
  );
}
