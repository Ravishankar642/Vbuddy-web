import { useState, type FormEvent } from "react";
import type { AcarsMessage } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { useBridgeActions } from "../lib/useBridge";

const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16) + "Z";
const KIND: Record<AcarsMessage["kind"], string> = { telex: "Telex", cpdlc: "CPDLC", info: "Info", system: "" };

function Msg({ m, enabled, onAnswer }: { m: AcarsMessage; enabled: boolean; onAnswer: (m: AcarsMessage, a: NonNullable<AcarsMessage["answers"]>[number]) => void }) {
  return (
    <div className={`msg msg--${m.dir}${m.kind === "system" ? " msg--system" : ""}`}>
      <div className="msg__meta">
        <b>{m.dir === "in" ? m.peer : `To ${m.peer}`}</b>
        <span>
          {KIND[m.kind] && `${KIND[m.kind]} · `}
          {hhmm(m.ts)}
        </span>
      </div>
      <div className="msg__text acars__text">{m.text}</div>
      {m.dir === "in" && m.answers && (
        <div className="acars__answers">
          {m.answered ? (
            <span className="muted">Answered: {m.answered}</span>
          ) : (
            m.answers.map((a) => (
              <button key={a} type="button" className={`btn${a === m.answers![0] ? " btn--primary" : ""}`} disabled={!enabled} onClick={() => onAnswer(m, a)}>
                {a}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function AcarsView({ b, enabled }: { b: BridgeSnapshot; enabled: boolean }) {
  const { acarsCommand } = useBridgeActions();
  const a = b.acars;
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [wxKind, setWxKind] = useState<"metar" | "taf" | "atis">("metar");
  const [icao, setIcao] = useState("");
  const [pdcTo, setPdcTo] = useState("");
  const [stand, setStand] = useState("");
  const [atis, setAtis] = useState("");
  const [logon, setLogon] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (cmd: Parameters<typeof acarsCommand>[0], after?: () => void) => {
    setBusy(true);
    setErr(null);
    const r = await acarsCommand(cmd);
    setBusy(false);
    if (r.ok) after?.();
    else setErr(r.error);
  };

  if (!enabled) return <p className="muted">Pair this device to use ACARS. Messages are private to paired devices.</p>;
  if (!a) return <p className="muted">Loading…</p>;
  if (!a.configured)
    return (
      <p className="muted">
        Enter your Hoppie logon code in the VBuddy window on your PC (under Your accounts), then come back here. You get a code from hoppie.nl/acars, and you need it to send and receive ACARS messages.
      </p>
    );

  const send = (e: FormEvent) => {
    e.preventDefault();
    void run({ op: "telex", to: to.trim(), text: text.trim() }, () => setText(""));
  };
  const ago = a.lastPollAt ? `${Math.max(0, Math.round((Date.now() - a.lastPollAt) / 60000))} min ago` : "not yet";

  return (
    <div className="acars">
      <p className="acars__status">
        <span>
          Sending as <b>{a.callsign ?? "(no callsign yet)"}</b>
        </span>
        <span className="muted">{a.polling ? `Checked ${ago}` : a.callsign ? "Waiting for the simulator" : "Connect to VATSIM or load a SimBrief plan"}</span>
        <button type="button" className="btn" disabled={busy || !a.callsign} onClick={() => void run({ op: "poll" })}>
          Check now
        </button>
      </p>
      {a.error && (
        <p className="setval__err" role="alert">
          {a.error}
        </p>
      )}

      <div className="acars__list" role="log" aria-live="polite">
        {a.messages.length === 0 ? <p className="muted">No messages yet.</p> : a.messages.map((m) => <Msg key={m.id} m={m} enabled={enabled && !busy} onAnswer={(msg, ans) => void run({ op: "cpdlcReply", id: msg.id, answer: ans })} />)}
      </div>

      <form className="acars__send" onSubmit={send}>
        <input value={to} onChange={(e) => setTo(e.target.value.toUpperCase())} placeholder="To, e.g. EGLL_DEL" aria-label="Station" maxLength={12} autoCapitalize="characters" spellCheck={false} />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Telex message" aria-label="Telex message" maxLength={220} />
        <button type="submit" className="btn btn--primary" disabled={busy || !to.trim() || !text.trim()}>
          Send
        </button>
      </form>

      <details className="acars__tools">
        <summary>Weather, clearance and CPDLC logon</summary>
        <form className="acars__tool" onSubmit={(e) => (e.preventDefault(), void run({ op: "info", kind: wxKind, icao }, () => setIcao("")))}>
          <b>Weather</b>
          <select value={wxKind} onChange={(e) => setWxKind(e.target.value as typeof wxKind)} aria-label="Report">
            <option value="metar">METAR</option>
            <option value="taf">TAF</option>
            <option value="atis">ATIS</option>
          </select>
          <input value={icao} onChange={(e) => setIcao(e.target.value.toUpperCase())} placeholder="ICAO" aria-label="Airport" maxLength={4} spellCheck={false} />
          <button type="submit" className="btn" disabled={busy || icao.length !== 4}>
            Request
          </button>
        </form>
        <form className="acars__tool" onSubmit={(e) => (e.preventDefault(), void run({ op: "pdc", to: pdcTo.trim(), ...(stand ? { stand } : {}), ...(atis ? { atis } : {}) }))}>
          <b>Pre-departure clearance</b>
          <input value={pdcTo} onChange={(e) => setPdcTo(e.target.value.toUpperCase())} placeholder="Station, e.g. EDDF_DEL" aria-label="Clearance station" maxLength={12} spellCheck={false} />
          <input value={stand} onChange={(e) => setStand(e.target.value)} placeholder="Stand (optional)" aria-label="Stand" maxLength={8} />
          <input value={atis} onChange={(e) => setAtis(e.target.value.toUpperCase().slice(0, 1))} placeholder="ATIS letter" aria-label="ATIS letter" maxLength={1} />
          <button type="submit" className="btn" disabled={busy || !pdcTo.trim()}>
            Request clearance
          </button>
          <small className="muted">Filled in from your SimBrief plan: callsign, aircraft, departure and arrival.</small>
        </form>
        <form className="acars__tool" onSubmit={(e) => (e.preventDefault(), void run({ op: "cpdlcLogon", to: logon.trim() }))}>
          <b>CPDLC logon</b>
          <input value={logon} onChange={(e) => setLogon(e.target.value.toUpperCase())} placeholder="ATC unit, e.g. EGTT" aria-label="ATC unit" maxLength={12} spellCheck={false} />
          <button type="submit" className="btn" disabled={busy || !logon.trim()}>
            Request logon
          </button>
          {a.logon && <small className="muted">Logon requested to {a.logon}. ATC answers with a message here.</small>}
        </form>
        <button type="button" className="btn btn--ghost" onClick={() => void run({ op: "clear" })}>
          Clear the list
        </button>
      </details>
      {err && (
        <p className="setval__err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
