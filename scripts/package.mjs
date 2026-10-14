#!/usr/bin/env node
/**
 * Builds the Windows release: a staged folder, a portable zip and (if Inno Setup is installed) the installer.
 *
 *   pnpm package                 everything it can
 *   pnpm package -- --no-build   reuse the last build of the packages
 *   pnpm package -- --skip-node  don't download Node.js (stage is then not runnable on Windows; for checking only)
 *   pnpm package -- --skip-plugin / --skip-installer
 *   pnpm package -- --plugin-dll <path>   use an already built VBuddyLink.dll
 *   pnpm package -- --edition cloud|local|both   cloud (default) has the away-from-home relay switch;
 *                                local is the home-network edition with no relay at all
 *
 * Output goes to ./release
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { unzipSync, unzlibSync, zipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const win = process.platform === "win32";

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const out = join(root, "release");
const stage = join(out, "stage");
const cache = join(out, "cache");
const say = (m) => console.log(`\n== ${m}`);
const warn = (m) => console.log(`!! ${m}`);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: root, shell: win && !cmd.includes("\\"), ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (${r.status})`);
}
const has = (cmd) => spawnSync(win ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function walk(dir, base = dir, acc = {}) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else acc[relative(base, p).split("\\").join("/")] = new Uint8Array(readFileSync(p));
  }
  return acc;
}

/** Decodes an 8-bit RGBA, non-interlaced PNG (the web app's icons) to raw pixels. */
function decodePng(buf) {
  let pos = 8;
  let w = 0, h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("icon must be 8-bit RGBA, not interlaced");
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = Buffer.from(unzlibSync(new Uint8Array(Buffer.concat(idat))));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let out;
      if (f === 0) out = v;
      else if (f === 1) out = v + a;
      else if (f === 2) out = v + b;
      else if (f === 3) out = v + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + x] = out & 255;
    }
  }
  return { w, h, px };
}

/** Box-filter downscale of RGBA pixels (premultiplied, so transparent edges don't bleed). */
function scale({ w, h, px }, size) {
  if (size === w) return { w, h, px };
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * w) / size), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / size));
      const y0 = Math.floor((y * h) / size), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / size));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * w + xx) * 4;
        const al = px[i + 3];
        r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al; n++;
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { w: size, h: size, px: out };
}

/** One BMP-based icon image (what every Windows, System.Drawing and Inno Setup version reads). */
function icoImage({ w, h, px }) {
  const maskStride = Math.ceil(w / 32) * 4;
  const dib = Buffer.alloc(40 + w * h * 4 + maskStride * h);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(w, 4);
  dib.writeInt32LE(h * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(w * h * 4, 20);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (h - 1 - y) * w * 4 + x * 4; // BMP rows run bottom to top
      const d = 40 + y * w * 4 + x * 4;
      dib[d] = px[s + 2];
      dib[d + 1] = px[s + 1];
      dib[d + 2] = px[s];
      dib[d + 3] = px[s + 3];
    }
  }
  return dib;
}

/** A multi-size .ico (16 to 64 px for the tray and shortcuts, plus the full image). */
function icoFromPng(png) {
  const src = decodePng(png);
  const sizes = [16, 24, 32, 48, 64].filter((n) => n < src.w);
  const images = [...sizes.map((n) => scale(src, n)), src].map((im) => ({ im, dib: icoImage(im) }));
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let at = head.length;
  images.forEach(({ im, dib }, i) => {
    const o = 6 + i * 16;
    head.writeUInt8(im.w >= 256 ? 0 : im.w, o);
    head.writeUInt8(im.h >= 256 ? 0 : im.h, o + 1);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(dib.length, o + 8);
    head.writeUInt32LE(at, o + 12);
    at += dib.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.dib)]);
}

