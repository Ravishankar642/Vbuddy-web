import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";

/**
 * Opened from the iPhone home screen, iOS reports the page as shorter than the screen by the status bar's height,
 * which leaves an empty band at the bottom. A home-screen app always fills the screen, so use the screen's size there.
 */
export function useAppHeight(): number | null {
  const calc = () => {
    const nav = navigator as Navigator & { standalone?: boolean };
    const standalone = nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
    if (!standalone) return null;
    const portrait = window.innerHeight >= window.innerWidth;
    const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    return full > window.innerHeight ? full : null;
  };
  const [h, setH] = useState(calc);
  useEffect(() => {
    const on = () => setH(calc());
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("orientationchange", on);
    };
  }, []);
  return h;
}

export type Detent = "low" | "mid" | "high";
const WIDE = "(min-width: 900px)";
export const WIDE_PANEL_PX = 440;

const heights = (vh: number): Record<Detent, number> => ({ low: Math.round(Math.max(250, vh * 0.3)), mid: Math.round(vh * 0.56), high: Math.round(vh - 64) });

/** The bottom sheet's size and drag behaviour. On a wide screen it is a fixed side panel instead. */
export function useSheet(root: RefObject<HTMLElement | null>) {
  const [vh, setVh] = useState(() => window.innerHeight);
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  const [detent, setDetent] = useState<Detent>("mid");
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    // The page's real height (a phone's browser bars change what 100% means), not the window's guess.
    const measure = () => setVh(root.current?.clientHeight || window.innerHeight);
    const on = () => {
      setWide(mq.matches);
      measure();
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" && root.current ? new ResizeObserver(measure) : null;
    if (ro && root.current) ro.observe(root.current);
    mq.addEventListener("change", on);
    window.addEventListener("resize", on);
    return () => {
      ro?.disconnect();
      mq.removeEventListener("change", on);
      window.removeEventListener("resize", on);
    };
  }, [root]);
  const h = heights(vh);
  const height = wide ? vh : (drag ?? h[detent]);
  return { wide, detent, setDetent, drag, setDrag, h, height, vh };
}

type SheetState = ReturnType<typeof useSheet>;

/** Handle and header: drag to resize, tap the handle to open or close. */
export function Grab({ s, children }: { s: SheetState; children: ReactNode }) {
  const start = useRef<{ y: number; h: number; moved: boolean; last: { y: number; t: number }; v: number } | null>(null);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (s.wide || (e.target as HTMLElement).closest("button, a, input, select")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, h: s.h[s.detent], moved: false, last: { y: e.clientY, t: e.timeStamp }, v: 0 };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const st = start.current;
    if (!st) return;
    if (Math.abs(e.clientY - st.y) > 4) st.moved = true;
    const dt = Math.max(1, e.timeStamp - st.last.t);
    st.v = (st.last.y - e.clientY) / dt;
    st.last = { y: e.clientY, t: e.timeStamp };
    if (st.moved) s.setDrag(Math.min(s.h.high, Math.max(s.h.low - 40, st.h + (st.y - e.clientY))));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const st = start.current;
    start.current = null;
    if (!st) return;
    if (!st.moved) {
      s.setDetent(s.detent === "low" ? "mid" : "low");
      return;
    }
    const projected = (s.drag ?? st.h) + st.v * 180;
    const order: Detent[] = ["low", "mid", "high"];
    const best = order.reduce((a, d) => (Math.abs(s.h[d] - projected) < Math.abs(s.h[a] - projected) ? d : a), "mid" as Detent);
    s.setDrag(null);
    s.setDetent(best);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const keys = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") s.setDetent(s.detent === "low" ? "mid" : "high");
      else if (e.key === "ArrowDown") s.setDetent(s.detent === "high" ? "mid" : "low");
    },
    [s],
  );
  return (
    <div className="ms__grab" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="ms__handle" role="slider" tabIndex={0} aria-label="Resize the panel" aria-valuemin={0} aria-valuemax={2} aria-valuenow={["low", "mid", "high"].indexOf(s.detent)} onKeyDown={keys} />
      {children}
    </div>
  );
}
