// node --test executor/chrome-pay-stealth.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { installChromePayStealth } from "./chrome-pay-stealth.js";

test("installChromePayStealth no-ops cleanly without context", async () => {
  const r = await installChromePayStealth(null);
  assert.equal(r.ok, false);
});

test("installChromePayStealth is opt-in (default skipped)", async () => {
  const prev = process.env.PAY_CHROME_STEALTH;
  delete process.env.PAY_CHROME_STEALTH;
  try {
    const r = await installChromePayStealth({ addInitScript: async () => {} });
    assert.equal(r.skipped, true);
  } finally {
    if (prev == null) delete process.env.PAY_CHROME_STEALTH;
    else process.env.PAY_CHROME_STEALTH = prev;
  }
});

test("installChromePayStealth runs when PAY_CHROME_STEALTH=1", async () => {
  const prev = process.env.PAY_CHROME_STEALTH;
  process.env.PAY_CHROME_STEALTH = "1";
  let called = false;
  try {
    const r = await installChromePayStealth({
      addInitScript: async () => {
        called = true;
      },
    });
    assert.equal(r.ok, true);
    assert.equal(called, true);
  } finally {
    if (prev == null) delete process.env.PAY_CHROME_STEALTH;
    else process.env.PAY_CHROME_STEALTH = prev;
  }
});
