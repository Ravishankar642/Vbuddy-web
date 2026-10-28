import assert from "node:assert/strict";
import { test } from "node:test";
import { simGeneration, simLabel } from "./connect.js";

test("MSFS 2020 and MSFS 2024 are told apart from the SimConnect handshake", () => {
  assert.equal(simGeneration("KittyHawk", 11), "msfs2020");
  assert.equal(simGeneration("SunRise", 12), "msfs2024");
  // The version wins over the name; the name is the fallback.
  assert.equal(simGeneration("KittyHawk", 12), "msfs2024");
  assert.equal(simGeneration("SunRise", Number.NaN), "msfs2024");
  assert.equal(simGeneration("KittyHawk", Number.NaN), "msfs2020");
  assert.equal(simGeneration("Prepar3D", 5), undefined);
  assert.equal(simLabel("msfs2020"), "Microsoft Flight Simulator 2020");
  assert.equal(simLabel(undefined), "Microsoft Flight Simulator");
});