async function main() {
  console.log(`VBuddy ${version} release build`);
  // The bridge reports its own version to the updater: if it differs from package.json, installed copies would update forever.
  const bridgeVersion = /VERSION = "([^"]+)"/.exec(readFileSync(join(root, "packages/bridge/src/version.ts"), "utf8"))?.[1];
  if (bridgeVersion !== version) throw new Error(`packages/bridge/src/version.ts says ${bridgeVersion} but package.json says ${version}. Set both to the same version (pnpm version:set <x.y.z>).`);
  if (!flag("no-build")) {
    say("Building the packages");
    run("pnpm", ["install", "--frozen-lockfile"]);
    run("pnpm", ["-r", "run", "build"]);
  }

  say("Staging");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "app", "tools"), { recursive: true });

  const banner = { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' };
  const common = { bundle: true, platform: "node", format: "esm", target: "node22", banner, legalComments: "none", logLevel: "warning" };
  await build({ ...common, entryPoints: [join(root, "packages/bridge/src/index.ts")], outfile: join(stage, "app/vbuddy-bridge.mjs") });
  for (const t of ["aircraft-discover", "fenix-discover", "pmdg-dump"]) {
    // The tools print their own leading comment as --help, so it has to stay at the top of the bundle.
    const src = readFileSync(join(root, `packages/bridge/src/tools/${t}.ts`), "utf8");
    const head = src.match(/^\s*\/\*\*[\s\S]*?\*\//)?.[0] ?? "";
    await build({ ...common, banner: { js: `${head}\n${banner.js}` }, entryPoints: [join(root, `packages/bridge/src/tools/${t}.ts`)], outfile: join(stage, `app/tools/${t}.mjs`) });
  }
  cpSync(join(root, "packages/web/dist"), join(stage, "web"), { recursive: true });
  if (!existsSync(join(stage, "web", "index.html"))) throw new Error("web client missing: build failed?");

  for (const f of ["VBuddy.cmd", "Open VBuddy.cmd", "Edit settings.cmd", "Find aircraft controls.cmd", "VBuddy.vbs", "tray.ps1", "stop.ps1"]) cpSync(join(root, "installer", f), join(stage, f));
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE.txt"));
  for (const f of ["THIRD_PARTY_NOTICES.md", "CHANGELOG.md"]) cpSync(join(root, f), join(stage, f));
  cpSync(join(root, "installer/README.txt"), join(stage, "README.txt"));
  cpSync(join(root, "sdk/README.md"), join(stage, "sdk/README.md"), { recursive: true });
  const png = readFileSync(join(root, "packages/web/public/icons/icon-192.png"));
  writeFileSync(join(stage, "VBuddy.ico"), icoFromPng(png));
  writeFileSync(join(stage, "VERSION.txt"), `${version}\n`);

  let hasPlugin = false;
  if (!flag("skip-plugin")) {
    say("vPilot plugin");
    let dll = opt("plugin-dll");
    if (!dll) {
      if (win && has("dotnet")) {
        try {
          run("dotnet", ["build", "plugin/VBuddyLink/VBuddyLink.csproj", "-c", "Release", "--nologo", "-v", "q"]);
          dll = join(root, "plugin/VBuddyLink/bin/Release/VBuddyLink.dll");
        } catch (e) {
          warn(`Plugin build failed (${e.message}). Is vPilot installed? The build needs %LOCALAPPDATA%\\vPilot\\RossCarlson.Vatsim.Vpilot.Plugins.dll. Continuing without the plugin.`);
        }
      } else warn("No .NET SDK on this machine (or not Windows): plugin not built. Use --plugin-dll <path> to include a built one.");
    }
    if (dll && existsSync(dll)) {
      mkdirSync(join(stage, "plugin"), { recursive: true });
      cpSync(dll, join(stage, "plugin/VBuddyLink.dll"));
      cpSync(join(root, "plugin/VBuddyLink/VBuddyLink.ini"), join(stage, "plugin/VBuddyLink.ini"));
      hasPlugin = true;
    }
  }

  if (!flag("skip-node")) {
    say(`Node.js ${process.version} for Windows`);
    mkdirSync(cache, { recursive: true });
    const name = `node-${process.version}-win-x64.zip`;
    const zipPath = join(cache, name);
    const sums = (await fetchBuf(`https://nodejs.org/dist/${process.version}/SHASUMS256.txt`)).toString("utf8");
    const want = sums.split("\n").find((l) => l.endsWith(` ${name}`))?.split(/\s+/)[0];
    if (!want) throw new Error(`no checksum for ${name} in SHASUMS256.txt`);
    let buf = existsSync(zipPath) ? readFileSync(zipPath) : null;
    if (!buf || sha256(buf) !== want) {
      console.log(`downloading ${name}`);
      buf = await fetchBuf(`https://nodejs.org/dist/${process.version}/${name}`);
      if (sha256(buf) !== want) throw new Error("Node.js download doesn't match its published checksum");
      writeFileSync(zipPath, buf);
    }
    const files = unzipSync(new Uint8Array(buf), { filter: (f) => /^[^/]+\/(node\.exe|LICENSE)$/.test(f.name) });
    mkdirSync(join(stage, "node"), { recursive: true });
    for (const [n, data] of Object.entries(files)) writeFileSync(join(stage, "node", n.split("/").pop()), data);
    if (!existsSync(join(stage, "node/node.exe"))) throw new Error("node.exe not found in the Node.js download");
  } else warn("--skip-node: the stage has no node.exe");

  const editionArg = (opt("edition") ?? "cloud").toLowerCase();
  if (!["cloud", "local", "both"].includes(editionArg)) throw new Error("--edition must be cloud, local or both");
  const editions = editionArg === "both" ? ["cloud", "local"] : [editionArg];
  const products = [];
  for (const edition of editions) {
    const local = edition === "local";
    const dir = local ? join(out, "stage-local") : stage;
    if (local) {
      rmSync(dir, { recursive: true, force: true });
      cpSync(stage, dir, { recursive: true });
      cpSync(join(root, "installer/README-local.txt"), join(dir, "README.txt"));
    }
    writeFileSync(join(dir, "edition.txt"), `${edition}\n`);
    const tag = local ? "Local-" : "";
    say(`Portable zip (${edition})`);
    const zipFile = join(out, `VBuddy-${tag}${version}-win-x64.zip`);
    const prefixed = Object.fromEntries(Object.entries(walk(dir)).map(([k, v]) => [`VBuddy/${k}`, v]));
    writeFileSync(zipFile, zipSync(prefixed, { level: 6 }));
    products.push(zipFile);

    if (!flag("skip-installer")) {
      say(`Installer (${edition})`);
      const iss = readFileSync(join(root, "installer/vbuddy.iss.in"), "utf8")
        .replaceAll("@VERSION@", version)
        .replaceAll("@STAGE@", dir)
        .replaceAll("@OUT@", out)
        .replaceAll("@OUTNAME@", `VBuddy-${tag}Setup-${version}`)
        .replace("@PLUGIN_TASK@", hasPlugin ? 'Name: "vpilotplugin"; Description: "Install the VBuddy Link plugin into vPilot (chat and VATSIM connect from the app)"; GroupDescription: "vPilot:"\n' : "")
        .replace("@PLUGIN_FILES@", hasPlugin ? 'Source: "{#StageDir}\\plugin\\VBuddyLink.dll"; DestDir: "{localappdata}\\vPilot\\Plugins"; Flags: ignoreversion; Tasks: vpilotplugin\nSource: "{#StageDir}\\plugin\\VBuddyLink.ini"; DestDir: "{localappdata}\\vPilot\\Plugins"; Flags: onlyifdoesntexist; Tasks: vpilotplugin\n' : "");
      const issPath = join(out, `vbuddy${local ? "-local" : ""}.iss`);
      writeFileSync(issPath, iss);
      const candidates = [process.env.ISCC, "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe", "C:\\Program Files\\Inno Setup 6\\ISCC.exe", join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe")].filter(Boolean);
      const iscc = candidates.find((p) => existsSync(p));
      if (win && iscc) {
        // Antivirus or a sync client sometimes holds the just-written .exe for a moment ("EndUpdateResource failed"): wait and try again.
        for (let attempt = 1; ; attempt++) {
          try {
            run(iscc, ["/Q", issPath]);
            break;
          } catch (e) {
            if (attempt >= 3) throw e;
            warn(`Inno Setup failed (try ${attempt} of 3). Waiting 8 seconds, then trying again. If it keeps failing, exclude the release folder from your antivirus.`);
            await new Promise((r) => setTimeout(r, 8000));
          }
        }
        products.push(join(out, `VBuddy-${tag}Setup-${version}.exe`));
      } else {
        warn(win ? `Inno Setup not found. Install it (winget install JRSoftware.InnoSetup) and run this again, or compile ${issPath} yourself.` : `Not on Windows: wrote ${issPath} but didn't compile it.`);
      }
    }
  }

  const sums = products.filter(existsSync).map((p) => `${sha256(readFileSync(p))}  ${p.split(/[\\/]/).pop()}`);
  writeFileSync(join(out, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  say("Done");
  for (const p of products) if (existsSync(p)) console.log(`${p}  (${(statSync(p).size / 1048576).toFixed(1)} MB)`);
  if (!hasPlugin && !flag("skip-plugin")) console.log("Note: this build has no vPilot plugin.");
}

main().catch((e) => {
  console.error(`\nPackaging failed: ${e.message}`);
  process.exit(1);
});
