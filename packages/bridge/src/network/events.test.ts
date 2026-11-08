import { test } from "node:test";
import assert from "node:assert/strict";
import { mapEvents, VatsimEvents } from "./events.js";

const NOW = Date.UTC(2026, 10, 8, 12);
const FEED = {
  data: [
    { name: "Dubai Overload", link: "https://my.vatsim.net/events/1", start_time: "2026-11-08T16:00:00.000000Z", end_time: "2026-11-08T19:00:00.000000Z", airports: [{ icao: "OMDB" }] },
    { name: "Old one", start_time: "2026-11-07T16:00:00Z", end_time: "2026-11-07T19:00:00Z", airports: [{ icao: "OMDB" }] },
    { name: "Elsewhere", start_time: "2026-11-08T16:00:00Z", end_time: "2026-11-08T19:00:00Z", airports: [{ icao: "EGLL" }] },
  ],
};

test("vatsim events: on the plan's airports, not ended, within a day; one fetch an hour", async () => {
  assert.equal(mapEvents(FEED).length, 3);
  let calls = 0;
  const ev = new VatsimEvents(async () => (calls++, { ok: true, status: 200, json: async () => FEED, text: async () => "" }));
  const a = await ev.at(["omdb", "VABB"], NOW);
  assert.deepEqual(a.map((e) => e.name), ["Dubai Overload"]);
  await ev.at(["EGLL"], NOW + 60_000);
  assert.equal(calls, 1);
});
