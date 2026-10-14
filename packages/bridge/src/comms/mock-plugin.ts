import type { BridgeToPlugin } from "@vbuddy/protocol";
import type { CommsService, PluginLink } from "./service.js";

/**
 * Stands in for vPilot with the mock flight: "connects" to the network, answers commands and now and then
 * receives an ATC call, UNICOM chatter and a direct message, so the Comms tab can be tried without MSFS or vPilot.
 */
export class MockPlugin implements PluginLink {
  private timers: NodeJS.Timeout[] = [];
  private callsign = "BAW123";
  private n = 0;

  constructor(private svc: CommsService) {}

  start() {
    this.svc.attachPlugin(this, "mock");
    this.net(true);
    const script = () => {
      const i = this.n++;
      const cs = this.callsign;
      if (i % 3 === 0) this.svc.fromPlugin({ t: "chat", kind: "radio", from: "EGLL_APP", freqs: [118_500], text: `${cs}, descend altitude 4000 feet QNH 1013.` });
      else if (i % 3 === 1) this.svc.fromPlugin({ t: "chat", kind: "radio", from: "EGKK123", freqs: [122_800], text: "Anyone on frequency? Inbound Biggin, 2000 feet." });
      else this.svc.fromPlugin({ t: "chat", kind: "private", from: "EGLL_TWR", freqs: [], text: "Please call me on 118.500 when you are established." });
    };
    this.timers.push(setInterval(script, 25_000));
    this.timers.push(setTimeout(script, 4000));
  }
  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.svc.detachPlugin(this);
  }

  private net(connected: boolean) {
    this.svc.fromPlugin({ t: "net", connected, callsign: connected ? this.callsign : null, type: "A320", selcal: "AB-CD".replace("-", ""), observer: false });
  }

  send(msg: BridgeToPlugin) {
    setTimeout(() => {
      if (msg.op === "connect") {
        this.callsign = msg.callsign;
        this.net(true);
      } else if (msg.op === "disconnect") this.net(false);
      this.svc.fromPlugin({ t: "result", id: msg.id, ok: true });
    }, 120);
  }
  close() {}
}
