/** What the app's health page shows: each part of VBuddy, how it is, and what to do about it. */
export interface HealthItem {
  id: "bridge" | "sim" | "vpilot" | "voice" | "relay" | "simbrief" | "network" | "update" | "perf";
  label: string;
  state: "ok" | "warn" | "bad" | "off";
  text: string;
  fix?: string;
}

export interface HealthInput {
  version: string;
  sim: { connected: boolean; aircraft: string | null };
  vpilot: { linked: boolean; installed: boolean | null };
  voice: { state: string; message: string | null; model: string | null } | null;
  relay: { available: boolean; enabled: boolean; state: string; error: string };
  simbrief: { set: boolean; plan: { dep: string; arr: string; matched: boolean } | null; error: string | null };
  network: { network: string; state: string; detail?: string } | null;
  update: { kind: string; latest?: string | null } | null;
  perf: { lite: boolean; background: boolean; landing: boolean };
  /** Home-network edition: the Tailscale https link for notifications. */
  tailscale?: { installed: boolean; running: boolean; url: string | null } | null;
}

export function healthItems(h: HealthInput): HealthItem[] {
  const out: HealthItem[] = [{ id: "bridge", label: "VBuddy bridge", state: "ok", text: `Version ${h.version}, running.` }];
  out.push(
    h.sim.connected
      ? { id: "sim", label: "Simulator", state: "ok", text: h.sim.aircraft ? `Connected · ${h.sim.aircraft}` : "Connected, no flight loaded yet." }
      : { id: "sim", label: "Simulator", state: "bad", text: "Not connected.", fix: "Start MSFS and load a flight. If it's running, use Reconnect in the VBuddy window on your PC." },
  );
  out.push(
    h.vpilot.linked
      ? { id: "vpilot", label: "vPilot link", state: "ok", text: "The VBuddy Link plugin is connected." }
      : h.vpilot.installed === false
        ? { id: "vpilot", label: "vPilot link", state: "warn", text: "The VBuddy Link plugin isn't installed.", fix: "Install it from the VBuddy window on your PC (vPilot plugin), then restart vPilot." }
        : { id: "vpilot", label: "vPilot link", state: "off", text: "vPilot isn't running, or its plugin isn't connected.", fix: "Start vPilot. If it's already open, restart it so the plugin connects." },
  );
  if (h.voice) {
    const v = h.voice;
    out.push(
      v.state === "listening"
        ? { id: "voice", label: "ATC voice to text", state: "ok", text: `Listening${v.model ? ` · ${v.model}` : ""}.` }
        : v.state === "off"
          ? { id: "voice", label: "ATC voice to text", state: "off", text: "Switched off." }
          : v.state === "error"
            ? { id: "voice", label: "ATC voice to text", state: "bad", text: v.message ?? "Not working.", fix: "Open the VBuddy window on your PC → Voice to text for details." }
            : { id: "voice", label: "ATC voice to text", state: "warn", text: v.message ?? "Getting ready." },
    );
  }
  if (h.relay.available)
    out.push(
      !h.relay.enabled
        ? { id: "relay", label: "Phone link (relay)", state: "off", text: "Off: phones connect on the same Wi-Fi only." }
        : h.relay.state === "connected"
          ? { id: "relay", label: "Phone link (relay)", state: "ok", text: "Connected: your phone can reach VBuddy away from home." }
          : { id: "relay", label: "Phone link (relay)", state: "bad", text: h.relay.error || `Relay ${h.relay.state}.`, fix: "Check your PC's internet connection; the bridge keeps retrying." },
    );
  if (!h.relay.available && h.tailscale)
    out.push(
      h.tailscale.url
        ? { id: "relay", label: "Secure phone link", state: "ok", text: `${h.tailscale.url} (Tailscale): notifications work there.` }
        : h.tailscale.installed
          ? { id: "relay", label: "Secure phone link", state: "warn", text: h.tailscale.running ? "Tailscale is on, but not set up for VBuddy." : "Tailscale isn't connected.", fix: "VBuddy window on your PC → Secure phone link → Set up." }
          : { id: "relay", label: "Secure phone link", state: "off", text: "Not set up: notifications need https.", fix: "Install Tailscale (free) on this PC and your phone, then use Secure phone link in the VBuddy window." },
    );
  out.push(
    !h.simbrief.set
      ? { id: "simbrief", label: "SimBrief", state: "warn", text: "No SimBrief name set.", fix: "Enter your SimBrief name or pilot ID in the VBuddy window on your PC." }
      : h.simbrief.error
        ? { id: "simbrief", label: "SimBrief", state: "bad", text: h.simbrief.error }
        : h.simbrief.plan
          ? { id: "simbrief", label: "SimBrief", state: h.simbrief.plan.matched ? "ok" : "warn", text: `${h.simbrief.plan.dep} → ${h.simbrief.plan.arr}${h.simbrief.plan.matched ? ", matches this flight." : ", doesn't start where this flight began."}`, fix: h.simbrief.plan.matched ? undefined : "Generate a new plan in SimBrief for this flight; VBuddy picks it up within a couple of minutes." }
          : { id: "simbrief", label: "SimBrief", state: "off", text: "No plan loaded yet." },
  );
  if (h.network && h.network.network !== "off")
    out.push(
      h.network.state === "ok"
        ? { id: "network", label: `${h.network.network.toUpperCase()} data`, state: "ok", text: "Traffic and ATC are up to date." }
        : { id: "network", label: `${h.network.network.toUpperCase()} data`, state: h.network.state === "error" ? "bad" : "warn", text: h.network.detail ?? `Feed ${h.network.state}.` },
    );
  if (h.update) {
    const k = h.update.kind;
    const v = h.update.latest ?? "update";
    out.push(
      k === "ready" || k === "waiting-for-sim"
        ? { id: "update", label: "Updates", state: "warn", text: `VBuddy ${v} is ready${k === "waiting-for-sim" ? "; it installs once the sim is closed" : ""}.`, fix: "Install it from the VBuddy window on your PC." }
        : k === "downloading" || k === "installing"
          ? { id: "update", label: "Updates", state: "ok", text: `${k === "downloading" ? "Downloading" : "Installing"} VBuddy ${v}.` }
          : k === "error"
            ? { id: "update", label: "Updates", state: "warn", text: "Couldn't check for updates." }
            : k === "off"
              ? { id: "update", label: "Updates", state: "off", text: "Update checks are off." }
              : { id: "update", label: "Updates", state: "ok", text: "Up to date." },
    );
  }
  out.push({ id: "perf", label: "PC load", state: "ok", text: h.perf.landing ? "Landing: running as light as possible." : h.perf.background ? "Nobody is looking: only the essentials run." : h.perf.lite ? "Lite mode on." : "Normal." });
  return out;
}

/** Log lines for a diagnostics file, without pairing codes or relay links (those let someone in). */
export function redactLog(line: string): string {
  return line.replace(/(pairing code[^:]*:\s*)\d{6}/gi, "$1••••••").replace(/(\?r=)[a-z0-9]+/gi, "$1••••").replace(/(token[=:\s"]+)[A-Za-z0-9._-]{8,}/gi, "$1••••");
}
