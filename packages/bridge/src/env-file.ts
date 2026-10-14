import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** KEY=VALUE lines; blank lines and # comments are ignored; quotes around a value are removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (v !== "") out[m[1]!] = v;
  }
  return out;
}

export function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export const SETTINGS_FILE = "config.env";

export const SETTINGS_TEMPLATE = `# VBuddy settings. Remove the # at the start of a line to use it, save, then restart VBuddy.
# Settings given on the command line or as Windows environment variables win over this file.

# Port the bridge listens on (default 4789)
#VBUDDY_PORT=4789

# Away from home. The VBuddy window has a "Cloud relay" switch for the shared VBuddy relay (no setup).
# Here you can also force it: on (shared VBuddy relay), off, or your own relay: wss://relay.example.com
#VBUDDY_RELAY=on
# paired = relayed devices must pair first (default) | open = anyone with the address can watch
#VBUDDY_RELAY_ACCESS=paired

# Phone notifications (on or off) and the contact the push services can reach
#VBUDDY_PUSH=on
#VBUDDY_PUSH_CONTACT=mailto:you@example.com

# Online traffic, ATC and boundary alerts: vatsim or off
#VBUDDY_NETWORK=vatsim

# Allow paired devices to operate the cockpit: on or off
#VBUDDY_CONTROL=on

# Your network callsign, only if it isn't picked up automatically
#VBUDDY_CALLSIGN=

# Hours of telemetry kept on disk (default 24, 0 = none)
#VBUDDY_KEEP_HOURS=24
`;

/** Writes the commented settings file the first time, so there is something to edit. Never overwrites. */
export function ensureSettingsFile(dir: string): string | null {
  const path = join(dir, SETTINGS_FILE);
  try {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, SETTINGS_TEMPLATE, { flag: "wx" });
    }
    return path;
  } catch {
    return null;
  }
}
