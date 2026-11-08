import { useEffect } from "react";

/** Keeps the screen on while `on` (and the page is visible): re-asked when the page comes back, released on leave. */
export function useWakeLock(on: boolean) {
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    if (!on || !nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    let stop = false;
    const ask = () => {
      if (document.visibilityState !== "visible") return;
      void nav.wakeLock!.request("screen").then(
        (l) => {
          if (stop) void l.release();
          else lock = l;
        },
        () => {},
      );
    };
    ask();
    document.addEventListener("visibilitychange", ask);
    return () => {
      stop = true;
      document.removeEventListener("visibilitychange", ask);
      void lock?.release().catch(() => {});
    };
  }, [on]);
}
