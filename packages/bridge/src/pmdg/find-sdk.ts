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

function installedPackagesPaths(): string[] {
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

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
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
  for (const root of installedPackagesPaths()) {
    if (!existsSync(root)) continue;
    const packageDirs: string[] = [];
    for (const sub of ["Community", "Official"]) {
      const base = join(root, sub);
      packageDirs.push(...subdirs(base));
      // Official\<channel>\<package>
      if (sub === "Official") for (const ch of subdirs(base)) packageDirs.push(...subdirs(ch));
    }
    for (const p of packageDirs) {
      if (!/pmdg/i.test(p.split(/[\\/]/).pop() ?? "")) continue;
      const likely = [join(p, "Documentation", "SDK", file), join(p, "Documentation", file), join(p, "SDK", file), join(p, file)].find((x) => existsSync(x));
      const hit = likely ?? walk(p, file, 4);
      if (hit) return read(hit);
    }
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
