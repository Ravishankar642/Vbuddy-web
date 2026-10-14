#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./log.js";
import { startRelay } from "./relay.js";

const log = logger("relay");

const HELP = `VBuddy relay

Runs on a small cloud VM. Each person's bridge dials out to it, and their phone/tablet opens the phone link
(https, served by Caddy in front of this) - no router port-forwarding at home. Many bridges can share one relay:
every bridge makes its own id and key the first time it connects, and the relay keeps only a hash of the key.

Usage: vbuddy-relay [options]

  --port <n>          Port to listen on                    (default 8080, env VBUDDY_RELAY_PORT)
  --host <addr>       Interface to listen on               (default 127.0.0.1, env VBUDDY_RELAY_HOST)
  --registry <file>   Where known bridges are kept         (default ~/.vbuddy-relay/bridges.json)
  --max-bridges <n>   Most bridges that may register       (default 5000)
  --no-proxy          Not behind Caddy/nginx: use the socket's address as the browser's address
  --help              Show this help
`;

function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes("--help")) return console.log(HELP);
  const port = Number(get("port") ?? process.env.VBUDDY_RELAY_PORT ?? 8080);
  const host = get("host") ?? process.env.VBUDDY_RELAY_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("--port must be 1-65535");
    process.exit(2);
  }
  const maxBridges = Number(get("max-bridges") ?? 5000);
  if (!Number.isInteger(maxBridges) || maxBridges < 1) {
    console.error("--max-bridges must be a positive number");
    process.exit(2);
  }
  const registryFile = get("registry") ?? join(homedir(), ".vbuddy-relay", "bridges.json");
  startRelay({ host, port, trustProxy: !args.includes("--no-proxy"), registryFile, maxBridges })
    .then((r) => {
      log.info(`Relay listening on ${host}:${r.port()} (${r.registeredCount()} known bridge(s), registry ${registryFile})`);
      log.info("Bridges need no setup: the VBuddy app registers itself the first time it connects.");
      const stop = () => void r.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((e: Error) => {
      log.error(`Could not start: ${e.message}`);
      process.exit(1);
    });
}
main();
