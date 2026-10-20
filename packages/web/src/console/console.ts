import qrcode from "qrcode-generator";

/** What the bridge tells this window (see consoleInfo in the bridge's index.ts). */
interface Info {
  version: string;
  port: number;
  mock: boolean;
  addresses: string[];
  sim: { connected: boolean; aircraft: string | null };
  vpilot: { linked: boolean };
  clients: number;
  pairing: { code: string; expiresAt: number } | null;
  devices: Array<{ id: string; name: string; pairedAt: number; lastSeen: number | null }>;
  relay: { available: boolean; enabled: boolean; state: "off" | "connecting" | "connected"; url: string; shared: boolean; id: string; phoneLink: string; access: "paired" | "open"; error: string };
  accounts: { simbrief: string; hoppieSet: boolean; owmSet?: boolean };
  dataDir: string | null;
  host: { autostart: boolean | null; plugin: { available: boolean; dir: string | null; installed: boolean; upToDate: boolean } | null; canReconnect: boolean };
  update: { current: string; status: { kind: string }; text: string; version: string | null; notes: string | null; url: string | null };
  pause: { schedule: { mode: "atTime"; atEpochMs: number } | { mode: "beforeTod"; leadSec: number }; etaSec: number | null; waiting: string } | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let info: Info | null = null;
let busy = false;
let accountsDirty = false;

function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

function pill(id: string, state: "ok" | "wait" | "off", text: string) {
  $(id).className = `pill ${state === "off" ? "" : state}`;
  setText($(id + "Text"), text);
}

function qrImage(text: string): HTMLImageElement {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const img = new Image();
  img.src = qr.createDataURL(5, 0);
  img.alt = `QR code for ${text}`;
  return img;
}

function showQr(box: HTMLElement, text: string) {
  box.replaceChildren(qrImage(text));
  box.hidden = false;
}

async function copy(text: string, button: HTMLButtonElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const range = document.createRange();
    const t = document.createElement("textarea");
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
    range.detach();
  }
  const was = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = was), 1200);
}

let lastNote = "";
async function call(path: string, body?: unknown): Promise<Info | null> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json", "x-vbuddy-console": "1" }, body: JSON.stringify(body) });
  if (res.status === 404) throw new Error("not-local");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as Info | { info: Info; note?: string };
  lastNote = "info" in j ? (j.note ?? "") : "";
  return "info" in j ? j.info : j;
}

function banner(text: string | null) {
  const b = $("banner");
  b.hidden = text === null;
  if (text !== null) b.textContent = text;
}

function render(i: Info) {
  info = i;
  setText($("version"), `Version ${i.version}${i.mock ? " (test flight)" : ""}`);

  const efbNav = document.querySelector<HTMLElement>('[data-nav="efb"]');
  const fenix = i.mock || /fenix|fnx/i.test(i.sim.aircraft ?? "");
  if (efbNav) efbNav.hidden = !fenix;
  if (!fenix && page === "efb") go("systems");
  pill("pSim", i.sim.connected ? "ok" : "wait", i.sim.connected ? i.sim.aircraft || "Connected" : "Waiting for MSFS");
  pill("pVp", i.vpilot.linked ? "ok" : "off", i.vpilot.linked ? "Plugin connected" : "Plugin not connected");
  pill("pDev", i.clients > 0 ? "ok" : "off", i.clients === 1 ? "1 connected" : `${i.clients} connected`);

  // The phone address is worked out by the person from ipconfig (the right adapter can't be guessed reliably); only the port is filled in.
  setText($("addrExample"), `http://<your IPv4 address>:${i.port}`);

  // pairing code
  const cc = $("codeCard");
  cc.hidden = !i.pairing;
  if (i.pairing) {
    setText($("code"), i.pairing.code);
    const s = Math.max(0, Math.round((i.pairing.expiresAt - Date.now()) / 1000));
    setText($("codeTtl"), `Changes in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  }

  // relay
  const r = i.relay;
  $("relayCard").hidden = !r.available;
  const sw = $<HTMLInputElement>("relayOn");
  if (!busy) sw.checked = r.enabled;
  setText(
    $("relayText"),
    r.shared
      ? "Use VBuddy from anywhere, on mobile data or another Wi-Fi, with no router setup. Your flight data passes through the VBuddy relay server while this is on, and a device must be paired with the code above before it sees anything."
      : `Using your own relay (${r.url}). A device must be paired with the code above before it sees anything.`,
  );
  $("relayLink").hidden = !r.enabled;
  setText($("relayUrl"), r.phoneLink);
  const st = $("relayStatus");
  if (!r.enabled) {
    st.className = "status muted";
    setText(st, "Off");
  } else if (r.state === "connected") {
    st.className = "status ok";
    setText(st, "Connected. Open the link on your phone, then enter the pairing code.");
  } else {
    st.className = r.error ? "status bad" : "status wait";
    setText(st, r.error ? `Can't connect: ${r.error}. Retrying…` : "Connecting…");
  }
  if (r.access === "open") setText(st, st.textContent + " (open access: anyone with the link can watch)");

  // devices
  const ul = $("devices");
  $("noDevices").hidden = i.devices.length > 0;
  ul.replaceChildren(
    ...i.devices.map((d) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = d.name;
      const when = document.createElement("small");
      when.textContent = d.lastSeen ? `last seen ${new Date(d.lastSeen).toLocaleString()}` : "never connected";
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = "Forget";
      b.onclick = () => void act("forget", { id: d.id });
      li.append(name, when, b);
      return li;
    }),
  );
  // accounts: don't overwrite what the pilot is typing
  const sb = $<HTMLInputElement>("simbrief");
  if (document.activeElement !== sb && !accountsDirty) sb.value = i.accounts.simbrief;
  setText($("hoppieState"), i.accounts.hoppieSet ? "A code is saved." : "No code saved.");
  setText($("owmState"), i.accounts.owmSet ? "A key is saved." : "No key saved.");
  $<HTMLButtonElement>("clearHoppie").hidden = !i.accounts.hoppieSet;
  setText($("dataDir"), i.dataDir ? `Settings and logs: ${i.dataDir}` : "");
  renderSettings(i);
}

