import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type Probe = { reachable: boolean; port: number; path: string | null; needsPairing: boolean };
type State = { k: "loading" } | { k: "error"; msg: string } | { k: "ready"; p: Probe };

/** The Fenix EFB, shown inside VBuddy. The bridge passes it through, so it also works away from home. */
export function EfbView() {
  const [st, setSt] = useState<State>({ k: "loading" });
  const load = useCallback(async () => {
    setSt({ k: "loading" });
    try {
      const res = await apiFetch("/api/efb");
      if (!res.ok) throw new Error(`The bridge answered ${res.status}.`);
      setSt({ k: "ready", p: (await res.json()) as Probe });
    } catch (e) {
      setSt({ k: "error", msg: e instanceof Error ? e.message : "Could not reach the bridge." });
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (st.k === "loading") return <p className="muted efb__note">Looking for the EFB…</p>;
  if (st.k === "error")
    return (
      <section className="card efb__note">
        <h2 className="card__title">Can't reach the bridge</h2>
        <p className="muted">{st.msg}</p>
        <button type="button" className="btn" onClick={load}>Try again</button>
      </section>
    );
  const p = st.p;
  if (p.needsPairing)
    return (
      <section className="card efb__note">
        <h2 className="card__title">Pair this device first</h2>
        <p className="muted">The EFB controls your aircraft, so it opens only on this PC and on devices you have paired. Pair under Settings, then come back.</p>
      </section>
    );
  if (!p.reachable || !p.path)
    return (
      <section className="card efb__note">
        <h2 className="card__title">The EFB isn't running</h2>
        <p className="muted">
          Load the Fenix A320 in MSFS and turn on its external EFB (Fenix → EFB settings → enable the web server). VBuddy looks for it on port {p.port}. If you changed the port, start the bridge with <code>--efb-port</code>.
        </p>
        <button type="button" className="btn btn--primary" onClick={load}>Check again</button>
      </section>
    );
  return (
    <div className="efb">
      <iframe className="efb__frame" title="Fenix EFB" src={p.path} allow="fullscreen" />
      <div className="efb__bar">
        <button type="button" className="btn btn--ghost" onClick={load}>Reload</button>
        <a className="btn btn--ghost" href={p.path} target="_blank" rel="noreferrer">Open full screen</a>
      </div>
      <p className="muted efb__hint">If the MCDU display is blank, tap the display, then come back. Use that as a workaround for now.</p>
    </div>
  );
}
