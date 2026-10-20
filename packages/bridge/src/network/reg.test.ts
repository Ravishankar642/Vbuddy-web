import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVatsimFeed } from "./vatsim-feed.js";

test("the registration is read from REG/ in the flight plan remarks", () => {
  const snap = parseVatsimFeed({
    pilots: [
      { callsign: "QTR1175", latitude: 25.5, longitude: 51.8, altitude: 13000, groundspeed: 400, heading: 220, flight_plan: { aircraft_short: "B788", departure: "OEMA", arrival: "OTHH", remarks: "PBN/A1B1 DOF/261020 REG/A7BCE EET/OTDF0105 /v/" } },
      { callsign: "IGO123", latitude: 12, longitude: 80, altitude: 0, groundspeed: 0, heading: 0, flight_plan: { remarks: "/v/ no registration" } },
    ],
    controllers: [],
    atis: [],
  });
  assert.equal(snap.pilots.find((p) => p.callsign === "QTR1175")?.reg, "A7BCE");
  assert.equal(snap.pilots.find((p) => p.callsign === "IGO123")?.reg, undefined);
});
