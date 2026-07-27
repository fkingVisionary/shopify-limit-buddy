import test from "node:test";
import assert from "node:assert/strict";
import {
  isPcHarvestFresh,
  PC_EDGE_TTL_MS,
} from "./pokemoncentre-harvest-fresh.js";

test("isPcHarvestFresh requires reese84 + datadome and TTL", () => {
  const now = Date.now();
  assert.equal(isPcHarvestFresh(null), false);
  assert.equal(
    isPcHarvestFresh({
      cookies: { reese84: "x".repeat(40), datadome: "ddcookie12" },
      edgeExpiresAt: now + PC_EDGE_TTL_MS,
    }),
    true,
  );
  assert.equal(
    isPcHarvestFresh({
      cookies: { reese84: "short", datadome: "dd" },
      edgeExpiresAt: now + PC_EDGE_TTL_MS,
    }),
    false,
  );
  assert.equal(
    isPcHarvestFresh({
      cookies: { reese84: "x".repeat(40), datadome: "ddcookie12" },
      edgeExpiresAt: now - 1,
    }),
    false,
  );
});

test("isPcHarvestFresh requireCaptcha", () => {
  const now = Date.now();
  const base = {
    cookies: { reese84: "x".repeat(40), datadome: "ddcookie12" },
    edgeExpiresAt: now + 60_000,
    captchaToken: "tok",
    captchaExpiresAt: now + 30_000,
  };
  assert.equal(isPcHarvestFresh(base, { requireCaptcha: true }), true);
  assert.equal(
    isPcHarvestFresh({ ...base, captchaToken: null }, { requireCaptcha: true }),
    false,
  );
});
