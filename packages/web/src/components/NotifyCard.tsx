import { setTaxiScreenPrefs, useTaxiScreenPrefs } from "../lib/taxi-prefs";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PushPrefs } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { useBridgeActions } from "../lib/useBridge";
import { existingSubscription, pushSupport, subscribeBrowser, unsubscribeBrowser } from "../lib/push";

const WHY: Record<string, string> = {
  insecure: "Notifications need a secure (https) address, like your relay link. They can't work on a plain http://192.168… address.",
  "ios-install": "On iPhone and iPad, add VBuddy to your Home Screen first (Share → Add to Home Screen), then open it from there to turn notifications on.",
  unsupported: "This browser can't receive notifications.",
  app: "The VBuddy iPhone app can't receive notifications (iPhone only allows them for App Store apps and Home Screen web apps). For notifications, open your phone link in Safari and add it to your Home Screen (Share → Add to Home Screen) as well; pair it the same way.",
};

/** The usual choices, plus whatever value is saved if it isn't one of them (so the box never shows something untrue). */
const withCurrent = (opts: number[], cur: number) => (opts.includes(cur) ? opts : [...opts, cur].sort((a, b) => a - b));

type BoolPref = { [K in keyof PushPrefs]: PushPrefs[K] extends boolean ? K : never }[keyof PushPrefs];

function Toggle({ label, hint, on, disabled, onChange }: { label: string; hint?: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`sw${disabled ? " is-off" : ""}`}>
      <span className="sw__text">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden />
    </label>
  );
}

