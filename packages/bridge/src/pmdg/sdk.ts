/**
 * Reads a PMDG SDK header (PMDG_NG3_SDK.h, PMDG_777X_SDK.h) that ships with the aircraft: the event numbers,
 * the mouse flags and the byte layout of the data struct. VBuddy never contains PMDG's file; it reads the copy
 * installed on the user's own PC, so the numbers always match the installed aircraft version.
 */

export interface Field {
  name: string;
  offset: number;
  size: number;
  float: boolean;
  signed: boolean;
  /** Array dimensions, [] for a plain value. */
  dims: number[];
}

export interface Layout {
  size: number;
  fields: Map<string, Field>;
}

export interface Sdk {
  /** Event name -> full event id (already includes THIRD_PARTY_EVENT_ID_MIN). */
  events: Map<string, number>;
  /** MOUSE_FLAG_* name -> value. */
  mouse: Map<string, number>;
  /** Client data area names as the header declares them (null when it doesn't say). */
  dataName: string | null;
  controlName: string | null;
  /** The byte layout, or null with the reason it couldn't be worked out. */
  layout: Layout | null;
  layoutError: string | null;
}

/* ------------------------------------------------------------------ text helpers */

export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

/** Tiny constant-expression evaluator: numbers, macro names, + - | & << >> and parentheses. */
function makeEvaluator(raw: Map<string, string>) {
  const cache = new Map<string, number | null>();
  const busy = new Set<string>();

  function evalExpr(src: string): number | null {
    const toks = src.match(/0[xX][0-9a-fA-F]+[uUlL]*|\d+[uUlL]*|[A-Za-z_]\w*|<<|>>|[()+\-|&~]/g);
    if (!toks) return null;
    let i = 0;
    const peek = () => toks[i];
    const parseShift = (): number | null => {
      let a = parseAdd();
      while (a !== null && (peek() === "<<" || peek() === ">>")) {
        const op = toks[i++];
        const b = parseAdd();
        if (b === null) return null;
        a = op === "<<" ? a << b : a >> b;
      }
      return a;
    };
    const parseAdd = (): number | null => {
      let a = parseUnary();
      while (a !== null && (peek() === "+" || peek() === "-")) {
        const op = toks[i++];
        const b = parseUnary();
        if (b === null) return null;
        a = op === "+" ? a + b : a - b;
      }
      return a;
    };
    const parseUnary = (): number | null => {
      if (peek() === "-") {
        i++;
        const v = parseUnary();
        return v === null ? null : -v;
      }
      if (peek() === "~") {
        i++;
        const v = parseUnary();
        return v === null ? null : ~v >>> 0;
      }
      return parsePrimary();
    };
    const parsePrimary = (): number | null => {
      const t = toks[i++];
      if (t === undefined) return null;
      if (t === "(") {
        const v = parseOr();
        if (toks[i++] !== ")") return null;
        return v;
      }
      if (/^0[xX]/.test(t)) return parseInt(t.replace(/[uUlL]+$/, ""), 16);
      if (/^\d/.test(t)) return parseInt(t.replace(/[uUlL]+$/, ""), 10);
      if (/^[A-Za-z_]/.test(t)) return resolve(t);
      return null;
    };
    const parseAnd = (): number | null => {
      let a = parseShift();
      while (a !== null && peek() === "&") {
        i++;
        const b = parseShift();
        if (b === null) return null;
        a = a & b;
      }
      return a;
    };
    const parseOr = (): number | null => {
      let a = parseAnd();
      while (a !== null && peek() === "|") {
        i++;
        const b = parseAnd();
        if (b === null) return null;
        a = (a | b) >>> 0;
      }
      return a;
    };
    const v = parseOr();
    return v !== null && i === toks.length ? v : null;
  }

  function resolve(name: string): number | null {
    if (cache.has(name)) return cache.get(name)!;
    const src = raw.get(name);
    if (src === undefined || busy.has(name)) return null;
    busy.add(name);
    const v = evalExpr(src);
    busy.delete(name);
    cache.set(name, v);
    return v;
  }
  return { resolve, evalExpr };
}

