const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDropFireAt,
  formatCountdown,
  staggerOffsets,
  countDropLanes,
  assessDropReady,
  planDropMode,
  formatLaneAfterAction,
  sydneyWallToUtcMs,
  sydneyNowParts,
} = require("./bandai-drop-ops.cjs");

test("parseDropFireAt HH:mm schedules future Sydney time", () => {
  const now = Date.UTC(2026, 6, 27, 0, 0, 0); // around morning AEST
  const r = parseDropFireAt("23:59", now);
  assert.equal(r.ok, true);
  assert.ok(r.atMs > now);
  assert.match(r.label, /23:59/);
});

test("parseDropFireAt rejects past absolute datetime", () => {
  const r = parseDropFireAt("2020-01-01T12:00", Date.now());
  assert.equal(r.ok, false);
});

test("sydneyWallToUtcMs round-trips wall parts", () => {
  const at = sydneyWallToUtcMs({
    year: 2026,
    month: 7,
    day: 27,
    hour: 13,
    minute: 0,
    second: 0,
  });
  assert.ok(at != null);
  const p = sydneyNowParts(at);
  assert.equal(p.hour, 13);
  assert.equal(p.minute, 0);
  assert.equal(p.day, 27);
});

test("staggerOffsets stays within 150ms", () => {
  assert.deepEqual(staggerOffsets(1), [0]);
  const s = staggerOffsets(4, { gapMs: 50, maxSpreadMs: 150 });
  assert.equal(s.length, 4);
  assert.equal(s[0], 0);
  assert.ok(s[s.length - 1] <= 150);
});

test("formatCountdown", () => {
  assert.equal(formatCountdown(5000), "5s");
  assert.equal(formatCountdown(65_000), "1m 05s");
});

test("countDropLanes sums Bandai checkout + ATC quantity", () => {
  const n = countDropLanes([
    { store: "bandai", bandaiMode: "checkout", enabled: true, quantity: 2 },
    { store: "bandai", bandaiMode: "atc", enabled: true, quantity: 3 },
    { store: "bandai", bandaiMode: "monitor", enabled: true, quantity: 5 },
    { store: "kmart", enabled: true, quantity: 3 },
    { store: "bandai", bandaiMode: "checkout", enabled: false, quantity: 9 },
  ]);
  assert.equal(n, 5);
});

test("assessDropReady blocks without engine / harvest", () => {
  const tasks = [
    {
      id: "t1",
      store: "bandai",
      bandaiMode: "checkout",
      enabled: true,
      quantity: 2,
      proxyGroupId: "px",
      accountAssign: "manual",
      accountId: "a1",
    },
  ];
  const accounts = [
    { id: "a1", storeId: "bandai", status: "ready", email: "a@b.com", password: "x", loginProvenAt: Date.now() },
  ];
  const proxyGroups = [{ id: "px", entries: ["h:1:u:p"] }];
  const bad = assessDropReady({
    engineRunning: false,
    harvest: { ready: 0, running: false, config: { desired: 2, proxyGroupId: "px" } },
    tasks,
    accounts,
    proxyGroups,
  });
  assert.equal(bad.ready, false);
  assert.ok(bad.checks.some((c) => c.id === "engine" && !c.ok));

  const good = assessDropReady({
    engineRunning: true,
    harvest: { ready: 2, running: true, config: { desired: 2, proxyGroupId: "px" } },
    tasks,
    accounts,
    proxyGroups,
  });
  assert.equal(good.ready, true);
  assert.equal(good.lanes, 2);
});

test("planDropMode sets desired = lanes", () => {
  const plan = planDropMode({
    tasks: [
      { id: "t1", store: "bandai", bandaiMode: "checkout", enabled: true, quantity: 2, proxyGroupId: "px" },
    ],
    harvest: { config: { proxyGroupId: "px", area: "au" } },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.desired, 2);
  assert.equal(plan.proxyGroupId, "px");
});

test("formatLaneAfterAction includes stage + tx", () => {
  const line = formatLaneAfterAction({
    ok: false,
    checkoutStage: "declined",
    areaItemNo: "NAI0868879AU",
    cartSn: 123,
    note: "AUTH_FAILED tx=171421200",
    atcWallMs: 25000,
    heldPayRetry: true,
  });
  assert.match(line, /declined/);
  assert.match(line, /tx=171421200/);
  assert.match(line, /Retry pay/);
});
