import { AIRBUS_MCDU_KEYS, type CduScreen } from "@vbuddy/protocol";
import type { PanelResult } from "../panel/backend.js";
import { C, Grid, plain } from "./grid.js";
import type { FmsProvider } from "./hub.js";

const CHAR: Record<string, string> = { DOT: ".", PLUS_MINUS: "-", SPACE: " ", SLASH: "/" };

/** A made-up Airbus MCDU for the test flight: a page per function key and a scratchpad that takes typing. */
export class MockMcdu implements FmsProvider {
  readonly label = "Test MCDU";
  private page = "INIT";
  private pad = ["", ""];
  private cbs: Array<(side: number) => void> = [];
  sides() {
    return 2;
  }
  onCdu(cb: (side: number) => void) {
    this.cbs.push(cb);
  }
  screen(side: number): CduScreen {
    const s = side === 1 ? 1 : 0;
    const g = new Grid();
    g.place(0, plain(this.page.replace(/_/g, " ")), "center");
    g.place(1, plain(" CO RTE", 0, true), "left");
    g.place(1, plain("FROM/TO  ", 0, true), "right");
    g.place(2, plain("□□□□□□□□□□", C.amber), "left");
    g.place(2, plain("VABB/OMDB", C.cyan), "right");
    g.place(3, plain("ALTN/CO RTE", 0, true), "left");
    g.place(4, plain("----/---------", C.cyan), "left");
    g.place(5, plain("FLT NBR", 0, true), "left");
    g.place(6, plain("VBD1", C.cyan), "left");
    g.place(10, plain("CRZ FL/TEMP", 0, true), "left");
    g.place(11, plain("FL370 /-56°", C.cyan), "left");
    g.place(12, plain(`${s === 0 ? "CAPT" : "F/O"} SIDE  TEST`, C.green, true), "center");
    g.place(13, plain(this.pad[s]!), "left");
    g.put(0, 23, plain("→"));
    return { aircraft: "mock", layout: "airbus", name: "Test MCDU", side: s, sides: 2, live: true, powered: true, ...g.out(), annun: { exec: false, msg: false, fail: false, ofst: false, call: false, dspy: false }, keys: [...AIRBUS_MCDU_KEYS], message: null };
  }
  async key(side: number, key: string): Promise<PanelResult> {
    if (!(AIRBUS_MCDU_KEYS as readonly string[]).includes(key)) return { ok: false, error: `No MCDU key ${key}.` };
    const s = side === 1 ? 1 : 0;
    if (key.length === 1 || CHAR[key]) this.pad[s] = (this.pad[s]! + (CHAR[key] ?? key)).slice(-22);
    else if (key === "CLR") this.pad[s] = this.pad[s]!.slice(0, -1);
    else if (/^[LR][1-6]$/.test(key)) this.pad[s] = "";
    else if (!["UP", "DOWN", "PREV_PAGE", "NEXT_PAGE", "OVFY"].includes(key)) this.page = key;
    for (const cb of this.cbs) cb(s);
    return { ok: true };
  }
}
