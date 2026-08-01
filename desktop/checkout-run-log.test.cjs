const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildCheckoutRunRow,
  redactDebugHint,
  proxyHostOnly,
  appendCheckoutRun,
  readCheckoutRuns,
} = require("./checkout-run-log.cjs");

test("proxyHostOnly strips credentials", () => {
  assert.equal(proxyHostOnly("http://user:pass@1.2.3.4:8000"), "1.2.3.4:8000");
  assert.equal(proxyHostOnly("user:pass@host.example:3128"), "host.example:3128");
});

test("redactDebugHint strips urls cards and bearer", () => {
  const out = redactDebugHint(
    "fail https://evil.test/x Bearer abc.def.ghi card 4111111111111111 password=secret",
  );
  assert.ok(!/evil\.test/.test(out));
  assert.ok(!/4111111111111111/.test(out));
  assert.ok(!/abc\.def\.ghi/.test(out));
  assert.match(out, /\[url\]/);
  assert.match(out, /\[card\]/);
});

test("buildCheckoutRunRow classifies oos and threeds", () => {
  const oos = buildCheckoutRunRow(
    {
      ok: false,
      consumerCode: "oos",
      consumerLabel: "Out of stock",
      failedStep: "addToCart",
      checkoutStage: "cart",
      debugError: "out of stock hasSku=false",
      runId: "r1",
      taskId: "t1",
    },
    { store: "bandai", bandaiWatchSku: "N2890904001", label: "Gundam" },
  );
  assert.equal(oos.outcome, "oos");
  assert.equal(oos.sku, "N2890904001");
  assert.equal(oos.ok, false);
  assert.equal(oos.reachedPay, false);
  assert.equal(oos.lane, "oos");

  const threeds = buildCheckoutRunRow({
    ok: false,
    consumerCode: "error",
    consumerLabel: "Waiting for bank approval",
    checkoutStage: "threeds",
    failedStep: "threeds",
  });
  assert.equal(threeds.outcome, "threeds");
  assert.equal(threeds.reachedPay, true);
  assert.equal(threeds.lane, "pay");

  const heldPay = buildCheckoutRunRow({
    ok: false,
    consumerCode: "held_pay_retry",
    checkoutStage: "tokenize",
    paymentStatus: "ge_reload_only_no_bank",
    cartSn: "c1",
    heldPayRetry: true,
  });
  assert.equal(heldPay.reachedPay, true);
  assert.equal(heldPay.lane, "pay");
});

test("appendCheckoutRun persists and reads back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j1ms-checkout-log-"));
  appendCheckoutRun(
    dir,
    {
      ok: false,
      consumerCode: "declined",
      consumerLabel: "Payment declined",
      failedStep: "place_order",
      debugError: "declined do_not_honor",
      runId: "r2",
      taskId: "t2",
      proxy: "http://u:p@10.0.0.1:9000",
      at: 1,
    },
    { store: "bandai", label: "Test" },
  );
  const runs = readCheckoutRuns(dir, { limit: 10 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, "declined");
  assert.equal(runs[0].proxyHost, "10.0.0.1:9000");
  assert.ok(!String(runs[0].debugHint || "").includes("u:p"));
});
