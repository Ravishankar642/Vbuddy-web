import { open, Protocol, type ConnectionHandle, type RecvOpen } from "node-simconnect";
import type { SimGeneration } from "@vbuddy/protocol";

export interface SimConnectTarget {
  host: string;
  port: number;
}

/**
 * Which Microsoft Flight Simulator answered. MSFS 2020 reports itself as "KittyHawk" with version 11; MSFS 2024 as
 * "SunRise" with version 12. The version is the stronger signal (a future update may rename the application), the name
 * is the fallback when the version is missing.
 */
export function simGeneration(applicationName: string, versionMajor: number): SimGeneration | undefined {
  if (Number.isFinite(versionMajor) && versionMajor >= 12) return "msfs2024";
  if (Number.isFinite(versionMajor) && versionMajor === 11) return "msfs2020";
  const n = applicationName.toLowerCase();
  if (n.includes("sunrise")) return "msfs2024";
  if (n.includes("kittyhawk")) return "msfs2020";
  return undefined;
}

/** "Microsoft Flight Simulator 2020" / "… 2024", for the app and the log. */
export function simLabel(gen: SimGeneration | undefined): string {
  return gen === "msfs2024" ? "Microsoft Flight Simulator 2024" : gen === "msfs2020" ? "Microsoft Flight Simulator 2020" : "Microsoft Flight Simulator";
}

/**
 * Opens a SimConnect connection. With no target it auto-detects (named pipe /
 * registry on the sim PC, or SimConnect.cfg). KittyHawk is the MSFS 2020
 * protocol and is accepted by MSFS 2024 as well, so one bridge serves both.
 */
export async function connectSim(
  appName: string,
  target: SimConnectTarget | null,
): Promise<{ handle: ConnectionHandle; info: RecvOpen; simName: string; simGen: SimGeneration | undefined }> {
  const { handle, recvOpen } = target
    ? await open(appName, Protocol.KittyHawk, { host: target.host, port: target.port })
    : await open(appName, Protocol.KittyHawk);
  const simGen = simGeneration(recvOpen.applicationName, recvOpen.applicationVersionMajor);
  const version = `${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor}.${recvOpen.applicationBuildMajor}.${recvOpen.applicationBuildMinor}`;
  const simName = simGen ? `${simLabel(simGen)} (${version})` : `${recvOpen.applicationName} ${version}`;
  return { handle, info: recvOpen, simName, simGen };
}

/** SimConnect errors are often bare objects or codes; make them printable. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "code" in e) return `code ${String((e as { code: unknown }).code)}`;
  return String(e);
}
