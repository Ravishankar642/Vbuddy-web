import { z } from "zod";
import { LandingSchema, LandingSummarySchema } from "./landing.js";
import { CockpitCommandSchema, ControlInfoSchema, FcuStateSchema, PairedDeviceSchema } from "./cockpit.js";
import { ChatMessageSchema, CommsCommandSchema, CommsStateSchema } from "./comms.js";
import { LegCommandSchema, PlannedLegSchema } from "./legs.js";
import { PanelCommandSchema, PanelStateSchema } from "./panel.js";
import { SystemsSnapshotSchema } from "./systems.js";
import { AcarsCommandSchema, AcarsStateSchema } from "./acars.js";
import { AtcAlertSchema, AtcPositionSchema, AtcStationSchema, NetPilotSchema, NetworkIdSchema, NetworkStatusSchema } from "./network.js";
import { SimStatusSchema, TelemetryFrameSchema } from "./telemetry.js";

/** Bumped on any breaking change to the wire format. */
export const PROTOCOL_VERSION = 1;

const base = { v: z.literal(PROTOCOL_VERSION), ts: z.number() };

/* ----------------------------------------------------------- bridge -> client */

export const WelcomeSchema = z.object({
  ...base,
  t: z.literal("welcome"),
  /** Random id for this bridge run. A new id means sequence numbers restarted. */
  sessionId: z.string(),
  bridgeVersion: z.string(),
  /** Highest seq the bridge has produced so far (-1 if none). */
  latestSeq: z.number().int(),
  /** Rate at which live telemetry is pushed. */
  telemetryHz: z.number(),
  sim: SimStatusSchema,
  /** Result of the client's resume request, if it sent one. */
  resume: z
    .object({
      /** "ok" = missed frames follow in a telemetryBatch; "gap" = some were too old to replay; "new-session" = bridge restarted. */
      status: z.enum(["ok", "gap", "new-session"]),
      replayCount: z.number().int().nonnegative(),
      /** 1 = every missed frame is replayed; N > 1 = a long outage was thinned to every Nth frame (the newest is always included). */
      stride: z.number().int().min(1).optional(),
      /** How many of the replayed frames came from the bridge's disk log rather than memory. */
      fromDisk: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const TelemetryMsgSchema = z.object({
  ...base,
  t: z.literal("telemetry"),
  frame: TelemetryFrameSchema,
});

/** Several frames at once, used to replay what a reconnecting client missed. */
export const TelemetryBatchSchema = z.object({
  ...base,
  t: z.literal("telemetryBatch"),
  reason: z.enum(["resume"]),
  frames: z.array(TelemetryFrameSchema),
});

export const SimStatusMsgSchema = z.object({
  ...base,
  t: z.literal("simStatus"),
  sim: SimStatusSchema,
});

/** Newest-first list of recorded landings, without their traces. Sent after hello. */
export const LandingListSchema = z.object({
  ...base,
  t: z.literal("landingList"),
  landings: z.array(LandingSummarySchema),
});

/** A full landing with its trace: pushed live when one happens, or sent when asked for. */
export const LandingMsgSchema = z.object({
  ...base,
  t: z.literal("landing"),
  reason: z.enum(["new", "requested"]),
  landing: LandingSchema,
});

/** Network traffic around the area this client asked for (or around your aircraft). Sent every network update. */
export const TrafficMsgSchema = z.object({
  ...base,
  t: z.literal("traffic"),
  network: NetworkIdSchema,
  updatedAt: z.number(),
  /** Your own callsign if the bridge recognised you on the network (it is then left out of pilots). */
  you: z.string().nullable(),
  pilots: z.array(NetPilotSchema),
});

/** Every online ATC station on the network, plus feed status. Sent after hello and whenever either changes. */
export const AtcListSchema = z.object({
  ...base,
  t: z.literal("atcList"),
  status: NetworkStatusSchema,
  stations: z.array(AtcStationSchema),
});

/** Which station covers your aircraft now and which one is next on your track. Sent when it changes. */
export const AtcPositionMsgSchema = z.object({
  ...base,
  t: z.literal("atcPosition"),
  position: AtcPositionSchema,
});

/** Something the pilot should act on: a new controller to contact, or a boundary coming up. */
export const AtcAlertMsgSchema = z.object({
  ...base,
  t: z.literal("atcAlert"),
  alert: AtcAlertSchema,
});

/** FCU state (null = no supported aircraft loaded) and this client's control rights. Sent after hello and on change. */
export const CockpitMsgSchema = z.object({
  ...base,
  t: z.literal("cockpit"),
  state: FcuStateSchema.nullable(),
  control: ControlInfoSchema,
});

export const CmdResultSchema = z.object({
  ...base,
  t: z.literal("cmdResult"),
  id: z.string(),
  ok: z.boolean(),
  /** Shown to the pilot when ok is false. */
  error: z.string().optional(),
});

export const PairResultSchema = z.object({
  ...base,
  t: z.literal("pairResult"),
  ok: z.boolean(),
  /** Keep this; send it in hello from now on. */
  token: z.string().optional(),
  error: z.string().optional(),
});

/** Only for clients on the bridge PC itself: the current pairing code and paired devices. */
export const PairingInfoSchema = z.object({
  ...base,
  t: z.literal("pairingInfo"),
  code: z.string(),
  expiresAt: z.number(),
  devices: z.array(PairedDeviceSchema),
});

/** Radios, transponder and network connection. Sent after hello (to devices allowed to control) and on change. */
export const CommsStateMsgSchema = z.object({ ...base, t: z.literal("commsState"), state: CommsStateSchema });
/** The recent conversation, sent once after hello to devices allowed to see it (DMs are private). */
export const ChatHistorySchema = z.object({ ...base, t: z.literal("chatHistory"), messages: z.array(ChatMessageSchema) });
export const ChatMsgSchema = z.object({ ...base, t: z.literal("chat"), message: ChatMessageSchema });
export const AcarsStateMsgSchema = z.object({ ...base, t: z.literal("acarsState"), state: AcarsStateSchema });
export const AcarsResultSchema = z.object({ ...base, t: z.literal("acarsResult"), id: z.string(), ok: z.boolean(), error: z.string().optional() });

export const CommsResultSchema = z.object({ ...base, t: z.literal("commsResult"), id: z.string(), ok: z.boolean(), error: z.string().optional() });

/** Lights, autopilot and aircraft family. Sent after hello and on change. */
export const PanelStateMsgSchema = z.object({ ...base, t: z.literal("panelState"), state: PanelStateSchema });
/** Live systems readout (engines, fuel, electrical, ...). Sent about once a second while the sim is connected. */
export const SystemsMsgSchema = z.object({ ...base, t: z.literal("systems"), systems: SystemsSnapshotSchema.nullable() });
/** The planned flights (the pilot's own list). Sent after hello and whenever it changes. */
export const LegsMsgSchema = z.object({ ...base, t: z.literal("legs"), legs: z.array(PlannedLegSchema) });
export const LegResultSchema = z.object({ ...base, t: z.literal("legResult"), id: z.string(), ok: z.boolean(), error: z.string().optional() });
export const PanelResultSchema = z.object({ ...base, t: z.literal("panelResult"), id: z.string(), ok: z.boolean(), error: z.string().optional() });

export const PushPrefsSchema = z.object({
  /** New controller to contact / boundary coming up. */
  atc: z.boolean(),
  /** Touchdown debrief. */
  landing: z.boolean(),
  /** Direct messages, SELCAL and radio calls that mention your callsign. */
  chat: z.boolean(),
  /** Connected to / disconnected from VATSIM. */
  vatsim: z.boolean().default(true),
  /** Aircraft alerts: low fuel, engine failure, stall, overspeed, gear up low, high sink rate. */
  alerts: z.boolean().default(true),
  /** Tell me when the autopilot switches off above 3,000 ft (not on the approach). Off unless chosen. */
  apOff: z.boolean().default(false),
  /** Tell me this many minutes before the top of descent (0 = no notice). Needs a SimBrief plan. */
  todMin: z.number().int().min(0).max(60).default(10),
  /** Warn when the fuel left lasts less than this many minutes (0 = no fuel warning). */
  fuelMin: z.number().int().min(0).max(240).default(30),
  /** Tell me about a coverage boundary when it is this many nautical miles ahead. */
  atcAheadNm: z.number().int().min(5).max(150).default(40),
  /** At most this many "boundary ahead" / "no ATC" notifications per hour (0 = no limit). */
  atcPerHour: z.number().int().min(0).max(60).default(0),
});
export type PushPrefs = z.infer<typeof PushPrefsSchema>;

/** Whether this bridge can send push notifications to this device, and the key the browser needs to subscribe. */
export const PushInfoSchema = z.object({
  ...base,
  t: z.literal("pushInfo"),
  enabled: z.boolean(),
  publicKey: z.string().nullable(),
  /** This paired device has a saved subscription (and its choices). */
  subscribed: z.boolean(),
  prefs: PushPrefsSchema,
  /** Why it is unavailable or what just happened (e.g. "test sent"). */
  note: z.string().optional(),
});

export type PushInfoMsg = z.infer<typeof PushInfoSchema>;

/** A warning about the aircraft itself, shown as a banner in the open app (and pushed to devices that asked for it). */
export const FlightAlertSchema = z.object({
  id: z.string(),
  kind: z.enum(["fuel", "engine", "stall", "overspeed", "gear", "sink", "autopilot"]),
  severity: z.enum(["warning", "caution"]),
  title: z.string(),
  text: z.string(),
});
export type FlightAlert = z.infer<typeof FlightAlertSchema>;
export const FlightAlertMsgSchema = z.object({ ...base, t: z.literal("flightAlert"), alert: FlightAlertSchema });

export const PongSchema = z.object({
  ...base,
  t: z.literal("pong"),
  nonce: z.string(),
});

export const ErrorMsgSchema = z.object({
  ...base,
  t: z.literal("error"),
  code: z.enum(["bad-message", "unsupported-version", "not-found", "internal", "not-allowed"]),
  message: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion("t", [
  WelcomeSchema,
  TelemetryMsgSchema,
  TelemetryBatchSchema,
  SimStatusMsgSchema,
  LandingListSchema,
  LandingMsgSchema,
  TrafficMsgSchema,
  AtcListSchema,
  AtcPositionMsgSchema,
  AtcAlertMsgSchema,
  FlightAlertMsgSchema,
  CockpitMsgSchema,
  CmdResultSchema,
  PairResultSchema,
  PairingInfoSchema,
  PushInfoSchema,
  CommsStateMsgSchema,
  ChatHistorySchema,
  ChatMsgSchema,
  CommsResultSchema,
  AcarsStateMsgSchema,
  AcarsResultSchema,
  PanelStateMsgSchema,
  SystemsMsgSchema,
  PanelResultSchema,
  LegsMsgSchema,
  LegResultSchema,
  PongSchema,
  ErrorMsgSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/* ----------------------------------------------------------- client -> bridge */

export const HelloSchema = z.object({
  ...base,
  t: z.literal("hello"),
  client: z.string().max(64).optional(),
  /** Pairing token from an earlier pairResult; lets this device send commands. */
  token: z.string().max(200).optional(),
  /** Sent on reconnect so the bridge can replay what this client missed. */
  resume: z
    .object({
      sessionId: z.string(),
      lastSeq: z.number().int(),
    })
    .optional(),
});

export const PingSchema = z.object({
  ...base,
  t: z.literal("ping"),
  nonce: z.string().max(64),
});

export const GetLandingSchema = z.object({
  ...base,
  t: z.literal("getLanding"),
  id: z.string().max(64),
});

/** Where this client's map is looking. Traffic is sent for this area; without it, around your aircraft. */
export const TrafficAreaSchema = z.object({
  ...base,
  t: z.literal("trafficArea"),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  radiusNm: z.number().min(1).max(1000),
});

export const CmdSchema = z.object({
  ...base,
  t: z.literal("cmd"),
  id: z.string().max(64),
  cmd: CockpitCommandSchema,
});

export const PairSchema = z.object({
  ...base,
  t: z.literal("pair"),
  code: z.string().regex(/^\d{6}$/),
  device: z.string().min(1).max(60),
});

/** Bridge PC only. */
export const RevokeDeviceSchema = z.object({ ...base, t: z.literal("revokeDevice"), id: z.string().max(64) });
export const NewPairingCodeSchema = z.object({ ...base, t: z.literal("newPairingCode") });
/** After commands stopped reaching the aircraft: try the first way of sending again. */
export const CockpitRetrySchema = z.object({ ...base, t: z.literal("cockpitRetry") });

/** A browser push subscription (from PushManager.subscribe().toJSON()). Only paired devices may send it. */
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});
export const PushSubscribeSchema = z.object({ ...base, t: z.literal("pushSubscribe"), subscription: PushSubscriptionSchema, prefs: PushPrefsSchema });
export const PushUnsubscribeSchema = z.object({ ...base, t: z.literal("pushUnsubscribe") });
export const PushTestSchema = z.object({ ...base, t: z.literal("pushTest") });

export const AcarsCmdSchema = z.object({ ...base, t: z.literal("acarsCmd"), id: z.string().max(40), cmd: AcarsCommandSchema });
export const CommsCmdSchema = z.object({ ...base, t: z.literal("commsCmd"), id: z.string().max(40), cmd: CommsCommandSchema });

export const PanelCmdSchema = z.object({ ...base, t: z.literal("panelCmd"), id: z.string().max(40), cmd: PanelCommandSchema });

export const LegCmdSchema = z.object({ ...base, t: z.literal("legCmd"), id: z.string().max(40), cmd: LegCommandSchema });

export const ClientMessageSchema = z.discriminatedUnion("t", [
  HelloSchema,
  PingSchema,
  GetLandingSchema,
  TrafficAreaSchema,
  CmdSchema,
  PairSchema,
  RevokeDeviceSchema,
  NewPairingCodeSchema,
  CockpitRetrySchema,
  PushSubscribeSchema,
  PushUnsubscribeSchema,
  PushTestSchema,
  CommsCmdSchema,
  AcarsCmdSchema,
  PanelCmdSchema,
  LegCmdSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ----------------------------------------------------------- helpers */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ServerMessageBody = DistributiveOmit<ServerMessage, "v" | "ts">;
export type ClientMessageBody = DistributiveOmit<ClientMessage, "v" | "ts">;

/** Wraps a message body with protocol version and timestamp, ready to JSON.stringify. */
export function envelope<T extends ServerMessageBody | ClientMessageBody>(
  body: T,
  now: number = Date.now(),
): T & { v: typeof PROTOCOL_VERSION; ts: number } {
  return { v: PROTOCOL_VERSION, ts: now, ...body };
}

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (typeof json === "object" && json !== null && "v" in json && json.v !== PROTOCOL_VERSION) {
    return { ok: false, error: `unsupported protocol version ${String(json.v)} (expected ${PROTOCOL_VERSION})` };
  }
  const r = schema.safeParse(json);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  return { ok: true, msg: r.data };
}

export const parseServerMessage = (raw: string) => parseWith(ServerMessageSchema, raw);
export const parseClientMessage = (raw: string) => parseWith(ClientMessageSchema, raw);
