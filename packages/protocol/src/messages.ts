import { z } from "zod";
import { LandingSchema, LandingSummarySchema } from "./landing.js";
import { CockpitCommandSchema, ControlInfoSchema, FcuStateSchema, PairedDeviceSchema } from "./cockpit.js";
import { ChatMessageSchema, CommsCommandSchema, CommsStateSchema } from "./comms.js";
import { LegCommandSchema, PlannedLegSchema } from "./legs.js";
import { CduKeySchema, CduScreenSchema } from "./cdu.js";
import { PanelCommandSchema, PanelStateSchema } from "./panel.js";
import { SystemsSnapshotSchema } from "./systems.js";
import { AcarsCommandSchema, AcarsStateSchema } from "./acars.js";
import { AtcAlertSchema, AtcPositionSchema, AtcStationSchema, NetPilotSchema, NetworkIdSchema, NetworkStatusSchema } from "./network.js";
import { SimStatusSchema, TelemetryFrameSchema } from "./telemetry.js";
import { TaxiGuideSchema, TaxiRequestSchema } from "./ground.js";

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
  /** Direct messages, SELCAL and ACARS. */
  chat: z.boolean(),
  /** ATC calling your callsign on the radio (text, VBuddy's voice to text, or an AI ATC app). */
  callsign: z.boolean().default(true),
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
  /** Wheels up. */
  takeoff: z.boolean().default(true),
  /** Levelled off at the cruise altitude (top of climb). */
  toc: z.boolean().default(true),
  /** Passing 10,000 ft, climbing and descending. */
  tenK: z.boolean().default(false),
  /** This many minutes before reaching the destination (0 = no notice). Needs a SimBrief plan. */
  approachMin: z.number().int().min(0).max(60).default(0),
  /** Parked at the gate after landing (parking brake set, engines off). */
  gate: z.boolean().default(true),
  /** The simulator closed or stopped sending data in the middle of a flight. */
  simLost: z.boolean().default(true),
  /** The SimBrief plan was loaded for this flight (when you connect to VATSIM). */
  planLoaded: z.boolean().default(true),
  /** The simulator paused itself (the "pause later" point, or before the top of descent). */
  paused: z.boolean().default(true),
  /** Taxi guidance: a turn, a runway crossing or the holding point coming up, and the route ATC gave you. */
  taxi: z.boolean().default(true),
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

/** Things that happen during a flight, shown as a note in the open app (and pushed to devices that want them). */
export const FlightEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["takeoff", "toc", "tenK", "tod", "approach", "gate", "simLost", "planLoaded", "paused", "flightStart"]),
  title: z.string(),
  text: z.string(),
});
export type FlightEvent = z.infer<typeof FlightEventSchema>;
export const FlightEventMsgSchema = z.object({ ...base, t: z.literal("flightEvent"), event: FlightEventSchema });

/** The SimBrief plan tied to the flight in progress (or the latest one, before a flight starts). Null = none. */
export const FlightPlanMsgSchema = z.object({
  ...base,
  t: z.literal("flightPlan"),
  plan: z
    .object({
      ofpId: z.string().nullable(),
      callsign: z.string().nullable(),
      dep: z.string(),
      arr: z.string(),
      /** The airports' names as SimBrief gives them. */
      depName: z.string().nullable().optional(),
      arrName: z.string().nullable().optional(),
      /** The aircraft registration in the SimBrief plan. */
      reg: z.string().nullable().optional(),
      route: z.string().nullable(),
      distanceNm: z.number().nullable(),
      eteMin: z.number().nullable(),
      cruiseFt: z.number().nullable(),
      aircraft: z.string().nullable(),
      /** The route's fixes that have a position, for the map. */
      fixes: z.array(z.object({ ident: z.string(), lat: z.number(), lon: z.number() })).max(2000),
      /** True when it belongs to the flight being recorded (its departure matches where the flight began). */
      matched: z.boolean(),
      loadedAt: z.number(),
    })
    .nullable(),
});
export type FlightPlanInfo = NonNullable<z.infer<typeof FlightPlanMsgSchema>["plan"]>;

/** A full-size screenshot of the simulator was taken and saved on the PC; fetch it from /api/screenshots/<name>. */
export const ScreenshotResultSchema = z.object({
  ...base,
  t: z.literal("screenshotResult"),
  id: z.string().max(40),
  ok: z.boolean(),
  name: z.string().max(120).optional(),
  w: z.number().int().optional(),
  h: z.number().int().optional(),
  bytes: z.number().int().optional(),
  error: z.string().max(300).optional(),
});

/** Live sim view: one JPEG frame of the simulator window (base64, no data: prefix). Sent only to devices that asked and are paired. */
export const SimViewFrameSchema = z.object({ ...base, t: z.literal("simViewFrame"), seq: z.number().int(), jpeg: z.string().max(3_000_000), w: z.number().int(), h: z.number().int() });
export const SimViewStateSchema = z.enum(["starting", "live", "no-window", "minimized", "unavailable", "not-allowed"]);
export type SimViewState = z.infer<typeof SimViewStateSchema>;
export const ChaseViewSchema = z.object({ guid: z.string(), name: z.string(), theme: z.string(), icao: z.string(), lat: z.number().nullable(), lon: z.number().nullable(), skipCycle: z.boolean() });
export type ChaseViewInfo = z.infer<typeof ChaseViewSchema>;
export const ChaseResultSchema = z.object({ ...base, t: z.literal("chaseResult"), id: z.string(), ok: z.boolean(), error: z.string().optional(), views: z.array(ChaseViewSchema).max(2000).optional(), airport: z.string().nullable().optional() });

