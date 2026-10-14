import { useState } from "react";
import type { PushPrefs } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { useBridgeActions } from "../lib/useBridge";
import { pushSupport, subscribeBrowser, unsubscribeBrowser } from "../lib/push";

const WHY: Record<string, string> = {
  insecure: "Notifications need a secure (https) address, like your relay. They can't work on a plain http://192.168… address.",
  "ios-install": "On iPhone and iPad, add VBuddy to your Home Screen first (Share → Add to Home Screen), then open it from there to turn notifications on.",
  unsupported: "This browser can't receive notifications.",
};

/** The usual choices, plus whatever value is saved if it isn't one of them (so the box never shows something untrue). */
const withCurrent = (opts: number[], cur: number) => (opts.includes(cur) ? opts : [...opts, cur].sort((a, b) => a - b));

/** Phone/tablet notifications for ATC contact changes and touchdowns. Hidden when the bridge has them switched off. */
export function NotifyCard({ b }: { b: BridgeSnapshot }) {
  const { pushSubscribe, pushUnsubscribe, pushTest } = useBridgeActions();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = b.push;
  if (!p) return null;
  const support = pushSupport();
  const paired = b.control?.reason === "paired";

  const turnOn = async (prefs: PushPrefs) => {
    if (!p.publicKey) return;
    setBusy(true);
    setErr(null);
    const r = await subscribeBrowser(p.publicKey);
    setBusy(false);
    if (r.ok) pushSubscribe(r.sub, prefs);
    else setErr(r.error);
  };
  const turnOff = async () => {
    await unsubscribeBrowser();
    pushUnsubscribe();
  };
  const setPref = <K extends keyof PushPrefs>(k: K, v: PushPrefs[K]) => {
    const next = { ...p.prefs, [k]: v };
    if (p.subscribed) void turnOn(next);
  };

  return (
    <section className="card notify">
      <h2 className="card__title">Notifications</h2>
      {!paired ? (
        <p className="muted">Pair this device under Systems → Controls to get notifications when VBuddy isn't open.</p>
      ) : support !== "ok" ? (
        <p className="muted">{WHY[support]}</p>
      ) : (
        <>
          <p className="muted">Get a message on this device when ATC or a pilot messages you, a new controller takes over, a boundary is coming up, you touch down, VATSIM connects or drops, or something is wrong with the aircraft, even with VBuddy closed.</p>
          {p.subscribed && (
            <>
              <div className="notify__prefs">
                <label>
                  <input type="checkbox" checked={p.prefs.atc} onChange={(e) => setPref("atc", e.target.checked)} /> ATC changes and boundaries
                </label>
                <label>
                  <input type="checkbox" checked={p.prefs.chat} onChange={(e) => setPref("chat", e.target.checked)} /> Messages (DMs, ATC calls to you)
                </label>
                <label>
                  <input type="checkbox" checked={p.prefs.landing} onChange={(e) => setPref("landing", e.target.checked)} /> Touchdown result
                </label>
                <label>
                  <input type="checkbox" checked={p.prefs.vatsim} onChange={(e) => setPref("vatsim", e.target.checked)} /> VATSIM connected / disconnected
                </label>
                <label>
                  <input type="checkbox" checked={p.prefs.alerts} onChange={(e) => setPref("alerts", e.target.checked)} /> Aircraft alerts (engine, stall, overspeed, gear, sink rate, fuel)
                </label>
                <label>
                  <input type="checkbox" checked={p.prefs.apOff} onChange={(e) => setPref("apOff", e.target.checked)} /> Autopilot switches off in the cruise
                </label>
              </div>
              <div className="notify__sel">
                <label>
                  <span>Tell me before the top of descent</span>
                  <select value={p.prefs.todMin} onChange={(e) => setPref("todMin", Number(e.target.value))}>
                    {withCurrent([0, 5, 10, 15, 20, 30], p.prefs.todMin).map((v) => (
                      <option key={v} value={v}>
                        {v === 0 ? "Don't tell me" : `${v} min before`}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Warn about low fuel when less than</span>
                  <select value={p.prefs.fuelMin} disabled={!p.prefs.alerts} onChange={(e) => setPref("fuelMin", Number(e.target.value))}>
                    {withCurrent([0, 15, 20, 30, 45, 60, 90], p.prefs.fuelMin).map((v) => (
                      <option key={v} value={v}>
                        {v === 0 ? "Don't warn" : `${v} min left`}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Tell me about an ATC boundary when it is</span>
                  <select value={p.prefs.atcAheadNm} disabled={!p.prefs.atc} onChange={(e) => setPref("atcAheadNm", Number(e.target.value))}>
                    {withCurrent([10, 20, 30, 40, 60, 80, 100, 150], p.prefs.atcAheadNm).map((v) => (
                      <option key={v} value={v}>
                        {v} nm ahead
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Boundary and no-ATC notices</span>
                  <select value={p.prefs.atcPerHour} disabled={!p.prefs.atc} onChange={(e) => setPref("atcPerHour", Number(e.target.value))}>
                    {withCurrent([0, 2, 3, 5, 10, 20], p.prefs.atcPerHour).map((v) => (
                      <option key={v} value={v}>
                        {v === 0 ? "No limit" : `At most ${v} per hour`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}
          <div className="notify__row">
            {p.subscribed ? (
              <>
                <button type="button" className="btn" onClick={pushTest}>
                  Send a test
                </button>
                <button type="button" className="btn btn--ghost" onClick={turnOff}>
                  Turn off
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--primary" disabled={busy || !p.publicKey} onClick={() => void turnOn(p.prefs)}>
                {busy ? "Turning on…" : "Turn on notifications"}
              </button>
            )}
          </div>
        </>
      )}
      {(err || p.note) && (
        <p className={err ? "setval__err" : "muted"} role="status">
          {err ?? p.note}
        </p>
      )}
    </section>
  );
}
