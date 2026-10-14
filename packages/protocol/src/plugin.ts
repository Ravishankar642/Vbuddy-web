import { z } from "zod";

/**
 * The link between the VBuddy Link plugin (inside vPilot) and the bridge on the same PC:
 * a WebSocket at /plugin, one JSON message per frame. Kept apart from the browser protocol
 * because the plugin is a separate program with its own release cycle.
 */
export const PLUGIN_PATH = "/plugin";
export const PLUGIN_PROTOCOL = 1;

export const PluginToBridgeSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), protocol: z.number(), plugin: z.string().max(40) }),
  z.object({
    t: z.literal("net"),
    connected: z.boolean(),
    callsign: z.string().max(12).nullable(),
    type: z.string().max(8).nullable(),
    selcal: z.string().max(8).nullable(),
    observer: z.boolean(),
  }),
  z.object({
    t: z.literal("chat"),
    kind: z.enum(["radio", "private", "broadcast", "selcal"]),
    from: z.string().max(40),
    /** Hz, kHz or MHz, as vPilot reports them (see toHz). */
    freqs: z.array(z.number()).max(8),
    text: z.string().max(1000),
  }),
  z.object({ t: z.literal("result"), id: z.string().max(40), ok: z.boolean(), error: z.string().max(300).optional() }),
]);
export type PluginToBridge = z.infer<typeof PluginToBridgeSchema>;

export const BridgeToPluginSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("connect"), id: z.string(), callsign: z.string(), type: z.string(), selcal: z.string() }),
  z.object({ op: z.literal("disconnect"), id: z.string() }),
  z.object({ op: z.literal("sendRadio"), id: z.string(), text: z.string() }),
  z.object({ op: z.literal("sendPrivate"), id: z.string(), to: z.string(), text: z.string() }),
  z.object({ op: z.literal("ident"), id: z.string() }),
  z.object({ op: z.literal("modeC"), id: z.string(), on: z.boolean() }),
]);
export type BridgeToPlugin = z.infer<typeof BridgeToPluginSchema>;
