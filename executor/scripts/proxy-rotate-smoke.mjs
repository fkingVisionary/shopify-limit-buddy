// Quick unit checks for proxy-rotate helpers (no network).
import assert from "node:assert/strict";
import {
  isGraphqlAkamaiWall,
  proxyHostFromUrl,
  pickUnusedResiProxy,
} from "../proxy-rotate.js";

assert.equal(proxyHostFromUrl("http://u:p@45.42.47.34:12323"), "45.42.47.34");
assert.equal(proxyHostFromUrl("45.42.47.34:12323:u:p"), "45.42.47.34");

assert.equal(
  isGraphqlAkamaiWall({
    ok: false,
    steps: [{ step: "cart_get:all_profiles_denied", ok: false }],
  }),
  true,
);
assert.equal(
  isGraphqlAkamaiWall({
    ok: false,
    steps: [{ step: "cart_get", ok: false, note: "393b profile=all_denied AkamaiGHost" }],
  }),
  true,
);
assert.equal(isGraphqlAkamaiWall({ ok: true, steps: [] }), false);

const a = pickUnusedResiProxy(["45.42.47.235", "45.42.47.161"]);
assert.ok(a.proxy, "expected a free pool proxy");
assert.notEqual(proxyHostFromUrl(a.proxy), "45.42.47.235");
assert.notEqual(proxyHostFromUrl(a.proxy), "45.42.47.161");

console.log("proxy-rotate-smoke: ok");
