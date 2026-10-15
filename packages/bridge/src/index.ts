#!/usr/bin/env node
import { networkInterfaces } from "node:os";
import { DEFAULT_RELAY_URL, loadConfig } from "./config.js";
import { ensureSettingsFile } from "./env-file.js";
import { TelemetryHub } from "./hub.js";
import { logger, recentLogs } from "./log.js";
import { autostartState, installPlugin, pluginState, setAutostart } from "./host/windows.js";
import { LandingAnalyzer } from "./landing/analyzer.js";
import { FlightDb } from "./db/flight-db.js";
import { importLandingsJsonl } from "./db/import-jsonl.js";
import { FlightRecorder } from "./db/recorder.js";
import { LegBook } from "./db/legs.js";
import { EfbProxy } from "./efb/proxy.js";
import { Airports, AtlasService } from "./atlas/atlas.js";
import { PauseScheduleSchema, summarize, type FlightAlert, type Telemetry } from "@vbuddy/protocol";
import { LandingStore } from "./landing/store.js";
import { SectorLoader } from "./network/sector-loader.js";
import { NetworkService } from "./network/service.js";
import { VatsimFeed } from "./network/vatsim-feed.js";
import { tmpdir } from "node:os";
import { Pairing } from "./control/pairing.js";
import { CockpitService, type CockpitHub } from "./cockpit/service.js";
import { CombinedCockpit } from "./cockpit/airliner.js";
import { MockCockpit } from "./cockpit/mock-cockpit.js";
import { FenixSim } from "./cockpit/fenix-sim.js";
import { startServer, type ConsoleAction } from "./server.js";
import { RelayClient } from "./relay/relay-client.js";
import { loadRelayIdentity, phoneLink } from "./relay/identity.js";
import { readPrefs, writePrefs } from "./relay/console-prefs.js";
import { IntegrationStore } from "./integrations/store.js";
import { BriefingService } from "./briefing/service.js";
import { HoppieService } from "./acars/hoppie.js";
import { CommsService } from "./comms/service.js";
import { SimRadios } from "./comms/sim-radios.js";
import { MockRadios } from "./comms/mock-radios.js";
import { MockPlugin } from "./comms/mock-plugin.js";
import { PushService } from "./push/service.js";
import { FlightAlerts } from "./alerts/engine.js";
import { EMPTY_EXTRAS, type SimExtras } from "./sim/source.js";
import { PmdgPanel } from "./pmdg/pmdg-panel.js";
import { MockCdu } from "./pmdg/mock-cdu.js";
import { describeSetup, setupPmdgSdk } from "./pmdg/sdk-setup.js";
import { PauseScheduler } from "./sim/pause-scheduler.js";
import { PanelService } from "./panel/service.js";
import { SimPanel } from "./panel/sim-panel.js";
import { MockPanel } from "./panel/mock-panel.js";
import { MockSystems, SimSystems } from "./panel/systems-reader.js";
import { randomBytes } from "node:crypto";
import { MockSource } from "./sim/mock-source.js";
import { SimConnectSource } from "./sim/simconnect-source.js";
import type { SimSource } from "./sim/source.js";
import { VERSION } from "./version.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankLanAddresses } from "./lan.js";
import { MockCapture, NoCapture, WindowsCapture } from "./simview/capture.js";
import { ChasePlaneClient, MockChasePlane } from "./chaseplane/client.js";
import { Updater, windowsLaunch } from "./update/updater.js";

const log = logger("bridge");