const mmss = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`);

function renderSettings(i: Info) {
  // simulator
  setText($("simText"), i.mock ? "This is a test flight, so there is no simulator to connect to." : i.sim.connected ? `Connected${i.sim.aircraft ? `: ${i.sim.aircraft}` : ""}.` : "Waiting for Microsoft Flight Simulator. VBuddy tries again every few seconds by itself.");
  $<HTMLButtonElement>("reconnectSim").disabled = !i.host.canReconnect;
  // scheduled pause
  const p = i.pause;
  const now = $("pauseNow");
  now.hidden = !p;
  if (p) {
    const what = p.schedule.mode === "atTime" ? `at ${new Date(p.schedule.atEpochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : `${Math.round(p.schedule.leadSec / 60)} min before top of descent`;
    now.className = "status ok";
    now.textContent = `Pause set ${what}${p.etaSec !== null ? ` (in ${mmss(p.etaSec)})` : ""}. Waiting for ${p.waiting}.`;
  }
  $<HTMLButtonElement>("pauseCancel").hidden = !p;
  // start with Windows
  const a = i.host.autostart;
  const sw = $<HTMLInputElement>("autostartOn");
  if (!busy) sw.checked = a === true;
  sw.disabled = a === null;
  setText($("autostartText"), a === null ? "Available in the installed VBuddy on Windows." : a ? "VBuddy starts in the notification area when you sign in." : "Off. Start VBuddy from the Start menu when you want it.");
  // updates
  const u = i.update;
  setText($("updateText"), `This PC has VBuddy ${u.current}. ${u.text}`);
  const notes = $("updateNotes");
  notes.hidden = !(u.notes && u.version && ["ready", "downloading", "waiting-for-sim"].includes(u.status.kind));
  if (!notes.hidden) setText(notes, `What's new in ${u.version}:\n${u.notes}`);
  $<HTMLButtonElement>("updateInstall").hidden = u.status.kind !== "ready";
  $<HTMLButtonElement>("updateCheck").disabled = u.status.kind === "off" || u.status.kind === "checking" || u.status.kind === "downloading" || u.status.kind === "installing";
  // vPilot plugin
  const pl = i.host.plugin;
  const btn = $<HTMLButtonElement>("installPlugin");
  if (!pl || !pl.available) {
    setText($("pluginText"), !pl ? "Available in the installed VBuddy on Windows." : "This copy of VBuddy doesn't include the plugin.");
    btn.disabled = true;
    setText(btn, "Install plugin");
  } else {
    const how = "It lets the app send and read VATSIM messages and connect for you. Close vPilot before installing, and restart it afterwards.";
    setText($("pluginText"), pl.installed ? (pl.upToDate ? `Installed and up to date. ${how}` : `Installed, but an update is included with this version. ${how}`) : pl.dir ? how : "vPilot doesn't seem to be installed on this PC.");
    btn.disabled = !pl.dir || (pl.installed && pl.upToDate);
    setText(btn, pl.installed ? (pl.upToDate ? "Installed" : "Update plugin") : "Install plugin");
  }
}

