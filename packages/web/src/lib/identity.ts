import type { BridgeSnapshot } from "./bridge-client";
import { airlineFromSim, airlineOf, type Airline } from "./airlines";

export type IdentitySource = "network" | "plan" | "sim";
export interface FlightIdentity {
  /** The callsign to show (QTR123); null when only the airline is known. */
  callsign: string | null;
  airline: (Airline & { icao: string }) | null;
  source: IdentitySource | null;
}

/**
 * Who you're flying as: your network callsign while connected, else the SimBrief plan's, else what the sim says
 * (the livery's airline and flight number, or an airline named in the aircraft's title).
 */
export function flightIdentity(b: Pick<BridgeSnapshot, "comms" | "plan" | "sim">): FlightIdentity {
  const net = b.comms?.net;
  const netCs = net?.connected ? net.callsign : null;
  if (netCs) return { callsign: netCs, airline: airlineOf(netCs), source: "network" };
  const planCs = b.plan?.callsign ?? null;
  if (planCs) return { callsign: planCs, airline: airlineOf(planCs), source: "plan" };
  const s = b.sim;
  const fromSim = s ? airlineFromSim(s.atcAirline, s.atcFlightNumber, s.aircraftTitle) : null;
  if (fromSim) return { callsign: fromSim.callsign, airline: { ...fromSim.airline, icao: fromSim.icao }, source: "sim" };
  return { callsign: null, airline: null, source: null };
}
