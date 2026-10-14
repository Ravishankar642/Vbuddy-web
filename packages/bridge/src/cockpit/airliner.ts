import type { CockpitCommand, ControlInfo, FcuState } from "@vbuddy/protocol";
import type { CmdOutcome } from "./driver.js";
import type { CockpitHub } from "./service.js";

/** What the iniBuilds FCU screen needs from the panel (SimPanel). */
export interface AirlinerFcu {
  airlinerFcu(): FcuState | null;
  airlinerCommand(cmd: CockpitCommand): Promise<CmdOutcome>;
  onChange(cb: () => void): void;
}

/**
 * The FCU screen in the app (the one the Fenix uses) for whichever aircraft has one: the Fenix through its own hub,
 * the iniBuilds A340 / A350 / A380 through their input events.
 */
export class CombinedCockpit implements CockpitHub {
  private cbs: Array<() => void> = [];
  private last = "";

  constructor(
    private fenix: CockpitHub,
    private airliner: AirlinerFcu,
  ) {
    fenix.onChange(() => this.fire(true));
    airliner.onChange(() => this.fire(false));
  }

  private fire(force: boolean) {
    const json = JSON.stringify(this.airliner.airlinerFcu());
    if (!force && json === this.last) return;
    this.last = json;
    for (const cb of this.cbs) cb();
  }

  state(): FcuState | null {
    return this.fenix.state() ?? this.airliner.airlinerFcu();
  }
  link(): Pick<ControlInfo, "path" | "working" | "detail"> {
    if (!this.fenix.state() && this.airliner.airlinerFcu()) return { path: "simconnect", working: null };
    return this.fenix.link();
  }
  run(cmd: CockpitCommand): Promise<CmdOutcome> {
    if (!this.fenix.state() && this.airliner.airlinerFcu()) return this.airliner.airlinerCommand(cmd);
    return this.fenix.run(cmd);
  }
  retry() {
    this.fenix.retry();
  }
  onChange(cb: () => void) {
    this.cbs.push(cb);
  }
}
