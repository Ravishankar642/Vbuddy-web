import type { CockpitCommand, ControlInfo, FcuState } from "@vbuddy/protocol";
import type { Logger } from "../log.js";
import type { CockpitBackend } from "./backend.js";
import { CockpitDriver, type CmdOutcome, type DriverOptions } from "./driver.js";

const STATE_MIN_MS = 100; // at most 10 state updates a second to clients

/** What the server needs from the cockpit side. */
export interface CockpitHub {
  state(): FcuState | null;
  link(): Pick<ControlInfo, "path" | "working" | "detail">;
  run(cmd: CockpitCommand): Promise<CmdOutcome>;
  retry(): void;
  /** State or link status changed (throttled). */
  onChange(cb: () => void): void;
}

export class CockpitService implements CockpitHub {
  private driver: CockpitDriver;
  private cbs: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private lastSent = 0;
  private lastJson = "";

  constructor(backend: CockpitBackend, log: Logger, opts?: DriverOptions) {
    this.driver = new CockpitDriver(backend, log, opts);
    backend.onValues(() => this.poke());
    this.driver.onChange(() => this.poke());
  }

  private poke() {
    if (this.timer) return;
    const wait = Math.max(0, STATE_MIN_MS - (Date.now() - this.lastSent));
    this.timer = setTimeout(() => {
      this.timer = null;
      const json = JSON.stringify([this.state(), this.link()]);
      if (json === this.lastJson) return;
      this.lastJson = json;
      this.lastSent = Date.now();
      for (const cb of this.cbs) cb();
    }, wait);
  }

  state() {
    return this.driver.state();
  }
  link() {
    return this.driver.link();
  }
  run(cmd: CockpitCommand) {
    return this.driver.run(cmd);
  }
  retry() {
    this.driver.reset();
  }
  onChange(cb: () => void) {
    this.cbs.push(cb);
  }
}
