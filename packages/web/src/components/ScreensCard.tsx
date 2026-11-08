import { useState } from "react";
import { readDash, SCREENS, TILES, writeDash } from "./InstrumentScreen";

/** Settings → Second screen: open one instrument full screen on this device, and choose the dashboard's tiles. */
export function ScreensCard() {
  const [dash, setDash] = useState(readDash);
  const [editing, setEditing] = useState(false);
  const save = (ids: string[]) => {
    setDash(ids);
    writeDash(ids);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= dash.length) return;
    const next = dash.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    save(next);
  };
  return (
    <section className="card scr">
      <h2 className="card__title">Second screen</h2>
      <p className="muted">Use an old phone or a tablet as one instrument beside your main screen. It stays on while it's shown.</p>
      <ul className="scr__list">
        {SCREENS.map(([k, title, text]) => (
          <li key={k}>
            <a className="scr__open" href={`#screen/${k}`}>
              <b>{title}</b>
              <span>{text}</span>
            </a>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" onClick={() => setEditing(!editing)} aria-expanded={editing}>
        {editing ? "Done" : "Choose dashboard tiles"}
      </button>
      {editing && (
        <div className="scr__edit">
          <ol className="scr__order">
            {dash.map((id, i) => (
              <li key={id}>
                <span>{TILES.find((t) => t.id === id)!.label}</span>
                <button type="button" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button type="button" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === dash.length - 1}>
                  ↓
                </button>
                <button type="button" aria-label="Remove" onClick={() => save(dash.filter((x) => x !== id))}>
                  ✕
                </button>
              </li>
            ))}
          </ol>
          <div className="scr__add">
            {TILES.filter((t) => !dash.includes(t.id)).map((t) => (
              <button key={t.id} type="button" className="clr__chip" onClick={() => save([...dash, t.id])}>
                + {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
