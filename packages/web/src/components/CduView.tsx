import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CDU_COLUMNS, CDU_FLAG_REVERSE, CDU_FLAG_SMALL, CDU_FLAG_UNUSED, CDU_ROWS, type CduScreen } from "@vbuddy/protocol";
import { cduKey, watchCdu } from "../lib/useBridge";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { Segments } from "./Pages";

const SIDE_NAMES = ["Left", "Right", "Centre"];
/** Keys typed as characters, and what they type. */
const CHAR_KEY: Record<string, string> = { ".": "DOT", "-": "PLUS_MINUS", "+": "PLUS_MINUS", " ": "SPACE", "/": "SLASH" };
const LABEL: Record<string, string> = {
  INIT_REF: "INIT REF",
  DEP_ARR: "DEP ARR",
  N1_LIMIT: "N1 LIMIT",
  PREV_PAGE: "PREV PAGE",
  NEXT_PAGE: "NEXT PAGE",
  FMCCOMM: "FMC COMM",
  NAV_RAD: "NAV RAD",
  PLUS_MINUS: "+/−",
  DOT: "·",
  SLASH: "/",
  SPACE: "SP",
};
/** The Airbus MCDU's own key captions. */
const AIRBUS_LABEL: Record<string, string> = {
  FPLN: "F-PLN",
  RAD_NAV: "RAD NAV",
  FUEL_PRED: "FUEL PRED",
  SEC_FPLN: "SEC F-PLN",
  ATC_COM: "ATC COMM",
  AIRPORT: "AIR PORT",
  MENU: "MCDU MENU",
  PREV_PAGE: "←",
  NEXT_PAGE: "→",
  UP: "↑",
  DOWN: "↓",
  OVFY: "OVFY",
  CLR: "CLR",
};
const EDIT_KEYS = ["SPACE", "DEL", "SLASH", "OVFY", "CLR"];
const label = (k: string, airbus = false) => (airbus ? AIRBUS_LABEL[k] : undefined) ?? LABEL[k] ?? k.replace(/_/g, " ");

type Screen = { k: "waiting" } | { k: "none" } | { k: "screen"; s: CduScreen };

/** One cell row: runs of the same colour and flags are drawn as one span. */
function Row({ text, colors, flags }: { text: string; colors: string; flags: string }) {
  const runs: Array<{ t: string; c: string; f: number }> = [];
  const chars = [...text.padEnd(CDU_COLUMNS)].slice(0, CDU_COLUMNS);
  chars.forEach((ch, i) => {
    const c = colors[i] ?? "0";
    const f = Number(flags[i] ?? "0");
    const last = runs[runs.length - 1];
    if (last && last.c === c && last.f === f) last.t += ch;
    else runs.push({ t: ch, c, f });
  });
  return (
    <div className="cdu__row">
      {runs.map((r, i) => (
        <span
          key={i}
          className={`cdu-c${r.c}${r.f & CDU_FLAG_SMALL ? " is-small" : ""}${r.f & CDU_FLAG_REVERSE ? " is-rev" : ""}${r.f & CDU_FLAG_UNUSED ? " is-unused" : ""}`}
        >
          {r.t}
        </span>
      ))}
    </div>
  );
}

function Key({ k, onKey, className = "", lit, disabled, airbus }: { k: string; onKey: (k: string) => void; className?: string; lit?: boolean; disabled: boolean; airbus?: boolean }) {
  const text = label(k, airbus);
  const spoken = airbus ? ({ PREV_PAGE: "Previous page", NEXT_PAGE: "Next page", UP: "Scroll up", DOWN: "Scroll down" } as Record<string, string>)[k] ?? text : text;
  return (
    <button type="button" className={`cdu__key ${className}${lit ? " is-lit" : ""}`} disabled={disabled} onClick={() => onKey(k)} aria-label={spoken}>
      {lit !== undefined && <span className="cdu__lamp" aria-hidden />}
      {text}
    </button>
  );
}

/**
 * A CDU or MCDU: PMDG 737 / 777, the FlyByWire A32NX family or the Fenix A320 family. The screen as the aircraft draws
 * it, and its keys. Typing on the keyboard goes to the scratchpad.
 */
