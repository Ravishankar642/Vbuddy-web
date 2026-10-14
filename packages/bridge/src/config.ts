import { DEFAULT_BRIDGE_PORT } from "@vbuddy/protocol";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile, SETTINGS_FILE } from "./env-file.js";

export interface BridgeConfig {
  host: string;
  port: number;
  /** Live telemetry push rate to clients. */
  telemetryHz: number;
  /** How many minutes of frames to keep in memory for clients that reconnect. */
  backlogMinutes: number;
  /** Hours of telemetry kept on disk for reconnecting clients and track history. 0 = don't record telemetry. */
  keepHours: number;
  /** The port the Fenix EFB's web server listens on, on this PC. */
  efbPort: number;
  mock: boolean;
  /** Mock flight skips takeoff/climb and repeats landings back to back. */
  mockQuick: boolean;
  /** Which aircraft the mock flight pretends to be (changes the Cockpit tab layout). */
  mockAircraft: "fenix" | "boeing";
  /** Where the landing logbook is kept, or null for memory only (the default for the mock flight). */
  dataDir: string | null;
  /** Built web client to serve, or null to serve only the API/WebSocket. */
  webDir: string | null;
  /** Online network for traffic, ATC and boundary alerts. */
  network: "vatsim" | "off";
  /** Allow paired devices to operate the cockpit (FCU). */
  control: boolean;
  /** Your network callsign, if automatic detection should be skipped. */
  callsign: string | null;
  /** Test/advanced overrides for the network data sources. */
  networkUrls: { feed?: string; vatspyBase?: string; tracon?: string };
  /** Relay to dial out to (wss://host), so devices away from home can reach this bridge. */
  /** The relay to use: your own, or the shared VBuddy one. Whether it is switched on is `relayOn` (the console window can change it). */
  relayUrl: string;
  /** Set by --relay / VBUDDY_RELAY; null = not decided (the console window's choice, else off). */
  relayOn: boolean | null;
  relayAccess: "paired" | "open";
  /** "local" = the home-network edition: no cloud relay at all (the switch is hidden and the PC never dials out). */
  edition: "cloud" | "local";
  /** Web Push notifications to paired devices (needs the relay or another https address to be useful). */
  push: boolean;
  /** Contact the push services can reach if your notifications misbehave (mailto: or https:). */
  pushContact: string;
  /** Optional explicit SimConnect address (otherwise auto-detected on the PC). */
  simconnect: { host: string; port: number } | null;
}

/** The shared VBuddy relay. Each install gets its own id there, so nothing secret is built in. */
export const DEFAULT_RELAY_URL = "wss://vbuddy.duckdns.org";

const HELP = `VBuddy bridge

Usage: vbuddy-bridge [options]

  --mock                 Use the built-in test flight instead of MSFS
  --mock-quick           With --mock: start on short final and land every ~2 minutes
  --mock-aircraft <a>    With --mock: fenix (default) or boeing, to see that Cockpit layout
  --data-dir <dir>       Where the flight log (flights.db) is saved
                         (default: %APPDATA%\\VBuddy on Windows, ~/.local/share/vbuddy elsewhere;
                          the mock flight doesn't save unless you set this; env VBUDDY_DATA_DIR)
  --port <n>             Port for HTTP + WebSocket          (default ${DEFAULT_BRIDGE_PORT}, env VBUDDY_PORT)
  --host <addr>          Interface to listen on              (default 0.0.0.0 = whole LAN, env VBUDDY_HOST)
  --hz <n>               Telemetry push rate, 1-30           (default 5, env VBUDDY_HZ)
  --backlog <minutes>    Replay buffer for reconnects        (default 15)
  --keep-hours <n>       Hours of telemetry kept on disk       (default 24, 0 = don't record; env VBUDDY_KEEP_HOURS)
  --web <dir>            Folder with the built web client    (default ../web/dist if it exists)
  --network <vatsim|off> Online traffic, ATC and boundary alerts  (default vatsim, env VBUDDY_NETWORK)
  --control <on|off>     Cockpit control from paired devices   (default on)
  --callsign <CS>        Your network callsign (normally found automatically)
  --relay <on|off|wss://host>  Use a relay for access away from home: on = the shared VBuddy relay, or your own wss:// address
                         (the VBuddy window has a switch for this too)
  --relay-access <m>     paired (default): relayed devices must pair first | open: anyone with the address can watch
  --push <on|off>        Phone notifications for ATC and landings   (default on)
  --push-contact <uri>   mailto:you@example.com, sent with push messages   (env VBUDDY_PUSH_CONTACT)
  --simconnect <h:port>  Connect to SimConnect over TCP instead of auto-detect
  --help                 Show this help
`;

