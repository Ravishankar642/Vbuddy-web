import type { SimStatus, Telemetry } from "@vbuddy/protocol";

/**
 * Slow-changing or event-style values the landing analyzer needs that aren't
 * part of the main telemetry. Each field is null until the sim has delivered it
 * (or forever, if the sim rejected that variable), so consumers must cope with
 * nulls and fall back to estimating from the per-frame telemetry.
 */
export interface SimExtras {
  /**
   * The sim's own latch of the normal (vertical) velocity at the last touchdown, ft/s.
   * It keeps the previous landing's value until the next touchdown, so only trust
   * it when it has changed since before the landing. Sign is not relied on.
   */
  touchdownNormalVelFps: number | null;
  /** Ambient wind speed, knots. */
  windKt: number | null;
  /** Direction the wind blows FROM, degrees true. */
  windFromDeg: number | null;
  /** Fuel on board, pounds (all tanks). */
  fuelLbs: number | null;
  /** How many engines the aircraft has. */
  engineCount: number | null;
  /** 1 = engine n is burning fuel, 0 = it is not. Null = the sim doesn't report it. */
  eng1: number | null;
  eng2: number | null;
  eng3: number | null;
  eng4: number | null;
  /** 1 while the stall warning is sounding. */
  stallWarning: number | null;
  /** 1 while the overspeed warning is sounding. */
  overspeedWarning: number | null;
  /**
   * The sim's CAMERA STATE: 2-10 are the flying views (cockpit, outside, drone…); 11-18 and 20-23 are the menu, world
   * map, hangar, loading and replay. Null when unknown.
   */
  cameraState?: number | null;
  /** From the sim's "Sim" event: 1 = a flight is running, 0 = the sim is in its menus. Null until the first event. */
  simRunning?: number | null;
}

export const EMPTY_EXTRAS: SimExtras = {
  touchdownNormalVelFps: null,
  windKt: null,
  windFromDeg: null,
  fuelLbs: null,
  engineCount: null,
  eng1: null,
  eng2: null,
  eng3: null,
  eng4: null,
  stallWarning: null,
  overspeedWarning: null,
  cameraState: null,
  simRunning: null,
};

/**
 * Anything that can produce aircraft telemetry: the real sim via SimConnect,
 * or the built-in mock flight. Sources push raw samples as fast as they get
 * them (every sim frame); the hub decides how often to forward them to clients,
 * and the landing analyzer consumes every one.
 */
export interface SimSource {
  start(): void;
  stop(): Promise<void>;
  onSample(cb: (t: Telemetry, at: number) => void): void;
  onExtras(cb: (e: SimExtras, at: number) => void): void;
  onStatus(cb: (s: SimStatus) => void): void;
  status(): SimStatus;
}

export const normDeg = (d: number) => ((d % 360) + 360) % 360;
