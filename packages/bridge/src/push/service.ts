import { formatMhz, PushPrefsSchema, type AtcAlert, type AcarsMessage, type AtcPosition, type ChatMessage, type FlightAlert, type FlightEvent, type LandingSummary, type PushInfoMsg, type PushPrefs } from "@vbuddy/protocol";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import webpush from "web-push";
import type { Logger } from "../log.js";

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
interface Saved {
  deviceId: string;
  subscription: PushSubscriptionJson;
  prefs: PushPrefs;
}
export interface PushPayload {
  title: string;
  body: string;
  /** Same tag replaces an earlier notification instead of stacking. */
  tag: string;
  kind: "atc" | "landing" | "chat" | "vatsim" | "alert" | "event" | "test";
  url: string;
}
export type PushSender = (sub: PushSubscriptionJson, payload: string, opts: { TTL: number; urgency: "normal" | "high" }) => Promise<{ statusCode: number }>;

export const DEFAULT_PREFS: PushPrefs = {
  atc: true,
  landing: true,
  chat: true,
  vatsim: true,
  alerts: true,
  apOff: false,
  todMin: 10,
  fuelMin: 30,
  atcAheadNm: 40,
  atcPerHour: 0,
  takeoff: true,
  toc: true,
  tenK: false,
  approachMin: 0,
  gate: true,
  simLost: true,
  planLoaded: true,
  paused: true,
};

/** Which choice switches each flight event on. */
const EVENT_PREF: Record<FlightEvent["kind"], (p: PushPrefs) => boolean> = {
  takeoff: (p) => p.takeoff,
  toc: (p) => p.toc,
  tenK: (p) => p.tenK,
  tod: () => false, // sent per device by notifyTod, at each device's own lead time
  approach: () => false, // likewise notifyApproach
  gate: (p) => p.gate,
  simLost: (p) => p.simLost,
  planLoaded: (p) => p.planLoaded,
  paused: (p) => p.paused,
  flightStart: () => false,
};

/** Saved choices from an older version lack the newer fields; fill them in, and keep numbers in range. */
export function withDefaults(p: Partial<PushPrefs> | undefined): PushPrefs {
  const r = PushPrefsSchema.safeParse({ ...DEFAULT_PREFS, ...(p ?? {}) });
  return r.success ? r.data : { ...DEFAULT_PREFS };
}

const HOUR = 3_600_000;
const REANNOUNCE_MS = 10 * 60_000;
/** Per-device memory for things that must not repeat. */
interface DeviceState {
  atcSent: number[]; // times of capped ATC notifications, last hour
  aheadKey: string | null;
  aheadAt: number;
  fuelArmed: boolean;
  todArmed: boolean;
  approachArmed: boolean;
}

/**
 * Web Push from the bridge itself: the browser's push service (Google, Apple, Mozilla) is reachable from the
 * PC, so no extra server is needed. Subscriptions belong to paired devices; revoking a device removes its subscription.
 */
export class PushService {
  private subs: Saved[] = [];
  private state = new Map<string, DeviceState>();
  readonly publicKey: string;
  private privateKey: string;
  private sender: PushSender;
  /** True while the device has VBuddy open on its screen: it sees everything there, so nothing is pushed to it. */
  private watching: (deviceId: string) => boolean = () => false;

  constructor(
    private file: string | null,
    vapidFile: string | null,
    private contact: string,
    private log: Logger,
    sender?: PushSender,
  ) {
    const keys = this.loadKeys(vapidFile);
    this.publicKey = keys.publicKey;
    this.privateKey = keys.privateKey;
    this.sender =
      sender ??
      ((sub, payload, o) =>
        webpush.sendNotification(sub, payload, { TTL: o.TTL, urgency: o.urgency, vapidDetails: { subject: this.contact, publicKey: this.publicKey, privateKey: this.privateKey } }).then((r) => ({ statusCode: r.statusCode })));
    this.load();
  }