/** A PMDG CDU screen, sent to the devices watching that CDU (cduView) whenever it changes; null when there is none. */
export const CduMsgSchema = z.object({ ...base, t: z.literal("cdu"), side: z.number().int().min(0).max(2), screen: CduScreenSchema.nullable() });
export const CduResultSchema = z.object({ ...base, t: z.literal("cduResult"), ok: z.boolean(), error: z.string().max(300).optional() });

/** The taxi route being followed and where you are on it (null = none). Sent after hello and on change (about once a second while taxiing). */
export const TaxiGuideMsgSchema = z.object({ ...base, t: z.literal("taxiGuide"), guide: TaxiGuideSchema.nullable() });
/** A taxi guidance note: a turn, a crossing or the holding point coming up, or a new route from ATC. */
export const TaxiNoticeMsgSchema = z.object({ ...base, t: z.literal("taxiNotice"), notice: z.object({ tag: z.string().max(40), title: z.string().max(120), text: z.string().max(400) }) });
export const TaxiResultSchema = z.object({ ...base, t: z.literal("taxiResult"), id: z.string().max(40), ok: z.boolean(), error: z.string().max(300).optional() });

/** Why there is or isn't a picture right now. */
export const SimViewStatusSchema = z.object({ ...base, t: z.literal("simViewStatus"), state: SimViewStateSchema, message: z.string().max(300).optional() });

/**
 * How hard the bridge is working: lite (the pilot's Lite mode), background (nobody looking: only the essentials run),
 * landing (in the landing window: nothing heavy runs). Sent after hello and on change.
 */
export const PerfStateMsgSchema = z.object({ ...base, t: z.literal("perfState"), lite: z.boolean(), background: z.boolean(), landing: z.boolean() });
/** The answer to setVoice / setLite. */
export const SettingResultSchema = z.object({ ...base, t: z.literal("settingResult"), id: z.string().max(40), ok: z.boolean(), error: z.string().max(300).optional() });

export const ServerMessageSchema = z.discriminatedUnion("t", [
  PerfStateMsgSchema,
  SettingResultSchema,
  TaxiGuideMsgSchema,
  TaxiNoticeMsgSchema,
  TaxiResultSchema,
  FlightEventMsgSchema,
  FlightPlanMsgSchema,
  ScreenshotResultSchema,
  CduMsgSchema,
  CduResultSchema,
  ChaseResultSchema,
  SimViewFrameSchema,
  SimViewStatusSchema,
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

/** ChasePlane camera views: list them, or switch to one (by ChasePlane's own id). */
export const ChaseCommandSchema = z.discriminatedUnion("op", [z.object({ op: z.literal("views") }), z.object({ op: z.literal("set"), guid: z.string().min(1).max(100) })]);
export type ChaseCommand = z.infer<typeof ChaseCommandSchema>;
export const ChaseCmdSchema = z.object({ ...base, t: z.literal("chaseCmd"), id: z.string().max(40), cmd: ChaseCommandSchema });

/** Start (on) or stop watching a PMDG CDU screen. */
export const CduViewSchema = z.object({ ...base, t: z.literal("cduView"), on: z.boolean(), side: z.number().int().min(0).max(2) });
/** Press a key on a PMDG CDU (paired devices only). */
export const CduKeyMsgSchema = z.object({ ...base, t: z.literal("cduKey"), side: z.number().int().min(0).max(2), key: CduKeySchema });

/** Plan a taxi route on the bridge (it then follows your aircraft along it), or stop following one. Paired devices. */
export const TaxiCmdSchema = z.object({ ...base, t: z.literal("taxiCmd"), id: z.string().max(40), cmd: TaxiRequestSchema });

/** Take a full-size screenshot of the simulator window (paired devices). */
export const ScreenshotCmdSchema = z.object({ ...base, t: z.literal("screenshot"), id: z.string().max(40) });
/** The app is on screen (true) or in the background (false): notifications are only pushed to devices that aren't looking. */
export const VisibilitySchema = z.object({ ...base, t: z.literal("visibility"), visible: z.boolean() });

/** Start (on) or stop watching the live sim view. */
export const SimViewSchema = z.object({ ...base, t: z.literal("simView"), on: z.boolean() });

/** Turn ATC voice to text on or off on the bridge (paired devices). */
export const SetVoiceSchema = z.object({ ...base, t: z.literal("setVoice"), id: z.string().max(40), enabled: z.boolean() });
/** Lite mode on or off (paired devices). */
export const SetLiteSchema = z.object({ ...base, t: z.literal("setLite"), id: z.string().max(40), on: z.boolean() });

export const ClientMessageSchema = z.discriminatedUnion("t", [
  SetVoiceSchema,
  SetLiteSchema,
  TaxiCmdSchema,
  ScreenshotCmdSchema,
  VisibilitySchema,
  CduViewSchema,
  CduKeyMsgSchema,
  SimViewSchema,
  ChaseCmdSchema,
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
