import { useEffect, useMemo, useRef, useState } from "react";
import type { Telemetry } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { checklistsFor, currentChecklist, familyOf, type AutoCtx } from "../lib/checklists";

type Ticks = Record<string, boolean>;
const KEY = "vbuddy.checklists";

function load(flight: string): Ticks {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "null") as { flight?: string; ticks?: Ticks } | null;
    return j?.flight === flight ? (j.ticks ?? {}) : {};
  } catch {
    return {};
  }
}
function save(flight: string, ticks: Ticks) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ flight, ticks }));
  } catch {
    /* this visit only */
  }
}

/**
 * Normal checklists for the aircraft's family. The one that fits the moment is shown (until you pick another); items the
 * sim can confirm tick themselves. Kept on this device, per flight: nothing runs on the PC.
 */
export function ChecklistCard({ b, t }: { b: BridgeSnapshot; t: Telemetry }) {
  const family = familyOf(b.sim?.aircraftTitle, b.sim?.atcModel);
  const lists = useMemo(() => checklistsFor(family), [family]);
  const flight = String(b.sim?.flight?.startedAt ?? "none");
  const [ticks, setTicks] = useState<Ticks>(() => load(flight));
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    setTicks(load(flight));
    setPicked(null);
  }, [flight]);
  // Ticked on another device: its ticks arrive through the PC.
  useEffect(() => {
    const on = () => setTicks(load(flight));
    window.addEventListener("vbuddy-settings", on);
    return () => window.removeEventListener("vbuddy-settings", on);
  }, [flight]);

  const eng = b.systems?.engines;
  const enginesRunning = eng ? [eng.eng1, eng.eng2, eng.eng3, eng.eng4].slice(0, eng.count || 2).filter((e) => e.running).length : null;
  const ctx: AutoCtx = { t, xpdrAlt: b.comms?.xpdr ? b.comms.xpdr.mode === "alt" : null, enginesRunning };
  const now = currentChecklist(t, !!b.sim?.flight?.takeoffAt, enginesRunning);
  const id = picked ?? now;
  const list = lists.find((l) => l.id === id) ?? lists[0]!;

  const state = (itemId: string, auto?: (c: AutoCtx) => boolean | null): { on: boolean; byAuto: boolean } => {
    const k = `${list.id}.${itemId}`;
    if (k in ticks) return { on: ticks[k]!, byAuto: false };
    const a = auto?.(ctx);
    return { on: a === true, byAuto: a === true };
  };
  const toggle = (itemId: string, on: boolean) => {
    const next = { ...ticks, [`${list.id}.${itemId}`]: !on };
    setTicks(next);
    save(flight, next);
  };
  // Keep the chosen checklist's chip in view.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && strip.current) strip.current.scrollTo({ left: el.offsetLeft - strip.current.clientWidth / 2 + el.clientWidth / 2, behavior: "smooth" });
  }, [list.id]);
  const done = list.items.filter((i) => state(i.id, i.auto).on).length;
  const reset = () => {
    const next = Object.fromEntries(Object.entries(ticks).filter(([k]) => !k.startsWith(`${list.id}.`)));
    setTicks(next);
    save(flight, next);
  };

  return (
    <div className="ck">
      <div className="ck__lists" role="tablist" aria-label="Checklists" ref={strip}>
        {lists.map((l) => (
          <button key={l.id} type="button" role="tab" aria-selected={l.id === list.id} className={l.id === now ? "is-now" : undefined} onClick={() => setPicked(l.id === now ? null : l.id)}>
            {l.title}
          </button>
        ))}
      </div>
      <div className="ck__head">
        <b>{list.title}</b>
        <span className={done === list.items.length ? "is-done" : undefined}>{done === list.items.length ? "Complete" : `${done} of ${list.items.length}`}</span>
        <button type="button" className="ck__reset" onClick={reset}>
          Reset
        </button>
      </div>
      <ul className="ck__items">
        {list.items.map((i) => {
          const s = state(i.id, i.auto);
          return (
            <li key={i.id}>
              <button type="button" aria-pressed={s.on} onClick={() => toggle(i.id, s.on)}>
                <span className="ck__box" aria-hidden>
                  {s.on && (
                    <svg viewBox="0 0 24 24">
                      <path d="M5 12l4 4 10-10" />
                    </svg>
                  )}
                </span>
                <span className="ck__item">{i.item}</span>
                <span className="ck__dots" aria-hidden />
                <span className="ck__state">{i.state}</span>
                {s.byAuto && <small className="ck__auto">sim</small>}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted ck__note">{family === "generic" ? "General checklist." : `${family === "airbus" ? "Airbus" : "Boeing"}-style checklist.`} Items marked "sim" were confirmed by the simulator. Not a substitute for your aircraft's own checklist.</p>
    </div>
  );
}
