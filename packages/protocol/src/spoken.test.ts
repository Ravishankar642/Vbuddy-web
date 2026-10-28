import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsCallsign, normaliseSpoken, spokenCallsign } from "./index.js";

test("spoken numbers and letters are normalised the way ATC says them", () => {
  assert.deepEqual(normaliseSpoken("Speedbird one two three, climb"), ["SPEEDBIRD", "123", "CLIMB"]);
  assert.deepEqual(normaliseSpoken("Qatari twelve thirty-four"), ["QATARI", "1234"]);
  assert.deepEqual(normaliseSpoken("November three alpha bravo"), ["N3AB"]);
  assert.deepEqual(normaliseSpoken("squawk 4 7 2 1"), ["SQUAWK", "4721"]);
});

test("your callsign is found however the recogniser wrote it", () => {
  assert.ok(mentionsCallsign("Speedbird 123, contact London on 121.5", "BAW123"));
  assert.ok(mentionsCallsign("speed bird one two three turn left", "BAW123"));
  assert.ok(mentionsCallsign("Speedbirds one two three", "BAW123"));
  assert.ok(mentionsCallsign("Qatari twelve thirty four descend", "QTR1234"));
  assert.ok(mentionsCallsign("Air India one seven one", "AIC171"));
  assert.ok(mentionsCallsign("november one two three alpha bravo", "N123AB"));
  assert.ok(mentionsCallsign("three alpha bravo, report downwind", "N123AB"));
  // Not you.
  assert.ok(!mentionsCallsign("Speedbird 124, contact London", "BAW123"));
  assert.ok(!mentionsCallsign("Emirates 123, climb", "BAW123"));
  assert.ok(!mentionsCallsign("anything", null));
  assert.deepEqual(spokenCallsign("UAE5"), { words: ["EMIRATES"], suffix: "5" });
  assert.deepEqual(spokenCallsign("XYZ12"), { words: ["XYZ"], suffix: "12" });
});
