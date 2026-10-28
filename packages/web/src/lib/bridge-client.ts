import {
  envelope,
  parseServerMessage,
  LandingSummarySchema,
  summarize,
  WS_PATH,
  type AtcAlert,
  type TaxiGuide,
  type TaxiRequest,
  type SimViewState,
  type CduScreen,
  type ChaseCommand,
  type ChaseViewInfo,
  type FlightAlert,
  type FlightEvent,
  type FlightPlanInfo,
  type CockpitCommand,
  type ControlInfo,
  type FcuState,
  type PairedDevice,
  type ChatMessage,
  type AcarsCommand,
  type AcarsState,
  type CommsCommand,
  type CommsState,
  type LegCommand,
  type PanelCommand,
  type PlannedLeg,
  type PanelState,
  type SystemsSnapshot,
  type PushInfoMsg,
  type PushPrefs,
  type AtcPosition,
  type AtcStation,
  type ClientMessageBody,
  type NetPilot,
  type NetworkStatus,
  type Landing,
  type LandingSummary,
  type ServerMessage,
  type SimStatus,
  type TelemetryFrame,
} from "@vbuddy/protocol";

export type LinkState = "connecting" | "open" | "waiting";

export interface BridgeSnapshot {
  link: LinkState;
  /** Seconds until the next reconnect attempt, when link = "waiting". */
  retryIn: number;
  sim: SimStatus | null;
  latest: TelemetryFrame | null;
  /**
   * When `latest` was produced, on this device's clock (ms). The frame's own `ts` is the PC's clock, which can be
   * seconds away from the phone's, so ages are measured from this.
   */
  latestAt: number;
  telemetryHz: number;
  bridgeVersion: string | null;
  /** Frames the bridge produced that this client never received (couldn't be replayed). */
  missedFrames: number;
  /** Frames recovered by replay after reconnecting, over this page's lifetime. */
  replayedFrames: number;
  /** After a long outage the bridge thins the replay to every Nth frame; 1 = nothing was skipped. */
  replayStride: number;
  /** Of the replayed frames, how many the bridge read back from its disk log. */
  replayedFromDisk: number;
  /** Times the connection was re-established. */
  reconnects: number;
  lastError: string | null;
  /** Recorded landings, newest first (no traces). */
  landings: LandingSummary[];
  /** Full landings (with traces) fetched so far, by id. */
  details: Record<string, Landing>;
  /** The landing list on screen is the copy saved on this device, not yet confirmed by the bridge. */
  landingsFromCache: boolean;
  /** Bridge run id (frames' seq numbers belong to it). */
  sessionId: string | null;
  /** Network traffic for the area this client asked for. receivedAt is this device's clock. */
  traffic: { updatedAt: number; receivedAt: number; you: string | null; pilots: NetPilot[] } | null;
  /** Online network status and every online ATC station. */
  network: NetworkStatus | null;
  stations: AtcStation[];
  /** Who covers your aircraft now and next. receivedAt is this device's clock (for counting ETAs down). */
  atc: (AtcPosition & { receivedAt: number }) | null;
  /** Latest ATC alert not yet dismissed. */
  atcAlert: (AtcAlert & { receivedAt: number }) | null;
  /** Latest aircraft alert (stall, engine, fuel...) not yet dismissed. */
  flightAlert: (FlightAlert & { receivedAt: number }) | null;
  /** Fenix FCU as the bridge sees it (null = no supported aircraft), and what this device may do. */
  cockpit: FcuState | null;
  control: ControlInfo | null;
  /** Only on the bridge PC: the code a new device enters, and the paired devices. */
  pairing: { code: string; expiresAt: number; devices: PairedDevice[] } | null;
  /** Notifications: whether this bridge can send them, the key the browser needs, and this device's choices. Null = bridge has none. */
  push: { publicKey: string | null; subscribed: boolean; prefs: PushPrefs; note: string | null } | null;
  /** Radios, transponder and the VATSIM connection (null until the bridge has said). */
  comms: CommsState | null;
  /** Hoppie ACARS messages and status (null until the bridge sends them; only paired devices get them). */
  acars: AcarsState | null;
  /** Lights, autopilot and aircraft family (null until the bridge has said). */
  panel: PanelState | null;
  /** Engines, fuel, electrical and the rest, about once a second (null until the sim is connected). */
  systems: SystemsSnapshot | null;
  /** The flights this pilot plans to fly (kept on the bridge PC). */
  legs: PlannedLeg[];
  /** The conversation (only for devices allowed to see it), oldest first. */
  chat: ChatMessage[];
  /** Unread messages per conversation, and how many of all unread ones deserve attention (DMs, SELCAL, calls using your callsign). */
  unread: Record<string, number>;
  attentionUnread: number;
  /** The newest attention message that arrived live, until dismissed (drives the toast). */
  lastAttention: ChatMessage | null;
  /** A landing that happened since this page loaded (live, or while it was disconnected). Cleared by dismissNewLanding(). */
  newLanding: LandingSummary | null;
  /** The SimBrief plan for the flight in progress (or the latest one). Null = none. */
  plan: FlightPlanInfo | null;
  /** The taxi route the bridge is following, and where you are on it (null = none). */
  taxi: TaxiGuide | null;
  /** The latest taxi note (a turn or crossing coming up, a new route from ATC), until dismissed. */
  taxiNotice: { tag: string; title: string; text: string; receivedAt: number } | null;
  /** The latest flight milestone (takeoff, top of climb…) not yet dismissed. */
  flightEvent: (FlightEvent & { receivedAt: number }) | null;
}