/* ------------------------------------------------------------------ struct layout */

interface TypeInfo {
  size: number;
  float: boolean;
  signed: boolean;
}

const UNSIGNED_TYPEDEFS = new Set(["BYTE", "WORD", "DWORD", "UINT", "ULONG", "USHORT", "UCHAR", "UINT8", "UINT16", "UINT32", "UINT64", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "bool"]);
const TYPE_WORDS = new Set([
  "unsigned", "signed", "short", "long", "int", "char", "float", "double", "bool", "const", "volatile",
  "__int8", "__int16", "__int32", "__int64",
  "BYTE", "WORD", "DWORD", "UINT", "ULONG", "USHORT", "UCHAR", "UINT8", "UINT16", "UINT32", "UINT64", "INT", "LONG", "SHORT", "CHAR", "INT8", "INT16", "INT32", "INT64", "BOOL", "FLOAT", "DOUBLE",
  "int8_t", "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t",
]);

function typeInfo(words: string[]): TypeInfo | null {
  const w = words.filter((x) => x !== "const" && x !== "volatile");
  if (!w.length) return null;
  const has = (...n: string[]) => w.some((x) => n.includes(x));
  const longs = w.filter((x) => x === "long").length;
  let size: number;
  let float = false;
  if (has("double", "DOUBLE")) {
    size = 8;
    float = true;
  } else if (has("float", "FLOAT")) {
    size = 4;
    float = true;
  } else if (has("__int64", "INT64", "int64_t", "uint64_t", "UINT64") || longs >= 2) size = 8;
  else if (has("char", "CHAR", "UCHAR", "BYTE", "bool", "__int8", "INT8", "int8_t", "uint8_t", "UINT8")) size = 1;
  else if (has("short", "SHORT", "USHORT", "WORD", "__int16", "INT16", "int16_t", "uint16_t", "UINT16")) size = 2;
  else if (has("BOOL")) size = 4;
  else size = 4; // int, long, unsigned, DWORD, UINT, ...
  const signed = !float && !has("unsigned") && !w.some((x) => UNSIGNED_TYPEDEFS.has(x));
  return { size, float, signed };
}

/** Finds `struct <name> { ... }` and returns its body text. */
function structBody(text: string, name: string): string | null {
  const m = new RegExp(`struct\\s+${name}\\b\\s*\\{`).exec(text);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < text.length && depth > 0) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    i++;
  }
  return depth === 0 ? text.slice(start, i - 1) : null;
}

export function computeLayout(clean: string, structName: string, evalExpr: (s: string) => number | null, pack: number): Layout {
  const body = structBody(clean, structName);
  if (body === null) throw new Error(`struct ${structName} not found`);
  const fields = new Map<string, Field>();
  let offset = 0;
  let maxAlign = 1;
  for (const stmtRaw of body.split(";")) {
    const stmt = stmtRaw.replace(/\s+/g, " ").trim();
    if (!stmt) continue;
    if (/[{}*:]/.test(stmt)) throw new Error(`unsupported declaration "${stmt.slice(0, 50)}"`);
    const toks = stmt.split(" ");
    const typeWords: string[] = [];
    while (toks.length > 1 && TYPE_WORDS.has(toks[0]!)) typeWords.push(toks.shift()!);
    const info = typeInfo(typeWords);
    if (!info) throw new Error(`unknown type in "${stmt.slice(0, 50)}"`);
    for (const decl of toks.join(" ").split(",")) {
      const dm = /^\s*(\w+)\s*((?:\[[^\]]+\]\s*)*)$/.exec(decl);
      if (!dm) throw new Error(`can't read declarator "${decl.trim().slice(0, 40)}"`);
      const dims: number[] = [];
      for (const d of (dm[2] ?? "").matchAll(/\[([^\]]+)\]/g)) {
        const n = evalExpr(d[1]!);
        if (n === null || n < 1) throw new Error(`array size "${d[1]}" of ${dm[1]} isn't a constant`);
        dims.push(n);
      }
      const align = Math.min(info.size, pack);
      maxAlign = Math.max(maxAlign, align);
      offset = Math.ceil(offset / align) * align;
      fields.set(dm[1]!, { name: dm[1]!, offset, size: info.size, float: info.float, signed: info.signed, dims });
      offset += info.size * dims.reduce((a, b) => a * b, 1);
    }
  }
  return { size: Math.ceil(offset / maxAlign) * maxAlign, fields };
}

