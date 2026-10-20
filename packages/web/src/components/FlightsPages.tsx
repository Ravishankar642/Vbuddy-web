import { useEffect, useState, type FormEvent } from "react";
import type { PlannedLeg } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { duration, loadRoute, useAtlas, useSavedFlights, type SavedFlight } from "../lib/flights";
import { int } from "../lib/format";
import { mapBus } from "../lib/mapbus";
import { useBridgeActions } from "../lib/useBridge";
import { LandingView } from "./LandingView";

const day = (ms: number) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
const dayTime = (ms: number) => new Date(ms).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const routeName = (f: SavedFlight) => (f.from || f.to ? `${f.from?.icao ?? "?"} → ${f.to?.icao ?? "?"}` : f.aircraft || "Flight");

/* ------------------------------------------------------------ planned flights */

/** `datetime-local` wants local time without a zone. */
const toInput = (ms: number | null) => {
  if (ms === null) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

function LegForm({ leg, onDone }: { leg: PlannedLeg | null; onDone: () => void }) {
  const { legCommand } = useBridgeActions();
  const [dep, setDep] = useState(leg?.dep ?? "");
  const [arr, setArr] = useState(leg?.arr ?? "");
  const [aircraft, setAircraft] = useState(leg?.aircraft ?? "");
  const [when, setWhen] = useState(toInput(leg?.plannedAt ?? null));
  const [notes, setNotes] = useState(leg?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fields = { dep, arr, aircraft, plannedAt: when ? new Date(when).getTime() : null, notes };
    const r = await legCommand(leg ? { op: "update", id: leg.id, ...fields } : { op: "add", ...fields });
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.error);
  };
  return (
    <form className="card fl__form" onSubmit={(e) => void submit(e)}>
      <h2 className="card__title">{leg ? "Change planned flight" : "Plan a flight"}</h2>
      <div className="fl__pair">
        <label>
          From
          <input value={dep} onChange={(e) => setDep(e.target.value.toUpperCase())} placeholder="EGLL" maxLength={4} autoCapitalize="characters" autoCorrect="off" spellCheck={false} required />
        </label>
        <label>
          To
          <input value={arr} onChange={(e) => setArr(e.target.value.toUpperCase())} placeholder="KJFK" maxLength={4} autoCapitalize="characters" autoCorrect="off" spellCheck={false} required />
        </label>
      </div>
      <label>
        Aircraft
        <input value={aircraft} onChange={(e) => setAircraft(e.target.value)} placeholder="Fenix A320" maxLength={60} />
      </label>
      <label>
        When
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>
      <label>
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Callsign, route, booking…" maxLength={500} rows={2} />
      </label>
      {error && <p className="fl__err" role="alert">{error}</p>}
      <div className="fl__actions">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "Saving…" : "Save flight"}
        </button>
      </div>
    </form>
  );
}

