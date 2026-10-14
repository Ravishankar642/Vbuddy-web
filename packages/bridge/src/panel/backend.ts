import type { ApButton, ApKnob, LightId, PanelState, SysId } from "@vbuddy/protocol";

export type PanelResult = { ok: true } | { ok: false; error: string };

/** Lights and autopilot of the loaded aircraft: from the simulator (or a pretend one). */
export interface PanelBackend {
  /** Latest values, or null when there is no simulator. */
  state(): PanelState | null;
  onChange(cb: () => void): void;
  setLight(id: LightId, on: boolean): Promise<PanelResult>;
  press(ctl: ApButton): Promise<PanelResult>;
  /** Dial a window to an absolute value (knots or Mach for spd). */
  set(ctl: ApKnob, value: number): Promise<PanelResult>;
  /** Airbus FCU knob push (managed) / pull (selected). */
  fcu?(ctl: "spd" | "hdg" | "alt" | "vs", action: "push" | "pull"): Promise<PanelResult>;
  /** Aircraft systems and simulator controls (flaps, gear, pause, ...). */
  sys(id: SysId, value?: number): Promise<PanelResult>;
}
