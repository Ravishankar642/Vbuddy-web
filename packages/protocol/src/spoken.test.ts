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

test("an AI ATC app's text and a transcript of its voice are the same call", async () => {
  const { sameTransmission } = await import("./index.js");
  assert.equal(sameTransmission("Speedbird 123, taxi to holding point runway 27R via Bravo, Charlie 2.", "Speedbird one two three, taxi to holding point runway two seven right via Bravo Charlie two"), true);
  assert.equal(sameTransmission("Speedbird 123, contact Mumbai Control 132.7", "Emirates 521, climb flight level 350"), false);
  assert.equal(sameTransmission("Roger", "Roger"), false);
});