function PlannedRow({ leg, onEdit }: { leg: PlannedLeg; onEdit: () => void }) {
  const { legCommand } = useBridgeActions();
  const [error, setError] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const remove = async () => {
    const r = await legCommand({ op: "delete", id: leg.id });
    if (!r.ok) setError(r.error);
  };
  return (
    <li className="ms__flight fl__planned">
      <div>
        <b>
          {leg.dep} → {leg.arr}
        </b>
        <small>
          {leg.plannedAt ? dayTime(leg.plannedAt) : "No date yet"}
          {leg.aircraft ? ` · ${leg.aircraft}` : ""}
        </small>
        {leg.notes && <small>{leg.notes}</small>}
        {error && <small className="fl__err">{error}</small>}
      </div>
      <div className="fl__rowBtns">
        <button type="button" className="btn" onClick={onEdit}>
          Edit
        </button>
        {sure ? (
          <button type="button" className="btn fl__danger" onClick={() => void remove()} onBlur={() => setSure(false)} autoFocus>
            Delete
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => setSure(true)} aria-label={`Delete planned flight ${leg.dep} to ${leg.arr}`}>
            ×
          </button>
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------ saved flights */

function FlightDetail({ f, onBack }: { f: SavedFlight; onBack: () => void }) {
  const [route, setRoute] = useState<"loading" | "none" | "shown">("loading");
  useEffect(() => {
    let cancelled = false;
    void loadRoute(f.id).then((pts) => {
      if (cancelled) return;
      setRoute(pts && pts.length > 1 ? "shown" : "none");
      if (pts && pts.length > 1) {
        mapBus.lowerSheet();
        window.setTimeout(() => mapBus.showRoute(pts), 350);
      }
    });
    return () => {
      cancelled = true;
      mapBus.showRoute(null);
    };
  }, [f.id]);
  const rows: Array<[string, string]> = [
    ["Date", day(f.startedAt)],
    ["Aircraft", f.aircraft || "–"],
    ["From", f.from ? `${f.from.icao} · ${f.from.name}` : "–"],
    ["To", f.to ? `${f.to.icao} · ${f.to.name}` : "–"],
    ["Time in the air", duration(f.endedAt - f.startedAt)],
    ["Distance", f.distanceNm ? `${int(f.distanceNm)} nm` : "–"],
    ["Highest", `${int(f.maxAltFt)} ft`],
    ["Fastest ground speed", `${int(f.maxGsKt)} kt`],
    ["Landings", String(f.landings)],
    ...(f.planDep && f.planArr
      ? ([
          ["SimBrief plan", `${f.planCallsign ? f.planCallsign + " · " : ""}${f.planDep} → ${f.planArr}`],
          ...(f.planDistanceNm ? ([["Planned distance", `${int(f.planDistanceNm)} nm${f.distanceNm ? ` (flown ${int(f.distanceNm)} nm)` : ""}`]] as Array<[string, string]>) : []),
          ...(f.planEteMin ? ([["Planned time", `${duration(f.planEteMin * 60_000)} (took ${duration(f.endedAt - f.startedAt)})`]] as Array<[string, string]>) : []),
          ...(f.planRoute ? ([["Route", f.planRoute]] as Array<[string, string]>) : []),
        ] as Array<[string, string]>)
      : []),
    ["Logbook", f.onPlan ? "Logged" : f.planDep ? `Not logged (flown ${f.from?.icao ?? "?"} → ${f.to?.icao ?? "?"}, planned ${f.planDep} → ${f.planArr})` : "Not logged (no SimBrief plan for this flight)"],
  ];
  return (
    <>
      <button type="button" className="btn fl__back" onClick={onBack}>
        ‹ My flights
      </button>
      <section className="ms__atlas fl__hero">
        <small>{day(f.startedAt)}</small>
        <h2>{routeName(f)}</h2>
      </section>
      <section className="card">
        <dl className="sv__list">
          {rows.map(([k, v]) => (
            <div className="sv__row" key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="muted fl__note">{route === "loading" ? "Loading the route…" : route === "none" ? "The route for this flight isn't stored any more." : "Your route is drawn on the map."}</p>
        {route === "shown" && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              mapBus.lowerSheet();
              void loadRoute(f.id).then((pts) => window.setTimeout(() => mapBus.showRoute(pts), 350));
            }}
          >
            Show on map
          </button>
        )}
      </section>
    </>
  );
}

function FlightRow({ f, onOpen }: { f: SavedFlight; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="ms__flight fl__open" onClick={onOpen}>
        <div>
          <b>{routeName(f)}</b>
          <small>
            {day(f.startedAt)} · {duration(f.endedAt - f.startedAt)}
            {f.aircraft ? ` · ${f.aircraft}` : ""}
          </small>
          <small className={f.onPlan ? "fl__tag fl__tag--on" : "fl__tag"}>
            {f.onPlan ? `On plan${f.planCallsign ? ` ${f.planCallsign}` : ""} · in your logbook` : f.planDep ? `Not on its plan (${f.planDep} → ${f.planArr})` : "No SimBrief plan"}
          </small>
        </div>
        <div className="ms__flightR">
          <span>{f.distanceNm ? `${int(f.distanceNm)} nm` : `${int(f.maxAltFt)} ft`}</span>
          <small>
            {f.landings} landing{f.landings === 1 ? "" : "s"}
          </small>
        </div>
      </button>
    </li>
  );
}

/** My flights: what you plan to fly, then what you have flown. */
export function MyFlights({ b }: { b: BridgeSnapshot }) {
  const flights = useSavedFlights(b.link);
  const [form, setForm] = useState<PlannedLeg | "new" | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const detail = Array.isArray(flights) ? flights.find((f) => f.id === open) : undefined;
  if (detail) return <FlightDetail f={detail} onBack={() => setOpen(null)} />;
  return (
    <>
      <div className="fl__head">
        <h2 className="fl__h">Planned</h2>
        {form === null && (
          <button type="button" className="btn btn--primary" onClick={() => setForm("new")}>
            Plan a flight
          </button>
        )}
      </div>
      {form !== null && <LegForm leg={form === "new" ? null : form} onDone={() => setForm(null)} />}
      {b.legs.length > 0 ? (
        <ul className="ms__flights">
          {b.legs.map((l) => (
            <PlannedRow key={l.id} leg={l} onEdit={() => setForm(l)} />
          ))}
        </ul>
      ) : (
        form === null && <p className="muted fl__none">Nothing planned. Add the flights you want to fly next.</p>
      )}
      <div className="fl__head">
        <h2 className="fl__h">Flown</h2>
      </div>
      {flights === null ? (
        <div className="empty">Loading your flights…</div>
      ) : flights === "off" ? (
        <div className="empty">Your flight log is switched off. Start the bridge with a data folder to keep your flights.</div>
      ) : !flights.length ? (
        <div className="empty">No saved flights yet. They appear here after your first flight.</div>
      ) : (
        <ul className="ms__flights">
          {flights.map((f) => (
            <FlightRow key={f.id} f={f} onOpen={() => setOpen(f.id)} />
          ))}
        </ul>
      )}
    </>
  );
}

/* ------------------------------------------------------------ atlas */

const hours = (ms: number) => `${int(ms / 3_600_000)}`;

/** Atlas: your logbook at a glance, the airports you have visited, the aircraft you fly, then every landing. */
export function AtlasPage({ b }: { b: BridgeSnapshot }) {
  const atlas = useAtlas(b.link, b.landings.length);
  const a = atlas && atlas !== "off" ? atlas : null;
  const stats: Array<[string, string]> = [
    ["Flights", a ? String(a.flights) : "–"],
    ["Hours", a ? hours(a.flightMs) : "–"],
    ["Distance nm", a ? int(a.distanceNm) : "–"],
    ["Airports", a ? String(a.airports.length) : "–"],
    ["Countries", a ? String(a.countries.length) : "–"],
    ["Landings", String(b.landings.length)],
  ];
  return (
    <>
      <section className="ms__atlas">
        <small>VBuddy Logbook</small>
        <h2>Flight record</h2>
      </section>
      <dl className="ms__stats ms__stats--6">
        {stats.map(([k, v]) => (
          <div key={k}>
            <dd>{v}</dd>
            <dt>{k}</dt>
          </div>
        ))}
      </dl>
      <p className="muted fl__none">Only flights flown on the route of your SimBrief plan are logged here. Fill in your plan before you fly.</p>
      {a && a.flights === 0 && <p className="muted fl__none">No logged flights yet.</p>}
      {atlas === "off" && <p className="muted fl__none">Your flight log is switched off, so there are no totals yet.</p>}
      {a && a.airports.length > 0 && (
        <section className="card">
          <h2 className="card__title">Airports visited</h2>
          <ul className="fl__apts">
            {a.airports.slice(0, 40).map((p) => (
              <li key={p.icao}>
                <b>{p.icao}</b>
                <span>{p.name}</span>
                <em>{p.visits}×</em>
              </li>
            ))}
          </ul>
          {a.airports.length > 40 && <p className="muted fl__note">and {a.airports.length - 40} more</p>}
        </section>
      )}
      {a && a.aircraft.length > 0 && (
        <section className="card">
          <h2 className="card__title">Aircraft</h2>
          <dl className="sv__list">
            {a.aircraft.slice(0, 8).map((t) => (
              <div className="sv__row" key={t.name}>
                <dt>{t.name}</dt>
                <dd>
                  {t.flights} · {duration(t.ms)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <LandingView b={b} />
    </>
  );
}
