import { useEffect, useState } from "react";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { apiFetch } from "../lib/api";
import { saveFile } from "../lib/logbook-stats";

interface Item {
  id: string;
  label: string;
  state: "ok" | "warn" | "bad" | "off";
  text: string;
  fix?: string;
}

/** Settings → Health: each part of VBuddy, how it is, and what to do. Asked for every 15 s while it's on screen. */
export function HealthCard({ b }: { b: BridgeSnapshot }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (b.link !== "open") return;
    let stop = false;
    const load = async () => {
      try {
        const r = await apiFetch("/api/health/check");
        const j = (await r.json()) as { items?: Item[]; error?: string };
        if (stop) return;
        if (!r.ok) setErr(j.error ?? "Not available.");
        else {
          setItems(j.items ?? []);
          setErr(null);
        }
      } catch {
        if (!stop) setErr("The bridge didn't answer.");
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [b.link]);
  const bad = items?.filter((i) => i.state === "bad" || i.state === "warn").length ?? 0;
  const download = async () => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/diagnostics");
      if (!r.ok) throw new Error();
      await saveFile(`vbuddy-diagnostics-${new Date().toISOString().slice(0, 16).replace(":", "")}.json`, "application/json", JSON.stringify(await r.json(), null, 1));
    } catch {
      setErr("Couldn't make the diagnostics file.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card hc" aria-label="Health">
      <div className="hc__head">
        <h2 className="card__title">Health</h2>
        {items && <span className={bad ? "is-warn" : "is-ok"}>{bad ? `${bad} to look at` : "All good"}</span>}
      </div>
      {err && <p className="muted">{err}</p>}
      {items && (
        <ul className="hc__list">
          {items.map((i) => (
            <li key={i.id}>
              <i className={`hc__dot hc__dot--${i.state}`} aria-label={i.state} />
              <div>
                <b>{i.label}</b>
                <span>{i.text}</span>
                {i.fix && <em>{i.fix}</em>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn" disabled={busy || !!err} onClick={() => void download()}>
        Diagnostics file
      </button>
      <p className="muted hc__note">For bug reports: settings, what's connected and the bridge's recent log. Pairing codes and links are left out.</p>
    </section>
  );
}
