/**
 * The tunnel between a bridge and a relay. The bridge dials OUT to the relay (so the home router needs no
 * port-forwarding) and the relay passes browsers' HTTP requests and WebSockets through it.
 *
 * One WebSocket carries everything. Text frames are JSON control messages; binary frames are
 * [4-byte stream id][bytes] and carry HTTP response bodies. Stream ids are chosen by the relay.
 */

export const TUNNEL_PATH = "/relay/tunnel";
export const TUNNEL_VERSION = 1;
/** Header a bridge sends when dialling the tunnel: which bridge it is. The key goes in the Authorization header. */
export const TUNNEL_ID_HEADER = "x-vbuddy-id";
/** Cookie the relay sets in a phone's browser so later requests (assets, the WebSocket) reach the right bridge. */
export const ROUTE_COOKIE = "vb";
/** Query parameter of the phone link: https://relay/?r=<bridge id> */
export const ROUTE_PARAM = "r";
/** The only part of a bridge that accepts more than GET through the relay: the Fenix EFB, which is a web app of its own. */
export const EFB_PREFIX = "/efb/";
/** Largest request body the relay passes on. */
export const MAX_REQUEST_BODY = 1024 * 1024;

/** A bridge id: 12 characters of lowercase base32, made by the bridge on first run. */
export const BRIDGE_ID_RE = /^[a-z2-7]{12}$/;
export const isBridgeId = (s: unknown): s is string => typeof s === "string" && BRIDGE_ID_RE.test(s);
/** A bridge key: at least 32 URL-safe characters. Only its hash is kept by the relay. */
export const isBridgeKey = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(s);

export type HeaderMap = Record<string, string>;

/** Relay -> bridge */
export type RelayToBridge =
  | { k: "ready"; v: number }
  | { k: "req"; id: number; method: string; url: string; headers: HeaderMap; ip: string; /** A request body follows as binary frames, then reqEnd. */ body?: boolean }
  | { k: "reqEnd"; id: number }
  | { k: "reqAbort"; id: number }
  | { k: "wsOpen"; id: number; url: string; headers: HeaderMap; ip: string; /** The WebSocket subprotocols the browser asked for. */ protocols?: string }
  | { k: "wsMsg"; id: number; data: string; /** `data` is base64 of a binary message. */ bin?: boolean }
  | { k: "wsClose"; id: number; code: number };

/** Bridge -> relay */
export type BridgeToRelay =
  | { k: "hello"; v: number; name: string }
  | { k: "res"; id: number; status: number; headers: HeaderMap }
  | { k: "resEnd"; id: number }
  | { k: "resErr"; id: number; message: string }
  | { k: "wsOpened"; id: number }
  | { k: "wsMsg"; id: number; data: string; bin?: boolean }
  | { k: "wsClose"; id: number; code: number };

export function packBody(id: number, body: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(id >>> 0, 0);
  out.set(body, 4);
  return out;
}

export function unpackBody(buf: Uint8Array): { id: number; body: Uint8Array } | null {
  if (buf.length < 4) return null;
  const id = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0);
  return { id, body: buf.subarray(4) };
}

/** Headers that are about one hop only, never passed through. */
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

/** Plain headers only: single string values, no hop-by-hop ones, nothing the sender could use to pose as the relay. */
export function cleanHeaders(h: Record<string, string | string[] | undefined>, drop: (name: string) => boolean = () => false): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, val] of Object.entries(h)) {
    const n = name.toLowerCase();
    if (val === undefined || HOP.has(n) || n.startsWith("sec-websocket-") || n.startsWith("x-vbuddy-") || n === "x-forwarded-for" || n === "x-real-ip" || n === "forwarded" || drop(n)) continue;
    out[n] = Array.isArray(val) ? val.join(", ") : val;
  }
  return out;
}
