import type { CommsState } from "@vbuddy/protocol";

export type RadioValues = Pick<CommsState, "radios" | "xpdr">;

/** The radios and transponder in the simulator (or a pretend one). */
export interface RadioBackend {
  /** Latest values, or null when no simulator is connected. */
  values(): RadioValues | null;
  onValues(cb: () => void): void;
  setCom(radio: 1 | 2, which: "active" | "standby", hz: number): boolean;
  swapCom(radio: 1 | 2): boolean;
  /** Receive (listen) on or off for one radio. */
  setListen(radio: 1 | 2, on: boolean): boolean;
  setXpdrCode(code: string): boolean;
  setXpdrMode(mode: "stby" | "alt"): boolean;
  /** Sim-side ident; used only when the vPilot plugin isn't there to do it. */
  ident(): boolean;
}