function num(v: string | undefined, name: string, lo: number, hi: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be a number between ${lo} and ${hi} (got "${v}")`);
  return n;
}

/** Where per-user data lives (flight log, settings file, pairings). */
export function defaultDataDir(env: NodeJS.ProcessEnv): string {
  return process.platform === "win32" ? join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "VBuddy") : join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "vbuddy");
}

export function loadConfig(argv: string[] = process.argv.slice(2), envIn: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"\n\n${HELP}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(key, next);
      i++;
    } else args.set(key, true);
  }
  if (args.has("help")) {
    console.log(HELP);
    process.exit(0);
  }
  const known = new Set(["mock", "mock-quick", "mock-aircraft", "data-dir", "port", "host", "hz", "backlog", "keep-hours", "web", "simconnect", "network", "callsign", "control", "relay", "relay-access", "push", "push-contact", "help"]);
  for (const k of args.keys()) if (!known.has(k)) throw new Error(`unknown option --${k}\n\n${HELP}`);

  const str = (k: string) => {
    const v = args.get(k);
    return typeof v === "string" ? v : undefined;
  };

  // The settings file (config.env in the data folder, or VBUDDY_CONFIG) fills in anything not set another way.
  // Only read for the real environment, so tests and the mock flight aren't affected by a file on the PC.
  const dirForFile = str("data-dir") ?? envIn.VBUDDY_DATA_DIR ?? defaultDataDir(envIn);
  const settingsPath = envIn.VBUDDY_CONFIG ?? (envIn === process.env ? join(resolve(dirForFile), SETTINGS_FILE) : null);
  const env: NodeJS.ProcessEnv = { ...(settingsPath ? readEnvFile(settingsPath) : {}), ...envIn };

  let simconnect: BridgeConfig["simconnect"] = null;
  const sc = str("simconnect") ?? env.VBUDDY_SIMCONNECT;
  if (sc) {
    const m = /^([^:]+):(\d+)$/.exec(sc);
    if (!m) throw new Error(`--simconnect must look like host:port (got "${sc}")`);
    simconnect = { host: m[1]!, port: Number(m[2]) };
  }

  const mock = args.get("mock") === true || env.VBUDDY_MOCK === "1";
  const dataArg = str("data-dir") ?? env.VBUDDY_DATA_DIR;
  const dataDir = dataArg
    ? resolve(dataArg)
    : mock
      ? null
      : defaultDataDir(env);

  const here = dirname(fileURLToPath(import.meta.url));
  const defaultWeb = resolve(here, "../../web/dist");
  const webArg = str("web") ?? env.VBUDDY_WEB_DIR;
  const webDir = webArg ? resolve(webArg) : existsSync(defaultWeb) ? defaultWeb : null;

  let relayUrl = DEFAULT_RELAY_URL;
  let relayOn: boolean | null = null;
  const relayArg = str("relay") ?? env.VBUDDY_RELAY;
  if (relayArg) {
    const v = relayArg.trim();
    if (/^(on|yes|true|1)$/i.test(v)) relayOn = true;
    else if (/^(off|no|false|0)$/i.test(v)) relayOn = false;
    else {
      if (!/^wss?:\/\/[^\s/]+(:\d+)?\/?$/.test(v)) throw new Error(`--relay must be on, off, or look like wss://relay.example.com (got "${v}")`);
      relayUrl = v.replace(/\/+$/, "");
      relayOn = true;
    }
  }
  // The installer's home-network edition carries an edition.txt saying "local" beside the app folder.
  let edition: "cloud" | "local" = "cloud";
  try {
    const f = resolve(here, "../edition.txt");
    const v = (env.VBUDDY_EDITION ?? (existsSync(f) ? readFileSync(f, "utf8") : "")).trim().toLowerCase();
    if (v === "local") edition = "local";
  } catch {
    /* no file: the normal edition */
  }
  if (edition === "local") relayOn = false;
  const relayAccess = (str("relay-access") ?? env.VBUDDY_RELAY_ACCESS ?? "paired").toLowerCase();
  if (relayAccess !== "paired" && relayAccess !== "open") throw new Error(`--relay-access must be paired or open (got "${relayAccess}")`);
  const pushArg = (str("push") ?? env.VBUDDY_PUSH ?? "on").toLowerCase();
  if (pushArg !== "on" && pushArg !== "off") throw new Error(`--push must be on or off (got "${pushArg}")`);
  const pushContact = str("push-contact") ?? env.VBUDDY_PUSH_CONTACT ?? "mailto:vbuddy@example.com";
  if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(pushContact)) throw new Error(`--push-contact must be mailto:you@example.com or an https address (got "${pushContact}")`);

  return {
    relayUrl,
    relayOn,
    edition,
    relayAccess,
    push: pushArg === "on",
    pushContact,
    host: str("host") ?? env.VBUDDY_HOST ?? "0.0.0.0",
    port: num(str("port") ?? env.VBUDDY_PORT, "--port", 1, 65535) ?? DEFAULT_BRIDGE_PORT,
    telemetryHz: num(str("hz") ?? env.VBUDDY_HZ, "--hz", 1, 30) ?? 5,
    backlogMinutes: num(str("backlog"), "--backlog", 0, 240) ?? 15,
    network: (() => {
      const n = (str("network") ?? env.VBUDDY_NETWORK ?? "vatsim").toLowerCase();
      if (n !== "vatsim" && n !== "off") throw new Error(`--network must be vatsim or off (got "${n}")`);
      return n;
    })(),
    control: (() => {
      const c = (str("control") ?? env.VBUDDY_CONTROL ?? "on").toLowerCase();
      if (c !== "on" && c !== "off") throw new Error(`--control must be on or off (got "${c}")`);
      return c === "on";
    })(),
    callsign: (str("callsign") ?? env.VBUDDY_CALLSIGN)?.toUpperCase() || null,
    networkUrls: {
      ...(env.VBUDDY_VATSIM_FEED ? { feed: env.VBUDDY_VATSIM_FEED } : {}),
      ...(env.VBUDDY_VATSPY_BASE ? { vatspyBase: env.VBUDDY_VATSPY_BASE } : {}),
      ...(env.VBUDDY_TRACON_URL ? { tracon: env.VBUDDY_TRACON_URL } : {}),
    },
    efbPort: num(str("efb-port") ?? env.VBUDDY_EFB_PORT, "--efb-port", 1, 65535) ?? 8083,
    keepHours: num(str("keep-hours") ?? env.VBUDDY_KEEP_HOURS, "--keep-hours", 0, 8760) ?? 24,
    mock,
    mockQuick: args.get("mock-quick") === true,
    mockAircraft: (() => {
      const a = (str("mock-aircraft") ?? "fenix").toLowerCase();
      if (a !== "fenix" && a !== "boeing") throw new Error(`--mock-aircraft must be fenix or boeing (got "${a}")`);
      return a;
    })(),
    dataDir,
    webDir,
    simconnect,
  };
}
