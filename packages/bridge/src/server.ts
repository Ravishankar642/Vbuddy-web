import type { CduSource } from "./pmdg/pmdg-panel.js";
import { envelope, type FlightAlert, type FlightEvent, type FlightPlanInfo, parseClientMessage, PLUGIN_PATH, PluginToBridgeSchema, WS_PATH, type ServerMessageBody } from "@vbuddy/protocol";
import type { BriefingService } from "./briefing/service.js";
import type { HoppieService } from "./acars/hoppie.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { FlightHistory } from "./db/recorder.js";
import type { TelemetryHub } from "./hub.js";
import type { NetworkHub, TrafficArea } from "./network/service.js";
import type { CockpitHub } from "./cockpit/service.js";
import { isLocalAddress, type Pairing } from "./control/pairing.js";
import type { ControlInfo, PairedDevice } from "@vbuddy/protocol";
import type { LandingStore } from "./landing/store.js";
import { logger } from "./log.js";
import { staticHandler } from "./static.js";
import type { CommsService } from "./comms/service.js";
import type { PanelService } from "./panel/service.js";
import type { SystemsSource } from "./panel/systems-reader.js";
import type { AtlasService } from "./atlas/atlas.js";
import type { LogEntry } from "./log.js";
import type { LegBook } from "./db/legs.js";
import type { EfbProxy } from "./efb/proxy.js";
import type { FrameSource } from "./simview/capture.js";
import type { Screenshots } from "./simview/screenshots.js";
import { existsSync as fileExists, readFileSync as readFileNow } from "node:fs";
import { SimViewFeed } from "./simview/feed.js";
import type { ChasePlaneLink } from "./chaseplane/client.js";
import type { PushService } from "./push/service.js";
import { RELAY_REMOTE_HEADER, RELAY_TAG_HEADER } from "./relay/relay-client.js";
import { VERSION } from "./version.js";

const log = logger("server");

const HELLO_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 15000;
/** Don't queue live frames for a client that can't keep up; it will resume instead. */
const MAX_BUFFERED_BYTES = 1_000_000;
const REPLAY_CHUNK = 500;

interface Client {
  ws: WebSocket;
  name: string;
  alive: boolean;
  /** Where this client's map is looking; null = around your aircraft. */
  area: TrafficArea | null;
  /** The client's address (behind the dev proxy: the forwarded one). */
  addr: string;
  /** On the bridge PC itself: may control without pairing and sees the pairing code. */
  local: boolean;
  device: PairedDevice | null;
  /** Came in through the relay (never "local", whatever address it claims). */
  relayed: boolean;
  /** Relayed and not paired: may only pair until it is. */
  locked: boolean;
  resume: { sessionId: string; lastSeq: number } | undefined;
  /** Watching the live sim view. */
  simView?: boolean;
  /** Watching this PMDG CDU (0 left, 1 right, 2 centre). */
  cdu?: number;
  /** The last CDU screen sent to it (JSON), so unchanged screens aren't sent again. */
  cduSent?: string;
  /** The app is on this client's screen (from its "visibility" messages; not assumed: an older app never says). */
  visible?: boolean;
}

/** Extra services the server shows to the app. */
export interface ServerExtras {
  flightEvents?: { onEvent(cb: (e: FlightEvent) => void): void } | null;
  plan?: { current(): FlightPlanInfo | null; onChange(cb: (p: FlightPlanInfo | null) => void): void } | null;
  screenshots?: Screenshots | null;
  /** A cloud/rain map tile from OpenWeatherMap through this PC (the key stays here). Null = no key. */
  weatherTile?: ((layer: string, z: number, x: number, y: number) => Promise<Buffer | null>) | null;
  weatherInfo?: (() => { clouds: boolean }) | null;
  /** Airline logos the pilot put in VBuddy's data folder (logos\QTR.png). */
  logosDir?: string | null;
}

const NETWORK_OFF = { network: "off", state: "off", updatedAt: null, boundaries: false } as const;

export interface BridgeServer {
  http: Server;
  close(): Promise<void>;
  clientCount(): number;
}

/** What the VBuddy window on the bridge PC shows and can change. Only the PC itself may use it. */
export interface ConsoleHooks {
  info(): unknown;
  act(action: ConsoleAction, body: Record<string, unknown>): string | void | Promise<string | void>;
  /** The latest log lines, for the Activity page. */
  activity(): LogEntry[];
}
export type ConsoleAction = "relay" | "newCode" | "forget" | "integrations" | "autostart" | "installPlugin" | "reconnectSim" | "pause" | "updateCheck" | "updateInstall";

