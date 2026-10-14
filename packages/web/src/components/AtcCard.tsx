import { UNICOM_FREQ, type AtcStation } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { useNow } from "../lib/useBridge";
import { ago } from "../lib/format";

function Station({ s }: { s: AtcStation | null }) {
  if (!s)
    return (
      <>
        <span className="atc__freq">{UNICOM_FREQ}</span>
        <span className="atc__name">UNICOM (no ATC covering you)</span>
      </>
    );
  return (
    <>
      <span className="atc__freq">{s.freq}</span>
      <span className="atc__name">
        {s.name} <span className="atc__cs">{s.callsign}</span>
      </span>
    </>
  );
}

/** "VATSIM · 42 nearby · 12 s ago", or what's wrong. */
export function NetworkChip({ b }: { b: BridgeSnapshot }) {
  const now = useNow(1000);
  const n = b.network;
  if (!n || n.state === "off") return <span className="chip">Online network off</span>;
  if (n.state === "loading") return <span className="chip">VATSIM: loading…</span>;
  if (n.state === "error") return <span className="chip chip--warn" title={n.detail}>VATSIM unreachable</span>;
  const age = n.updatedAt ? now - n.updatedAt : null;
  return (
    <span className={`chip${n.state === "stale" ? " chip--warn" : ""}`} title={n.detail}>
      VATSIM · {b.traffic?.pilots.length ?? 0} nearby{b.traffic?.you ? ` · you: ${b.traffic.you}` : ""}
      {age !== null && ` · ${ago(age)}`}
      {n.state === "stale" && " (retrying)"}
    </span>
  );
}

/** Who to talk to now, and what's next on your track. */
export function AtcCard({ b, compact }: { b: BridgeSnapshot; compact?: boolean }) {
  const now = useNow(1000);
  if (!b.network || b.network.state === "off") return null;
  const atc = b.atc;
  const simUp = !!b.sim?.connected && !!b.latest;
  const noShapes = !b.network.boundaries;

  return (
    <section className={`card atc${compact ? " atc--compact" : ""}`} aria-label="Air traffic control">
      <h2 className="card__title">Your ATC</h2>
      {!simUp ? (
        <p className="muted">Shown once the simulator is sending your position.</p>
      ) : b.network.state === "error" ? (
        <p className="muted">{b.network.detail ?? "VATSIM data isn't available."}</p>
      ) : (
        <>
          <div className="atc__now">
            <Station s={atc?.current ?? null} />
          </div>
          {atc?.ahead && (
            <div className="atc__next">
              <span className="atc__when">
                Next in {Math.max(0, Math.round((atc.ahead.etaSec - (now - atc.receivedAt) / 1000) / 60)) || "<1"} min · {atc.ahead.distNm} nm
              </span>
              <Station s={atc.ahead.station} />
            </div>
          )}
          {noShapes && <p className="muted atc__note">Sector shapes haven't downloaded yet, so only airport positions can be matched.</p>}
        </>
      )}
    </section>
  );
}