  private loadKeys(file: string | null): { publicKey: string; privateKey: string } {
    if (file) {
      try {
        const j = JSON.parse(readFileSync(file, "utf8")) as { publicKey?: string; privateKey?: string };
        if (j.publicKey && j.privateKey) return { publicKey: j.publicKey, privateKey: j.privateKey };
      } catch {
        /* make new ones below */
      }
    }
    const k = webpush.generateVAPIDKeys();
    if (file) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
      } catch (e) {
        this.log.warn(`Couldn't save the push keys (${(e as Error).message}); devices will need to turn notifications on again after a restart.`);
      }
    }
    return k;
  }

  private load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as { subs?: Saved[] };
      this.subs = (j.subs ?? []).filter((s) => s?.deviceId && s.subscription?.endpoint && s.subscription.keys).map((s) => ({ ...s, prefs: withDefaults(s.prefs) }));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn(`Couldn't read saved notification subscriptions (${(e as Error).message}).`);
    }
  }
  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + ".tmp", JSON.stringify({ subs: this.subs }, null, 2), { mode: 0o600 });
      renameSync(this.file + ".tmp", this.file);
    } catch (e) {
      this.log.warn(`Couldn't save notification subscriptions: ${(e as Error).message}`);
    }
  }

  info(deviceId: string | null): Omit<PushInfoMsg, "t" | "v" | "ts"> {
    const s = deviceId ? this.subs.find((x) => x.deviceId === deviceId) : undefined;
    return { enabled: true, publicKey: this.publicKey, subscribed: !!s, prefs: withDefaults(s?.prefs) };
  }

  subscribe(deviceId: string, subscription: PushSubscriptionJson, prefs: Partial<PushPrefs>) {
    // One subscription per device, and one device per browser endpoint.
    this.subs = this.subs.filter((s) => s.deviceId !== deviceId && s.subscription.endpoint !== subscription.endpoint);
    this.subs.push({ deviceId, subscription, prefs: withDefaults(prefs) });
    this.save();
  }
  unsubscribe(deviceId: string) {
    const n = this.subs.length;
    this.subs = this.subs.filter((s) => s.deviceId !== deviceId);
    this.state.delete(deviceId);
    if (this.subs.length !== n) this.save();
  }
  count() {
    return this.subs.length;
  }

  /** Tells the service which devices have the app on screen right now. */
  setWatching(fn: (deviceId: string) => boolean) {
    this.watching = fn;
  }

  /** Forgets subscriptions of devices that are no longer paired (a phone paired again gets a new id). */
  keepOnly(pairedIds: string[]) {
    const keep = new Set(pairedIds);
    const n = this.subs.length;
    this.subs = this.subs.filter((s) => keep.has(s.deviceId));
    if (this.subs.length !== n) {
      this.log.info(`Removed ${n - this.subs.length} notification subscription(s) of devices that are no longer paired.`);
      this.save();
    }
  }

  private async deliver(all: Saved[], p: PushPayload, ttl: number, urgency: "normal" | "high") {
    // A device looking at the app already shows it there (iPhones also take back permission after pushes they had to hide).
    const targets = p.kind === "test" ? all : all.filter((t) => !this.watching(t.deviceId));
    if (!targets.length) return 0;
    const payload = JSON.stringify(p);
    const dead: string[] = [];
    let failed = 0;
    await Promise.all(
      targets.map(async (t) => {
        try {
          await this.sender(t.subscription, payload, { TTL: ttl, urgency });
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) dead.push(t.deviceId);
          else {
            failed++;
            const body = (e as { body?: string }).body;
            this.log.warn(`Notification "${p.title}" to a device failed (${code ?? (e as Error).message}${body ? `: ${String(body).slice(0, 160)}` : ""})`);
          }
        }
      }),
    );
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.deviceId));
      this.save();
      this.log.info(`Removed ${dead.length} notification subscription(s) the browser no longer accepts`);
    }
    const sent = targets.length - dead.length - failed;
    if (sent > 0) this.log.info(`Notification "${p.title}" sent to ${sent} device(s)`);
    return sent;
  }

  private st(id: string): DeviceState {
    let d = this.state.get(id);
    if (!d) this.state.set(id, (d = { atcSent: [], aheadKey: null, aheadAt: 0, fuelArmed: true, todArmed: false, approachArmed: false }));
    return d;
  }

  /** The device's hourly limit on "boundary ahead" and "no ATC" notifications. Counts the send when it allows it. */
  private underAtcLimit(s: Saved, now: number): boolean {
    const d = this.st(s.deviceId);
    d.atcSent = d.atcSent.filter((t) => now - t < HOUR);
    const cap = s.prefs.atcPerHour;
    if (cap > 0 && d.atcSent.length >= cap) return false;
    d.atcSent.push(now);
    return true;
  }

  /** "Contact X" always goes out (you have to act on it). "No ATC coverage" counts towards the hourly limit. */
  notifyAtc(a: AtcAlert, now = Date.now()) {
    if (a.kind === "ahead") return Promise.resolve(0); // handled per device by notifyAtcAhead, which knows each device's distance
    const title = a.kind === "unicom" ? "No ATC coverage" : "Contact ATC";
    const targets = this.subs.filter((s) => s.prefs.atc && (a.kind !== "unicom" || this.underAtcLimit(s, now)));
    return this.deliver(targets, { title, body: a.text, tag: "atc", kind: "atc", url: "/#map" }, 120, "high");
  }

  /** Called with every new "who covers me / what's next" picture. Each device gets its warning at its own distance. */
  notifyAtcAhead(p: AtcPosition, now = Date.now()) {
    const ahead = p.ahead;
    if (!ahead) return Promise.resolve(0);
    const key = ahead.station ? ahead.station.callsign : "UNICOM";
    const mins = Math.max(1, Math.round(ahead.etaSec / 60));
    const text = ahead.station ? `${ahead.station.name} in about ${mins} min (${ahead.distNm} nm): ${ahead.station.freq} (${ahead.station.callsign}).` : `Leaving ATC coverage in about ${mins} min (${ahead.distNm} nm). Monitor UNICOM 122.800.`;
    const targets = this.subs.filter((s) => {
      if (!s.prefs.atc || ahead.distNm > s.prefs.atcAheadNm) return false;
      const d = this.st(s.deviceId);
      if (d.aheadKey === key && now - d.aheadAt < REANNOUNCE_MS) return false;
      if (!this.underAtcLimit(s, now)) return false;
      d.aheadKey = key;
      d.aheadAt = now;
      return true;
    });
    return this.deliver(targets, { title: "ATC boundary ahead", body: text, tag: "atc", kind: "atc", url: "/#map" }, 120, "high");
  }

  /** Aircraft alerts (stall, engine and so on) for devices that have them on. */
  notifyAlert(a: FlightAlert) {
    const wants = (s: Saved) => (a.kind === "autopilot" ? s.prefs.apOff : s.prefs.alerts);
    return this.deliver(this.subs.filter(wants), { title: a.title, body: a.text, tag: `alert-${a.kind}`, kind: "alert", url: "/" }, 120, "high");
  }

  /**
   * Fuel warning, per device: sent when the fuel left would last less than the device's own limit, and not again
   * until it has climbed back well above it (a refuel or a burn estimate that settles).
   */
  notifyFuel(enduranceMin: number | null, fuelText: string) {
    if (enduranceMin === null) return Promise.resolve(0);
    const targets = this.subs.filter((s) => {
      const lim = s.prefs.fuelMin;
      if (!s.prefs.alerts || lim <= 0) return false;
      const d = this.st(s.deviceId);
      if (enduranceMin > lim + 10) d.fuelArmed = true;
      if (!d.fuelArmed || enduranceMin >= lim) return false;
      d.fuelArmed = false;
      return true;
    });
    const mins = Math.max(1, Math.round(enduranceMin));
    return this.deliver(targets, { title: "Low fuel", body: `About ${mins} min of fuel left${fuelText ? ` (${fuelText})` : ""} at the current burn.`, tag: "alert-fuel", kind: "alert", url: "/" }, 300, "high");
  }

  /**
   * Top of descent, per device: sent once when the descent point is within the device's lead time. It only counts
   * if the point was first seen further away than that, so joining a flight already near it stays quiet.
   */
  notifyTod(minAway: number | null, nm: number | null) {
    if (minAway === null || nm === null) return Promise.resolve(0);
    const targets = this.subs.filter((s) => {
      const lim = s.prefs.todMin;
      if (lim <= 0) return false;
      const d = this.st(s.deviceId);
      if (minAway > lim + 1) d.todArmed = true;
      if (!d.todArmed || minAway > lim) return false;
      d.todArmed = false;
      return true;
    });
    const mins = Math.max(1, Math.round(minAway));
    return this.deliver(targets, { title: "Top of descent ahead", body: `The descent should start in about ${mins} min (${Math.round(nm)} nm).`, tag: "alert-tod", kind: "alert", url: "/" }, 600, "high");
  }

  /** Getting near the destination, per device: once, at the device's own lead time (like the top of descent). */
  notifyApproach(minAway: number | null, nm: number | null, arr: string | null) {
    if (minAway === null || nm === null) return Promise.resolve(0);
    const targets = this.subs.filter((s) => {
      const lim = s.prefs.approachMin;
      if (lim <= 0) return false;
      const d = this.st(s.deviceId);
      if (minAway > lim + 1) d.approachArmed = true;
      if (!d.approachArmed || minAway > lim) return false;
      d.approachArmed = false;
      return true;
    });
    const mins = Math.max(1, Math.round(minAway));
    return this.deliver(targets, { title: `Approaching ${arr ?? "the destination"}`, body: `About ${mins} min (${Math.round(nm)} nm) to go.`, tag: "event-approach", kind: "event", url: "/" }, 600, "high");
  }

  /** Takeoff, top of climb, 10,000 ft, at the gate, the sim stopping, the plan loaded, the sim pausing itself. */
  notifyEvent(e: FlightEvent) {
    const wants = EVENT_PREF[e.kind];
    return this.deliver(this.subs.filter((s) => wants(s.prefs)), { title: e.title, body: e.text, tag: `event-${e.kind}`, kind: "event", url: "/" }, e.kind === "simLost" ? 3600 : 600, e.kind === "simLost" ? "high" : "normal");
  }

  notifyVatsim(connected: boolean, callsign: string | null, pluginLinked: boolean) {
    const body = connected ? `Connected to VATSIM${callsign ? ` as ${callsign}` : ""}.` : pluginLinked ? "Disconnected from VATSIM." : "vPilot closed, so you are no longer connected to VATSIM.";
    return this.deliver(this.subs.filter((s) => s.prefs.vatsim), { title: connected ? "VATSIM connected" : "VATSIM disconnected", body, tag: "vatsim", kind: "vatsim", url: "/#comms" }, 300, "high");
  }
  notifyChat(m: ChatMessage) {
    const title = m.kind === "private" ? `Message from ${m.from}` : m.kind === "selcal" ? `SELCAL from ${m.from}` : `${m.from}${m.freqHz[0] ? " " + formatMhz(m.freqHz[0]) : ""}`;
    return this.deliver(this.subs.filter((s) => s.prefs.chat !== false), { title, body: m.text.slice(0, 180), tag: m.kind === "private" ? `dm-${m.from}` : "chat", kind: "chat", url: "/#comms" }, 300, "high");
  }
  notifyAcars(m: AcarsMessage) {
    const title = m.kind === "cpdlc" ? `CPDLC from ${m.peer}` : m.kind === "info" ? "ACARS information" : `ACARS from ${m.peer}`;
    return this.deliver(this.subs.filter((s) => s.prefs.chat !== false), { title, body: m.text.slice(0, 180), tag: `acars-${m.peer}`, kind: "chat", url: "/#comms" }, 300, "high");
  }
  notifyLanding(l: LandingSummary) {
    const flags = [l.touchAndGo ? "touch-and-go" : "", l.bounces ? `${l.bounces} bounce${l.bounces > 1 ? "s" : ""}` : ""].filter(Boolean);
    const body = `${Math.abs(l.vsFpm)} fpm, ${l.gPeak.toFixed(2)} g${flags.length ? ", " + flags.join(", ") : ""}`;
    return this.deliver(
      this.subs.filter((s) => s.prefs.landing),
      { title: `Touchdown: ${l.rating.toUpperCase()}`, body, tag: `landing-${l.id}`, kind: "landing", url: "/#landing" },
      3600,
      "normal",
    );
  }
  async test(deviceId: string) {
    const t = this.subs.filter((s) => s.deviceId === deviceId);
    if (!t.length) return false;
    return (await this.deliver(t, { title: "VBuddy", body: "Notifications are working.", tag: "test", kind: "test", url: "/" }, 60, "high")) > 0;
  }
}
