import { CDU_COLUMNS, CDU_ROWS, type CduScreen } from "@vbuddy/protocol";
import type { PanelResult } from "../panel/backend.js";
import type { CduSource } from "./pmdg-panel.js";

const KEYS = [
  ...["L", "R"].flatMap((s) => [1, 2, 3, 4, 5, 6].map((n) => `${s}${n}`)),
  "INIT_REF", "RTE", "CLB", "CRZ", "DES", "MENU", "LEGS", "DEP_ARR", "HOLD", "PROG", "EXEC", "N1_LIMIT", "FIX", "PREV_PAGE", "NEXT_PAGE",
  ..."1234567890".split(""), "DOT", "PLUS_MINUS",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "SPACE", "DEL", "SLASH", "CLR",
];
const CHAR: Record<string, string> = { DOT: ".", PLUS_MINUS: "-", SPACE: " ", SLASH: "/" };

/** A made-up CDU for the mock bridge: a page per function key and a scratchpad that takes typing. */
export class MockCdu implements CduSource {
  private page = "MENU";
  private pad = ["", ""];
  private exec = false;
  private cbs: Array<(side: number) => void> = [];

  onCdu(cb: (side: number) => void) {
    this.cbs.push(cb);
  }

  screen(side: number): CduScreen {
    const s = Math.max(0, Math.min(1, side));
    const lines: Array<[string, string]> = Array.from({ length: CDU_ROWS }, () => ["", ""]);
    const title = this.page.replace(/_/g, " ");
    lines[0] = [" ".repeat(Math.max(0, Math.floor((CDU_COLUMNS - title.length) / 2))) + title, "0"];
    lines[1] = [" MOCK CDU", "0"];
    lines[2] = [`<${s === 0 ? "LEFT" : "RIGHT"}            ACT>`, "2"];
    lines[3] = [" TYPE BELOW, PRESS LSK", "0"];
    lines[4] = ["<INDEX            NEXT>", "1"];
    lines[12] = ["------------------------", "0"];
    lines[13] = [this.pad[s]!, "0"];
    const rows = lines.map(([t]) => t.padEnd(CDU_COLUMNS).slice(0, CDU_COLUMNS));
    const colors = lines.map(([, c]) => c.repeat(CDU_COLUMNS));
    const flags = rows.map((_, y) => (y % 2 === 1 && y < 12 ? "1" : "0").repeat(CDU_COLUMNS));
    return { aircraft: "737", side: s, sides: 2, live: true, powered: true, rows, colors, flags, annun: { exec: this.exec, msg: false, fail: false, ofst: false, call: false, dspy: false }, keys: KEYS, message: null };
  }

  async key(side: number, key: string): Promise<PanelResult> {
    if (!KEYS.includes(key)) return { ok: false, error: `No CDU key ${key}.` };
    const s = side === 1 ? 1 : 0;
    if (key.length === 1 || CHAR[key]) this.pad[s] = (this.pad[s]! + (CHAR[key] ?? key)).slice(-CDU_COLUMNS);
    else if (key === "CLR" || key === "DEL") this.pad[s] = this.pad[s]!.slice(0, -1);
    else if (/^[LR][1-6]$/.test(key)) {
      this.pad[s] = "";
      this.exec = true;
    } else if (key === "EXEC") this.exec = false;
    else this.page = key;
    for (const cb of this.cbs) cb(s);
    return { ok: true };
  }
}
