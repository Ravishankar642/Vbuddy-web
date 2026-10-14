import { readPairToken } from "./bridge-client";

/** fetch() for the bridge's /api/* endpoints. Through the relay these need the pairing token. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = readPairToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
