import type { FenixValues, FenixVar } from "./fenix-vars.js";

export type ControlPath = "mobiflight" | "simconnect" | "mock" | "none";

/** Something that holds the aircraft's cockpit values and can change them. */
export interface CockpitBackend {
  readonly aircraft: "fenix-a320" | "mock";
  /** Latest values, or null when no supported aircraft is loaded. */
  values(): FenixValues | null;
  onValues(cb: () => void): void;
  /** Adds delta to a counter variable. False if nothing could be sent. */
  add(v: FenixVar, delta: number): boolean;
  /** Sets a variable to an absolute value. */
  set(v: FenixVar, value: number): boolean;
  path(): ControlPath;
  /** Moves to the next way of sending commands; false when there is none left. */
  nextPath(): boolean;
  /** Back to the first way (after the pilot asks to retry, or the sim reconnects). */
  resetPath(): void;
  paused(): boolean;
}