async function act(name: "relay" | "newCode" | "forget" | "integrations" | "autostart" | "installPlugin" | "reconnectSim" | "pause" | "updateCheck" | "updateInstall", body: object = {}): Promise<boolean> {
  busy = true;
  try {
    const next = await call(`/api/console/${name}`, body);
    if (next) render(next);
    banner(null);
    return lastNote === "";
  } catch (e) {
    banner(`That didn't work (${(e as Error).message}).`);
    return false;
  } finally {
    busy = false;
  }
}

async function poll() {
  try {
    const i = await call("/api/console");
    banner(null);
    if (i && !busy) render(i);
  } catch (e) {
    banner((e as Error).message === "not-local" ? "This window only works on the PC where VBuddy is running (open http://localhost:4789/console.html there)." : "VBuddy isn't running. Start it from the Start menu, then this window reconnects by itself.");
  }
}

function accountsSay(text: string, state: "ok" | "bad" | "muted") {
  const s = $("accountsStatus");
  s.className = `status ${state}`;
  s.textContent = text;
}
for (const id of ["simbrief", "hoppie", "owm"]) $<HTMLInputElement>(id).addEventListener("input", () => (accountsDirty = true));
$<HTMLButtonElement>("saveAccounts").onclick = async () => {
  const body: { simbrief: string; hoppie?: string; owm?: string } = { simbrief: $<HTMLInputElement>("simbrief").value };
  const h = $<HTMLInputElement>("hoppie").value;
  if (h.trim() !== "") body.hoppie = h;
  const o = $<HTMLInputElement>("owm").value;
  if (o.trim() !== "") body.owm = o;
  const ok = await act("integrations", body);
  if (ok) {
    accountsDirty = false;
    $<HTMLInputElement>("hoppie").value = "";
    $<HTMLInputElement>("owm").value = "";
    accountsSay("Saved.", "ok");
  } else accountsSay(lastNote || "Couldn't save.", "bad");
};
$<HTMLButtonElement>("clearHoppie").onclick = async () => {
  if (await act("integrations", { hoppie: "" })) accountsSay("Hoppie code removed.", "muted");
};
$("newCode").onclick = () => void act("newCode");
$<HTMLInputElement>("relayOn").onchange = (e) => void act("relay", { enabled: (e.target as HTMLInputElement).checked });
$<HTMLButtonElement>("copyRelay").onclick = (e) => info && void copy(info.relay.phoneLink, e.target as HTMLButtonElement);
$<HTMLButtonElement>("qrRelay").onclick = () => {
  if (!info) return;
  const box = $("relayQr");
  if (box.hidden) showQr(box, info.relay.phoneLink);
  else box.hidden = true;
};

/* ---- sidebar pages ---- */
type Page = "connect" | "map" | "flights" | "systems" | "efb" | "atlas" | "activity" | "settings";
const FRAME_HASH: Partial<Record<Page, string>> = { map: "flights/live", flights: "flights/mine", systems: "systems", efb: "systems/efb", atlas: "atlas" };
let page: Page = "connect";
let frame: HTMLIFrameElement | null = null;

