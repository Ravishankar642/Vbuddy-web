import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { ensureSettingsFile, parseEnvFile, SETTINGS_TEMPLATE } from "./env-file.js";

test("settings lines are read, comments and blanks skipped, quotes removed", () => {
  const v = parseEnvFile('# note\n\nVBUDDY_PORT=5000\nVBUDDY_RELAY = "wss://r.example.com"\n#VBUDDY_PUSH=off\nBAD LINE\nEMPTY=\n');
  assert.deepEqual(v, { VBUDDY_PORT: "5000", VBUDDY_RELAY: "wss://r.example.com" });
});

test("the template changes nothing until a line is uncommented", () => {
  assert.deepEqual(parseEnvFile(SETTINGS_TEMPLATE), {});
});

test("the first-run file is created once and never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "vbuddy-cfg-"));
  const path = ensureSettingsFile(dir)!;
  assert.equal(readFileSync(path, "utf8"), SETTINGS_TEMPLATE);
  writeFileSync(path, "VBUDDY_PORT=6000\n");
  ensureSettingsFile(dir);
  assert.equal(readFileSync(path, "utf8"), "VBUDDY_PORT=6000\n");
});

test("the settings file fills gaps; real environment and flags win", () => {
  const dir = mkdtempSync(join(tmpdir(), "vbuddy-cfg-"));
  const file = join(dir, "config.env");
  writeFileSync(file, "VBUDDY_PORT=5555\nVBUDDY_HZ=7\nVBUDDY_NETWORK=off\n");
  const cfg = loadConfig([], { VBUDDY_CONFIG: file, VBUDDY_HZ: "9" });
  assert.equal(cfg.port, 5555);
  assert.equal(cfg.telemetryHz, 9);
  assert.equal(cfg.network, "off");
  assert.equal(loadConfig(["--port", "6001"], { VBUDDY_CONFIG: file }).port, 6001);
});

test("the home-network edition never turns the relay on", () => {
  const cfg = loadConfig(["--relay", "on"], { VBUDDY_EDITION: "local" });
  assert.equal(cfg.edition, "local");
  assert.equal(cfg.relayOn, false);
  assert.equal(loadConfig([], {}).edition, "cloud");
});
