import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../log.js";
import { isNewer, parseVersion, pickInstaller, sumFor, Updater } from "./updater.js";

test("versions, installer choice and checksums", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("latest"), null);
  assert.equal(isNewer("1.0.1", "1.0.0"), true);
  assert.equal(isNewer("v1.10.0", "1.9.9"), true);
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
  assert.equal(isNewer("0.9.9", "1.0.0"), false);
  const assets = [{ name: "VBuddy-Setup-1.1.0.exe" }, { name: "VBuddy-Local-Setup-1.1.0.exe" }, { name: "SHA256SUMS.txt" }];
  assert.equal(pickInstaller(assets, "cloud"), "VBuddy-Setup-1.1.0.exe");
  assert.equal(pickInstaller(assets, "local"), "VBuddy-Local-Setup-1.1.0.exe");
  assert.equal(sumFor(`${"a".repeat(64)}  VBuddy-Setup-1.1.0.exe\n${"b".repeat(64)}  VBuddy-Local-Setup-1.1.0.exe`, "VBuddy-Local-Setup-1.1.0.exe"), "b".repeat(64));
});

/** A stand-in for GitHub's API and download server. */
function fakeGitHub(opts: { tag: string; payload: Buffer; badSum?: boolean; noRelease?: boolean }) {
  const sha = opts.badSum ? "0".repeat(64) : createHash("sha256").update(opts.payload).digest("hex");
  let base = "";
  const hits: string[] = [];
  const srv: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/repos/me/app/releases/latest") {
      if (opts.noRelease) return res.writeHead(404).end("{}");
      return res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          tag_name: opts.tag,
          body: "Fixes and new things",
          html_url: `${base}/rel`,
          assets: [
            { name: `VBuddy-Setup-${opts.tag.replace("v", "")}.exe`, browser_download_url: `${base}/dl/setup.exe`, size: opts.payload.length },
            { name: `VBuddy-Local-Setup-${opts.tag.replace("v", "")}.exe`, browser_download_url: `${base}/dl/local.exe`, size: opts.payload.length },
            { name: "SHA256SUMS.txt", browser_download_url: `${base}/dl/sums` },
          ],
        }),
      );
    }
    if (req.url === "/dl/sums") return res.end(`${sha}  VBuddy-Setup-${opts.tag.replace("v", "")}.exe\n${sha}  VBuddy-Local-Setup-${opts.tag.replace("v", "")}.exe\n`);
    if (req.url?.startsWith("/dl/")) return res.writeHead(200, { "content-length": String(opts.payload.length) }).end(opts.payload);
    res.writeHead(404).end();
  });
  return new Promise<{ srv: Server; api: string; hits: string[] }>((r) =>
    srv.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      r({ srv, api: base, hits });
    }),
  );
}

function updater(api: string, over: Partial<ConstructorParameters<typeof Updater>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vbuddy-upd-"));
  const launched: string[] = [];
  let sim = false;
  const u = new Updater({ current: "1.0.0", edition: "local", packaged: true, disabled: false, dir, repo: "me/app", api, simConnected: () => sim, log: logger("test"), launch: async (f) => void launched.push(f), ...over });
  return { u, dir, launched, setSim: (v: boolean) => (sim = v) };
}

test("downloads and verifies a newer release for this edition, then installs on request", async () => {
  const payload = Buffer.alloc(300_000, 7);
  const gh = await fakeGitHub({ tag: "v1.1.0", payload });
  try {
    const { u, dir, launched } = updater(gh.api);
    const st = await u.check();
    assert.equal(st.status.kind, "ready", st.text);
    assert.equal(st.version, "1.1.0");
    assert.match(st.notes ?? "", /Fixes/);
    const file = join(dir, "updates", "VBuddy-Local-Setup-1.1.0.exe");
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file).length, payload.length);
    assert.ok(gh.hits.includes("/dl/local.exe"), "the home network edition's installer");
    assert.equal(await u.install(), undefined);
    assert.deepEqual(launched, [file]);
    assert.equal(u.state().status.kind, "installing");
  } finally {
    gh.srv.close();
  }
});

test("waits for the simulator to close before downloading", async () => {
  const gh = await fakeGitHub({ tag: "v2.0.0", payload: Buffer.from("x") });
  try {
    const { u, setSim } = updater(gh.api, { edition: "cloud" });
    setSim(true);
    const st = await u.check();
    assert.equal(st.status.kind, "waiting-for-sim");
    assert.ok(!gh.hits.some((h) => h.startsWith("/dl/setup")));
    setSim(false);
    u.simChanged();
    for (let i = 0; i < 50 && u.state().status.kind !== "ready"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(u.state().status.kind, "ready");
  } finally {
    gh.srv.close();
  }
});

test("refuses a download that fails the checksum, and says so calmly", async () => {
  const gh = await fakeGitHub({ tag: "v1.0.5", payload: Buffer.from("tampered"), badSum: true });
  try {
    const { u, dir } = updater(gh.api);
    const st = await u.check();
    assert.equal(st.status.kind, "error");
    assert.match(st.text, /failed verification/);
    assert.ok(!existsSync(join(dir, "updates", "VBuddy-Local-Setup-1.0.5.exe")));
    assert.equal(await u.install(), "There's no update ready to install.");
  } finally {
    gh.srv.close();
  }
});

test("same version or no release yet is 'up to date'; dev builds never check", async () => {
  const gh = await fakeGitHub({ tag: "v1.0.0", payload: Buffer.from("x") });
  const none = await fakeGitHub({ tag: "v9.0.0", payload: Buffer.from("x"), noRelease: true });
  try {
    assert.equal((await updater(gh.api).u.check()).status.kind, "current");
    assert.equal((await updater(none.api).u.check()).status.kind, "current");
    const dev = updater(gh.api, { packaged: false }).u;
    const before = gh.hits.length;
    assert.equal((await dev.check()).status.kind, "off");
    assert.equal(gh.hits.length, before);
  } finally {
    gh.srv.close();
    none.srv.close();
  }
});
