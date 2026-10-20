import { useEffect, useState, useSyncExternalStore } from "react";
import { BridgeClient, defaultBridgeUrl, type BridgeSnapshot } from "./bridge-client";
import { track } from "./track";

let shared: BridgeClient | null = null;
function client() {
  if (!shared) {
    shared = new BridgeClient(defaultBridgeUrl(), "web");
    const c = shared;
    // The map's track is recorded from the start, whichever tab is open.
    c.subscribe(() => track.setSession(c.getSnapshot().sessionId));
    c.subscribe(() => track.setFlight(c.getSnapshot().sim?.flight ?? null, c.getSnapshot().sim?.inFlight ?? null));
    c.onFrames((frames) => track.addFrames(frames));
    c.start();
    // The bridge doesn't push notifications to a device that has the app on screen.
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => c.setVisible(document.visibilityState === "visible"));
  }
  return shared;
}

export function useBridgeActions() {
  const c = client();
  return {
    requestLanding: c.requestLanding,
    dismissNewLanding: c.dismissNewLanding,
    dismissAtcAlert: c.dismissAtcAlert,
    dismissFlightAlert: c.dismissFlightAlert,
    dismissFlightEvent: c.dismissFlightEvent,
    screenshot: c.screenshot,
    setTrafficArea: c.setTrafficArea,
    command: c.command,
    pair: c.pair,
    revokeDevice: c.revokeDevice,
    newPairingCode: c.newPairingCode,
    cockpitRetry: c.cockpitRetry,
    pushSubscribe: c.pushSubscribe,
    pushUnsubscribe: c.pushUnsubscribe,
    pushTest: c.pushTest,
    commsCommand: c.commsCommand,
    acarsCommand: c.acarsCommand,
    panelCommand: c.panelCommand,
    chaseCommand: c.chaseCommand,
    legCommand: c.legCommand,
    markRead: c.markRead,
    dismissAttention: c.dismissAttention,
  };
}

export function onAttention(fn: Parameters<BridgeClient["onAttention"]>[0]) {
  return client().onAttention(fn);
}

export function useBridge(): BridgeSnapshot {
  const c = client();
  return useSyncExternalStore(c.subscribe, c.getSnapshot);
}

/** Re-renders every `ms` so "x seconds ago" labels stay current. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}


/** Watch the live sim view (the bridge only captures while someone watches). */
export function watchSimView(fn: Parameters<BridgeClient["watchSimView"]>[0]) {
  return client().watchSimView(fn);
}

/** Watch one PMDG CDU (the bridge sends its screen on every change). */
export function watchCdu(side: number, fn: Parameters<BridgeClient["watchCdu"]>[1]) {
  return client().watchCdu(side, fn);
}
/** Press a key on a PMDG CDU. */
export function cduKey(side: number, key: string) {
  client().cduKey(side, key);
}
