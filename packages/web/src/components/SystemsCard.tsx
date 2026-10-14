import { useEffect, useRef, useState } from "react";
import type { PanelCommand, PanelState } from "@vbuddy/protocol";
import type { CmdReply } from "../lib/bridge-client";
import { PanelButton, SetValue } from "./PanelParts";

type Run = (cmd: PanelCommand) => Promise<CmdReply>;
type Sys = NonNullable<PanelState["sys"]>;

const RATES = [0.25, 0.5, 1, 2, 4, 8, 16];
const LEADS = [0, 2, 5, 10, 15];

const rateText = (r: number) => `${r}×`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const mmss = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min` : `${s} s`);

/** Pause, time rate, flaps, gear, brakes, engines, APU, altimeter and the camera, for any aircraft that follows the simulator's standard controls. */
export function SystemsCard({ p, enabled, run }: { p: PanelState; enabled: boolean; run: Run }) {
  const s = p.sys;
  const [baro, setBaro] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const stopTimer = useRef<number | null>(null);
  useEffect(() => () => void (stopTimer.current && clearTimeout(stopTimer.current)), []);
  if (!s) return null;
  const sys = (id: Extract<PanelCommand, { op: "sys" }>["id"], value?: number) => void run({ op: "sys", id, value });

  const engines = () => {
    if (s.enginesRunning === 0) return sys("engines", 1);
    if (!confirmStop) {
      setConfirmStop(true);
      stopTimer.current = window.setTimeout(() => setConfirmStop(false), 3000);
      return;
    }
    setConfirmStop(false);
    sys("engines", 0);
  };

  return (
    <section className="card systems" aria-label="Simulator and systems">
      <h2 className="card__title">Simulator and systems</h2>
      <div className="systems__grid">
        <PanelButton label={s.paused ? "RESUME" : "PAUSE"} lit={s.paused} disabled={!enabled} onPress={() => sys("pause", s.paused ? 0 : 1)} />
        <PanelButton label="GEAR" lit={s.gearDown} disabled={!enabled} onPress={() => sys("gear", s.gearDown ? 0 : 1)} />
        <PanelButton label="SPOILERS ARM" lit={s.spoilersArmed} disabled={!enabled} onPress={() => sys("spoilersArm", s.spoilersArmed ? 0 : 1)} />
        <PanelButton label="PARK BRAKE" lit={s.parkingBrake} disabled={!enabled} onPress={() => sys("parkingBrake", s.parkingBrake ? 0 : 1)} />
        <PanelButton label={confirmStop ? "TAP AGAIN TO STOP" : s.enginesRunning === 0 ? "START ENGINES" : "STOP ENGINES"} lit={s.enginesRunning > 0} disabled={!enabled} onPress={engines} />
        <PanelButton label="APU" lit={s.apuOn} disabled={!enabled} onPress={() => sys("apu", s.apuOn ? 0 : 1)} />
        <PanelButton label="PITOT HEAT" lit={s.pitotHeat} disabled={!enabled} onPress={() => sys("pitotHeat", s.pitotHeat ? 0 : 1)} />
        <PanelButton label="SEAT BELTS" lit={s.seatbelts} disabled={!enabled} onPress={() => sys("seatbelts", s.seatbelts ? 0 : 1)} />
      </div>

      <div className="systems__row">
        <div className="systems__group" role="group" aria-label="Flaps">
          <span className="systems__label">Flaps</span>
          <button type="button" className="btn" disabled={!enabled || s.flapsIndex <= 0} onClick={() => sys("flapsUp")} aria-label="Flaps up one position">
            −
          </button>
          <output className="systems__value" aria-live="polite">
            {s.flapsIndex === 0 ? "UP" : s.flapsIndex}
            {s.flapsCount > 0 ? ` / ${s.flapsCount}` : ""}
          </output>
          <button type="button" className="btn" disabled={!enabled || (s.flapsCount > 0 && s.flapsIndex >= s.flapsCount)} onClick={() => sys("flapsDown")} aria-label="Flaps down one position">
            +
          </button>
        </div>

        <label className="systems__group">
          <span className="systems__label">Time rate</span>
          <select value={RATES.includes(s.simRate) ? s.simRate : ""} disabled={!enabled} onChange={(e) => sys("simRate", Number(e.target.value))}>
            {!RATES.includes(s.simRate) && <option value="">{rateText(s.simRate)}</option>}
            {RATES.map((r) => (
              <option key={r} value={r}>
                {rateText(r)}
              </option>
            ))}
          </select>
        </label>

        <div className="systems__group" role="group" aria-label="Altimeter">
          <span className="systems__label">Altimeter</span>
          <output className="systems__value">{Math.round(s.baroHpa)} hPa</output>
          <button type="button" className="btn" disabled={!enabled} onClick={() => sys("baroStd")}>
            STD
          </button>
          <button type="button" className="btn" disabled={!enabled} onClick={() => setBaro(true)}>
            Set
          </button>
        </div>

        <div className="systems__group" role="group" aria-label="Camera view">
          <span className="systems__label">View</span>
          {(["Cockpit", "Outside", "Drone"] as const).map((label, i) => (
            <button key={label} type="button" className={`btn${s.camera === i ? " btn--primary" : ""}`} aria-pressed={s.camera === i} disabled={!enabled} onClick={() => sys("camera", i)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {s.flapsCount > 0 && (
        <div className="systems__group systems__detents" role="group" aria-label="Flaps position">
          <span className="systems__label">Set flaps</span>
          {Array.from({ length: s.flapsCount + 1 }, (_, i) => (
            <button key={i} type="button" className={`btn${s.flapsIndex === i ? " btn--primary" : ""}`} aria-pressed={s.flapsIndex === i} disabled={!enabled} onClick={() => sys("flapsSet", i)}>
              {i === 0 ? "UP" : i}
            </button>
          ))}
        </div>
      )}

      <div className="systems__grid">
        <PanelButton label="WING LEVELER" lit={!!s.wingLeveler} disabled={!enabled} onPress={() => sys("wingLeveler", s.wingLeveler ? 0 : 1)} />
        <PanelButton label="SLEW" lit={!!s.slew} disabled={!enabled} onPress={() => sys("slew", s.slew ? 0 : 1)} />
        {[1, 2, 3, 4].map((n) => (
          <PanelButton key={n} label={`DOOR ${n}${(s.doors?.[n - 1] ?? 0) > 5 ? " OPEN" : ""}`} lit={(s.doors?.[n - 1] ?? 0) > 5} disabled={!enabled} onPress={() => sys("doorToggle", n)} />
        ))}
      </div>

      <div className="systems__group systems__cam" role="group" aria-label="Move the view">
        <span className="systems__label">Move view</span>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("panLeft")} aria-label="Look left">◀</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("panUp")} aria-label="Look up">▲</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("panDown")} aria-label="Look down">▼</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("panRight")} aria-label="Look right">▶</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("zoomIn")} aria-label="Zoom in">＋</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("zoomOut")} aria-label="Zoom out">－</button>
        <button type="button" className="btn" disabled={!enabled} onClick={() => sys("viewReset")}>Reset</button>
      </div>

      {baro && <SetValue label="altimeter (hPa or inHg)" hint="1013 or 29.92" onSet={(v) => run({ op: "sys", id: "baroSet", value: v })} onClose={() => setBaro(false)} />}

      <PauseLater p={p} enabled={enabled} run={run} />
    </section>
  );
}

/** Pause later: at a time, or a few minutes before the top of descent. Kept on the PC, so it works with the phone away. */
function PauseLater({ p, enabled, run }: { p: PanelState; enabled: boolean; run: Run }) {
  const [mode, setMode] = useState<"atTime" | "beforeTod">("beforeTod");
  const [time, setTime] = useState("");
  const [lead, setLead] = useState(5);
  const [err, setErr] = useState<string | null>(null);
  const ps = p.pauseSchedule;

  const set = async () => {
    setErr(null);
    if (mode === "beforeTod") {
      const r = await run({ op: "pauseAt", schedule: { mode: "beforeTod", leadSec: lead * 60 } });
      if (!r.ok) setErr(r.error);
      return;
    }
    const m = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!m) return setErr("Enter a time, for example 14:30.");
    const at = new Date();
    at.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    const r = await run({ op: "pauseAt", schedule: { mode: "atTime", atEpochMs: at.getTime() } });
    if (!r.ok) setErr(r.error);
  };

  if (ps) {
    const when = ps.schedule.mode === "atTime" ? `at ${clock(ps.schedule.atEpochMs)}` : `${ps.schedule.leadSec / 60} min before the top of descent`;
    return (
      <div className="systems__later">
        <p className="systems__status" role="status">
          Pausing {when}. Waiting for {ps.waiting}
          {ps.etaSec !== null ? ` (about ${mmss(ps.etaSec)})` : ""}.
        </p>
        <button type="button" className="btn" disabled={!enabled} onClick={() => void run({ op: "pauseCancel" })}>
          Cancel pause
        </button>
      </div>
    );
  }
  return (
    <div className="systems__later">
      <div className="systems__group" role="group" aria-label="Pause later">
        <span className="systems__label">Pause later</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="When to pause">
          <option value="beforeTod">Before the top of descent</option>
          <option value="atTime">At a time</option>
        </select>
        {mode === "beforeTod" ? (
          <select value={lead} onChange={(e) => setLead(Number(e.target.value))} aria-label="How long before">
            {LEADS.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "at the point" : `${m} min before`}
              </option>
            ))}
          </select>
        ) : (
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time to pause" />
        )}
        <button type="button" className="btn" disabled={!enabled} onClick={() => void set()}>
          Set
        </button>
      </div>
      {err && (
        <p className="setval__err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
