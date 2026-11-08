import { useEffect, useState } from "react";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { useBridgeActions } from "../lib/useBridge";

/** Settings → Share my flight: a link a friend opens to follow along, view only, for 24 hours. */
export function ShareCard({ b }: { b: BridgeSnapshot }) {
  const { shareLink } = useBridgeActions();
  const [copied, setCopied] = useState(false);
  const paired = b.control?.reason === "paired" || b.control?.reason === "localhost";
  useEffect(() => {
    if (b.link === "open" && paired) shareLink("get");
  }, [b.link, paired, shareLink]);
  if (!paired || b.share?.viewer) return null;
  const s = b.share;
  const until = s?.expiresAt ? new Date(s.expiresAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <section className="card share">
      <h2 className="card__title">Share my flight</h2>
      <p className="muted">A link a friend can open to follow your flight on the map, with your flight card and landings. View only: no messages, controls or settings. It works for 24 hours, or until you stop it.</p>
      {s?.url ? (
        <>
          <div className="share__link">
            <code>{s.url}</code>
          </div>
          <div className="share__acts">
            <button
              type="button"
              className="btn"
              onClick={() => {
                const nav = navigator as Navigator & { share?: (d: { url: string; title: string }) => Promise<void> };
                if (nav.share) void nav.share({ url: s.url!, title: "Follow my flight" }).catch(() => {});
                else void navigator.clipboard?.writeText(s.url!).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Share"}
            </button>
            <button type="button" className="btn" onClick={() => shareLink("revoke")}>
              Stop sharing
            </button>
          </div>
          {until && <p className="muted share__until">Works until {until}.</p>}
        </>
      ) : (
        <button type="button" className="btn" onClick={() => shareLink("create")}>
          Make a link
        </button>
      )}
      {s?.error && <p className="muted share__err">{s.error}</p>}
    </section>
  );
}