export interface RelayServerOptions {
  /** Random per run; the relay client sends it so requests through the relay can be told from loopback ones. */
  tag: string;
  /** "paired": relayed devices must pair before they see anything. "open": anyone with the address sees what the LAN sees (control still needs pairing). */
  access: "paired" | "open";
  /** This install's relay id: put into the home-screen app's start address so an installed app finds this PC again. */
  id?: string;
}

export function startServer(opts: { console?: ConsoleHooks | null; briefing?: BriefingService | null; acars?: HoppieService | null; flightAlerts?: { onAlert(cb: (a: FlightAlert) => void): void } | null; panel?: PanelService | null; cdu?: CduSource | null; systems?: SystemsSource | null; legs?: LegBook | null; atlas?: AtlasService | null; efb?: EfbProxy | null; efbPort?: number; simView?: FrameSource | null; chasePlane?: ChasePlaneLink | null; comms?: CommsService | null; relay?: RelayServerOptions | null; push?: PushService | null; hub: TelemetryHub; landings: LandingStore; history?: FlightHistory | null; network?: NetworkHub | null; cockpit?: CockpitHub | null; pairing?: Pairing | null; host: string; port: number; webDir: string | null } & ServerExtras): Promise<BridgeServer> {
  const { hub, landings } = opts;
  const history = opts.history ?? null;
  const legs = opts.legs ?? null;
  const atlas = opts.atlas ?? null;
  const efb = opts.efb ?? null;
  const network = opts.network ?? null;
  const cockpit = opts.cockpit ?? null;
  const pairing = opts.pairing ?? null;
  const push = opts.push ?? null;
  const comms = opts.comms ?? null;
  const panel = opts.panel ?? null;
  const systems = opts.systems ?? null;
  const relayOpt = opts.relay ?? null;
  const consoleHooks = opts.console ?? null;
  const briefing = opts.briefing ?? null;
  const acars = opts.acars ?? null;

  /** Through the relay? Only trusted when it arrives over loopback carrying this run's tag. */
  const relayInfo = (req: IncomingMessage): { relayed: boolean; addr: string } => {
    const sock = req.socket.remoteAddress ?? "?";
    if (relayOpt && isLocalAddress(sock) && req.headers[RELAY_TAG_HEADER] === relayOpt.tag) {
      const ip = String(req.headers[RELAY_REMOTE_HEADER] ?? "").trim();
      return { relayed: true, addr: ip || "relay" };
    }
    return { relayed: false, addr: "" };
  };
  const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];

  const controlFor = (c: Client): ControlInfo => {
    const reason = c.local ? "localhost" : c.device ? "paired" : "not-paired";
    const link = cockpit?.link() ?? { path: "none" as const, working: false, detail: "Cockpit control is turned off on the bridge (--control off)." };
    return { allowed: !!cockpit && reason !== "not-paired", reason, ...(c.device ? { deviceName: c.device.name } : {}), ...(c.locked ? { locked: true } : {}), ...link };
  };
  /** DMs and radio calls are private: only the bridge PC and paired devices see them. */
  const trusted = (c: Client) => c.local || !!c.device;

  // Live sim view (Cobalt's camera feed): frames only to paired devices and this PC that asked for them.
  // A frame is dropped for a viewer whose connection hasn't drained (a newer one follows in a third of a second).
  const SIM_VIEW_BACKLOG = 512 * 1024;
  const simViewers = () => [...clients].filter((c) => c.simView && trusted(c));
  const simView = opts.simView
    ? new SimViewFeed(
        opts.simView,
        (f) => {
          const payload = JSON.stringify(envelope({ t: "simViewFrame", ...f }));
          for (const c of simViewers()) if (c.ws.readyState === WebSocket.OPEN && c.ws.bufferedAmount < SIM_VIEW_BACKLOG) c.ws.send(payload);
        },
        (state, message) => {
          for (const c of simViewers()) send(c.ws, { t: "simViewStatus", state, ...(message ? { message } : {}) });
        },
        log,
      )
    : null;
  const recountSimView = () => simView?.setViewers(simViewers().length);

  // PMDG CDU screens: to paired devices and this PC watching that CDU, whenever the screen changes (at most 10/s), and
  // once a second in case only the message changed (e.g. the broadcast is off).
  const cduSrc = opts.cdu ?? null;
  const sendCdu = (c: Client) => {
    if (!cduSrc || c.cdu === undefined || !trusted(c)) return;
    const screen = cduSrc.screen(c.cdu);
    const json = JSON.stringify(screen);
    if (json === c.cduSent) return;
    c.cduSent = json;
    send(c.ws, { t: "cdu", side: c.cdu, screen });
  };
  if (cduSrc) {
    cduSrc.onCdu((side) => {
      for (const c of clients) if (c.cdu === side) sendCdu(c);
    });
  }
  const cduTick = cduSrc
    ? setInterval(() => {
        for (const c of clients) if (c.cdu !== undefined) sendCdu(c);
      }, 1000)
    : null;
  cduTick?.unref?.();
  const sendComms = (c: Client) => {
    if (!comms) return;
    send(c.ws, { t: "commsState", state: comms.state() });
    if (trusted(c)) send(c.ws, { t: "chatHistory", messages: comms.history() });
  };
  /** ACARS messages are private like DMs: only the PC and paired devices get them. */
  const sendAcars = (c: Client) => {
    if (acars && trusted(c)) send(c.ws, { t: "acarsState", state: acars.state() });
  };
  const sendPanel = (c: Client) => {
    if (panel) send(c.ws, { t: "panelState", state: panel.state() });
  };
  const sendLegs = (c: Client) => {
    if (legs) send(c.ws, { t: "legs", legs: legs.list() });
  };
  const sendSystems = (c: Client) => {
    if (systems) send(c.ws, { t: "systems", systems: systems.snapshot() });
  };
  const sendPush = (c: Client, note?: string) => {
    if (!push) return;
    send(c.ws, { t: "pushInfo", ...push.info(c.device?.id ?? null), ...(note ? { note } : {}) });
  };
  const sendCockpit = (c: Client) => send(c.ws, { t: "cockpit", state: cockpit?.state() ?? null, control: controlFor(c) });
  const sendPairingInfo = (c: Client) => {
    if (!c.local || !pairing) return;
    send(c.ws, { t: "pairingInfo", ...pairing.current(), devices: pairing.devicesList() });
  };

  const atcListBody = (): ServerMessageBody =>
    network ? { t: "atcList", status: network.status(), stations: network.stations() } : { t: "atcList", status: { ...NETWORK_OFF }, stations: [] };
  const sendTraffic = (c: Client) => {
    const tr = network?.traffic(c.area);
    if (tr) send(c.ws, { t: "traffic", ...tr });
  };
  const clients = new Set<Client>();
  /** Relayed devices that haven't paired yet: they get no data, only the chance to pair. */
  const pending = new Set<Client>();
  const serveStatic = opts.webDir ? staticHandler(opts.webDir) : null;

  const send = (ws: WebSocket, body: ServerMessageBody) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(envelope(body)));
  };


  /** Everything a client gets once it is allowed in: welcome (with any replay), logs, network and cockpit state. */
  const openSession = (client: Client) => {
    const ws = client.ws;
    const resume = client.resume;
    const replay = resume ? hub.resume(resume.sessionId, resume.lastSeq) : null;
    send(ws, {
      t: "welcome",
      sessionId: hub.sessionId,
      bridgeVersion: VERSION,
      latestSeq: hub.latestSeq(),
      telemetryHz: hub.hz,
      sim: hub.simStatus(),
      ...(replay ? { resume: { status: replay.status, replayCount: replay.frames.length, stride: replay.stride, fromDisk: replay.fromDisk } } : {}),
    });
    if (replay) {
      for (let i = 0; i < replay.frames.length; i += REPLAY_CHUNK) {
        send(ws, { t: "telemetryBatch", reason: "resume", frames: replay.frames.slice(i, i + REPLAY_CHUNK) });
      }
    }
    send(ws, { t: "landingList", landings: landings.list() });
    if (opts.plan) send(ws, { t: "flightPlan", plan: opts.plan.current() });
    send(ws, atcListBody());
    if (network) {
      send(ws, { t: "atcPosition", position: network.position() });
      sendTraffic(client);
    }
    sendCockpit(client);
    sendComms(client);
    sendAcars(client);
    sendPanel(client);
    sendSystems(client);
    sendLegs(client);
    sendPairingInfo(client);
    sendPush(client);
    clients.add(client);
    log.info(
      `${client.name} connected from ${client.addr}${client.relayed ? " (via relay)" : ""}` +
        (replay
          ? ` (resume: ${replay.status}, replayed ${replay.frames.length} frames` + (replay.fromDisk ? `, ${replay.fromDisk} from disk` : "") + (replay.stride > 1 ? `, every ${replay.stride}th` : "") + ")"
          : "") +
        ` - ${clients.size} client(s)`,
    );
  };

  /** The VBuddy window: only a browser on this PC, opened as localhost (so a web page or the relay can't reach it). */
  const isConsoleCaller = (req: IncomingMessage): boolean => {
    if (!isLocalAddress(req.socket.remoteAddress) || relayInfo(req).relayed || req.headers["x-forwarded-for"] !== undefined) return false;
    const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return false;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        if (new URL(String(origin)).host.toLowerCase() !== String(req.headers.host ?? "").toLowerCase()) return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const http = createServer(async (req, res) => {
    const url = req.url ?? "/";
    // The Fenix EFB, passed through under /efb/<session>/ (see efb/proxy.ts).
    if (efb && url.startsWith("/efb/") && efb.handle(req, res)) return;
    if (efb && url === "/api/efb") {
      // Is the EFB there, and (for this PC and paired devices only) the address to open it at.
      const reachable = await efb.probe();
      const allowed = isConsoleCaller(req) || (!!pairing && !!pairing.verify(bearer(req)));
      return json(res, 200, { reachable, port: opts.efbPort ?? 8083, path: allowed ? efb.mint() : null, needsPairing: !allowed });
    }
    if (url === "/api/console" || url.startsWith("/api/console/")) {
      if (!consoleHooks || !isConsoleCaller(req)) return json(res, 404, { error: "not found" });
      if (url === "/api/console" && req.method === "GET") return json(res, 200, consoleHooks.info());
      if (url === "/api/console/activity" && req.method === "GET") return json(res, 200, consoleHooks.activity());
      const m = /^\/api\/console\/(relay|newCode|forget|integrations|autostart|installPlugin|reconnectSim|pause|updateCheck|updateInstall)$/.exec(url);
      if (m && req.method === "POST" && req.headers["x-vbuddy-console"] === "1") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 2048) return json(res, 413, { error: "too big" });
        }
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          return json(res, 400, { error: "bad json" });
        }
        const note = await consoleHooks.act(m[1] as ConsoleAction, body);
        return json(res, 200, { ok: true, ...(note ? { note } : {}), info: consoleHooks.info() });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    if (url.startsWith("/api/") && url !== "/api/health" && relayOpt?.access === "paired" && relayInfo(req).relayed && !pairing?.verify(bearer(req))) {
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "pair this device first" }));
      return;
    }
    if (url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          ok: true,
          version: VERSION,
          sessionId: hub.sessionId,
          latestSeq: hub.latestSeq(),
          clients: clients.size,
          recording: history !== null,
          sim: hub.simStatus(),
        }),
      );
      return;
    }
    if (url === "/api/briefing" || url.startsWith("/api/briefing?")) {
      if (!briefing) return json(res, 404, { error: "not available" });
      const q = new URL(url, "http://x").searchParams;
      return json(res, 200, await briefing.get({ extra: q.get("icao"), refresh: q.get("refresh") === "1" }));
    }
    if (url === "/api/landings" || url.startsWith("/api/landings/")) {
      const id = url.length > "/api/landings/".length ? decodeURIComponent(url.slice("/api/landings/".length)) : null;
      const body = id === null ? landings.list(500) : landings.get(id);
      res.writeHead(body ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body ?? { error: "not found" }));
      return;
    }
    if (url.startsWith("/api/network/boundaries")) {
      const ids = (new URL(url, "http://x").searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 300);
      res.writeHead(network ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(network ? network.boundaries(ids) : { error: "network data is off" }));
      return;
    }
    const shotM = /^\/api\/screenshots\/([A-Za-z0-9._-]+)$/.exec(url);
    if (shotM) {
      const buf = opts.screenshots?.read(shotM[1]!) ?? null;
      if (!buf) return json(res, 404, { error: "no such screenshot" });
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(buf.length), "cache-control": "private, max-age=86400", "content-disposition": `inline; filename="${shotM[1]}"` });
      res.end(buf);
      return;
    }
    if (url === "/api/weather/info") return json(res, 200, opts.weatherInfo?.() ?? { clouds: false });
    const wxM = /^\/api\/weather\/(clouds|precipitation)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(url);
    if (wxM) {
      const tile = opts.weatherTile ? await opts.weatherTile(wxM[1]!, Number(wxM[2]), Number(wxM[3]), Number(wxM[4])).catch(() => null) : null;
      if (!tile) return json(res, 404, { error: "no weather tile" });
      res.writeHead(200, { "content-type": "image/png", "content-length": String(tile.length), "cache-control": "public, max-age=600" });
      res.end(tile);
      return;
    }
    const logoM = /^\/api\/airline-logo\/([A-Z0-9]{2,3})$/.exec(url);
    if (logoM) {
      const dir = opts.logosDir;
      const types: Array<[string, string]> = [["svg", "image/svg+xml"], ["png", "image/png"], ["webp", "image/webp"], ["jpg", "image/jpeg"]];
      const hit = dir ? types.map(([ext, type]) => ({ f: join(dir, `${logoM[1]}.${ext}`), type })).find((x) => fileExists(x.f)) : undefined;
      if (!hit) {
        res.writeHead(404, { "cache-control": "public, max-age=300" });
        res.end();
        return;
      }
      const buf = readFileNow(hit.f);
      res.writeHead(200, { "content-type": hit.type, "content-length": String(buf.length), "cache-control": "public, max-age=3600", ...(hit.type === "image/svg+xml" ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}) });
      res.end(buf);
      return;
    }
    if (url === "/api/flights" || url.startsWith("/api/flights/") || url.startsWith("/api/flights?") || url === "/api/atlas") {
      const u = new URL(url, "http://x");
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
      };
      if (!history) return json(404, { error: "the flight log is off" });
      try {
        const track = /^\/api\/flights\/(\d+)\/track$/.exec(u.pathname);
        if (u.pathname === "/api/flights") {
          const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit")) || 50));
          const rows = history.flights(limit);
          return json(200, atlas ? atlas.withFacts(rows) : rows);
        }
        if (u.pathname === "/api/atlas") {
          if (!atlas) return json(404, { error: "atlas is off" });
          return json(200, atlas.atlas(history.flights(1000)));
        }
        if (track) {
          const max = Math.min(20000, Math.max(2, Number(u.searchParams.get("max")) || 2000));
          const pts = history.track(Number(track[1]), max);
          return pts ? json(200, { fields: ["ts", "lat", "lon", "altMsl", "gs", "hdgTrue"], points: pts }) : json(404, { error: "not found" });
        }
      } catch (e) {
        return json(500, { error: (e as Error).message });
      }
      return json(404, { error: "not found" });
    }
    // Through the relay, the home-screen app must start at an address that carries the relay id (an installed app may not share the browser's cookie).
    if (opts.webDir && relayOpt?.id && url.split("?")[0] === "/manifest.webmanifest" && relayInfo(req).relayed) {
      try {
        const m = JSON.parse(await readFile(join(opts.webDir, "manifest.webmanifest"), "utf8")) as Record<string, unknown>;
        m.start_url = `/?r=${relayOpt.id}`;
        res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-cache" });
        res.end(JSON.stringify(m));
        return;
      } catch {
        /* fall through to the plain file */
      }
    }
    if (serveStatic && (await serveStatic(req, res))) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      serveStatic
        ? "Not found"
        : "VBuddy bridge is running, but the web client isn't built.\nRun `pnpm build` in the webapp folder, or use `pnpm dev` and open the Vite URL.",
    );
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const pluginWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  pluginWss.on("connection", (ws) => {
    log.info("vPilot plugin: connection opened");
    let linked: { send(m: unknown): void; close(): void } | null = null;
    // A vPilot that was killed leaves a half-open socket; ping so a dead one is dropped and the next start isn't confused by it.
    let alive = true;
    ws.on("pong", () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 10_000);
    const link = { send: (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)), close: () => ws.close(1000, "replaced") };
    const timer = setTimeout(() => ws.close(4000, "no hello"), HELLO_TIMEOUT_MS);
    ws.on("message", (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return;
      }
      const r = PluginToBridgeSchema.safeParse(json);
      if (!r.success) return;
      if (r.data.t === "hello") {
        clearTimeout(timer);
        linked = link;
        comms?.attachPlugin(link as never, r.data.plugin);
        link.send({ t: "welcome", protocol: 1 });
      } else if (linked) comms?.fromPlugin(r.data);
    });
    ws.on("close", (code) => {
      log.info(`vPilot plugin: connection closed (code ${code})`);
      clearTimeout(timer);
      clearInterval(beat);
      if (linked) comms?.detachPlugin(link as never);
    });
    ws.on("error", () => {});
  });

  http.on("upgrade", (req, socket, head) => {
    if (efb?.handleUpgrade(req, socket, head)) return;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === PLUGIN_PATH) {
      // The plugin lives inside vPilot on this PC: never through the relay, never from another machine.
      if (!comms || !isLocalAddress(req.socket.remoteAddress) || req.headers[RELAY_TAG_HEADER] !== undefined || req.headers["x-forwarded-for"] !== undefined) {
        log.warn(`Refused a plugin connection from ${req.socket.remoteAddress ?? "?"}: the VBuddy Link plugin must run on this PC and connect to 127.0.0.1 directly.`);
        socket.destroy();
        return;
      }
      pluginWss.handleUpgrade(req, socket, head, (ws) => pluginWss.emit("connection", ws, req));
      return;
    }
    if (path !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    // Behind a proxy on this same PC (the Vite dev server), trust its X-Forwarded-For; never from anywhere else.
    const sock = req.socket.remoteAddress ?? "?";
    const via = relayInfo(req);
    const fwd = !via.relayed && isLocalAddress(sock) ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
    const addr = via.relayed ? via.addr : fwd || sock;
    let client: Client | null = null;
    const helloTimer = setTimeout(() => {
      send(ws, { t: "error", code: "bad-message", message: "expected hello within 5s" });
      ws.close(4000, "no hello");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        send(ws, { t: "error", code: "bad-message", message: "binary frames are not supported" });
        return;
      }
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        const unsupported = parsed.error.startsWith("unsupported protocol version");
        send(ws, { t: "error", code: unsupported ? "unsupported-version" : "bad-message", message: parsed.error });
        if (unsupported || !client) ws.close(4001, "bad message");
        return;
      }
      const msg = parsed.msg;

      if (msg.t === "hello") {
        if (client) return; // duplicate hello: ignore
        clearTimeout(helloTimer);
        const device = pairing?.verify(msg.token) ?? null;
        client = {
          ws,
          name: msg.client ?? "client",
          alive: true,
          area: null,
          addr,
          local: !via.relayed && isLocalAddress(addr),
          device,
          relayed: via.relayed,
          locked: via.relayed && relayOpt?.access === "paired" && !device,
          resume: msg.resume,
        };
        if (client.locked) {
          // Nothing but pairing until this device proves itself.
          sendCockpit(client);
          pending.add(client);
          log.info(`${client.name} reached the relay from ${addr}; waiting for it to pair`);
          return;
        }
        openSession(client);
        return;
      }

      if (!client) {
        send(ws, { t: "error", code: "bad-message", message: "send hello first" });
        ws.close(4001, "hello first");
        return;
      }
      if (msg.t === "ping") send(ws, { t: "pong", nonce: msg.nonce });
      else if (client.locked && msg.t !== "pair") {
        send(ws, { t: "error", code: "not-allowed", message: "Pair this device first." });
      } else if (msg.t === "cmd") {
        const c = client;
        const id = msg.id;
        if (!controlFor(c).allowed) {
          send(ws, { t: "cmdResult", id, ok: false, error: cockpit ? "This device isn't paired. Pair it under Systems → Controls first." : "Cockpit control is turned off on the bridge." });
          return;
        }
        void cockpit!.run(msg.cmd).then((r) => send(ws, { t: "cmdResult", id, ...r }));
      } else if (msg.t === "cockpitRetry") {
        if (controlFor(client).allowed) cockpit?.retry();
      } else if (msg.t === "pair") {
        if (!pairing) {
          send(ws, { t: "pairResult", ok: false, error: "Pairing isn't available." });
          return;
        }
        const r = pairing.pair(msg.code, msg.device, client.addr);
        if (r.ok) {
          client.device = r.device;
          send(ws, { t: "pairResult", ok: true, token: r.token });
          if (client.locked) {
            client.locked = false;
            pending.delete(client);
            openSession(client);
          } else {
            sendCockpit(client);
            sendComms(client);
            sendAcars(client);
            sendPush(client);
          }
          for (const c of clients) sendPairingInfo(c);
        } else send(ws, { t: "pairResult", ok: false, error: r.error });
      } else if (msg.t === "revokeDevice" || msg.t === "newPairingCode") {
        if (!client.local || !pairing) {
          send(ws, { t: "error", code: "not-allowed", message: "Only possible on the bridge PC." });
          return;
        }
        if (msg.t === "newPairingCode") pairing.rotate();
        else if (pairing.revoke(msg.id)) {
          push?.unsubscribe(msg.id);
          for (const c of [...clients]) {
            if (c.device?.id !== msg.id) continue;
            c.device = null;
            if (c.simView) queueMicrotask(recountSimView);
            if (c.relayed && relayOpt?.access === "paired") c.ws.close(4003, "removed");
            else {
              sendCockpit(c);
              sendComms(c);
              sendAcars(c);
              sendPush(c);
            }
          }
        }
      } else if (msg.t === "commsCmd") {
        const id = msg.id;
        if (!comms) {
          send(ws, { t: "commsResult", id, ok: false, error: "Comms aren't available on this bridge." });
        } else if (!trusted(client)) {
          send(ws, { t: "commsResult", id, ok: false, error: "Pair this device first (Systems → Controls)." });
        } else void comms.run(msg.cmd).then((r) => send(ws, { t: "commsResult", id, ...r }));
      } else if (msg.t === "acarsCmd") {
        const id = msg.id;
        if (!acars) {
          send(ws, { t: "acarsResult", id, ok: false, error: "ACARS isn't available on this bridge." });
        } else if (!trusted(client)) {
          send(ws, { t: "acarsResult", id, ok: false, error: "Pair this device first (Systems → Controls)." });
        } else void acars.run(msg.cmd).then((r) => send(ws, { t: "acarsResult", id, ...r }));
      } else if (msg.t === "legCmd") {
        const id = msg.id;
        if (!legs) {
          send(ws, { t: "legResult", id, ok: false, error: "Planned flights need the flight log, which is off." });
        } else if (!trusted(client)) {
          send(ws, { t: "legResult", id, ok: false, error: "Pair this device first (Systems → Controls)." });
        } else {
          const r = legs.run(msg.cmd);
          send(ws, { t: "legResult", id, ...r });
        }
      } else if (msg.t === "chaseCmd") {
        const id = msg.id;
        const cp = opts.chasePlane;
        if (!cp) send(ws, { t: "chaseResult", id, ok: false, error: "ChasePlane isn't available on this bridge." });
        else if (!trusted(client)) send(ws, { t: "chaseResult", id, ok: false, error: "Pair this device first (Systems → Controls)." });
        else if (msg.cmd.op === "views") {
          void cp.views().then(
            (r) => send(ws, { t: "chaseResult", id, ok: true, views: r.views.slice(0, 2000), airport: r.airport }),
            (e: Error) => send(ws, { t: "chaseResult", id, ok: false, error: e.message }),
          );
        } else {
          void cp.setView(msg.cmd.guid).then(
            () => send(ws, { t: "chaseResult", id, ok: true }),
            (e: Error) => send(ws, { t: "chaseResult", id, ok: false, error: e.message }),
          );
        }
      } else if (msg.t === "cduView") {
        if (!msg.on) client.cdu = undefined;
        else if (!cduSrc) send(ws, { t: "cdu", side: msg.side, screen: null });
        else if (!trusted(client)) send(ws, { t: "cduResult", ok: false, error: "Pair this device first (Systems → Controls) to use the CDU." });
        else {
          client.cdu = msg.side;
          client.cduSent = undefined;
          sendCdu(client);
        }
      } else if (msg.t === "cduKey") {
        if (!cduSrc) send(ws, { t: "cduResult", ok: false, error: "There is no CDU on this bridge." });
        else if (!trusted(client)) send(ws, { t: "cduResult", ok: false, error: "Pair this device first (Systems → Controls)." });
        else
          void cduSrc.key(msg.side, msg.key).then((r) => {
            if (!r.ok) send(ws, { t: "cduResult", ok: false, error: r.error });
          });
      } else if (msg.t === "simView") {
        if (!simView) send(ws, { t: "simViewStatus", state: "unavailable", message: "The sim view isn't available on this bridge." });
        else if (msg.on && !trusted(client)) send(ws, { t: "simViewStatus", state: "not-allowed", message: "Pair this device first (Systems → Controls) to see the sim." });
        else {
          client.simView = msg.on;
          recountSimView();
          if (msg.on) {
            const st = simView.status();
            send(ws, { t: "simViewStatus", state: st.state, ...(st.message ? { message: st.message } : {}) });
          }
        }
      } else if (msg.t === "visibility") {
        client.visible = msg.visible;
      } else if (msg.t === "screenshot") {
        const id = msg.id;
        const shots = opts.screenshots;
        if (!shots || !shots.available()) send(ws, { t: "screenshotResult", id, ok: false, error: "Screenshots aren't available on this bridge." });
        else if (!trusted(client)) send(ws, { t: "screenshotResult", id, ok: false, error: "Pair this device first (Systems → Controls) to take screenshots." });
        else
          void shots.take().then(
            (r) => send(ws, r.ok ? { t: "screenshotResult", id, ok: true, name: r.name, w: r.w, h: r.h, bytes: r.bytes } : { t: "screenshotResult", id, ok: false, error: r.error }),
            (e: Error) => send(ws, { t: "screenshotResult", id, ok: false, error: e.message }),
          );
      } else if (msg.t === "panelCmd") {
        const id = msg.id;
        if (!panel) {
          send(ws, { t: "panelResult", id, ok: false, error: "Lights and autopilot aren't available on this bridge." });
        } else if (!trusted(client)) {
          send(ws, { t: "panelResult", id, ok: false, error: "Pair this device first (Systems → Controls)." });
        } else void panel.run(msg.cmd).then((r) => send(ws, { t: "panelResult", id, ...r }));
      } else if (msg.t === "pushSubscribe" || msg.t === "pushUnsubscribe" || msg.t === "pushTest") {
        if (!push) {
          send(ws, { t: "error", code: "not-allowed", message: "Notifications aren't available on this bridge." });
          return;
        }
        if (!client.device) {
          send(ws, { t: "error", code: "not-allowed", message: "Pair this device before turning on notifications." });
          return;
        }
        if (msg.t === "pushSubscribe") {
          push.subscribe(client.device.id, msg.subscription, msg.prefs);
          sendPush(client, "Notifications are on for this device.");
        } else if (msg.t === "pushUnsubscribe") {
          push.unsubscribe(client.device.id);
          sendPush(client, "Notifications are off for this device.");
        } else void push.test(client.device.id).then((ok) => sendPush(client!, ok ? "Test sent." : "Turn notifications on first."));
      } else if (msg.t === "trafficArea") {
        client.area = { lat: msg.lat, lon: msg.lon, radiusNm: msg.radiusNm };
        sendTraffic(client);
      }
      else if (msg.t === "getLanding") {
        const l = landings.get(msg.id);
        if (l) send(ws, { t: "landing", reason: "requested", landing: l });
        else send(ws, { t: "error", code: "not-found", message: `no landing ${msg.id}` });
      }
    });

    ws.on("pong", () => {
      if (client) client.alive = true;
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (client) pending.delete(client);
      if (client && clients.delete(client)) log.info(`${client.name} (${addr}) disconnected - ${clients.size} client(s)`);
      if (client?.simView) recountSimView();
    });
    ws.on("error", (e) => log.debug(`socket error from ${addr}: ${e.message}`));
  });

  hub.onFrame((frame) => {
    if (clients.size === 0) return;
    const payload = JSON.stringify(envelope({ t: "telemetry", frame }));
    for (const c of clients) {
      if (c.ws.readyState === WebSocket.OPEN && c.ws.bufferedAmount < MAX_BUFFERED_BYTES) c.ws.send(payload);
    }
  });
  landings.onAdd((landing) => {
    for (const c of clients) send(c.ws, { t: "landing", reason: "new", landing });
  });
  if (network) {
    let lastAtc = "";
    network.onUpdate(() => {
      const body = atcListBody();
      const text = JSON.stringify(body);
      for (const c of clients) {
        if (text !== lastAtc) send(c.ws, body);
        sendTraffic(c);
      }
      lastAtc = text;
    });
    network.onPosition((position) => {
      for (const c of clients) send(c.ws, { t: "atcPosition", position });
    });
    network.onAlert((alert) => {
      for (const c of clients) send(c.ws, { t: "atcAlert", alert });
    });
  }
  acars?.onState(() => {
    for (const c of clients) sendAcars(c);
  });
  opts.flightAlerts?.onAlert((alert) => {
    for (const c of clients) send(c.ws, { t: "flightAlert", alert });
  });
  opts.flightEvents?.onEvent((event) => {
    for (const c of clients) send(c.ws, { t: "flightEvent", event });
  });
  opts.plan?.onChange((plan) => {
    for (const c of clients) send(c.ws, { t: "flightPlan", plan });
  });
  // Notifications aren't pushed to a device that has the app on its screen.
  push?.setWatching((id) => [...clients].some((c) => c.device?.id === id && c.visible === true && c.ws.readyState === WebSocket.OPEN));
  comms?.onState(() => {
    for (const c of clients) send(c.ws, { t: "commsState", state: comms.state() });
  });
  legs?.onChange(() => {
    for (const c of clients) sendLegs(c);
  });
  systems?.onChange(() => {
    for (const c of clients) sendSystems(c);
  });
  panel?.onChange(() => {
    for (const c of clients) sendPanel(c);
  });
  comms?.onChat((message) => {
    for (const c of clients) if (trusted(c)) send(c.ws, { t: "chat", message });
  });
  cockpit?.onChange(() => {
    for (const c of clients) sendCockpit(c);
  });
  pairing?.onChange(() => {
    for (const c of clients) sendPairingInfo(c);
  });
  // Pairing codes expire; current() replaces an expired one (and onChange tells the PC's screen).
  const pairingTimer = pairing
    ? setInterval(() => {
        pairing.current();
      }, 15_000)
    : null;
  pairingTimer?.unref();
  hub.onStatus((sim) => {
    for (const c of clients) send(c.ws, { t: "simStatus", sim });
  });

  const heartbeat = setInterval(() => {
    // A device forgotten from the VBuddy window stops counting as a viewer.
    recountSimView();
    for (const c of [...clients, ...pending]) {
      if (!c.alive) {
        log.info(`${c.name} stopped responding; dropping it`);
        c.ws.terminate();
        clients.delete(c);
        pending.delete(c);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, HEARTBEAT_MS);

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => {
      http.off("error", reject);
      resolve({
        http,
        clientCount: () => clients.size,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            simView?.stop();
            opts.chasePlane?.close();
            if (pairingTimer) clearInterval(pairingTimer);
            if (cduTick) clearInterval(cduTick);
            pairing?.flush();
            for (const c of [...clients, ...pending]) c.ws.close(1001, "bridge shutting down");
            wss.close();
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
