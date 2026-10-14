import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const DETENT_DEG = 20; // finger rotation per click when dragging round the knob
const DRAG_START_PX = 8;
const HOLD_MS = 420;
const REPEAT_MS = 110;
const SEND_EVERY_MS = 120;

interface Props {
  label: string;
  /** Called with batched clicks (+ = clockwise). */
  onTurn: (clicks: number) => void;
  disabled?: boolean;
  size?: number;
}

/**
 * A rotary knob for touch: tap the left half for one click anticlockwise, the
 * right half for clockwise, hold to keep turning, or drag round it like the
 * real thing. Arrow keys work too (Page Up/Down for 10 clicks).
 * Clicks are collected and sent every ~120 ms so a fast spin is one message.
 */
export function Knob({ label, onTurn, disabled, size = 92 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [angle, setAngle] = useState(0);
  const [pressed, setPressed] = useState<"l" | "r" | null>(null);
  const pending = useRef(0);
  const flushTimer = useRef<number | null>(null);
  const gesture = useRef<{ x: number; y: number; side: "l" | "r"; dragging: boolean; lastAng: number; acc: number; hold: number | null; repeat: number | null } | null>(null);
  const turnRef = useRef(onTurn);
  turnRef.current = onTurn;

  const flush = useCallback(() => {
    flushTimer.current = null;
    const n = pending.current;
    pending.current = 0;
    if (n) turnRef.current(Math.max(-50, Math.min(50, n)));
  }, []);

  const click = useCallback(
    (dir: number) => {
      if (disabled) return;
      pending.current += dir;
      setAngle((a) => a + dir * DETENT_DEG);
      try {
        navigator.vibrate?.(6);
      } catch {
        /* not supported */
      }
      if (flushTimer.current === null) flushTimer.current = window.setTimeout(flush, SEND_EVERY_MS);
    },
    [disabled, flush],
  );

  useEffect(
    () => () => {
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      const g = gesture.current;
      if (g?.hold) clearTimeout(g.hold);
      if (g?.repeat) clearInterval(g.repeat);
    },
    [],
  );

  const centre = () => {
    const r = ref.current!.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };
  const angOf = (x: number, y: number) => {
    const { cx, cy } = centre();
    return (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
  };
  const stopTimers = () => {
    const g = gesture.current;
    if (!g) return;
    if (g.hold) clearTimeout(g.hold);
    if (g.repeat) clearInterval(g.repeat);
    g.hold = g.repeat = null;
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    const side = e.clientX < centre().cx ? "l" : "r";
    const g = { x: e.clientX, y: e.clientY, side, dragging: false, lastAng: angOf(e.clientX, e.clientY), acc: 0, hold: null as number | null, repeat: null as number | null } as const;
    gesture.current = { ...g };
    setPressed(side);
    gesture.current.hold = window.setTimeout(() => {
      const gg = gesture.current;
      if (!gg || gg.dragging) return;
      click(gg.side === "l" ? -1 : 1);
      gg.repeat = window.setInterval(() => click(gg.side === "l" ? -1 : 1), REPEAT_MS);
    }, HOLD_MS);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    if (!g.dragging && Math.hypot(e.clientX - g.x, e.clientY - g.y) > DRAG_START_PX) {
      g.dragging = true;
      stopTimers();
      setPressed(null);
    }
    if (!g.dragging) return;
    const a = angOf(e.clientX, e.clientY);
    let d = a - g.lastAng;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    g.lastAng = a;
    g.acc += d;
    while (g.acc >= DETENT_DEG) {
      g.acc -= DETENT_DEG;
      click(1);
    }
    while (g.acc <= -DETENT_DEG) {
      g.acc += DETENT_DEG;
      click(-1);
    }
  };
  const up = () => {
    const g = gesture.current;
    if (!g) return;
    const wasRepeating = g.repeat !== null;
    stopTimers();
    if (!g.dragging && !wasRepeating) click(g.side === "l" ? -1 : 1);
    gesture.current = null;
    setPressed(null);
  };
  const cancel = () => {
    stopTimers();
    gesture.current = null;
    setPressed(null);
  };

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const map: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
    const n = map[e.key];
    if (!n) return;
    e.preventDefault();
    for (let i = 0; i < Math.abs(n); i++) click(Math.sign(n));
  };

  const ridges = Array.from({ length: 36 }, (_, i) => i * 10);
  return (
    <div
      ref={ref}
      className={`knob${disabled ? " is-disabled" : ""}${pressed ? ` is-${pressed}` : ""}`}
      style={{ width: size, height: size }}
      role="slider"
      aria-label={`${label} knob`}
      aria-valuetext="Turn: left half or arrow left for one click down, right half or arrow right for one click up"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onKeyDown={key}
    >
      <svg viewBox="-50 -50 100 100" aria-hidden="true">
        <circle r="48" className="knob__skirt" />
        <g style={{ transform: `rotate(${angle}deg)` }} className="knob__cap">
          {ridges.map((a) => (
            <line key={a} x1="0" y1="-46" x2="0" y2="-39" transform={`rotate(${a})`} className="knob__ridge" />
          ))}
          <circle r="37" className="knob__face" />
          <line x1="0" y1="-34" x2="0" y2="-20" className="knob__mark" />
        </g>
        <text x="-22" y="5" className="knob__hint">−</text>
        <text x="22" y="5" className="knob__hint">+</text>
      </svg>
    </div>
  );
}
