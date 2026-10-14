import { z } from "zod";

/** Frequencies travel as Hz (122.800 MHz = 122800000) so 8.33 kHz channels survive. */
export const UNICOM_HZ = 122_800_000;

export const RadioSchema = z.object({ active: z.number().int(), standby: z.number().int(), /** Listening on this radio (the audio panel's receive switch). */ rx: z.boolean() });
export const XpdrModeSchema = z.enum(["off", "stby", "alt", "other"]);

export const CommsStateSchema = z.object({
  net: z.object({
    connected: z.boolean(),
    callsign: z.string().nullable(),
    observer: z.boolean(),
    /** The VBuddy Link plugin inside vPilot is talking to this bridge. Without it there is no chat or connect/disconnect. */
    pluginLinked: z.boolean(),
    /** What the plugin last connected with, to prefill the connect form. */
    last: z.object({ callsign: z.string(), type: z.string(), selcal: z.string() }).nullable(),
  }),
  /** null = no simulator connected. */
  radios: z.object({ com1: RadioSchema, com2: RadioSchema }).nullable(),
  xpdr: z.object({ code: z.string().regex(/^[0-7]{4}$/), mode: XpdrModeSchema, ident: z.boolean() }).nullable(),
});
export type CommsState = z.infer<typeof CommsStateSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  ts: z.number(),
  kind: z.enum(["radio", "private", "broadcast", "selcal", "system"]),
  dir: z.enum(["in", "out"]),
  from: z.string(),
  to: z.string().nullable(),
  freqHz: z.array(z.number().int()),
  text: z.string(),
  /** "freq:<Hz>", "dm:<CALLSIGN>", "broadcast" or "system": which conversation it belongs to. */
  thread: z.string(),
  /** Worth interrupting the pilot for: a DM, a SELCAL, or a radio call that mentions your callsign. */
  attention: z.boolean(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const CommsCommandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("com"),
    radio: z.union([z.literal(1), z.literal(2)]),
    action: z.enum(["active", "standby", "swap", "listen"]),
    hz: z.number().int().min(118_000_000).max(136_990_000).optional(),
    /** For "listen": true = receive on this radio. */
    on: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("xpdr"),
    action: z.enum(["code", "mode", "ident"]),
    code: z.string().regex(/^[0-7]{4}$/).optional(),
    mode: z.enum(["stby", "alt"]).optional(),
  }),
  z.object({
    op: z.literal("net"),
    action: z.enum(["connect", "disconnect"]),
    callsign: z.string().regex(/^[A-Za-z0-9_-]{2,12}$/).optional(),
    type: z.string().regex(/^[A-Za-z0-9]{2,5}$/).optional(),
    selcal: z.string().regex(/^[A-Za-z]{4}$/).optional(),
  }),
  z.object({
    op: z.literal("send"),
    /** radio = whatever vPilot is transmitting on (freqHz: the frequency this conversation is on, checked against your tuned radios); private = a direct message. */
    to: z.discriminatedUnion("kind", [z.object({ kind: z.literal("radio"), freqHz: z.number().int().optional() }), z.object({ kind: z.literal("private"), callsign: z.string().min(2).max(12) })]),
    text: z.string().min(1).max(250),
  }),
]);
export type CommsCommand = z.infer<typeof CommsCommandSchema>;

export const MAX_CHAT = 500;

/** Normalises the frequency formats vPilot/FSD use (Hz, kHz, or kHz without the leading 1) to Hz. */
export function toHz(v: number): number {
  if (v >= 1_000_000) return Math.round(v);
  if (v >= 100_000) return Math.round(v * 1000);
  if (v >= 10_000) return Math.round((v + 100_000) * 1000);
  return Math.round(v * 1_000_000);
}

export const formatMhz = (hz: number) => (hz / 1_000_000).toFixed(3);
/** Parses "122.8", "122.800", "122800" into Hz, or null. */
export function parseMhz(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d{3}(\.\d{1,3})?$/.test(t) && !/^\d{6}$/.test(t)) return null;
  const hz = /^\d{6}$/.test(t) ? Number(t) * 1000 : Math.round(Number(t) * 1_000_000);
  return hz >= 118_000_000 && hz <= 136_990_000 ? hz : null;
}
