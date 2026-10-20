import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanModel } from "./simconnect-source.js";

test("the sim's ATC MODEL text key becomes the ICAO type", () => {
  assert.equal(cleanModel("TT:ATCCOM.AC_MODEL_B788.0.text"), "B788");
  assert.equal(cleanModel("TT:ATCCOM.AC_MODEL A20N.0.text"), "A20N");
  assert.equal(cleanModel("A359"), "A359");
  assert.equal(cleanModel("TT:ATCCOM.ATC_NAME_SOMETHING.0.text"), "");
});
