import { open, Protocol, type ConnectionHandle, type RecvOpen } from "node-simconnect";

export interface SimConnectTarget {
  host: string;
  port: number;
}

/**
 * Opens a SimConnect connection. With no target it auto-detects (named pipe /
 * registry on the sim PC, or SimConnect.cfg). KittyHawk is the MSFS 2020
 * protocol and is accepted by MSFS 2024 as well.
 */
export async function connectSim(
  appName: string,
  target: SimConnectTarget | null,
): Promise<{ handle: ConnectionHandle; info: RecvOpen; simName: string }> {
  const { handle, recvOpen } = target
    ? await open(appName, Protocol.KittyHawk, { host: target.host, port: target.port })
    : await open(appName, Protocol.KittyHawk);
  const simName = `${recvOpen.applicationName} ${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor}.${recvOpen.applicationBuildMajor}.${recvOpen.applicationBuildMinor}`;
  return { handle, info: recvOpen, simName };
}

/** SimConnect errors are often bare objects or codes; make them printable. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "code" in e) return `code ${String((e as { code: unknown }).code)}`;
  return String(e);
}
