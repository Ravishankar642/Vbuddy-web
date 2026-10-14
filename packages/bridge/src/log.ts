type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let min: Level = (process.env.VBUDDY_LOG as Level) in order ? (process.env.VBUDDY_LOG as Level) : "info";

export function setLogLevel(l: Level) {
  min = l;
}

export interface LogEntry {
  ts: number;
  level: Level;
  scope: string;
  msg: string;
}
const RECENT_MAX = 300;
const recent: LogEntry[] = [];
/** The latest log lines (info and above), oldest first: what the VBuddy window's Activity page shows. */
export function recentLogs(): LogEntry[] {
  return recent.slice();
}

function out(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < order[min]) return;
  if (order[level] >= order.info) {
    recent.push({ ts: Date.now(), level, scope, msg: extra instanceof Error ? `${msg} ${extra.message}` : msg });
    if (recent.length > RECENT_MAX) recent.shift();
  }
  const t = new Date().toISOString().slice(11, 23);
  const line = `${t} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra !== undefined) fn(line, extra);
  else fn(line);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => out("debug", scope, m, e),
    info: (m: string, e?: unknown) => out("info", scope, m, e),
    warn: (m: string, e?: unknown) => out("warn", scope, m, e),
    error: (m: string, e?: unknown) => out("error", scope, m, e),
  };
}
export type Logger = ReturnType<typeof logger>;
