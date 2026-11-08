import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * A secure (https) link for the home-network edition, through Tailscale: phones need https for notifications, and
 * `tailscale serve` gives this PC a real certificate on its tailnet name. Checked only when asked (startup and the
 * VBuddy window's button), never on a timer.
 */
export interface TailscaleState {
  installed: boolean;
  running: boolean;
  /** "gaming-pc.tail1234.ts.net" */
  dnsName: string | null;
  /** The https address that reaches VBuddy, when `tailscale serve` is set up for it. */
  url: string | null;
  error: string | null;
}

const OFF: TailscaleState = { installed: false, running: false, dnsName: null, url: null, error: null };

type Run = (file: string, args: string[]) => Promise<string>;
const run: Run = (file, args) =>
  new Promise((resolve, reject) =>
    // On failure the message carries everything Tailscale printed: it puts the approval link on stdout.
    execFile(file, args, { timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(`${String(errOut ?? "")}\n${String(out ?? "")}\n${err.message}`.trim())) : resolve(out))),
  );

/** The link Tailscale prints when Serve has to be allowed for the tailnet first ("To enable, visit: https://login.tailscale.com/f/serve?node=…"). */
export function approvalLink(text: string): string | null {
  return /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0].replace(/[.,)]+$/, "") ?? null;
}

export function tailscaleBin(): string | null {
  if (process.platform === "win32") {
    const p = "C:\\Program Files\\Tailscale\\tailscale.exe";
    return existsSync(p) ? p : null;
  }
  return existsSync("/usr/bin/tailscale") ? "/usr/bin/tailscale" : existsSync("/usr/local/bin/tailscale") ? "/usr/local/bin/tailscale" : null;
}

/** Reads `tailscale status --json` and `tailscale serve status --json`: is the tailnet up, and does it serve this port? */
export async function tailscaleState(port: number, bin = tailscaleBin(), exec: Run = run): Promise<TailscaleState> {
  if (!bin) return OFF;
  try {
    const st = JSON.parse(await exec(bin, ["status", "--json"])) as { BackendState?: string; Self?: { DNSName?: string } };
    const running = st.BackendState === "Running";
    const dnsName = st.Self?.DNSName ? st.Self.DNSName.replace(/\.$/, "") : null;
    let url: string | null = null;
    if (running && dnsName) {
      const serve = await exec(bin, ["serve", "status", "--json"]).catch(() => "{}");
      // The serve config maps https handlers to proxies; ours points at this port.
      if (new RegExp(`127\\.0\\.0\\.1:${port}\\b|localhost:${port}\\b`).test(serve)) url = `https://${dnsName}/`;
    }
    return { installed: true, running, dnsName, url, error: null };
  } catch (e) {
    return { installed: true, running: false, dnsName: null, url: null, error: (e as Error).message };
  }
}

/** Turns on `tailscale serve` for VBuddy's port (it stays on across restarts). */
export async function tailscaleServe(port: number, bin = tailscaleBin(), exec: Run = run): Promise<string | null> {
  if (!bin) return "Tailscale isn't installed on this PC.";
  const explain = (m: string): string => {
    const link = approvalLink(m);
    if (link) return `Tailscale needs you to allow Serve for your tailnet once. Open ${link} , approve it, then press Set up again.`;
    if (/not enabled|https certificates|cert/i.test(m)) return "Turn on HTTPS certificates for your tailnet (Tailscale admin console → DNS → HTTPS Certificates, with MagicDNS on), then press Set up again.";
    const first = m.split("\n").map((l) => l.trim()).find((l) => l && !/^Command failed/i.test(l));
    return `Tailscale said: ${first ?? m.slice(0, 200)}`;
  };
  try {
    await exec(bin, ["serve", "--bg", String(port)]);
    return null;
  } catch (e) {
    const m = (e as Error).message;
    // Tailscale before 1.52 has no --bg: the older form.
    if (/flag provided but not defined|unknown flag/i.test(m) && !approvalLink(m)) {
      try {
        await exec(bin, ["serve", "https", "/", `http://127.0.0.1:${port}`]);
        return null;
      } catch (e2) {
        return explain((e2 as Error).message);
      }
    }
    return explain(m);
  }
}
