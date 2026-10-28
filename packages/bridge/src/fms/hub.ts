import type { CduScreen, PanelState } from "@vbuddy/protocol";
import type { Logger } from "../log.js";
import type { PanelResult } from "../panel/backend.js";
import type { CduSource } from "../pmdg/pmdg-panel.js";

/** One aircraft family's CDU / MCDU, as the hub sees it. */
export interface FmsProvider extends CduSource {
  readonly label: string;
  sides(): number;
  /** Connect (true) only while this aircraft is loaded; disconnect when it isn't. */
  setActive?(on: boolean): void;
}

export type FmsKind = "pmdg" | "fbw" | "fenix" | "mock";

/** Which provider an aircraft title belongs to. */
export function fmsKindFor(title: string): FmsKind | null {
  const t = title.toLowerCase();
  if (/fenix|fnx/.test(t)) return "fenix";
  if (/a32nx|flybywire|\bfbw\b|headwind|a339|a330-?900|a330neo/.test(t)) return "fbw";
  if (/pmdg/.test(t)) return "pmdg";
  return null;
}

/**
 * Every CDU / MCDU VBuddy can show, behind the one CDU page in the app: PMDG 737 / 777 (their SDK), the FlyByWire A32NX
 * family (SimBridge) and the Fenix A320 family (the Fenix's data service). The aircraft loaded picks the provider; only
 * that one keeps a connection open.
 */
export class FmsHub implements CduSource {
  private active: FmsKind | null = null;
  private cbs: Array<(side: number) => void> = [];
  private infoCbs: Array<() => void> = [];

  constructor(
    private providers: Partial<Record<FmsKind, FmsProvider>>,
    /** PMDG's CDU availability comes from its panel (it knows whether the SDK data is flowing). */
    private pmdgInfo: () => PanelState["cdu"] | null,
    private log: Logger,
  ) {
    for (const [kind, p] of Object.entries(providers) as Array<[FmsKind, FmsProvider]>) {
      p.onCdu((side) => {
        if (kind === this.active) for (const cb of this.cbs) cb(side);
      });
    }
  }

  /** The aircraft changed (title, or "" when none). */
  aircraft(title: string, forced?: FmsKind | null) {
    const kind = forced !== undefined ? forced : fmsKindFor(title);
    if (kind === this.active) return;
    const was = this.active;
    this.active = kind && this.providers[kind] ? kind : null;
    for (const [k, p] of Object.entries(this.providers) as Array<[FmsKind, FmsProvider]>) p.setActive?.(k === this.active);
    if (this.active && this.active !== "pmdg") this.log.info(`MCDU: ${this.providers[this.active]!.label}`);
    if (was !== this.active) {
      for (const cb of this.infoCbs) cb();
      for (const cb of this.cbs) {
        cb(0);
        cb(1);
        cb(2);
      }
    }
  }

  /** What the Systems page offers: none, PMDG's CDUs, or an Airbus MCDU. */
  info(): PanelState["cdu"] | null {
    const k = this.active;
    if (!k) return null;
    if (k === "pmdg") return this.pmdgInfo();
    const p = this.providers[k]!;
    return { sides: p.sides(), kind: "mcdu", name: p.label };
  }
  onInfo(cb: () => void) {
    this.infoCbs.push(cb);
  }

  onCdu(cb: (side: number) => void) {
    this.cbs.push(cb);
  }

  screen(side: number): CduScreen | null {
    const p = this.active ? this.providers[this.active] : null;
    if (!p) return null;
    const s = p.screen(side);
    if (!s) return null;
    return s.name ? s : { ...s, layout: s.layout ?? "boeing", name: /^(737|777)$/.test(s.aircraft) ? `PMDG ${s.aircraft}` : s.aircraft };
  }

  key(side: number, key: string): Promise<PanelResult> {
    const p = this.active ? this.providers[this.active] : null;
    if (!p) return Promise.resolve({ ok: false, error: "This aircraft has no CDU VBuddy can reach." });
    return p.key(side, key);
  }
}
