import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { formatMhz, isTaxiClearance, parseMhz, UNICOM_HZ, type AtcAppStatus, type ChatMessage, type CommsCommand, type VoiceStatus } from "@vbuddy/protocol";
import { apiFetch } from "../lib/api";
import type { BridgeSnapshot, CmdReply } from "../lib/bridge-client";
import { chimeEnabled, playChime, setChimeEnabled } from "../lib/chime";
import { useBridgeActions } from "../lib/useBridge";
import { PairThisDevice } from "./Cockpit";
import { zulu } from "./StatusBar";
import { AcarsView } from "./AcarsView";
import { onBridgePc, setAutoPlay, useAutoPlay, type AutoPlay } from "../lib/atc-audio";

type Run = (cmd: CommsCommand) => Promise<CmdReply>;

/* ------------------------------------------------------------------ radios */

function RadioRow({ n, active, standby, rx, run, enabled }: { n: 1 | 2; active: number; standby: number; rx: boolean; run: Run; enabled: boolean }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const set = async (hz: number) => {
    setErr(null);
    const r = await run({ op: "com", radio: n, action: "standby", hz });
    if (r.ok) setText("");
    else setErr(r.error);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const hz = parseMhz(text);
    if (hz === null) return setErr("Enter a frequency from 118.000 to 136.990.");
    void set(hz);
  };
  return (
    <div className="radio">
      <div className="radio__name">
        COM{n}
        <button
          type="button"
          className={`btn radio__listen${rx ? " is-on" : ""}`}
          aria-pressed={rx}
          disabled={!enabled}
          title={rx ? "Listening on this radio. Tap to mute it." : "Not listening on this radio. Tap to listen."}
          onClick={() => void run({ op: "com", radio: n, action: "listen", on: !rx }).then((r) => !r.ok && setErr(r.error))}
        >
          {rx ? "🔊 Listening" : "🔇 Muted"}
        </button>
      </div>
      <div className="radio__freq" aria-label={`COM${n} active`}>
        <small>ACTIVE</small>
        <span className="lcd-num">{formatMhz(active)}</span>
      </div>
      <button type="button" className="btn radio__swap" disabled={!enabled} aria-label={`Swap COM${n} active and standby`} onClick={() => void run({ op: "com", radio: n, action: "swap" }).then((r) => !r.ok && setErr(r.error))}>
        ⇄
      </button>
      <div className="radio__freq" aria-label={`COM${n} standby`}>
        <small>STANDBY</small>
        <span className="lcd-num lcd-num--dim">{formatMhz(standby)}</span>
      </div>
      <form className="radio__set" onSubmit={submit}>
        <input inputMode="decimal" placeholder="121.900" aria-label={`New COM${n} standby frequency`} value={text} onChange={(e) => setText(e.target.value)} disabled={!enabled} />
        <button type="submit" className="btn" disabled={!enabled || !text}>
          Set
        </button>
        <button type="button" className="btn btn--ghost" disabled={!enabled} onClick={() => void set(UNICOM_HZ)} title="Put 122.800 in standby">
          UNICOM
        </button>
      </form>
      {err && (
        <p className="setval__err radio__err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

function Transponder({ x, run, enabled }: { x: NonNullable<BridgeSnapshot["comms"]>["xpdr"]; run: Run; enabled: boolean }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!x) return <p className="muted">No simulator connected.</p>;
  const go = async (cmd: CommsCommand) => {
    setErr(null);
    const r = await run(cmd);
    if (!r.ok) setErr(r.error);
    return r;
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^[0-7]{4}$/.test(text)) return setErr("A squawk code is 4 digits, each 0 to 7.");
    if ((await go({ op: "xpdr", action: "code", code: text })).ok) setText("");
  };
  return (
    <div className="xpdr">
      <div className="xpdr__code" aria-label={`Squawk ${x.code}`}>
        <small>SQUAWK</small>
        <span className="lcd-num">{x.code}</span>
      </div>
      <form className="xpdr__set" onSubmit={submit}>
        <input inputMode="numeric" maxLength={4} pattern="[0-7]{4}" placeholder="1200" aria-label="New squawk code" value={text} onChange={(e) => setText(e.target.value.replace(/[^0-7]/g, ""))} disabled={!enabled} />
        <button type="submit" className="btn" disabled={!enabled || text.length !== 4}>
          Set
        </button>
        {["1200", "7000", "2000"].map((c) => (
          <button key={c} type="button" className="btn btn--ghost" disabled={!enabled} onClick={() => void go({ op: "xpdr", action: "code", code: c })}>
            {c}
          </button>
        ))}
      </form>
      <div className="xpdr__row">
        <div className="seg" role="radiogroup" aria-label="Transponder mode">
          {(["stby", "alt"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={x.mode === m} disabled={!enabled} onClick={() => void go({ op: "xpdr", action: "mode", mode: m })}>
              {m === "stby" ? "STBY" : "ALT"}
            </button>
          ))}
        </div>
        <button type="button" className={`btn xpdr__ident${x.ident ? " is-on" : ""}`} disabled={!enabled} aria-pressed={x.ident} onClick={() => void go({ op: "xpdr", action: "ident" })}>
          IDENT
        </button>
        {x.mode === "off" || x.mode === "other" ? <span className="muted">Mode: {x.mode === "off" ? "off" : "other (set by the aircraft)"}</span> : null}
      </div>
      {err && (
        <p className="setval__err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ VATSIM switch */

function NetworkCard({ b, run, enabled }: { b: BridgeSnapshot; run: Run; enabled: boolean }) {
  const net = b.comms?.net;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [cs, setCs] = useState(net?.last?.callsign ?? "");
  const [type, setType] = useState(net?.last?.type ?? "");
  const [selcal, setSelcal] = useState(net?.last?.selcal ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const last = net?.last;
  // Fill the form from what vPilot last used, once, when it becomes known.
  useEffect(() => {
    if (last) {
      setCs((v) => v || last.callsign);
      setType((v) => v || last.type);
      setSelcal((v) => v || last.selcal);
    }
  }, [last]);
  if (!net) return null;
  const on = net.connected;
  const linked = net.pluginLinked;

  const toggle = () => {
    setErr(null);
    if (on) setConfirm(true);
    else setOpen((o) => !o);
  };
  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await run({ op: "net", action: "connect", callsign: cs.trim() || undefined, type: type.trim() || undefined, selcal: selcal.trim() || undefined });
    setBusy(false);
    if (r.ok) setOpen(false);
    else setErr(r.error);
  };
  const disconnect = async () => {
    setBusy(true);
    const r = await run({ op: "net", action: "disconnect" });
    setBusy(false);
    setConfirm(false);
    if (!r.ok) setErr(r.error);
  };

  return (
    <div className="net">
      <div className="net__row">
        <div>
          <b>VATSIM</b>
          <span className="muted"> {!linked ? "vPilot isn't linked" : on ? `connected as ${net.callsign}${net.observer ? " (observer)" : ""}` : "not connected"}</span>
        </div>
        <button type="button" role="switch" aria-checked={on} className={`switch${on ? " is-on" : ""}`} disabled={!enabled || !linked || busy} onClick={toggle} aria-label={on ? "Disconnect from VATSIM" : "Connect to VATSIM"}>
          <span className="switch__knob" />
        </button>
      </div>
      {!linked && <p className="muted">Start vPilot with the VBuddy Link plugin installed to connect and chat from here. See plugin/README.md.</p>}
      {confirm && (
        <div className="net__confirm" role="alertdialog" aria-label="Confirm disconnect">
          <span>Disconnect from VATSIM?</span>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setConfirm(false)}>
            Stay connected
          </button>
        </div>
      )}
      {open && !on && (
        <form className="net__form" onSubmit={connect}>
          <label>
            Callsign
            <input value={cs} onChange={(e) => setCs(e.target.value.toUpperCase())} maxLength={12} required />
          </label>
          <label>
            Aircraft type
            <input value={type} onChange={(e) => setType(e.target.value.toUpperCase())} maxLength={5} placeholder="A320" required />
          </label>
          <label>
            SELCAL
            <input value={selcal} onChange={(e) => setSelcal(e.target.value.toUpperCase())} maxLength={4} placeholder="optional" />
          </label>
          <button type="submit" className="btn btn--primary" disabled={busy || !cs || !type}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      )}
      {err && (
        <p className="setval__err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ chat */

interface Thread {
  key: string;
  label: string;
  sub: string;
  last: number;
  pinned: boolean;
  freqHz: number | null;
  canSend: boolean;
}

function buildThreads(chat: ChatMessage[], b: BridgeSnapshot, extraDms: string[]): Thread[] {
  const map = new Map<string, Thread>();
  const radios = b.comms?.radios;
  const ensure = (key: string, t: Partial<Thread>) => {
    const cur = map.get(key);
    if (cur) Object.assign(cur, t, { last: Math.max(cur.last, t.last ?? 0), pinned: cur.pinned || !!t.pinned });
    else map.set(key, { key, label: key, sub: "", last: 0, pinned: false, freqHz: null, canSend: false, ...t });
  };
  const freqLabel = (hz: number) => (hz === UNICOM_HZ ? `UNICOM ${formatMhz(hz)}` : hz ? formatMhz(hz) : "Radio");
  // The frequencies you are tuned to always have a conversation, even before anyone speaks.
  if (radios) {
    ensure(`freq:${radios.com1.active}`, { label: freqLabel(radios.com1.active), sub: "COM1", pinned: true, freqHz: radios.com1.active, canSend: true });
    ensure(`freq:${radios.com2.active}`, { label: freqLabel(radios.com2.active), sub: "COM2", pinned: true, freqHz: radios.com2.active, canSend: true });
  }
  for (const m of chat) {
    if (m.thread.startsWith("freq:")) {
      const hz = Number(m.thread.slice(5));
      const sub = m.dir === "in" && m.from ? m.from : "";
      ensure(m.thread, { label: freqLabel(hz), freqHz: hz || null, canSend: hz > 0, last: m.ts, ...(sub && !map.get(m.thread)?.sub ? { sub } : {}) });
    } else if (m.thread.startsWith("dm:")) {
      const cs = m.thread.slice(3);
      ensure(m.thread, { label: cs, sub: "direct message", last: m.ts, canSend: true });
    } else if (m.thread === "broadcast") ensure("broadcast", { label: "Broadcasts", sub: "all pilots", last: m.ts });
    else ensure("system", { label: "System", sub: "network events, SELCAL", last: m.ts });
  }
  for (const cs of extraDms) ensure(`dm:${cs}`, { label: cs, sub: "direct message", canSend: true });
  return [...map.values()].sort((a, b2) => Number(b2.pinned) - Number(a.pinned) || b2.last - a.last);
}

function Console({ b, run, enabled }: { b: BridgeSnapshot; run: Run; enabled: boolean }) {
  const { markRead } = useBridgeActions();
  const [extraDms, setExtraDms] = useState<string[]>([]);
  const threads = useMemo(() => buildThreads(b.chat, b, extraDms), [b.chat, b.comms?.radios, extraDms]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sel, setSel] = useState<string | null>(null);
  const current = threads.find((t) => t.key === sel) ?? threads[0] ?? null;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newDm, setNewDm] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const msgs = useMemo(() => (current ? b.chat.filter((m) => m.thread === current.key) : []), [b.chat, current?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reading: everything in the open conversation counts as read while this tab is on screen.
  useEffect(() => {
    if (current && msgs.length && document.visibilityState === "visible") markRead(current.key);
  }, [current?.key, msgs.length, markRead]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, current?.key]);

  const radios = b.comms?.radios;
  const tuned = !!current?.freqHz && !!radios && (radios.com1.active === current.freqHz || radios.com2.active === current.freqHz);
  const needsTune = !!current?.freqHz && !!radios && !tuned;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || !text.trim()) return;
    setBusy(true);
    setErr(null);
    const r = await run(
      current.key.startsWith("dm:")
        ? { op: "send", to: { kind: "private", callsign: current.key.slice(3) }, text: text.trim() }
        : { op: "send", to: { kind: "radio", ...(current.freqHz ? { freqHz: current.freqHz } : {}) }, text: text.trim() },
    );
    setBusy(false);
    if (r.ok) setText("");
    else setErr(r.error);
  };
  const addDm = (e: FormEvent) => {
    e.preventDefault();
    const cs = newDm.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,12}$/.test(cs)) return;
    setExtraDms((d) => (d.includes(cs) ? d : [...d, cs]));
    setSel(`dm:${cs}`);
    setNewDm("");
  };

  return (
    <div className="chat">
      <div className="chat__threads" role="tablist" aria-label="Conversations">
        {threads.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={current?.key === t.key} className="thread" onClick={() => setSel(t.key)}>
            <span className="thread__label">{t.label}</span>
            <span className="thread__sub">{t.sub}</span>
            {(b.unread[t.key] ?? 0) > 0 && <span className="thread__badge">{b.unread[t.key]}</span>}
          </button>
        ))}
        <form className="thread thread--new" onSubmit={addDm}>
          <input value={newDm} onChange={(e) => setNewDm(e.target.value)} placeholder="New DM: callsign" aria-label="Start a direct message to a callsign" maxLength={12} />
        </form>
      </div>
      <div className="chat__main">
        {!current ? (
          <div className="empty">No conversations yet. Messages on your radios, DMs and ATC calls appear here.</div>
        ) : (
          <>
            <div className="chat__list" ref={listRef} role="log" aria-live="polite">
              {msgs.length === 0 && <p className="muted chat__none">Nothing yet on {current.label}.</p>}
              {msgs.map((m) => (
                <div key={m.id} className={`msg msg--${m.dir}${m.attention ? " is-attention" : ""}${m.kind === "system" ? " msg--system" : ""}`}>
                  <div className="msg__meta">
                    <b>{m.dir === "out" ? "You" : m.from}</b>
                    {m.source && m.source !== "vatsim" && <span className={`msg__src msg__src--${m.source}`}>{SOURCE_LABEL[m.source]}</span>}
                    <span>{zulu(m.ts, false)}</span>
                  </div>
                  <div className="msg__text">{m.text}</div>
                  {(m.clip || (m.dir === "in" && isTaxiClearance(m.text))) && (
                    <div className="msg__acts">
                      {m.clip && <ClipButton id={m.clip} />}
                      {m.dir === "in" && isTaxiClearance(m.text) && (
                        <a className="btn btn--map" href="#ground">
                          Taxi route
                        </a>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {current.canSend ? (
              <form className="chat__send" onSubmit={send}>
                {needsTune && current.freqHz && (
                  <div className="chat__tune">
                    <span>Neither radio is on {formatMhz(current.freqHz)}.</span>
                    {[1, 2].map((n) => (
                      <button key={n} type="button" className="btn" disabled={!enabled} onClick={() => void run({ op: "com", radio: n as 1 | 2, action: "active", hz: current.freqHz! })}>
                        Tune COM{n}
                      </button>
                    ))}
                  </div>
                )}
                <div className="chat__row">
                  <input value={text} onChange={(e) => setText(e.target.value)} maxLength={250} placeholder={current.key.startsWith("dm:") ? `Message ${current.label}` : `Say on ${current.label}`} disabled={!enabled || busy} aria-label="Message" />
                  <button type="submit" className="btn btn--primary" disabled={!enabled || busy || !text.trim() || needsTune}>
                    Send
                  </button>
                </div>
                {!current.key.startsWith("dm:") && <p className="muted chat__hint">Goes out on the radio vPilot is set to transmit on (TX in vPilot).</p>}
              </form>
            ) : null}
            {err && (
              <p className="setval__err" role="alert">
                {err}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { voice: "🎙 heard", sayintentions: "SayIntentions", beyondatc: "BeyondATC" };

/** Plays the bridge's recording of a transmission (only kept for a while, on the PC). */
function ClipButton({ id }: { id: string }) {
  const [st, setSt] = useState<"idle" | "loading" | "playing" | "gone">("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const play = async () => {
    if (st === "playing") {
      audio.current?.pause();
      setSt("idle");
      return;
    }
    setSt("loading");
    try {
      const r = await apiFetch(`/api/voice/clip/${encodeURIComponent(id)}`);
      if (!r.ok) return setSt("gone");
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => {
        URL.revokeObjectURL(url);
        setSt("idle");
      };
      await a.play();
      setSt("playing");
    } catch {
      setSt("gone");
    }
  };
  return (
    <button type="button" className="btn btn--map" onClick={() => void play()} disabled={st === "gone" || st === "loading"} aria-label={st === "playing" ? "Stop the recording" : "Play the recording"}>
      {st === "playing" ? "■ Stop" : st === "gone" ? "Recording gone" : st === "loading" ? "…" : "▶ Play"}
    </button>
  );
}

const VOICE_STATE: Record<VoiceStatus["state"], string> = { off: "Off", setup: "Needs setting up", starting: "Starting", listening: "Listening", error: "Problem" };
const APP_STATE: Record<AtcAppStatus["state"], string> = { off: "Off", waiting: "Waiting", live: "Connected", error: "Problem" };

/** Voice to text and the AI ATC apps: what VBuddy is listening to. Set up in the VBuddy window on the PC. */
function ListeningCard({ b }: { b: BridgeSnapshot }) {
  const v = b.comms?.voice;
  const apps = b.comms?.apps;
  if (!v && !apps) return null;
  const row = (name: string, state: string, tone: string, msg: string | null | undefined) => (
    <div className="listenrow">
      <span className={`listenrow__dot listenrow__dot--${tone}`} aria-hidden="true" />
      <b>{name}</b>
      <span className="listenrow__state">{state}</span>
      {msg && <small className="muted">{msg}</small>}
    </div>
  );
  const tone = (st: string) => (st === "listening" || st === "live" ? "ok" : st === "error" ? "bad" : st === "off" ? "off" : "warn");
  return (
    <section className="card">
      <h2 className="card__title">ATC to text</h2>
      {v &&
        row(
          "Voice to text",
          VOICE_STATE[v.state] + (v.state === "listening" && v.device ? ` · ${v.device}` : ""),
          tone(v.state),
          v.state === "off" ? "Turns what ATC says on your radio into text here, on the PC itself. Switch it on in the VBuddy window on the PC." : v.message,
        )}
      {v?.progress !== null && v?.progress !== undefined && (
        <progress className="listenrow__bar" value={v.progress} max={1} aria-label="Download progress" />
      )}
      {apps && row("SayIntentions.AI", APP_STATE[apps.sayintentions.state], tone(apps.sayintentions.state), apps.sayintentions.state === "off" ? "Add your SayIntentions developer key in the VBuddy window to see its ATC here." : apps.sayintentions.message)}
      {apps && row("BeyondATC", APP_STATE[apps.beyondatc.state], tone(apps.beyondatc.state), apps.beyondatc.message)}
    </section>
  );
}

/* ------------------------------------------------------------------ tab */

type CommsMode = "radio" | "messages" | "acars";
const modeFromHash = (): CommsMode => {
  const seg = window.location.hash.slice(1).split("/")[1];
  return seg === "messages" || seg === "acars" ? seg : "radio";
};

export function CommsView({ b }: { b: BridgeSnapshot }) {
  const { commsCommand } = useBridgeActions();
  const [chime, setChime] = useState(chimeEnabled);
  const [chimeNote, setChimeNote] = useState<string | null>(null);
  const control = b.control;
  const enabled = !!control?.allowed;
  const c = b.comms;
  const [mode, setModeState] = useState<CommsMode>(modeFromHash);
  const setMode = (m: CommsMode) => {
    setModeState(m);
    history.replaceState(null, "", m === "radio" ? "#comms" : `#comms/${m}`);
  };
  useEffect(() => {
    const on = () => setModeState(modeFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const unreadAcars = b.acars ? b.acars.messages.filter((m) => m.dir === "in" && m.answers && !m.answered).length : 0;
  const auto = useAutoPlay();
  const unreadMsgs = Object.values(b.unread).reduce((n, x) => n + x, 0);

  return (
    <div className="comms">
      {control && !control.allowed && control.reason === "not-paired" && <PairThisDevice />}
      <div className="seg comms__mode" role="group" aria-label="Radio, messages or ACARS">
        <button type="button" aria-pressed={mode === "radio"} onClick={() => setMode("radio")}>
          Radio
        </button>
        <button type="button" aria-pressed={mode === "messages"} onClick={() => setMode("messages")}>
          Messages{unreadMsgs > 0 ? ` (${unreadMsgs})` : ""}
        </button>
        <button type="button" aria-pressed={mode === "acars"} onClick={() => setMode("acars")}>
          ACARS{unreadAcars > 0 ? ` (${unreadAcars})` : ""}
        </button>
      </div>
      {mode === "acars" ? (
        <section className="card">
          <h2 className="card__title">ACARS (Hoppie)</h2>
          <AcarsView b={b} enabled={enabled} />
        </section>
      ) : mode === "messages" ? (
        <>
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">Messages</h2>
              <div className="chime">
                <label>
                  <input
                    type="checkbox"
                    checked={chime}
                    onChange={(e) => {
                      setChime(e.target.checked);
                      setChimeEnabled(e.target.checked);
                    }}
                  />{" "}
                  Chime
                </label>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => void playChime(true).then((ok) => setChimeNote(ok ? null : "Your browser blocked sound. Tap anywhere on the page and try again."))}
                >
                  Test
                </button>
              </div>
            </div>
            {chimeNote && <p className="muted">{chimeNote}</p>}
            <div className="autoplay">
              <span className="autoplay__label">🔊 Hear ATC here</span>
              <div className="seg seg--small" role="group" aria-label="Play ATC recordings as they arrive">
                {(
                  [
                    ["off", "Off"],
                    ["mine", "Calls for me"],
                    ["all", "All ATC"],
                  ] as Array<[AutoPlay, string]>
                ).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={auto.mode === k} onClick={() => setAutoPlay(k)} disabled={onBridgePc() && k !== "off"}>
                    {label}
                  </button>
                ))}
              </div>
              <small className="muted">
                {onBridgePc()
                  ? "On this PC you already hear ATC. Use this on your phone or tablet."
                  : (auto.note ??
                    (auto.mode === "off"
                      ? "Plays each transmission from VBuddy's voice to text as it arrives, without pressing play. Keep the app open."
                      : auto.playingId
                        ? "Playing…"
                        : auto.mode === "mine"
                          ? "Plays the calls that use your callsign as they arrive."
                          : "Plays every transmission as it arrives."))}
              </small>
            </div>
            {!enabled && control?.reason === "not-paired" ? <p className="muted">Pair this device to read and send messages. Direct messages are private to paired devices.</p> : <Console b={b} run={commsCommand} enabled={enabled} />}
          </section>
          <ListeningCard b={b} />
        </>
      ) : (
      <>
      <section className="card">
        <h2 className="card__title">Avionics</h2>
        {!c?.radios ? (
          <p className="muted">No simulator connected, so the radios and transponder can't be read.</p>
        ) : (
          <div className="avionics">
            <div className="avionics__radios">
              <RadioRow n={1} active={c.radios.com1.active} standby={c.radios.com1.standby} rx={c.radios.com1.rx} run={commsCommand} enabled={enabled} />
              <RadioRow n={2} active={c.radios.com2.active} standby={c.radios.com2.standby} rx={c.radios.com2.rx} run={commsCommand} enabled={enabled} />
            </div>
            <Transponder x={c.xpdr} run={commsCommand} enabled={enabled} />
            <p className="listen">
              <a className="btn" href="https://listen.vatsim.net/" target="_blank" rel="noopener noreferrer">
                🎧 Listen on this device
              </a>
              <span className="muted">
                Opens VATSIM Listen, VATSIM's own web listener (sign in with your VATSIM account). Pick the ATC station
                {c.radios.com1.active ? ` for ${formatMhz(c.radios.com1.active)}` : ""} there. It plays what ATC says on the network, not your sim's audio, and VATSIM limits it to 15 minutes an hour.
              </span>
            </p>
          </div>
        )}
        <NetworkCard b={b} run={commsCommand} enabled={enabled} />
      </section>

      </>
      )}
    </div>
  );
}