export function CduView({ b }: { b: BridgeSnapshot }) {
  const sides = b.panel?.cdu?.sides ?? 2;
  const [side, setSide] = useState(0);
  const [st, setSt] = useState<Screen>({ k: "waiting" });
  const [error, setError] = useState<string | null>(null);
  const errTimer = useRef<number | null>(null);
  const allowed = !!b.control?.allowed && b.link === "open";

  useEffect(() => {
    setSt({ k: "waiting" });
    return watchCdu(side, (e) => {
      if (e.kind === "screen") setSt(e.screen ? { k: "screen", s: e.screen } : { k: "none" });
      else {
        setError(e.error);
        if (errTimer.current) clearTimeout(errTimer.current);
        errTimer.current = window.setTimeout(() => setError(null), 5000);
      }
    });
  }, [side]);

  const s = st.k === "screen" ? st.s : null;
  const airbus = s?.layout === "airbus" || b.panel?.cdu?.kind === "mcdu";
  const unit = airbus ? "MCDU" : "CDU";
  const name = s?.name ?? b.panel?.cdu?.name ?? (airbus ? "MCDU" : "PMDG");
  const keys = new Set(s?.keys ?? []);
  const press = useCallback((k: string) => cduKey(side, k), [side]);
  const typeChar = (ch: string) => {
    const up = ch.toUpperCase();
    const k = /^[A-Z0-9]$/.test(up) ? up : CHAR_KEY[ch];
    if (k && keys.has(k)) press(k);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!allowed || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "Backspace" || e.key === "Delete") press("CLR");
    else if (e.key === "Enter" && keys.has("EXEC")) press("EXEC");
    else if (e.key.length === 1) typeChar(e.key);
    else return;
    e.preventDefault();
  };
  const [typed, setTyped] = useState("");

  const lsk = (n: number, lr: "L" | "R") => <Key key={`${lr}${n}`} k={`${lr}${n}`} airbus={airbus} onKey={press} className="cdu__lsk" disabled={!allowed || !keys.has(`${lr}${n}`)} />;
  const fn = [...keys].filter((k) => !/^[LR][1-6]$/.test(k) && k.length > 1 && !EDIT_KEYS.includes(k) && k !== "DOT" && k !== "PLUS_MINUS");
  const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "DOT", "0", "PLUS_MINUS"].filter((k) => keys.has(k));
  const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", ...EDIT_KEYS].filter((k) => keys.has(k));
  const a = s?.annun;

  return (
    <div className="cdu-page" onKeyDown={onKeyDown}>
      {sides > 1 && <Segments<string> pills value={String(side)} onChange={(v) => setSide(Number(v))} items={Array.from({ length: sides }, (_, i) => [String(i), `${SIDE_NAMES[i]} ${unit}`] as [string, string])} />}
      {!allowed && <p className="banner">Pair this device to press {unit} keys (Systems → Controls). The screen still shows.</p>}
      {error && <p className="banner" aria-live="assertive">{error}</p>}

      <section className={`cdu${airbus ? " cdu--airbus" : ""}`} aria-label={`${name} ${SIDE_NAMES[side]?.toLowerCase()} ${unit}`} tabIndex={-1}>
        <div className="cdu__top">
          <div className="cdu__lsks">{[1, 2, 3, 4, 5, 6].map((n) => lsk(n, "L"))}</div>
          <div className={`cdu__screen${s && s.live && !s.powered ? " is-off" : ""}`} role="img" aria-label={s?.live ? s.rows.join("\n") : "CDU screen"}>
            {s?.live ? (
              s.powered ? (
                Array.from({ length: CDU_ROWS }, (_, y) => <Row key={y} text={s.rows[y] ?? ""} colors={s.colors[y] ?? ""} flags={s.flags[y] ?? ""} />)
              ) : (
                <p className="cdu__msg">No power to this {unit}.</p>
              )
            ) : (
              <p className="cdu__msg">{st.k === "none" ? "No CDU VBuddy can reach on this aircraft." : (s?.message ?? `Waiting for the ${unit} screen…`)}</p>
            )}
          </div>
          <div className="cdu__lsks">{[1, 2, 3, 4, 5, 6].map((n) => lsk(n, "R"))}</div>
        </div>

        {s && !airbus && (
          <div className="cdu__annun" aria-label="CDU lights">
            {(
              [
                ["msg", "MSG"],
                ["ofst", "OFST"],
                ["fail", "FAIL"],
                [s.aircraft === "777" ? "dspy" : "call", s.aircraft === "777" ? "DSPY" : "CALL"],
              ] as const
            ).map(([id, text]) => (
              <span key={id} className={`cdu__light${a?.[id] ? " is-on" : ""}`}>
                {text}
              </span>
            ))}
          </div>
        )}

        {fn.length > 0 && (
          <div className="cdu__fn" role="group" aria-label="Function keys">
            {fn.map((k) => (
              <Key key={k} k={k} airbus={airbus} onKey={press} className={k === "EXEC" ? "cdu__exec" : ""} lit={k === "EXEC" ? !!a?.exec : undefined} disabled={!allowed} />
            ))}
          </div>
        )}
        <div className="cdu__pad">
          <div className="cdu__digits" role="group" aria-label="Numbers">
            {digits.map((k) => (
              <Key key={k} k={k} airbus={airbus} onKey={press} disabled={!allowed} />
            ))}
          </div>
          <div className="cdu__letters" role="group" aria-label="Letters">
            {letters.map((k) => (
              <Key key={k} k={k} airbus={airbus} onKey={press} className={EDIT_KEYS.includes(k) ? "cdu__edit" : ""} disabled={!allowed} />
            ))}
          </div>
        </div>
      </section>

      <form
        className="cdu__type"
        onSubmit={(e) => {
          e.preventDefault();
          for (const ch of typed) typeChar(ch);
          setTyped("");
        }}
      >
        <label htmlFor="cdu-type">Type into the scratchpad</label>
        <div className="cdu__typerow">
          <input id="cdu-type" value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase().slice(0, CDU_COLUMNS))} autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="e.g. KSEA" disabled={!allowed} />
          <button type="submit" className="btn" disabled={!allowed || !typed}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
