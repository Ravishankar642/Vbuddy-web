import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sdkHeadersInPackages } from "./find-sdk.js";
import { PROFILES, type PmdgKind } from "./profiles.js";

/**
 * Sets a PMDG 737 / 777 up for VBuddy without the user touching a file:
 *  - copies the aircraft's SDK header (Documentation\SDK in its package) into %APPDATA%\VBuddy\sdk, and again
 *    whenever the aircraft's copy changes (an aircraft update can move the data layout);
 *  - makes sure the aircraft's options .ini (in its work folder) has the [SDK] lines that turn on PMDG's data
 *    and CDU broadcast. PMDG recreates the work folder when the aircraft is reinstalled or updated, which drops
 *    those lines, so this runs on every start and every aircraft change, and only writes when something is missing.
 */

interface IniSpec {
  kind: PmdgKind;
  file: string;
  keys: string[];
}

const INI: IniSpec[] = [
  { kind: "ng3", file: "737_Options.ini", keys: ["EnableDataBroadcast", "EnableCDUBroadcast.0", "EnableCDUBroadcast.1"] },
  { kind: "777x", file: "777_Options.ini", keys: ["EnableDataBroadcast", "EnableCDUBroadcast.0", "EnableCDUBroadcast.1", "EnableCDUBroadcast.2"] },
];

export const BACKUP_SUFFIX = ".vbuddy-backup";

export interface HeaderResult {
  kind: PmdgKind;
  file: string;
  from: string;
  to: string;
  action: "installed" | "updated" | "current";
}

export interface IniResult {
  kind: PmdgKind;
  path: string;
  action: "enabled" | "created" | "current";
  added: string[];
}

export interface PmdgSetupReport {
  headers: HeaderResult[];
  inis: IniResult[];
  errors: string[];
}

export interface PmdgSetupOptions {
  /** VBuddy's data folder (%APPDATA%\VBuddy): the headers go into its `sdk` folder. Without it, no headers are copied. */
  dataDir?: string;
  /** The simulator's package folders (tests; default: InstalledPackagesPath and the usual places). */
  packageRoots?: string[];
  /** The folders holding each package's work folder (tests; default: see workRoots()). */
  workRoots?: string[];
  headers?: boolean;
  inis?: boolean;
}

/** Where the simulators keep each package's `work` folder (where PMDG writes its options .ini). */
export function workRoots(): string[] {
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  const out: string[] = [];
  if (local) {
    out.push(join(local, "Packages", "Microsoft.Limitless_8wekyb3d8bbwe", "LocalState", "WASM", "MSFS2024")); // MSFS 2024, Store
    out.push(join(local, "Packages", "Microsoft.FlightSimulator_8wekyb3d8bbwe", "LocalState", "packages")); // MSFS 2020, Store
  }
  if (roaming) {
    out.push(join(roaming, "Microsoft Flight Simulator 2024", "WASM", "MSFS2024")); // MSFS 2024, Steam
    out.push(join(roaming, "Microsoft Flight Simulator", "Packages")); // MSFS 2020, Steam
  }
  return out;
}

