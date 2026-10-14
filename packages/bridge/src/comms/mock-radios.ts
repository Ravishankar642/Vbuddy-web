import type { RadioBackend, RadioValues } from "./backend.js";

/** Pretend COM radios and transponder for the mock flight and tests. */
export class MockRadios implements RadioBackend {
  private v: RadioValues = {
    radios: { com1: { active: 118_500_000, standby: 121_900_000, rx: true }, com2: { active: 122_800_000, standby: 121_500_000, rx: true } },
    xpdr: { code: "2000", mode: "alt", ident: false },
  };
  private cbs: Array<() => void> = [];
  identCount = 0;

  values() {
    return this.v;
  }
  onValues(cb: () => void) {
    this.cbs.push(cb);
  }
  private change(fn: (v: RadioValues) => void) {
    this.v = structuredClone(this.v);
    fn(this.v);
    for (const cb of this.cbs) cb();
    return true;
  }
  setCom(radio: 1 | 2, which: "active" | "standby", hz: number) {
    return this.change((v) => (v.radios![radio === 1 ? "com1" : "com2"][which] = hz));
  }
  swapCom(radio: 1 | 2) {
    return this.change((v) => {
      const r = v.radios![radio === 1 ? "com1" : "com2"];
      [r.active, r.standby] = [r.standby, r.active];
    });
  }
  setListen(radio: 1 | 2, on: boolean) {
    return this.change((v) => (v.radios![radio === 1 ? "com1" : "com2"].rx = on));
  }
  setXpdrCode(code: string) {
    return this.change((v) => (v.xpdr!.code = code));
  }
  setXpdrMode(mode: "stby" | "alt") {
    return this.change((v) => (v.xpdr!.mode = mode));
  }
  ident() {
    this.identCount++;
    this.change((v) => (v.xpdr!.ident = true));
    setTimeout(() => this.change((v) => (v.xpdr!.ident = false)), 18_000).unref();
    return true;
  }
}
