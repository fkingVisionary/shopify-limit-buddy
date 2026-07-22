import assert from "node:assert/strict";
import {
  normalizeBandaiArea,
  resolveBandaiArea,
  bandaiBaseFor,
  BANDAI_REGIONS,
} from "./bandai-session.js";

assert.equal(normalizeBandaiArea("AU"), "au");
assert.equal(normalizeBandaiArea("us"), "us");
assert.equal(normalizeBandaiArea("jp"), null);
assert.ok(BANDAI_REGIONS.includes("fr"));

assert.equal(resolveBandaiArea({ pdpUrl: "https://p-bandai.com/us/item/X" }), "us");
assert.equal(resolveBandaiArea({ bandaiArea: "NZ" }), "nz");
assert.equal(resolveBandaiArea({}), "au");
assert.equal(bandaiBaseFor("sg"), "https://p-bandai.com/sg");

console.log("bandai-region.test.mjs ok");
