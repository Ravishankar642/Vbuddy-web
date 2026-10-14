import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The folder VBuddy is installed in (the one with VBuddy.vbs and the app folder), or null when running from source. */
export function installRoot(argv1: string | undefined = process.argv[1]): string | null {
  if (!argv1) return null;
  const appDir = dirname(argv1);
  if (basename(appDir).toLowerCase() !== "app") return null;
  const root = dirname(appDir);
  return existsSync(join(root, "VBuddy.vbs")) ? root : null;
}

const isWin = () => process.platform === "win32";

/** The shortcut that starts VBuddy when you sign in. The tray icon's menu uses the same one. */
export function autostartLink(env: NodeJS.ProcessEnv = process.env): string | null {
  return isWin() && env.APPDATA ? join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "VBuddy.lnk") : null;
}

/** On, off, or null when it can't be changed from here (not installed, or not Windows). */
export function autostartState(root = installRoot()): boolean | null {
  const link = autostartLink();
  return root && link ? existsSync(link) : null;
}

export async function setAutostart(on: boolean, root = installRoot()): Promise<string | void> {
  const link = autostartLink();
  if (!root || !link) return "Starting with Windows can only be changed in the installed VBuddy.";
  if (!on) {
    try {
      rmSync(link, { force: true });
    } catch (e) {
      return `Couldn't turn it off: ${(e as Error).message}`;
    }
    return;
  }
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$s = $ws.CreateShortcut(${q(link)})`,
    "$s.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'",
    `$s.Arguments = '"' + ${q(join(root, "VBuddy.vbs"))} + '" quiet'`,
    `$s.WorkingDirectory = ${q(root)}`,
    `$s.IconLocation = ${q(join(root, "VBuddy.ico"))}`,
    "$s.Save()",
  ].join("; ");
  return new Promise((done) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 15_000, windowsHide: true }, (err) => {
      done(err ? `Couldn't turn it on: ${err.message}` : undefined);
    });
  });
}

export interface PluginState {
  /** The plugin file ships with this install. */
  available: boolean;
  /** vPilot's plugin folder, or null when vPilot doesn't seem to be installed. */
  dir: string | null;
  installed: boolean;
  /** Installed and identical to the one that ships with this version. */
  upToDate: boolean;
}

const same = (a: string, b: string) => {
  try {
    return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

function vpilotDirs(env: NodeJS.ProcessEnv) {
  const base = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "vPilot") : null;
  return base ? { base, plugins: join(base, "Plugins") } : null;
}

export function pluginState(root = installRoot(), env: NodeJS.ProcessEnv = process.env): PluginState | null {
  if (!isWin() && !env.VBUDDY_TEST_PLUGIN) return null;
  const src = root ? join(root, "plugin", "VBuddyLink.dll") : null;
  const v = vpilotDirs(env);
  const available = !!src && existsSync(src);
  const dst = v ? join(v.plugins, "VBuddyLink.dll") : null;
  const installed = !!dst && existsSync(dst);
  return { available, dir: v && existsSync(v.base) ? v.plugins : null, installed, upToDate: installed && available && same(src!, dst!) };
}

/** Copies the plugin into vPilot's Plugins folder. Returns a message for the person when it can't. */
export function installPlugin(root = installRoot(), env: NodeJS.ProcessEnv = process.env): string | void {
  const st = pluginState(root, env);
  const v = vpilotDirs(env);
  if (!st || !root || !v) return "The vPilot plugin can only be installed from the installed VBuddy on Windows.";
  if (!st.available) return "This copy of VBuddy doesn't include the vPilot plugin.";
  if (!st.dir) return "vPilot doesn't seem to be installed (no vPilot folder in your local app data).";
  try {
    mkdirSync(v.plugins, { recursive: true });
    copyFileSync(join(root, "plugin", "VBuddyLink.dll"), join(v.plugins, "VBuddyLink.dll"));
    const ini = join(v.plugins, "VBuddyLink.ini");
    if (!existsSync(ini) && existsSync(join(root, "plugin", "VBuddyLink.ini"))) copyFileSync(join(root, "plugin", "VBuddyLink.ini"), ini);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EBUSY" || err.code === "EPERM" ? "Close vPilot first, then install the plugin again." : `Couldn't install the plugin: ${err.message}`;
  }
}