function sameFile(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Copies each PMDG SDK header from the aircraft's package into <dataDir>/sdk when it's missing or different. */
export function installHeaders(dataDir: string, packageRoots?: string[]): { headers: HeaderResult[]; errors: string[] } {
  const headers: HeaderResult[] = [];
  const errors: string[] = [];
  const dir = join(dataDir, "sdk");
  for (const p of PROFILES) {
    const from = sdkHeadersInPackages(p.headerFile, packageRoots)[0];
    if (!from) continue; // that aircraft isn't installed (or its package has no SDK)
    const to = join(dir, p.headerFile);
    try {
      if (existsSync(to) && sameFile(from, to)) {
        headers.push({ kind: p.kind, file: p.headerFile, from, to, action: "current" });
        continue;
      }
      const had = existsSync(to);
      mkdirSync(dir, { recursive: true });
      if (had) copyFileSync(to, `${to}.old`);
      copyFileSync(from, to);
      headers.push({ kind: p.kind, file: p.headerFile, from, to, action: had ? "updated" : "installed" });
    } catch (e) {
      errors.push(`couldn't copy ${from} to ${to}: ${(e as Error).message}`);
    }
  }
  return { headers, errors };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Makes `key=1` true for every key in `section` of an .ini text: changes a key that has another value, adds a
 * missing one at the end of the section, and adds the section at the end when there is none. Everything else,
 * the line endings included, is left as it was.
 */
export function ensureIniKeys(text: string, section: string, keys: string[]): { text: string; added: string[] } {
  const nl = text.includes("\r\n") || !text.includes("\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const endsWithNl = lines.length > 0 && lines[lines.length - 1] === "";
  if (endsWithNl) lines.pop();
  const added: string[] = [];
  const header = new RegExp(`^\\s*\\[\\s*${escape(section)}\\s*\\]\\s*$`, "i");
  let start = lines.findIndex((l) => header.test(l));
  if (start < 0) {
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(`[${section}]`);
    start = lines.length - 1;
  }
  const sectionEnd = () => {
    let i = start + 1;
    while (i < lines.length && !/^\s*\[/.test(lines[i]!)) i++;
    return i;
  };
  for (const key of keys) {
    const re = new RegExp(`^\\s*${escape(key)}\\s*=\\s*(.*?)\\s*$`, "i");
    const end = sectionEnd();
    const at = lines.slice(start + 1, end).findIndex((l) => re.test(l));
    if (at >= 0) {
      const line = lines[start + 1 + at]!;
      if (re.exec(line)![1] !== "1") {
        lines[start + 1 + at] = `${key}=1`;
        added.push(key);
      }
      continue;
    }
    // after the section's last non-blank line
    let ins = end;
    while (ins > start + 1 && lines[ins - 1]!.trim() === "") ins--;
    lines.splice(ins, 0, `${key}=1`);
    added.push(key);
  }
  return { text: lines.join(nl) + nl, added };
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir).map((n) => join(dir, n)).filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Which options .ini a PMDG package's work folder uses: the one that's there, or by the package name. */
function iniFor(pkg: string, work: string): IniSpec | null {
  const there = INI.find((s) => existsSync(join(work, s.file)));
  if (there) return there;
  const name = pkg.split(/[\\/]/).pop() ?? "";
  if (/77/.test(name)) return INI.find((s) => s.kind === "777x")!;
  if (/73/.test(name)) return INI.find((s) => s.kind === "ng3")!;
  return null;
}

/** Turns on PMDG's data and CDU broadcast in every installed PMDG 737 / 777 options .ini that's missing it. */
export function enableBroadcast(roots: string[] = workRoots()): { inis: IniResult[]; errors: string[] } {
  const inis: IniResult[] = [];
  const errors: string[] = [];
  for (const root of roots) {
    for (const pkg of subdirs(root)) {
      if (!/^pmdg-aircraft-/i.test(pkg.split(/[\\/]/).pop() ?? "")) continue;
      const work = join(pkg, "work");
      if (!existsSync(work)) continue; // the aircraft hasn't been flown yet; PMDG makes the folder on first load
      const spec = iniFor(pkg, work);
      if (!spec) continue;
      const path = join(work, spec.file);
      try {
        const existed = existsSync(path);
        const before = existed ? readFileSync(path, "latin1") : "";
        const { text, added } = ensureIniKeys(before, "SDK", spec.keys);
        if (!added.length) {
          inis.push({ kind: spec.kind, path, action: "current", added });
          continue;
        }
        if (existed && !existsSync(path + BACKUP_SUFFIX)) copyFileSync(path, path + BACKUP_SUFFIX);
        writeFileSync(path, text, "latin1");
        inis.push({ kind: spec.kind, path, action: existed ? "enabled" : "created", added });
      } catch (e) {
        errors.push(`couldn't update ${path}: ${(e as Error).message}`);
      }
    }
  }
  return { inis, errors };
}

/** Both of the above; never throws. */
export function setupPmdgSdk(o: PmdgSetupOptions = {}): PmdgSetupReport {
  const report: PmdgSetupReport = { headers: [], inis: [], errors: [] };
  try {
    if (o.headers !== false && o.dataDir) {
      const h = installHeaders(o.dataDir, o.packageRoots);
      report.headers.push(...h.headers);
      report.errors.push(...h.errors);
    }
    if (o.inis !== false) {
      const i = enableBroadcast(o.workRoots);
      report.inis.push(...i.inis);
      report.errors.push(...i.errors);
    }
  } catch (e) {
    report.errors.push((e as Error).message);
  }
  return report;
}

/** One log line per thing that changed. */
export function describeSetup(r: PmdgSetupReport): string[] {
  const out: string[] = [];
  for (const h of r.headers) if (h.action !== "current") out.push(`${h.action === "installed" ? "Installed" : "Updated"} ${h.file} from ${h.from}`);
  for (const i of r.inis) if (i.action !== "current") out.push(`Turned on PMDG's data in ${i.path} (${i.added.join(", ")})`);
  return out;
}
