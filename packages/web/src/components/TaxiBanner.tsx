import type { TaxiGuide } from "@vbuddy/protocol";

const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);

/** What to do next, in words and an arrow. */
export function nextInstruction(g: TaxiGuide): { arrow: string; tone: "turn" | "hold" | "arrive"; title: string; inM: number } | null {
  const n = g.progress?.next;
  if (!n) return null;
  if (n.what === "turn") return { arrow: n.turn === "left" ? "↰" : n.turn === "right" ? "↱" : "↑", tone: "turn", title: `${n.turn === "ahead" ? "Continue onto" : `Turn ${n.turn} onto`} ${n.name}`, inM: n.inM };
  if (n.what === "cross") return { arrow: "⛔", tone: "hold", title: `Hold short of runway ${n.name}`, inM: n.inM };
  if (n.what === "hold") return { arrow: "⛔", tone: "hold", title: `Holding point: ${g.plan.destination.replace(/^holding point /, "")}`, inM: n.inM };
  return { arrow: "■", tone: "arrive", title: `Arriving at ${g.plan.destination}`, inM: n.inM };
}

/** The progressive taxi banner at the top of the Flights tab, while taxiing on a route. Tap to open Ground. */
export function TaxiBanner({ g, onOpen }: { g: TaxiGuide; onOpen: () => void }) {
  const n = nextInstruction(g);
  if (!n || !g.progress) return null;
  return (
    <button type="button" className={`taxibar taxibar--${n.tone}`} onClick={onOpen} aria-live="polite" aria-label={`${n.title}, in ${dist(n.inM)}. ${dist(g.progress.remainingM)} to go. Open Ground.`}>
      <span className="taxibar__arrow" aria-hidden="true">
        {n.arrow}
      </span>
      <span className="taxibar__text">
        <b>{n.title}</b>
        <span>
          in <strong>{dist(n.inM)}</strong> · {dist(g.progress.remainingM)} to {g.plan.destination}
          {g.progress.offRouteM > 40 ? " · off the route" : ""}
        </span>
      </span>
    </button>
  );
}
