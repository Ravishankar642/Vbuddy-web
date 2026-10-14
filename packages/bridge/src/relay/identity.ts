import { isBridgeId, isBridgeKey } from "@vbuddy/protocol";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RelayIdentity {
  /** Public: part of the phone link. Picks this PC on a shared relay. */
  id: string;
  /** Secret: proves the PC owns the id. Never shown, never in the phone link. */
  key: string;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function makeIdentity(): RelayIdentity {
  let id = "";
  for (let i = 0; i < 12; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return { id, key: randomBytes(32).toString("base64url") };
}

/** This install's id and key: made on first use and kept in the data folder (memory only without one). */
export function loadRelayIdentity(file: string | null): RelayIdentity {
  if (file && existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as Partial<RelayIdentity>;
      if (isBridgeId(j.id) && isBridgeKey(j.key)) return { id: j.id, key: j.key };
    } catch {
      /* made again below */
    }
  }
  const made = makeIdentity();
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      writeFileSync(tmp, JSON.stringify(made), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      /* still works for this run */
    }
  }
  return made;
}

/** The link to type or scan on a phone: the relay's https address plus this install's id. */
export function phoneLink(relayUrl: string, id: string): string {
  return relayUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "") + "/?r=" + id;
}
