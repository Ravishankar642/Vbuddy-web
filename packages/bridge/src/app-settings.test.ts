import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSettings, cleanSettings } from "./app-settings.js";

test("app settings: keeps the newest set, survives a restart, drops odd keys", () => {
  const file = join(mkdtempSync(join(tmpdir(), "vb-")), "app-settings.json");
  const s = new AppSettings(file);
  assert.equal(s.put({ "vbuddy.theme": "dark", "other.key": "x", "vbuddy.n": 5 }, 100)!.values["vbuddy.theme"], "dark");
  assert.deepEqual(s.get().values, { "vbuddy.theme": "dark" });
  s.put({ "vbuddy.theme": "light" }, 50); // older: ignored
  assert.equal(s.get().values["vbuddy.theme"], "dark");
  assert.equal(new AppSettings(file).get().values["vbuddy.theme"], "dark");
  assert.equal(cleanSettings({ "vbuddy.big": "x".repeat(60_000) })!["vbuddy.big"], undefined);
});
