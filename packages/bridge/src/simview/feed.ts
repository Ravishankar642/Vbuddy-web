import type { SimViewState } from "@vbuddy/protocol";
import type { Logger } from "../log.js";
import type { FrameSource } from "./capture.js";

/** About 3 frames a second, as Cobalt's sim view. */
export const FRAME_INTERVAL_MS = 333;
/** Release the capture helper this long after the last viewer leaves. */
export const IDLE_RELEASE_MS = 3000;

export interface Frame {
  seq: number;
  jpeg: string;
  w: number;
  h: number;
}

/**
 * The live sim view, the way Cobalt's camera feed works: one capture loop for every viewer, running only while
 * someone watches; a frame is skipped while the previous capture is still busy. Who gets the frames (and dropping
 * them for a viewer whose connection is backed up) is the server's job.
 */
export class SimViewFeed {
  private timer: NodeJS.Timeout | null = null;
  private idle: NodeJS.Timeout | null = null;
  private busy = false;
  private seq = 0;
  private viewers = 0;
  private state: SimViewState = "starting";
  private message = "";

  constructor(
    private source: FrameSource,
    private onFrame: (f: Frame) => void,
    private onStatus: (state: SimViewState, message: string) => void,
    private log: Logger,
    private interval = FRAME_INTERVAL_MS,
  ) {}

  status(): { state: SimViewState; message: string } {
    return { state: this.state, message: this.message };
  }

  setViewers(n: number) {
    const was = this.viewers;
    this.viewers = Math.max(0, n);
    if (this.viewers > 0) {
      if (this.idle) {
        clearTimeout(this.idle);
        this.idle = null;
      }
      if (!this.timer) {
        if (was === 0) this.setState("starting", "");
        this.log.info("Sim view started");
        this.timer = setInterval(() => void this.tick(), this.interval);
        void this.tick();
      }
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info("Sim view stopped");
      this.idle = setTimeout(() => {
        this.idle = null;
        this.source.release();
      }, IDLE_RELEASE_MS);
      this.idle.unref?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.idle) clearTimeout(this.idle);
    this.timer = this.idle = null;
    this.source.release();
  }

  private setState(state: SimViewState, message: string) {
    if (state === this.state && message === this.message) return;
    this.state = state;
    this.message = message;
    this.onStatus(state, message);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await this.source.grab();
      if (this.viewers === 0) return;
      if (r.ok) {
        this.setState("live", "");
        this.seq += 1;
        this.onFrame({ seq: this.seq, jpeg: r.jpeg, w: r.w, h: r.h });
      } else this.setState(r.reason, r.message);
    } catch (e) {
      this.log.debug(`Sim view capture failed: ${(e as Error).message}`);
      this.setState("unavailable", "Couldn't capture the sim window.");
    } finally {
      this.busy = false;
    }
  }
}