function go(next: Page) {
  page = next;
  document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((b) => (b.dataset.nav === next ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  const inFrame = next in FRAME_HASH;
  document.querySelectorAll<HTMLElement>(".page").forEach((p) => (p.hidden = p.dataset.page !== (inFrame ? "map" : next)));
  if (inFrame) {
    const hash = FRAME_HASH[next]!;
    if (!frame) {
      // The app itself, in the same wide layout as a tablet, with its own tab bar hidden (this sidebar picks the page).
      frame = document.createElement("iframe");
      frame.title = "VBuddy";
      frame.src = `/?pc=1#${hash}`;
      document.querySelector('[data-page="map"]')!.append(frame);
    } else if (frame.contentWindow) frame.contentWindow.location.hash = hash;
  }
  if (next === "activity") void loadActivity();
  try {
    sessionStorage.setItem("vbuddy-page", next);
  } catch {
    /* the window opens on Connect next time */
  }
}
document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((b) => (b.onclick = () => go(b.dataset.nav as Page)));

/* ---- activity ---- */
interface LogLine { ts: number; level: "debug" | "info" | "warn" | "error"; scope: string; msg: string }
async function loadActivity() {
  if (page !== "activity") return;
  try {
    const res = await fetch("/api/console/activity");
    if (!res.ok) return;
    const all = (await res.json()) as LogLine[];
    const only = $<HTMLInputElement>("problemsOnly").checked;
    const lines = only ? all.filter((l) => l.level === "warn" || l.level === "error") : all;
    const ol = $("activityLog");
    const stick = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 24;
    ol.replaceChildren(
      ...lines.map((l) => {
        const li = document.createElement("li");
        const t = document.createElement("time");
        t.textContent = new Date(l.ts).toLocaleTimeString([], { hour12: false });
        const sc = document.createElement("span");
        sc.className = "sc";
        sc.textContent = l.scope;
        const m = document.createElement("span");
        m.className = l.level;
        m.textContent = l.msg;
        li.append(t, sc, m);
        return li;
      }),
    );
    $("activityEmpty").hidden = lines.length > 0;
    if (stick) ol.scrollTop = ol.scrollHeight;
  } catch {
    /* the banner already says the bridge is unreachable */
  }
}
$<HTMLInputElement>("problemsOnly").onchange = () => void loadActivity();
setInterval(() => void loadActivity(), 2000);

/* ---- settings ---- */
const say = (id: string, text: string, state: "ok" | "bad" | "muted") => {
  const s = $(id);
  s.className = `status ${state}`;
  s.textContent = text;
};
$<HTMLButtonElement>("reconnectSim").onclick = async () => {
  const ok = await act("reconnectSim");
  say("simStatus", ok ? "Trying to connect…" : lastNote || "Couldn't reconnect.", ok ? "muted" : "bad");
};
$<HTMLInputElement>("autostartOn").onchange = async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  const ok = await act("autostart", { on });
  if (!ok) {
    $<HTMLInputElement>("autostartOn").checked = !on;
    banner(lastNote || "Couldn't change that.");
  }
};
$<HTMLButtonElement>("updateCheck").onclick = async () => {
  say("updateStatus", "Checking…", "muted");
  const ok = await act("updateCheck");
  say("updateStatus", ok ? "" : lastNote || "Couldn't check for updates.", ok ? "muted" : "bad");
};
$<HTMLButtonElement>("updateInstall").onclick = async () => {
  say("updateStatus", "Starting the installer. Windows asks for your permission…", "muted");
  const ok = await act("updateInstall");
  say("updateStatus", ok ? "Installing. VBuddy closes and starts again by itself." : lastNote || "Couldn't start the installer.", ok ? "ok" : "bad");
};
$<HTMLButtonElement>("installPlugin").onclick = async () => {
  const ok = await act("installPlugin");
  say("pluginStatus", ok ? "Installed. Restart vPilot to load it." : lastNote || "Couldn't install the plugin.", ok ? "ok" : "bad");
};
const pauseMode = $<HTMLSelectElement>("pauseMode");
pauseMode.onchange = () => {
  $("pauseTimeBox").hidden = pauseMode.value !== "atTime";
  $("pauseLeadBox").hidden = pauseMode.value !== "beforeTod";
};
$<HTMLButtonElement>("pauseSet").onclick = async () => {
  let schedule: object;
  if (pauseMode.value === "atTime") {
    const v = $<HTMLInputElement>("pauseTime").value;
    if (!v) return say("pauseStatus", "Choose a time first.", "bad");
    const [h, m] = v.split(":").map(Number) as [number, number];
    const at = new Date();
    at.setHours(h, m, 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1); // an earlier time today means tomorrow
    schedule = { mode: "atTime", atEpochMs: at.getTime() };
  } else {
    schedule = { mode: "beforeTod", leadSec: Math.max(0, Math.min(60, Number($<HTMLInputElement>("pauseLead").value) || 0)) * 60 };
  }
  const ok = await act("pause", { schedule });
  say("pauseStatus", ok ? "" : lastNote || "Couldn't set the pause.", ok ? "muted" : "bad");
};
$<HTMLButtonElement>("pauseCancel").onclick = async () => {
  if (await act("pause", { cancel: true })) say("pauseStatus", "Pause cancelled.", "muted");
};

try {
  const saved = sessionStorage.getItem("vbuddy-page") as Page | null;
  if (saved && (saved === "connect" || saved === "activity" || saved === "settings" || saved in FRAME_HASH)) go(saved);
} catch {
  /* start on Connect */
}
void poll();
setInterval(() => void poll(), 2000);
setInterval(() => info?.pairing && setText($("codeTtl"), (() => { const s = Math.max(0, Math.round((info!.pairing!.expiresAt - Date.now()) / 1000)); return `Changes in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; })()), 1000);
