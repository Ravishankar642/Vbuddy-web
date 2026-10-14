import { z } from "zod";

/**
 * Live aircraft systems. The shape and field names follow Cobalt's universal aircraft state, so every aircraft
 * (default or add-on) fills the same model from the simulator's own variables, with study-aircraft overlays where
 * the stock variables are wrong (Fenix, FlyByWire).
 */
export const EngineKindSchema = z.enum(["piston", "jet", "turboprop", "none", "unknown"]);
export type EngineKind = z.infer<typeof EngineKindSchema>;

export const EngineGaugeSchema = z.object({
  n1: z.number(),
  n2: z.number(),
  running: z.boolean(),
  /** °C */
  egt: z.number(),
  /** °C */
  oilTemp: z.number(),
  /** psi */
  oilPressure: z.number(),
  /** gallons per hour */
  fuelFlow: z.number(),
  vibration: z.number(),
  antiIce: z.boolean(),
  /** Piston: engine RPM. Turboprop: propeller RPM (Np). 0 on jets. */
  rpm: z.number(),
  /** Turboprop torque, percent of maximum. 0 on other engines. */
  torquePct: z.number(),
  engineType: EngineKindSchema,
});
export type EngineGauge = z.infer<typeof EngineGaugeSchema>;

const b = z.boolean();
const n = z.number();

export const SystemsSnapshotSchema = z.object({
  /** Which control/readout profile the bridge picked from the aircraft title. */
  profile: z.string(),
  engines: z.object({ count: n, eng1: EngineGaugeSchema, eng2: EngineGaugeSchema, eng3: EngineGaugeSchema, eng4: EngineGaugeSchema }),
  fuel: z.object({ totalGal: n, totalLbs: n, left: n, right: n, center: n, capacity: n, weightPerGal: n }),
  autopilot: z.object({
    apMaster: b, fdActive: b, apAltHold: b, apAltTarget: n, apHDGHold: b, apHDGTarget: n, apSpdHold: b, apSpdTarget: n,
    apMachHold: b, apMachTarget: n, apVSHold: b, apVSTarget: n, apNAVHold: b, apAPRHold: b, apGSHold: b, apWingLeveler: b,
    apFLCActive: b, autothrottleActive: b, autothrottleArmed: b,
    fcuHeadingSelected: b, fcuSpeedSelected: b, fcuAltSelected: b, fcuVSSelected: b,
  }),
  surfaces: z.object({
    flapsHandle: n, flapsDetents: n, flapsLeft: n, spoilers: n, spoilersArmed: b, gearHandle: b, gearExtended: n,
    gearLeft: n, gearRight: n, gearNose: n, parkingBrake: b,
  }),
  electrical: z.object({ busVoltage: n, batteryVoltage: n, extPower: b, apuSwitch: b, apuGenActive: b, hydPressure1: n, hydPressure2: n }),
  pressurization: z.object({ cabinAlt: n, diffPressure: n, cabinRate: n }),
  navigation: z.object({
    wpNextLat: n, wpNextLon: n, wpNextId: z.string(), wpDistanceNm: n, wpEteSec: n, destEteSec: n, wpCount: n, wpIndex: n,
    nav1Active: n, com1Active: n, com1Standby: n, com2Active: n, com2Standby: n, xpdrCode: n, xpdrState: n, baroMb: n,
  }),
  lights: z.object({ beacon: b, nav: b, strobe: b, landing: b, taxi: b, logo: b, cabin: b }),
  doors: z.object({ door1: b, door2: b, door3: b, door4: b }),
  warnings: z.object({ stallWarning: b, overspeedWarning: b, masterCaution: b, masterWarning: b }),
  weight: z.object({ grossWeight: n }),
  environment: z.object({ oat: n, windSpeed: n, windDir: n, qnh: n }),
  systems: z.object({ pitotHeat: b, seatbeltSign: b }),
  meta: z.object({ onGround: b, simRate: n, maxSimRate: n }),
});
export type SystemsSnapshot = z.infer<typeof SystemsSnapshotSchema>;

export function emptyEngine(): EngineGauge {
  return { n1: 0, n2: 0, running: false, egt: 0, oilTemp: 0, oilPressure: 0, fuelFlow: 0, vibration: 0, antiIce: false, rpm: 0, torquePct: 0, engineType: "unknown" };
}

/** The starting values, as Cobalt's createEmptyState. */
export function emptySystems(): SystemsSnapshot {
  return {
    profile: "stock",
    engines: { count: 2, eng1: emptyEngine(), eng2: emptyEngine(), eng3: emptyEngine(), eng4: emptyEngine() },
    fuel: { totalGal: 0, totalLbs: 0, left: 0, right: 0, center: 0, capacity: 0, weightPerGal: 6.7 },
    autopilot: {
      apMaster: false, fdActive: false, apAltHold: false, apAltTarget: 0, apHDGHold: false, apHDGTarget: 0, apSpdHold: false, apSpdTarget: 0,
      apMachHold: false, apMachTarget: 0, apVSHold: false, apVSTarget: 0, apNAVHold: false, apAPRHold: false, apGSHold: false, apWingLeveler: false,
      apFLCActive: false, autothrottleActive: false, autothrottleArmed: false,
      fcuHeadingSelected: false, fcuSpeedSelected: false, fcuAltSelected: false, fcuVSSelected: false,
    },
    surfaces: { flapsHandle: 0, flapsDetents: 0, flapsLeft: 0, spoilers: 0, spoilersArmed: false, gearHandle: true, gearExtended: 100, gearLeft: 100, gearRight: 100, gearNose: 100, parkingBrake: false },
    electrical: { busVoltage: 0, batteryVoltage: 0, extPower: false, apuSwitch: false, apuGenActive: false, hydPressure1: 0, hydPressure2: 0 },
    pressurization: { cabinAlt: 0, diffPressure: 0, cabinRate: 0 },
    navigation: {
      wpNextLat: 0, wpNextLon: 0, wpNextId: "", wpDistanceNm: 0, wpEteSec: 0, destEteSec: 0, wpCount: 0, wpIndex: 0,
      nav1Active: 0, com1Active: 0, com1Standby: 0, com2Active: 0, com2Standby: 0, xpdrCode: 1200, xpdrState: 1, baroMb: 1013.2,
    },
    lights: { beacon: false, nav: false, strobe: false, landing: false, taxi: false, logo: false, cabin: false },
    doors: { door1: false, door2: false, door3: false, door4: false },
    warnings: { stallWarning: false, overspeedWarning: false, masterCaution: false, masterWarning: false },
    weight: { grossWeight: 0 },
    environment: { oat: 15, windSpeed: 0, windDir: 0, qnh: 1013 },
    systems: { pitotHeat: false, seatbeltSign: false },
    meta: { onGround: true, simRate: 1, maxSimRate: 1 },
  };
}