const lanAddresses = rankLanAddresses;

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  log.info(`VBuddy bridge ${VERSION} (${cfg.mock ? "MOCK flight" : "MSFS via SimConnect"})`);
  if (!cfg.mock && cfg.dataDir) {
    const settings = ensureSettingsFile(cfg.dataDir);
    if (settings) log.info(`Settings file: ${settings}`);
  }
  const source: SimSource = cfg.mock ? new MockSource({ quick: cfg.mockQuick }) : new SimConnectSource(cfg.simconnect);
  const hub = new TelemetryHub(source, cfg.telemetryHz, cfg.backlogMinutes);

  // The flight log: telemetry, flights and landings in one SQLite file. If it can't be opened the bridge still runs, just without history.
  const dbFile = cfg.dataDir ? join(cfg.dataDir, "flights.db") : null;
  const db = dbFile ? await FlightDb.open(dbFile, logger("flightlog")) : null;
  if (db && cfg.dataDir) await importLandingsJsonl(join(cfg.dataDir, "landings.jsonl"), db, logger("flightlog"));

  let recorder: FlightRecorder | null = null;
  let atlas: AtlasService | null = null;
  // The SimBrief plan service is made further down; the recorder asks it which route the pilot has planned.
  let briefingRef: BriefingService | null = null;
  // Works out how far each finished flight went before its telemetry is pruned (the distance is kept; the route is not).
  const settleAndPrune = () => {
    if (!recorder) return;
    try {
      atlas?.withFacts(recorder.flights(1000));
    } catch (e) {
      logger("flightlog").warn(`Couldn't total up the flights before clearing old telemetry: ${(e as Error).message}`);
    }
    recorder.prune(cfg.keepHours);
  };
  if (db && cfg.keepHours > 0) {
    recorder = new FlightRecorder(db, hub.sessionId, cfg.mock ? "mock" : "simconnect", () => source.status().aircraftTitle ?? "", logger("flightlog"), {}, () => briefingRef?.cachedEndpoints() ?? null);
    hub.onFrame((f) => recorder!.onFrame(f));
    hub.onStatus((s) => recorder!.onStatus(s));
    hub.setArchive(recorder);
    atlas = new AtlasService(new Airports(), (id, max) => recorder!.track(id, max), (id, nm) => recorder!.setDistance(id, nm));
    settleAndPrune();
    recorder.start();
  }
  const legs = db ? new LegBook(db) : null;
  // The Fenix EFB (its own web app on this PC), reachable from a paired device anywhere, through the relay too.
  const efb = new EfbProxy(() => cfg.efbPort, logger("efb"));
  const pruneTimer = recorder ? setInterval(settleAndPrune, 3_600_000) : null;
  pruneTimer?.unref();

  // Landing analysis sees every sim frame, not the 5 Hz client stream.
  const landings = new LandingStore(
    db ? { save: (l) => (recorder ? recorder.saveLanding(l) : void db.insertLanding(l, null)), loadRecent: (n) => db.recentLandingJson(n) } : null,
    logger("landings"),
  );
  landings.load();
  const analyzer = new LandingAnalyzer(() => ({
    aircraftTitle: source.status().aircraftTitle,
    source: cfg.mock ? "mock" : "simconnect",
  }));
  source.onSample((t, at) => analyzer.ingest(t, at));
  source.onExtras((x) => analyzer.setExtras(x));
  let lastTitle = "";
  // Updates (as Cobalt's bridge: 6-hourly, downloads wait while the simulator is connected).
  const updater = new Updater({
    current: VERSION,
    edition: cfg.edition,
    packaged: cfg.packaged && !cfg.mock,
    disabled: cfg.noUpdates,
    dir: cfg.dataDir,
    repo: cfg.updateRepo,
    simConnected: () => source.status().connected,
    log: logger("update"),
    launch: process.platform === "win32" ? windowsLaunch : undefined,
  });
  source.onStatus(() => updater.simChanged());
  source.onStatus((s) => {
    if (!s.connected) {
      analyzer.reset();
      lastTitle = "";
    } else if (s.aircraftTitle !== lastTitle) {
      // A different aircraft (or the first one after connecting): the sim reports odd values while it loads.
      if (lastTitle || s.aircraftTitle) analyzer.spawn();
      lastTitle = s.aircraftTitle;
    }
  });
  const lLog = logger("landing");
  analyzer.onLanding((l) => {
    const flags = [l.touchAndGo ? "touch-and-go" : "", l.bounces ? `${l.bounces} bounce(s)` : "", l.lowConfidence ? "low confidence" : ""].filter(Boolean);
    lLog.info(
      `Touchdown ${l.vsFpm} fpm (${l.vsSource}), ${l.gPeak.toFixed(2)} g, ${l.rating.toUpperCase()}` + (flags.length ? ` [${flags.join(", ")}]` : ""),
    );
    landings.add(l);
  });
  const flushTimer = setInterval(() => analyzer.flush(Date.now()), 1000);

  // Online network: traffic, ATC sectors and boundary alerts. Polls only while a client or the sim is connected.
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let network: NetworkService | null = null;
  let sectorTimer: NodeJS.Timeout | null = null;
  if (cfg.network === "vatsim") {
    const nLog = logger("network");
    const feed = new VatsimFeed({
      log: nLog,
      feedUrl: cfg.networkUrls.feed,
      wanted: () => (server?.clientCount() ?? 0) > 0 || source.status().connected,
    });
    network = new NetworkService(feed, null, nLog, cfg.callsign);
    hub.onFrame((f) => network!.setOwn(f.data));
    hub.onStatus((s) => {
      if (!s.connected) network!.setOwn(null);
    });
    const loader = new SectorLoader({
      dir: cfg.dataDir ? join(cfg.dataDir, "network") : join(tmpdir(), "vbuddy-network"),
      log: nLog,
      vatspyBase: cfg.networkUrls.vatspyBase,
      traconUrl: cfg.networkUrls.tracon,
    });
    const loadSectors = () => void loader.load().then((s) => s && network!.setSectors(s));
    loadSectors();
    sectorTimer = setInterval(loadSectors, 24 * 3_600_000);
    sectorTimer.unref();
  }

  // Cockpit control: the Fenix FCU (or a pretend one with the mock flight), only for paired devices and this PC.
  let cockpit: CockpitHub | null = null;
  let fenixCockpit: CockpitService | null = null;
  let pairing: Pairing | null = null;
  if (cfg.control) {
    const cLog = logger("cockpit");
    const backend = source instanceof SimConnectSource ? new FenixSim(source, cLog) : new MockCockpit();
    fenixCockpit = new CockpitService(backend, cLog);
    cockpit = fenixCockpit;
    // The Fenix keeps its own autopilot: its AP1/AP2 lights count as "autopilot on" in the live data.
    hub.setApOverride(() => {
      const v = backend.values();
      return !!v && (v.I_FCU_AP1 !== 0 || v.I_FCU_AP2 !== 0);
    });
    pairing = new Pairing(cfg.dataDir ? join(cfg.dataDir, "paired-devices.json") : null, logger("pairing"));
  }

  // Phone notifications: sent straight from this PC to the browser's push service. Only paired devices can subscribe.
  let push: PushService | null = null;
  if (cfg.push && pairing) {
    push = new PushService(cfg.dataDir ? join(cfg.dataDir, "push-subscriptions.json") : null, cfg.dataDir ? join(cfg.dataDir, "push-vapid.json") : null, cfg.pushContact, logger("push"));
    landings.onAdd((l) => {
      void push!.notifyLanding(summarize(l));
    });
    network?.onAlert((a) => {
      void push!.notifyAtc(a);
    });
    network?.onPosition((p) => {
      void push!.notifyAtcAhead(p);
    });
  }
  // Aircraft alerts: fed from the sim, shown in the open app and pushed to devices that want them. Low fuel is judged per device.
  const flight = new FlightAlerts();
  const flightAlertCbs: Array<(a: FlightAlert) => void> = [];
  let simExtras: SimExtras = EMPTY_EXTRAS;
  let lastFlightAt = 0;
  let lastFuelAt = 0;
  let lastPlanAt = 0;
  source.onExtras((x) => (simExtras = x));
  // The descent point comes from the SimBrief plan; refreshed every few minutes while airborne.
  const loadTodPlan = async () => {
    const fixes = await briefing.routeFixes();
    const tod = fixes.find((f) => f.ident.toUpperCase() === "TOD" && f.lat !== null && f.lon !== null);
    const dest = fixes[fixes.length - 1];
    flight.setTodPlan(
      tod ? { kind: "fix", lat: tod.lat!, lon: tod.lon! } : dest && dest.lat !== null && dest.lon !== null ? { kind: "dest", lat: dest.lat, lon: dest.lon, elevFt: dest.altFt ?? 0 } : null,
    );
  };
  let lastSample: { t: Telemetry; at: number } | null = null;
  source.onSample((t, at) => {
    lastSample = { t, at: Date.now() };
    if (at - lastFlightAt < 500) return;
    lastFlightAt = at;
    // The aircraft's own autopilot (the Fenix) counts, as it does in the live data.
    const own = !t.ap.master && hub.apOverrideOn();
    for (const a of flight.update(own ? { ...t, ap: { ...t.ap, master: true } } : t, simExtras, at)) {
      log.info(`Alert: ${a.title}. ${a.text}`);
      for (const cb of flightAlertCbs) cb(a);
      void push?.notifyAlert(a);
    }
    if (!t.onGround && at - lastPlanAt >= 5 * 60_000) {
      lastPlanAt = at;
      void loadTodPlan().catch(() => {});
    }
    if (t.onGround) lastPlanAt = 0;
    if (push) void push.notifyTod(flight.todMinAway, flight.todNm);
    if (push && at - lastFuelAt >= 5000) {
      lastFuelAt = at;
      void push.notifyFuel(flight.enduranceMin, flight.fuelText());
    }
  });
  source.onStatus((s) => {
    if (!s.connected) flight.reset();
  });
  // Radios, transponder, VATSIM connection and chat. The radios come from the sim; chat and connect go through the vPilot plugin.
  const comms = new CommsService(source instanceof SimConnectSource ? new SimRadios(source) : new MockRadios(), logger("comms"), cfg.dataDir ? join(cfg.dataDir, "comms-identity.json") : null);
  if (push) {
    comms.onChat((m) => {
      if (m.attention && m.dir === "in") void push!.notifyChat(m);
    });
    // Connected to / disconnected from VATSIM.
    let wasConnected = comms.state().net.connected;
    comms.onState(() => {
      const n = comms.state().net;
      if (n.connected !== wasConnected) void push!.notifyVatsim(n.connected, n.callsign, n.pluginLinked);
      wasConnected = n.connected;
    });
  }
  // Lights and autopilot. PMDG 737 / 777 are driven from their own SDK data and events (the header is found in the aircraft's package, or in the `sdk` folder);
  // everything else goes through the standard events and the add-on profiles in panel/addons.ts.
  const simPanel = source instanceof SimConnectSource ? new SimPanel(source) : null;
  // The iniBuilds A340 / A350 / A380 get the same FCU screen as the Fenix, through their input events.
  if (fenixCockpit && simPanel) cockpit = new CombinedCockpit(fenixCockpit, simPanel);
  // The PMDG headers are copied from the aircraft into %APPDATA%\VBuddy\sdk (and refreshed when the aircraft is updated), and the
  // aircraft's options .ini gets the [SDK] lines that turn its data on: at start, and again on every aircraft change.
  let pmdgPanel: PmdgPanel | null = null;
  if (source instanceof SimConnectSource && simPanel) {
    const pLog = logger("pmdg");
    const setup = (o: { headers: boolean }) => setupPmdgSdk({ dataDir: cfg.dataDir ?? undefined, headers: o.headers });
    const first = setupPmdgSdk({ dataDir: cfg.dataDir ?? undefined });
    for (const line of describeSetup(first)) pLog.info(line);
    for (const e of first.errors) pLog.warn(`PMDG setup: ${e}`);
    // The copy in the data folder comes first: it's kept the same as the installed aircraft's.
    const sdkDirs = [...(cfg.dataDir ? [join(cfg.dataDir, "sdk")] : []), join(process.cwd(), "sdk"), fileURLToPath(new URL("../../../sdk", import.meta.url))];
    pmdgPanel = new PmdgPanel(source, simPanel, pLog, { sdkDirs, setup });
  }
  const panelBackend = pmdgPanel ?? new MockPanel(cfg.mockAircraft);
  const panel = new PanelService(panelBackend, logger("panel"));
  const cdu = panelBackend instanceof PmdgPanel ? panelBackend : new MockCdu();
  const systems = source instanceof SimConnectSource ? new SimSystems(source, logger("systems")) : new MockSystems();
  // A scheduled pause is kept on the PC so it still happens when the phone is away. The top-of-descent estimate comes from the plan.
  const pauser = new PauseScheduler({
    now: Date.now,
    flight: () => {
      return lastSample && Date.now() - lastSample.at < 5000 ? { altMsl: lastSample.t.altMsl, vs: lastSample.t.vs, onGround: lastSample.t.onGround } : null;
    },
    todMin: () => flight.todMinAway,
    paused: () => source.status().paused,
    pause: () => panelBackend.sys("pause", 1),
  });
  panel.attachPauseScheduler(pauser);
  setInterval(() => pauser.tick(), 500).unref();
  const mockPlugin = cfg.mock ? new MockPlugin(comms) : null;
  const relayTag = randomBytes(24).toString("base64url");

  // The cloud relay: this install's own id and key (made on first run) pick this PC on a shared relay; nothing secret is built in.
  const identity = loadRelayIdentity(cfg.dataDir ? join(cfg.dataDir, "relay-identity.json") : null);
  const prefsFile = cfg.dataDir ? join(cfg.dataDir, "console-settings.json") : null;
  const relayAllowed = cfg.edition !== "local";
  let relayOn = relayAllowed && (readPrefs(prefsFile).relay ?? cfg.relayOn ?? false);
  const relayClient = new RelayClient({ url: cfg.relayUrl, id: identity.id, key: identity.key, localPort: cfg.port, tag: relayTag, name: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "bridge", log: logger("relay") });

  const integrations = new IntegrationStore(cfg.dataDir ? join(cfg.dataDir, "integrations.json") : null);
  const briefing = new BriefingService((url, init) => fetch(url, init), () => integrations.get().simbrief);
  briefingRef = briefing;
  // Keep the plan's route fresh, so a flight can be tied to the plan that was filled in when it began.
  void briefing.endpoints().catch(() => {});
  const planTimer = setInterval(() => void briefing.endpoints().catch(() => {}), 120_000);
  planTimer.unref();

  const acars = new HoppieService(
    (url, init) => fetch(url, init),
    () => integrations.get().hoppie,
    () => comms.state().net.callsign ?? briefing.cachedCallsign(),
    () => source.status().connected,
    () => briefing.get(),
    logger("acars"),
  );

  const consoleInfo = () => {
    const p = pairing?.current() ?? null;
    return {
      version: VERSION,
      port: cfg.port,
      mock: cfg.mock,
      addresses: cfg.host === "0.0.0.0" ? lanAddresses().map((a) => `http://${a}:${cfg.port}`) : [`http://${cfg.host}:${cfg.port}`],
      sim: { connected: source.status().connected, aircraft: source.status().aircraftTitle || null },
      vpilot: { linked: comms.state().net.pluginLinked },
      clients: server?.clientCount() ?? 0,
      pairing: p ? { code: p.code, expiresAt: p.expiresAt } : null,
      devices: pairing?.devicesList() ?? [],
      relay: {
        available: relayAllowed,
        enabled: relayOn,
        state: relayClient.state,
        url: cfg.relayUrl,
        shared: cfg.relayUrl === DEFAULT_RELAY_URL,
        id: identity.id,
        phoneLink: phoneLink(cfg.relayUrl, identity.id),
        access: cfg.relayAccess,
        error: relayOn ? relayClient.lastError : "",
      },
      accounts: { simbrief: integrations.get().simbrief, hoppieSet: integrations.get().hoppie !== "" },
      dataDir: cfg.dataDir,
      host: { autostart: autostartState(), plugin: pluginState(), canReconnect: source instanceof SimConnectSource },
      pause: pauser.status(),
      update: updater.state(),
    };
  };
  const consoleAct = (action: ConsoleAction, body: Record<string, unknown>): string | void | Promise<string | void> => {
    if (action === "relay") {
      if (!relayAllowed) return "This edition of VBuddy works on your home network only.";
      relayOn = body.enabled === true;
      writePrefs(prefsFile, { relay: relayOn });
      if (relayOn) relayClient.start();
      else relayClient.stop();
      log.info(`Relay: ${relayOn ? "switched on" : "switched off"} from the VBuddy window`);
    } else if (action === "newCode") {
      pairing?.rotate();
    } else if (action === "integrations") {
      const err = integrations.set({ simbrief: body.simbrief, hoppie: body.hoppie });
      acars.changed();
      return err ?? undefined;
    } else if (action === "forget" && typeof body.id === "string") {
      pairing?.revoke(body.id);
    } else if (action === "autostart") {
      return setAutostart(body.on === true);
    } else if (action === "installPlugin") {
      const err = installPlugin();
      if (!err) log.info("vPilot plugin installed from the VBuddy window. Restart vPilot to load it.");
      return err ?? undefined;
    } else if (action === "updateCheck") {
      return updater.check("manual").then((st) => (st.status.kind === "error" ? st.text : undefined));
    } else if (action === "updateInstall") {
      return updater.install();
    } else if (action === "reconnectSim") {
      if (source instanceof SimConnectSource) source.reconnectNow();
      else return "There is no simulator connection to restart in a test flight.";
    } else if (action === "pause") {
      if (body.cancel === true) {
        pauser.cancel();
        return;
      }
      const sch = PauseScheduleSchema.safeParse(body.schedule);
      if (!sch.success) return "That pause time isn't valid.";
      const r = pauser.set(sch.data);
      return r.ok ? undefined : r.error;
    }
  };

  try {
    server = await startServer({ console: { info: consoleInfo, act: consoleAct, activity: recentLogs }, briefing, acars, flightAlerts: { onAlert: (cb) => void flightAlertCbs.push(cb) }, panel, cdu, systems, comms, relay: { tag: relayTag, access: cfg.relayAccess, id: identity.id }, push, hub, landings, history: recorder, legs, atlas, efb, efbPort: cfg.efbPort, chasePlane: cfg.mock ? new MockChasePlane() : new ChasePlaneClient(logger("chaseplane")), simView: cfg.mock ? new MockCapture() : process.platform === "win32" ? new WindowsCapture(logger("simview")) : new NoCapture(), network, cockpit, pairing, host: cfg.host, port: cfg.port, webDir: cfg.webDir });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") log.error(`Port ${cfg.port} is already in use. Is another bridge running? Use --port to pick another.`);
    else log.error(`Could not start the server: ${err.message}`);
    process.exit(1);
  }

  if (relayOn) relayClient.start();
  updater.start();

  acars.start();
  comms.onState(() => acars.changed());
  if (push) acars.onMessage((m) => void push!.notifyAcars(m));
  mockPlugin?.start();
  source.start();
  hub.start();
  network?.start();

  const urls = cfg.host === "0.0.0.0" ? ["localhost", ...lanAddresses()] : [cfg.host];
  log.info(cockpit ? "Cockpit control: on (this PC and paired devices)" : "Cockpit control: off");
  log.info(cfg.mock ? "vPilot link: mock (pretend VATSIM session)" : "vPilot link: waiting for the VBuddy Link plugin (ws://127.0.0.1:" + cfg.port + "/plugin)");
  log.info(relayOn ? `Relay: ${cfg.relayUrl} (${cfg.relayAccess === "paired" ? "devices must pair" : "OPEN - anyone with the address can watch"}). Phone link: ${phoneLink(cfg.relayUrl, identity.id)}` : relayAllowed ? "Relay: off (switch it on in the VBuddy window for access away from home)" : "Home network edition: no cloud relay (phones connect on the same Wi-Fi)");
  log.info(push ? "Notifications: on (paired devices can turn them on in the app)" : cfg.push && !pairing ? "Notifications: off (needs --control on)" : "Notifications: off");
  log.info(network ? `Online network: VATSIM${cfg.callsign ? ` (callsign ${cfg.callsign})` : ""}` : "Online network: off");
  log.info(`Telemetry at ${cfg.telemetryHz} Hz, ${cfg.backlogMinutes} min replay buffer`);
  if (cfg.webDir) {
    log.info("Open VBuddy on your phone/tablet (same Wi-Fi):");
    for (const u of urls) log.info(`   http://${u}:${cfg.port}`);
  } else {
    log.warn("Web client not built: only the WebSocket is available. Run `pnpm build` or `pnpm dev`.");
  }
  if (!db) log.info(cfg.dataDir ? "Flight log: OFF (see the warning above). Landings are kept in memory only." : "Flight log: memory only (not saved). Use --data-dir to save it.");
  else if (recorder) log.info(`Flight log: ${db.file} (telemetry kept ${cfg.keepHours} h; ${db.landingCount()} landing(s) saved)`);
  else log.info(`Flight log: ${db.file} (landings only; telemetry recording is off)`);
  if (cfg.host === "0.0.0.0") {
    log.info(`If other devices can't connect, allow Node.js (or TCP port ${cfg.port}) through Windows Firewall on Private networks.`);
  }

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info(`${sig}: shutting down`);
    hub.stop();
    network?.stop();
    relayClient.stop();
    mockPlugin?.stop();
    if (sectorTimer) clearInterval(sectorTimer);
    clearInterval(flushTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    await source.stop(); // a landing still open when the sim goes away is finished by the status handler
    recorder?.stop();
    await server!.close();
    db?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