/** Reads one value out of a data snapshot. Index selects the array element (row-major). */
export function readField(layout: Layout, buf: Buffer, f: Field, ...idx: number[]): number {
  let n = 0;
  for (let d = 0; d < f.dims.length; d++) n = n * f.dims[d]! + (idx[d] ?? 0);
  const at = f.offset + n * f.size;
  if (at + f.size > buf.length) return 0;
  if (f.float) return f.size === 8 ? buf.readDoubleLE(at) : buf.readFloatLE(at);
  switch (f.size) {
    case 1:
      return f.signed ? buf.readInt8(at) : buf.readUInt8(at);
    case 2:
      return f.signed ? buf.readInt16LE(at) : buf.readUInt16LE(at);
    case 4:
      return f.signed ? buf.readInt32LE(at) : buf.readUInt32LE(at);
    default:
      return Number(f.signed ? buf.readBigInt64LE(at) : buf.readBigUInt64LE(at));
  }
}

/* ------------------------------------------------------------------ the header */

export function parseHeader(text: string, structName: string): Sdk {
  const clean = stripComments(text);
  const raw = new Map<string, string>();
  for (const m of clean.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(?!\()[ \t]+(.+?)[ \t]*$/gm)) raw.set(m[1]!, m[2]!.trim());
  const { resolve, evalExpr } = makeEvaluator(raw);

  const events = new Map<string, number>();
  const mouse = new Map<string, number>();
  const strings = new Map<string, string>();
  for (const [name, src] of raw) {
    const s = /^"([^"]*)"$/.exec(src);
    if (s) {
      strings.set(name, s[1]!);
      continue;
    }
    if (name.startsWith("EVT_")) {
      const v = resolve(name);
      if (v !== null) events.set(name, v);
    } else if (name.startsWith("MOUSE_FLAG_")) {
      const v = resolve(name);
      if (v !== null) mouse.set(name, v >>> 0);
    }
  }
  // events written as enum members: EVT_X = THIRD_PARTY_EVENT_ID_MIN + 5,
  for (const e of clean.matchAll(/enum\b[^{;]*\{([\s\S]*?)\}/g)) {
    let next = 0;
    for (const item of e[1]!.split(",")) {
      const m = /^\s*([A-Za-z_]\w*)\s*(?:=\s*(.+?))?\s*$/.exec(item);
      if (!m) continue;
      const v = m[2] !== undefined ? evalExpr(m[2]) : next;
      if (v === null) continue;
      next = v + 1;
      if (m[1]!.startsWith("EVT_")) events.set(m[1]!, v);
    }
  }

  const find = (re: RegExp) => [...strings.entries()].find(([k]) => re.test(k))?.[1] ?? null;
  const pack = /#\s*pragma\s+pack\s*\(\s*(?:push\s*,\s*)?(\d+)\s*\)/.exec(clean);
  let layout: Layout | null = null;
  let layoutError: string | null = null;
  try {
    layout = computeLayout(clean, structName, evalExpr, pack ? Number(pack[1]) : 8);
  } catch (e) {
    layoutError = (e as Error).message;
  }
  return { events, mouse, dataName: find(/DATA_NAME$/), controlName: find(/CONTROL_NAME$/), layout, layoutError };
}