function Pick({ label, value, options, render, disabled, onChange }: { label: string; value: number; options: number[]; render: (v: number) => string; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <label className={`sw sw--pick${disabled ? " is-off" : ""}`}>
      <span className="sw__text">
        <b>{label}</b>
      </span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {withCurrent(options, value).map((v) => (
          <option key={v} value={v}>
            {render(v)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card notify__group">
      <h2 className="card__title">{title}</h2>
      <div className="notify__list">{children}</div>
    </section>
  );
}

/**
 * This browser already has permission and a subscription, but the bridge doesn't know it (paired again, a new
 * bridge data folder, or a subscription made before): hand it over again, so notifications keep arriving.
 * Runs whenever the app opens.
 */
export function usePushResync(b: BridgeSnapshot) {
  const { pushSubscribe } = useBridgeActions();
  const done = useRef(false);
  const p = b.push;
  const paired = b.control?.reason === "paired";
  useEffect(() => {
    if (!p || p.subscribed || !paired || done.current || !p.publicKey || pushSupport() !== "ok") return;
    done.current = true;
    void existingSubscription(p.publicKey).then((sub) => {
      if (sub) pushSubscribe(sub, p.prefs);
    });
  }, [p, paired, pushSubscribe]);
}

/**
 * Notifications: one switch for this device, then what to be told about. They reach the phone even with VBuddy
 * closed (through the browser's push service); while the app is on screen the same things show inside it.
 */
export function NotificationsPage({ b }: { b: BridgeSnapshot }) {
  const { pushSubscribe, pushUnsubscribe, pushTest } = useBridgeActions();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = b.push;
  const support = pushSupport();
  const paired = b.control?.reason === "paired";

  if (!p) {
    return (
      <section className="card">
        <h2 className="card__title">Notifications</h2>
        <p className="muted">Notifications are switched off on the bridge (VBUDDY_PUSH in the settings file on the PC).</p>
      </section>
    );
  }

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
  const set = <K extends keyof PushPrefs>(k: K, v: PushPrefs[K]) => {
    if (p.subscribed) void turnOn({ ...p.prefs, [k]: v });
  };
  const sw = (k: BoolPref, label: string, hint?: string, disabled?: boolean) => <Toggle label={label} hint={hint} on={!!p.prefs[k]} disabled={!p.subscribed || disabled} onChange={(v) => set(k, v)} />;
  const off = !p.subscribed || !paired || support !== "ok";

  return (
    <div className="notify">
      <section className="card notify__master">
        {!paired ? (
          <p className="muted">Pair this device under Systems → Controls to get notifications when VBuddy isn't open.</p>
        ) : support !== "ok" ? (
          <p className="muted">{WHY[support]}</p>
        ) : (
          <>
            <Toggle
              label="Notifications on this device"
              hint={p.subscribed ? "On. They arrive even with VBuddy closed." : "Off. Turn on to be told about your flight while you're away from the PC."}
              on={p.subscribed}
              disabled={busy || !p.publicKey}
              onChange={(v) => void (v ? turnOn(p.prefs) : turnOff())}
            />
            {p.subscribed && (
              <div className="notify__row">
                <button type="button" className="btn" onClick={pushTest}>
                  Send a test
                </button>
              </div>
            )}
          </>
        )}
        {(err || p.note) && (
          <p className={err ? "setval__err" : "muted"} role="status">
            {err ?? p.note}
          </p>
        )}
      </section>

      <TaxiScreenCard />
      {(
        <div className={off ? "notify__dim" : undefined} aria-disabled={off}>
          <Group title="Your flight">
            {sw("takeoff", "Takeoff", "Wheels up.")}
            {sw("toc", "Top of climb", "Levelled off at the cruise altitude.")}
            {sw("tenK", "Passing 10,000 ft", "Climbing and descending.")}
            <Pick label="Top of descent" value={p.prefs.todMin} options={[0, 5, 10, 15, 20, 30]} render={(v) => (v === 0 ? "Off" : `${v} min before`)} disabled={off} onChange={(v) => set("todMin", v)} />
            <Pick label="Approaching the destination" value={p.prefs.approachMin} options={[0, 5, 10, 15, 20, 30]} render={(v) => (v === 0 ? "Off" : `${v} min before`)} disabled={off} onChange={(v) => set("approachMin", v)} />
            {sw("landing", "Touchdown", "Rate, G and the rating.")}
            {sw("gate", "At the gate", "Parked, parking brake set, engines off.")}
          </Group>
          <Group title="Taxi">
            {sw("taxi", "Taxi guidance", "A turn, a runway crossing or the holding point coming up, and the route ATC gave you.")}
          </Group>
          <Group title="ATC and VATSIM">
            {sw("atc", "New controller and boundaries", "Who to contact next, and leaving ATC coverage.")}
            <Pick label="Boundary warning" value={p.prefs.atcAheadNm} options={[10, 20, 30, 40, 60, 80, 100, 150]} render={(v) => `${v} nm ahead`} disabled={off || !p.prefs.atc} onChange={(v) => set("atcAheadNm", v)} />
            <Pick label="Boundary notices" value={p.prefs.atcPerHour} options={[0, 2, 3, 5, 10, 20]} render={(v) => (v === 0 ? "No limit" : `At most ${v} an hour`)} disabled={off || !p.prefs.atc} onChange={(v) => set("atcPerHour", v)} />
            {sw("callsign", "ATC calls you", "When ATC says your callsign on the radio: VATSIM text, VBuddy's voice to text, SayIntentions or BeyondATC.")}
            {sw("chat", "Messages", "Private messages, SELCAL and ACARS.")}
            {sw("vatsim", "VATSIM connected or disconnected")}
            {sw("planLoaded", "Flight plan loaded", "Your SimBrief plan, when you connect to VATSIM.")}
          </Group>
          <Group title="Aircraft and simulator">
            {sw("alerts", "Aircraft alerts", "Engine, stall, overspeed, gear, sink rate, fuel.")}
            <Pick label="Low fuel warning" value={p.prefs.fuelMin} options={[0, 15, 20, 30, 45, 60, 90]} render={(v) => (v === 0 ? "Off" : `Under ${v} min left`)} disabled={off || !p.prefs.alerts} onChange={(v) => set("fuelMin", v)} />
            {sw("apOff", "Autopilot off in the cruise")}
            {sw("simLost", "Simulator stopped", "MSFS closed or stopped sending data mid-flight.")}
            {sw("paused", "Simulator paused", "When VBuddy pauses it for you (Pause later).")}
          </Group>
        </div>
      )}
    </div>
  );
}

/** Taxi guidance while VBuddy is open on this device (notifications when it's closed are with the others below). */
function TaxiScreenCard() {
  const p = useTaxiScreenPrefs();
  return (
    <section className="card">
      <h2 className="card__title">Taxi guidance on this screen</h2>
      <Toggle label="Banner on the Flights tab" hint="The next turn or holding point and how far, at the top of the screen while you taxi on a route." on={p.banner} disabled={false} onChange={(v) => setTaxiScreenPrefs({ banner: v })} />
      <Toggle label="Notes in the app" hint="A short note, with a chime, as each turn comes up and when ATC's taxi clearance becomes the route." on={p.notes} disabled={false} onChange={(v) => setTaxiScreenPrefs({ notes: v })} />
    </section>
  );
}

/** Kept for the Settings page: a short note pointing to the Notifications page. */
export function NotifyCard({ b, open }: { b: BridgeSnapshot; open: () => void }) {
  if (!b.push) return null;
  return (
    <section className="card">
      <h2 className="card__title">Notifications</h2>
      <p className="muted">{b.push.subscribed ? "On for this device." : "Off for this device."}</p>
      <div className="notify__row">
        <button type="button" className="btn" onClick={open}>
          Choose notifications
        </button>
      </div>
    </section>
  );
}
