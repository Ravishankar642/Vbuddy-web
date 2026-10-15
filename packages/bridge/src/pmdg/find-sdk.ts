import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where MSFS keeps UserCfg.opt, which names the folder that holds the Community and Official packages. */
function userCfgFiles(): string[] {
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  const out: string[] = [];
  if (local) {
    out.push(join(local, "Packages", "Microsoft.Limitless_8wekyb3d8bbwe", "LocalCache", "UserCfg.opt")); // MSFS 2024, Store
    out.push(join(local, "Packages", "Microsoft.FlightSimulator_8wekyb3d8bbwe", "LocalCache", "UserCfg.opt")); // MSFS 2020, Store
  }
  if (roaming) {
    out.push(join(roaming, "Microsoft Flight Simulator 2024", "UserCfg.opt")); // Steam
    out.push(join(roaming, "Microsoft Flight Simulator", "UserCfg.opt"));
  }
  return out;
}

/** The folders that hold the simulator's packages (InstalledPackagesPath from UserCfg.opt, plus the usual defaults). */
export function installedPackagesPaths(): string[] {
  const found = new Set<string>();
  for (const f of userCfgFiles()) {
    try {
      const m = /InstalledPackagesPath\s+"([^"]+)"/.exec(readFileSync(f, "utf8"));
      if (m) found.add(m[1]!);
    } catch {
      /* not this install */
    }
  }
  // the usual default for the Store version
  const local = process.env.LOCALAPPDATA;
  if (local) {
    found.add(join(local, "Packages", "Microsoft.Limitless_8wekyb3d8bbwe", "LocalCache", "Packages"));
    found.add(join(local, "Packages", "Microsoft.FlightSimulator_8wekyb3d8bbwe", "LocalCache", "Packages"));
  }
  if (process.env.APPDATA) found.add(join(process.env.APPDATA, "Microsoft Flight Simulator 2024", "Packages"));
  return [...found];
}

/** Folders in `dir`, including links and junctions to folders (add-on linkers and a moved Community folder use them). */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => {
        if (d.isDirectory()) return true;
        if (!d.isSymbolicLink()) return false;
        try {
          return statSync(join(dir, d.name)).isDirectory();
        } catch {
          return false; // a broken link
        }
      })
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * Every PMDG package in the simulator's package folders: Community (and Community2024 and the like),
 * Official / Official2024 (one folder per store: OneStore, Steam) and StreamedPackages.
 */
export function pmdgPackageDirs(roots: string[] = installedPackagesPaths()): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const base of subdirs(root)) {
      const name = base.split(/[\\/]/).pop() ?? "";
      let packages: string[] = [];
      if (/^community/i.test(name) || /^streamedpackages$/i.test(name)) packages = subdirs(base);
      else if (/^official/i.test(name)) for (const ch of subdirs(base)) packages.push(...subdirs(ch));
      out.push(...packages.filter((p) => /pmdg/i.test(p.split(/[\\/]/).pop() ?? "")));
    }
  }
  return out;
}

/** Every copy of `file` in the PMDG packages (Documentation\SDK first), newest first. */
export function sdkHeadersInPackages(file: string, roots?: string[]): string[] {
  const hits: string[] = [];
  for (const p of pmdgPackageDirs(roots)) {
    const likely = [join(p, "Documentation", "SDK", file), join(p, "Documentation", file), join(p, "SDK", file), join(p, file)].find((x) => existsSync(x));
    const hit = likely ?? walk(p, file, 4);
    if (hit) hits.push(hit);
  }
  const mtime = (f: string) => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  return hits.sort((a, b) => mtime(b) - mtime(a));
}

/** Looks for `file` below `dir`, at most `depth` folders down. */
function walk(dir: string, file: string, depth: number): string | null {
  const direct = join(dir, file);
  if (existsSync(direct)) return direct;
  if (depth <= 0) return null;
  for (const d of subdirs(dir)) {
    const hit = walk(d, file, depth - 1);
    if (hit) return hit;
  }
  return null;
}

export interface FoundSdk {
  path: string;
  text: string;
}

/**
 * The SDK header sits in the aircraft's package (Documentation\SDK). Looks in: a folder named by the user
 * (PMDG_SDK_DIR, or the `sdk` folder next to the app), then every PMDG package in the Community and Official folders.
 * Returns null when it can't be found.
 */
export function findSdkHeader(file: string, extraDirs: string[] = []): FoundSdk | null {
  const tried: string[] = [];
  const userDirs = [process.env.PMDG_SDK_DIR, ...extraDirs].filter((x): x is string => !!x);
  for (const d of userDirs) {
    tried.push(d);
    const hit = walk(d, file, 3);
    if (hit) return read(hit);
  }
  for (const hit of sdkHeadersInPackages(file)) {
    const got = read(hit);
    if (got) return got;
  }
  return null;
}

function read(path: string): FoundSdk | null {
  try {
    if (!statSync(path).isFile()) return null;
    return { path, text: readFileSync(path, "latin1") };
  } catch {
    return null;
  }
}