export type ShotReply = { ok: true; name: string; w: number; h: number; bytes: number } | { ok: false; error: string };

const MAX_CACHED_DETAILS = 40;
const READ_KEY = "vbuddy.chat.readAt";
const MAX_CHAT_KEPT = 500;

function loadReadAt(): Record<string, number> {
  try {
    const j = JSON.parse(localStorage.getItem(READ_KEY) ?? "{}") as Record<string, number>;
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
const TOKEN_KEY = "vbuddy.pairToken";
const CMD_TIMEOUT_MS = 30_000;

export type CmdReply = { ok: true } | { ok: false; error: string };
export type ChaseReply = { ok: true; views?: ChaseViewInfo[]; airport?: string | null } | { ok: false; error: string };

export function readPairToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The landing list is kept on this device so the log still opens when the bridge is off. */
const LANDINGS_KEY = "vbuddy.landings.v1";
const MAX_SAVED_LANDINGS = 100;

function loadSavedLandings(): LandingSummary[] {
  try {
    const raw = localStorage.getItem(LANDINGS_KEY);
    if (!raw) return [];
    const out: LandingSummary[] = [];
    for (const item of JSON.parse(raw) as unknown[]) {
      const r = LandingSummarySchema.safeParse(item);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}
function saveLandings(list: LandingSummary[]) {
  try {
    localStorage.setItem(LANDINGS_KEY, JSON.stringify(list.slice(0, MAX_SAVED_LANDINGS)));
  } catch {
    /* storage full or blocked: history is just not kept offline */
  }
}

const LIVENESS_MS = 6000; // no message for this long = connection is dead
const PING_MS = 2500;
const MAX_BACKOFF_MS = 10000;

/** Where the bridge is: same host as the page, or ?bridge=host:port to override. */
export function defaultBridgeUrl(loc: Location = window.location): string {
  const override = new URLSearchParams(loc.search).get("bridge");
  const secure = loc.protocol === "https:";
  const host = override ?? loc.host;
  return `${secure ? "wss" : "ws"}://${host}${WS_PATH}`;
}

/**
 * Keeps a WebSocket to the bridge alive across Wi-Fi drops, sleeps and bridge
 * restarts. On reconnect it tells the bridge the last frame it saw, so the
 * bridge can replay what was missed.
 */
/** What the live sim view hears from the bridge. */
export type CduEvent = { kind: "screen"; screen: CduScreen | null } | { kind: "error"; error: string };
export type SimViewEvent = { kind: "frame"; seq: number; jpeg: string; w: number; h: number } | { kind: "status"; state: SimViewState; message: string };

export class BridgeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private frameListeners = new Set<(frames: TelemetryFrame[], replay: boolean) => void>();
  private sessionId: string | null = null;
  private lastSeq = -1;
  private attempt = 0;
  private retryTimer: number | null = null;
  private countdown: number | null = null;
  private pingTimer: number | null = null;
  private lastMsgAt = 0;
  private everOpened = false;
  private stopped = false;
  /** Stride of the replay currently arriving; frames skipped on purpose aren't "missed". */
  private incomingStride = 1;
  private area: { lat: number; lon: number; radiusNm: number } | null = null;
  private cmdSeq = 0;
  private pendingCmds = new Map<string, { done: (r: CmdReply) => void; timer: number }>();
  private pendingPair: ((r: CmdReply) => void) | null = null;
  private pendingAcars = new Map<string, { done: (r: CmdReply) => void; timer: number }>();
  private pendingComms = new Map<string, { done: (r: CmdReply) => void; timer: number }>();
  private pendingPanel = new Map<string, { done: (r: CmdReply) => void; timer: number }>();
  private pendingChase = new Map<string, { done: (r: ChaseReply) => void; timer: number }>();
  private pendingShot = new Map<string, { done: (r: ShotReply) => void; timer: number }>();
  private pendingLeg = new Map<string, { done: (r: CmdReply) => void; timer: number }>();
  private pendingTaxi = new Map<string, { done: (r: CmdReply) => void; timer: number }>();
  private readAt: Record<string, number> = loadReadAt();
  /** This device's clock minus the PC's (ms), from the last live frame. */
  private clockOffset: number | null = null;
  private attentionCbs = new Set<(m: ChatMessage) => void>();

  private snap: BridgeSnapshot = {
    link: "connecting",
    retryIn: 0,
    sim: null,
    latest: null,
    latestAt: 0,
    telemetryHz: 0,
    bridgeVersion: null,
    missedFrames: 0,
    replayedFrames: 0,
    replayStride: 1,
    replayedFromDisk: 0,
    reconnects: 0,
    lastError: null,
    landings: [],
    landingsFromCache: false,
    sessionId: null,
    traffic: null,
    network: null,
    stations: [],
    atc: null,
    atcAlert: null,
    flightAlert: null,
    cockpit: null,
    control: null,
    pairing: null,
    push: null,
    comms: null,
    acars: null,
    panel: null,
    systems: null,
    legs: [],
    chat: [],
    unread: {},
    attentionUnread: 0,
    lastAttention: null,
    details: {},
    newLanding: null,
    plan: null,
    taxi: null,
    taxiNotice: null,
    flightEvent: null,
  };
  private seenLandings = new Set<string>();
  private gotLandingList = false;
  private pendingLandings = new Set<string>();

  constructor(
    private url: string,
    private clientName = "web",
  ) {
    const saved = loadSavedLandings();
    if (saved.length) this.snap = { ...this.snap, landings: saved, landingsFromCache: true };
  }

  /* ---- subscription API (works with React's useSyncExternalStore) ---- */
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  /** Every frame in order, including replayed ones. For recorders/maps later. */
  onFrames(fn: (frames: TelemetryFrame[], replay: boolean) => void) {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /* ---- live sim view: frames go to the watchers directly (not through the snapshot: a third of a second each, 50-100 KB) ---- */
  private simViewCbs = new Set<(e: SimViewEvent) => void>();
  /** Watch the live sim view while the returned function hasn't been called. */
  watchSimView = (fn: (e: SimViewEvent) => void) => {
    this.simViewCbs.add(fn);
    if (this.simViewCbs.size === 1) this.send({ t: "simView", on: true });
    return () => {
      if (!this.simViewCbs.delete(fn)) return;
      if (this.simViewCbs.size === 0) this.send({ t: "simView", on: false });
    };
  };

  /* ---- PMDG CDU: screens go to the watcher directly; one CDU at a time ---- */
  private cduCb: ((e: CduEvent) => void) | null = null;
  private cduSide = 0;
  /** Watch one CDU (0 left, 1 right, 2 centre) while the returned function hasn't been called. */
  watchCdu = (side: number, fn: (e: CduEvent) => void) => {
    this.cduCb = fn;
    this.cduSide = side;
    this.send({ t: "cduView", on: true, side });
    return () => {
      if (this.cduCb !== fn) return;
      this.cduCb = null;
      this.send({ t: "cduView", on: false, side });
    };
  };
  /** Press a key on the watched CDU. */
  cduKey = (side: number, key: string) => this.send({ t: "cduKey", side, key });

  /** Asks the bridge for a landing's full trace, unless we have it or already asked. */
  requestLanding = (id: string) => {
    if (this.snap.details[id] || this.pendingLandings.has(id)) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.pendingLandings.add(id);
    this.send({ t: "getLanding", id });
  };
  /** Where this client's map is looking; traffic is sent for that area. Re-sent after reconnects. */
  setTrafficArea = (lat: number, lon: number, radiusNm: number) => {
    const r = Math.max(1, Math.min(1000, Math.round(radiusNm)));
    const lo = ((((lon + 180) % 360) + 360) % 360) - 180;
    this.area = { lat: Math.max(-90, Math.min(90, lat)), lon: lo, radiusNm: r };
    this.send({ t: "trafficArea", ...this.area });
  };
  /** Sends a cockpit command; resolves when the bridge has checked it arrived. */
  command = (cmd: CockpitCommand): Promise<CmdReply> => {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "Not connected to the bridge." });
    const id = `c${++this.cmdSeq}`;
    return new Promise((done) => {
      const timer = window.setTimeout(() => {
        this.pendingCmds.delete(id);
        done({ ok: false, error: "No answer from the bridge." });
      }, CMD_TIMEOUT_MS);
      this.pendingCmds.set(id, { done, timer });
      this.send({ t: "cmd", id, cmd });
    });
  };
  /** Radios, transponder, connect/disconnect and sending messages. Resolves when the bridge says it was done. */
  commsCommand = (cmd: CommsCommand): Promise<CmdReply> => {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "Not connected to the bridge." });
    const id = `k${++this.cmdSeq}`;
    return new Promise((done) => {
      const timer = window.setTimeout(() => {
        this.pendingComms.delete(id);
        done({ ok: false, error: "No answer from the bridge." });
      }, CMD_TIMEOUT_MS);
      this.pendingComms.set(id, { done, timer });
      this.send({ t: "commsCmd", id, cmd });
    });
  };
  /** Hoppie ACARS: telex, CPDLC answers, clearance and weather requests. */
  acarsCommand = (cmd: AcarsCommand): Promise<CmdReply> => {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "Not connected to the bridge." });
    const id = `a${++this.cmdSeq}`;
    return new Promise((done) => {
      const timer = window.setTimeout(() => {
        this.pendingAcars.delete(id);
        done({ ok: false, error: "No answer from the bridge." });
      }, CMD_TIMEOUT_MS + 10_000);
      this.pendingAcars.set(id, { done, timer });
      this.send({ t: "acarsCmd", id, cmd });
    });
  };
  /** Lights and the autopilot. Resolves when the bridge has seen the aircraft react (or not). */
  panelCommand = (cmd: PanelCommand): Promise<CmdReply> => {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "Not connected to the bridge." });
    const id = `p${++this.cmdSeq}`;
    return new Promise((done) => {
      const timer = window.setTimeout(() => {
        this.pendingPanel.delete(id);
        done({ ok: false, error: "No answer from the bridge." });
      }, CMD_TIMEOUT_MS);
      this.pendingPanel.set(id, { done, timer });
      this.send({ t: "panelCmd", id, cmd });
    });
  };
  /** ChasePlane: list its saved views, or switch to one. */
  chaseCommand = (cmd: ChaseCommand): Promise<ChaseReply> => {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "Not connected to the bridge." });
    const id = `c${++this.cmdSeq}`;
    return new Promise((done) => {
      const timer = window.setTimeout(() => {
        this.pendingChase.delete(id);
        done({ ok: false, error: "No answer from the bridge." });
      }, CMD_TIMEOUT_MS + 6000);
      this.pendingChase.set(id, { done, timer });
      this.send({ t: "chaseCmd", id, cmd });
    });
  };
  /** Takes a full-size screenshot of the simulator; it's saved on the PC and can be fetched from /api/screenshots/<name>. */
  screenshot = (): Promise<ShotReply> => {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "Not connected to the bridge." });
    const id = `s${++this.cmdSeq}`;
    return new Promise((done) => {
      const timer = window.setTimeout(() => {
        this.pendingShot.delete(id);
        done({ ok: false, error: "No answer from the bridge." });
      }, CMD_TIMEOUT_MS);
      this.pendingShot.set(id, { done, timer });
      this.send({ t: "screenshot", id });
    });
  };
  /** Plans a taxi route on the bridge (which then guides you along it), or stops following one. */
  taxiCommand = (cmd: TaxiRequest): Promise<CmdReply> => {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "Not connected to the bridge." });
    const id = `t${++this.cmdSeq}`;
    return new Promise((done) => {
      const timer = window.setTimeout(() => {
        this.pendingTaxi.delete(id);
        done({ ok: false, error: "No answer from the bridge." });
      }, CMD_TIMEOUT_MS);
      this.pendingTaxi.set(id, { done, timer });
      this.send({ t: "taxiCmd", id, cmd });
    });
  };
  dismissTaxiNotice = () => {
    if (this.snap.taxiNotice) this.update({ taxiNotice: null });
  };
  /** Adds, changes or deletes a planned flight. */
  legCommand = (cmd: LegCommand): Promise<CmdReply> => {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "Not connected to the bridge." });
    const id = `l${++this.cmdSeq}`;
    return new Promise((done) => {
      const timer = window.setTimeout(() => {
        this.pendingLeg.delete(id);
        done({ ok: false, error: "No answer from the bridge." });
      }, CMD_TIMEOUT_MS);
      this.pendingLeg.set(id, { done, timer });
      this.send({ t: "legCmd", id, cmd });
    });
  };
  /** Marks a conversation read (everything in it up to now). */
  markRead = (thread: string) => {
    const latest = this.snap.chat.reduce((t, m) => (m.thread === thread ? Math.max(t, m.ts) : t), 0);
    if (latest <= (this.readAt[thread] ?? 0)) return;
    this.readAt[thread] = latest;
    try {
      localStorage.setItem(READ_KEY, JSON.stringify(this.readAt));
    } catch {
      /* unread counts just start over next time */
    }
    this.update(this.unreadPatch(this.snap.chat));
  };
  dismissAttention = () => {
    if (this.snap.lastAttention) this.update({ lastAttention: null });
  };
  /** Called for each attention message that arrives live (not when history loads); used for the chime. */
  onAttention(fn: (m: ChatMessage) => void) {
    this.attentionCbs.add(fn);
    return () => this.attentionCbs.delete(fn);
  }
  private unreadPatch(chat: ChatMessage[]): Pick<BridgeSnapshot, "chat" | "unread" | "attentionUnread"> {
    const unread: Record<string, number> = {};
    let attention = 0;
    for (const m of chat) {
      if (m.dir !== "in" || m.kind === "system" || m.ts <= (this.readAt[m.thread] ?? 0)) continue;
      unread[m.thread] = (unread[m.thread] ?? 0) + 1;
      if (m.attention) attention++;
    }
    return { chat, unread, attentionUnread: attention };
  }
  /** Pairs this device with the code shown on the bridge PC; keeps the token for next time. */
  pair = (code: string, device: string): Promise<CmdReply> => {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "Not connected to the bridge." });
    this.pendingPair?.({ ok: false, error: "Replaced by a newer attempt." });
    return new Promise((done) => {
      this.pendingPair = done;
      this.send({ t: "pair", code, device });
    });
  };
  pushSubscribe = (subscription: PushSubscriptionJSON, prefs: PushPrefs) => {
    const { endpoint, keys } = subscription;
    if (!endpoint || !keys?.p256dh || !keys.auth) return;
    this.send({ t: "pushSubscribe", subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, prefs });
  };
  pushUnsubscribe = () => this.send({ t: "pushUnsubscribe" });
  pushTest = () => this.send({ t: "pushTest" });
  revokeDevice = (id: string) => this.send({ t: "revokeDevice", id });
  newPairingCode = () => this.send({ t: "newPairingCode" });
  cockpitRetry = () => this.send({ t: "cockpitRetry" });
  dismissAtcAlert = () => {
    if (this.snap.atcAlert) this.update({ atcAlert: null });
  };
  dismissFlightAlert = () => {
    if (this.snap.flightAlert) this.update({ flightAlert: null });
  };
  dismissFlightEvent = () => {
    if (this.snap.flightEvent) this.update({ flightEvent: null });
  };
  /** Tells the bridge whether the app is on screen, so it doesn't push notifications this device already shows. */
  private visible = typeof document === "undefined" || document.visibilityState === "visible";
  setVisible = (v: boolean) => {
    this.visible = v;
    this.send({ t: "visibility", visible: v });
  };
  dismissNewLanding = () => {
    if (this.snap.newLanding) this.update({ newLanding: null });
  };

  private update(patch: Partial<BridgeSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  start() {
    this.stopped = false;
    window.addEventListener("online", this.kick);
    document.addEventListener("visibilitychange", this.onVisible);
    this.connect();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener("online", this.kick);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  /** Reconnect now instead of waiting for the backoff timer (network came back, tab woke up). */
  private kick = () => {
    if (this.stopped || this.snap.link !== "waiting") return;
    this.attempt = 0;
    this.connect();
  };
  private onVisible = () => {
    if (document.visibilityState !== "visible") return;
    // Phones freeze background tabs; a socket can look open but be dead.
    if (this.snap.link === "open" && Date.now() - this.lastMsgAt > LIVENESS_MS) this.ws?.close();
    else this.kick();
  };

  private clearTimers() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.countdown !== null) clearInterval(this.countdown);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.retryTimer = this.countdown = this.pingTimer = null;
  }

  private send(body: ClientMessageBody) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(envelope(body)));
  }

  private connect() {
    this.clearTimers();
    this.update({ link: "connecting", retryIn: 0 });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.update({ lastError: String(e) });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.lastMsgAt = Date.now();
      this.send({
        t: "hello",
        client: this.clientName,
        ...(readPairToken() ? { token: readPairToken() } : {}),
        ...(this.sessionId ? { resume: { sessionId: this.sessionId, lastSeq: this.lastSeq } } : {}),
      });
      this.pingTimer = window.setInterval(() => {
        if (Date.now() - this.lastMsgAt > LIVENESS_MS) {
          ws.close();
          return;
        }
        this.send({ t: "ping", nonce: String(Date.now()) });
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now();
      const r = parseServerMessage(String(ev.data));
      if (!r.ok) {
        console.warn("[vbuddy] bad message from bridge:", r.error);
        return;
      }
      this.handle(r.msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Commands in flight can't be confirmed any more.
      for (const [, p] of this.pendingCmds) {
        clearTimeout(p.timer);
        p.done({ ok: false, error: "Lost the connection to the bridge." });
      }
      this.pendingCmds.clear();
      this.pendingPair?.({ ok: false, error: "Lost the connection to the bridge." });
      this.pendingPair = null;
      for (const [, p] of this.pendingComms) {
        clearTimeout(p.timer);
        p.done({ ok: false, error: "Lost the connection to the bridge." });
      }
      this.pendingComms.clear();
      for (const [, p] of this.pendingAcars) {
        clearTimeout(p.timer);
        p.done({ ok: false, error: "Lost the connection to the bridge." });
      }
      this.pendingAcars.clear();
      for (const [, p] of this.pendingPanel) {
        clearTimeout(p.timer);
        p.done({ ok: false, error: "Lost the connection to the bridge." });
      }
      this.pendingPanel.clear();
      for (const [, p] of this.pendingShot) {
        clearTimeout(p.timer);
        p.done({ ok: false, error: "The connection to the bridge dropped." });
      }
      this.pendingShot.clear();
      for (const [, p] of this.pendingChase) {
        clearTimeout(p.timer);
        p.done({ ok: false, error: "Lost the connection to the bridge." });
      }
      this.pendingChase.clear();
      for (const [, p] of this.pendingLeg) {
        clearTimeout(p.timer);
        p.done({ ok: false, error: "Lost the connection to the bridge." });
      }
      this.pendingLeg.clear();
      for (const [, p] of this.pendingTaxi) {
        clearTimeout(p.timer);
        p.done({ ok: false, error: "Lost the connection to the bridge." });
      }
      this.pendingTaxi.clear();
      if (!this.stopped) this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows and handles retry */
    };
  }

  private scheduleRetry() {
    this.clearTimers();
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
    this.attempt++;
    const due = Date.now() + delay;
    this.update({ link: "waiting", retryIn: Math.ceil(delay / 1000) });
    this.countdown = window.setInterval(() => this.update({ retryIn: Math.max(0, Math.ceil((due - Date.now()) / 1000)) }), 1000);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private acceptFrames(frames: TelemetryFrame[], replay: boolean) {
    let missed = 0;
    const fresh: TelemetryFrame[] = [];
    for (const f of frames) {
      if (f.seq <= this.lastSeq) continue; // duplicate
      const skippedOnPurpose = replay && this.incomingStride > 1;
      if (!skippedOnPurpose && this.lastSeq >= 0 && f.seq > this.lastSeq + 1) missed += f.seq - this.lastSeq - 1;
      this.lastSeq = f.seq;
      fresh.push(f);
    }
    if (!fresh.length) return;
    for (const l of this.frameListeners) l(fresh, replay);
    const last = fresh[fresh.length - 1]!;
    // A live frame is from now; that also tells how far the PC's clock is from this one. A replayed frame is as old
    // as its PC timestamp says, shifted by that difference.
    if (!replay) this.clockOffset = Date.now() - last.ts;
    this.update({
      latest: last,
      latestAt: replay ? last.ts + (this.clockOffset ?? 0) : Date.now(),
      missedFrames: this.snap.missedFrames + missed,
      replayedFrames: this.snap.replayedFrames + (replay ? fresh.length : 0),
    });
  }

  private handle(m: ServerMessage) {
    switch (m.t) {
      case "welcome": {
        if (m.sessionId !== this.sessionId) {
          // New bridge run (or first connect): sequence numbers start over.
          this.sessionId = m.sessionId;
          this.lastSeq = -1;
        }
        this.incomingStride = m.resume?.stride ?? 1;
        this.attempt = 0;
        this.pendingLandings.clear(); // anything asked for on the old connection is lost
        this.update({
          link: "open",
          sim: m.sim,
          telemetryHz: m.telemetryHz,
          bridgeVersion: m.bridgeVersion,
          lastError: null,
          sessionId: m.sessionId,
          ...(m.resume ? { replayStride: this.incomingStride, replayedFromDisk: this.snap.replayedFromDisk + (m.resume.fromDisk ?? 0) } : {}),
          reconnects: this.snap.reconnects + (this.everOpened ? 1 : 0),
        });
        this.everOpened = true;
        if (this.area) this.send({ t: "trafficArea", ...this.area });
        this.send({ t: "visibility", visible: this.visible });
        if (this.simViewCbs.size) this.send({ t: "simView", on: true });
        if (this.cduCb) this.send({ t: "cduView", on: true, side: this.cduSide });
        break;
      }
      case "cdu":
        if (m.side === this.cduSide) this.cduCb?.({ kind: "screen", screen: m.screen });
        break;
      case "cduResult":
        if (!m.ok) this.cduCb?.({ kind: "error", error: m.error ?? "That key didn't reach the CDU." });
        break;
      case "simViewFrame":
        for (const cb of this.simViewCbs) cb({ kind: "frame", seq: m.seq, jpeg: m.jpeg, w: m.w, h: m.h });
        break;
      case "simViewStatus":
        for (const cb of this.simViewCbs) cb({ kind: "status", state: m.state, message: m.message ?? "" });
        break;
      case "telemetry":
        this.acceptFrames([m.frame], false);
        break;
      case "telemetryBatch":
        this.acceptFrames(m.frames, true);
        break;
      case "simStatus":
        this.update({ sim: m.sim });
        break;
      case "landingList": {
        // Newest first. After the first list, anything unseen happened while we weren't listening.
        const fresh = m.landings.filter((l) => !this.seenLandings.has(l.id));
        for (const l of m.landings) this.seenLandings.add(l.id);
        saveLandings(m.landings);
        this.update({ landings: m.landings, landingsFromCache: false, ...(this.gotLandingList && fresh[0] ? { newLanding: fresh[0] } : {}) });
        this.gotLandingList = true;
        break;
      }
      case "landing": {
        const l = m.landing;
        this.pendingLandings.delete(l.id);
        const details = { ...this.snap.details, [l.id]: l };
        const keys = Object.keys(details);
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_DETAILS))) if (k !== l.id) delete details[k];
        let landings = this.snap.landings;
        if (!landings.some((x) => x.id === l.id)) {
          landings = [summarize(l), ...landings].sort((a, b) => b.ts - a.ts);
          saveLandings(landings);
        }
        const isNew = !this.seenLandings.has(l.id);
        this.seenLandings.add(l.id);
        this.update({ details, landings, ...(isNew && m.reason === "new" ? { newLanding: summarize(l) } : {}) });
        break;
      }
      case "traffic":
        this.update({ traffic: { updatedAt: m.updatedAt, receivedAt: Date.now(), you: m.you, pilots: m.pilots } });
        break;
      case "atcList":
        this.update({ network: m.status, stations: m.stations, ...(m.status.state === "off" ? { traffic: null, atc: null } : {}) });
        break;
      case "atcPosition":
        this.update({ atc: { ...m.position, receivedAt: Date.now() } });
        break;
      case "flightAlert":
        this.update({ flightAlert: { ...m.alert, receivedAt: Date.now() } });
        break;
      case "flightEvent":
        this.update({ flightEvent: { ...m.event, receivedAt: Date.now() } });
        break;
      case "flightPlan":
        this.update({ plan: m.plan });
        break;
      case "screenshotResult": {
        const p = this.pendingShot.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingShot.delete(m.id);
          p.done(m.ok && m.name ? { ok: true, name: m.name, w: m.w ?? 0, h: m.h ?? 0, bytes: m.bytes ?? 0 } : { ok: false, error: m.error ?? "The screenshot didn't work." });
        }
        break;
      }
      case "atcAlert":
        this.update({ atcAlert: { ...m.alert, receivedAt: Date.now() } });
        break;
      case "cockpit":
        // A device that may no longer see the conversation (removed, or not paired) drops what it had.
        this.update({ cockpit: m.state, control: m.control, ...(m.control.reason === "not-paired" && this.snap.chat.length ? { chat: [], acars: null, unread: {}, attentionUnread: 0, lastAttention: null } : {}) });
        break;
      case "acarsState":
        this.update({ acars: m.state });
        break;
      case "acarsResult": {
        const p = this.pendingAcars.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingAcars.delete(m.id);
          p.done(m.ok ? { ok: true } : { ok: false, error: m.error ?? "That didn't work." });
        }
        break;
      }
      case "commsState":
        this.update({ comms: m.state });
        break;
      case "systems":
        this.update({ systems: m.systems });
        break;
      case "panelState":
        this.update({ panel: m.state });
        break;
      case "legs":
        this.update({ legs: m.legs });
        break;
      case "taxiGuide":
        this.update({ taxi: m.guide });
        break;
      case "taxiNotice":
        this.update({ taxiNotice: { ...m.notice, receivedAt: Date.now() } });
        break;
      case "taxiResult": {
        const p = this.pendingTaxi.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingTaxi.delete(m.id);
          p.done(m.ok ? { ok: true } : { ok: false, error: m.error ?? "That didn't work." });
        }
        break;
      }
      case "legResult": {
        const p = this.pendingLeg.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingLeg.delete(m.id);
          p.done(m.ok ? { ok: true } : { ok: false, error: m.error ?? "That didn't work." });
        }
        break;
      }
      case "chaseResult": {
        const p = this.pendingChase.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingChase.delete(m.id);
          p.done(m.ok ? { ok: true, views: m.views, airport: m.airport ?? null } : { ok: false, error: m.error ?? "That didn't work." });
        }
        break;
      }
      case "panelResult": {
        const p = this.pendingPanel.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingPanel.delete(m.id);
          p.done(m.ok ? { ok: true } : { ok: false, error: m.error ?? "That didn't work." });
        }
        break;
      }
      case "chatHistory":
        this.update(this.unreadPatch(m.messages.slice(-MAX_CHAT_KEPT)));
        break;
      case "chat": {
        if (this.snap.chat.some((x) => x.id === m.message.id)) break;
        const chat = [...this.snap.chat, m.message].slice(-MAX_CHAT_KEPT);
        const live = m.message.dir === "in" && m.message.attention;
        this.update({ ...this.unreadPatch(chat), ...(live ? { lastAttention: m.message } : {}) });
        if (live) for (const fn of this.attentionCbs) fn(m.message);
        break;
      }
      case "commsResult": {
        const p = this.pendingComms.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingComms.delete(m.id);
          p.done(m.ok ? { ok: true } : { ok: false, error: m.error ?? "That didn't work." });
        }
        break;
      }
      case "cmdResult": {
        const p = this.pendingCmds.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingCmds.delete(m.id);
          p.done(m.ok ? { ok: true } : { ok: false, error: m.error ?? "The command failed." });
        }
        break;
      }
      case "pairResult":
        if (m.ok && m.token) {
          try {
            localStorage.setItem(TOKEN_KEY, m.token);
          } catch {
            /* private mode: this device will need to pair again next time */
          }
        }
        this.pendingPair?.(m.ok ? { ok: true } : { ok: false, error: m.error ?? "Pairing failed." });
        this.pendingPair = null;
        break;
      case "pairingInfo":
        this.update({ pairing: { code: m.code, expiresAt: m.expiresAt, devices: m.devices } });
        break;
      case "pushInfo": {
        const i: PushInfoMsg = m;
        this.update({ push: i.enabled ? { publicKey: i.publicKey, subscribed: i.subscribed, prefs: i.prefs, note: i.note ?? null } : null });
        break;
      }
      case "error":
        this.update({ lastError: `${m.code}: ${m.message}` });
        break;
      case "pong":
        break;
    }
  }
}
