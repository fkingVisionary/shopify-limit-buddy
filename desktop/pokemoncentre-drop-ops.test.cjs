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
} = require("./pokemoncentre-drop-ops.cjs");

test("parseDropFireAt HH:mm schedules future Sydney time", () => {
  const now = Date.UTC(2026, 6, 27, 0, 0, 0);
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

test("countDropLanes sums PC checkout quantity", () => {
  const n = countDropLanes([
    { store: "pokemoncentre", pcMode: "checkout", enabled: true, quantity: 2 },
    { store: "pokemoncentre", pcMode: "monitor", enabled: true, quantity: 5 },
    { store: "kmart", enabled: true, quantity: 3 },
    { store: "pokemoncentre", pcMode: "checkout", enabled: false, quantity: 9 },
  ]);
  assert.equal(n, 2);
});

test("assessDropReady blocks without engine / harvest", () => {
  const tasks = [
    {
      id: "t1",
      store: "pokemoncentre",
      pcMode: "checkout",
      enabled: true,
      quantity: 2,
      proxyGroupId: "px",
    },
  ];
  const proxyGroups = [{ id: "px", entries: ["h:1:u:p"] }];
  const bad = assessDropReady({
    engineRunning: false,
    harvest: { ready: 0, running: false, config: { desired: 2, proxyGroupId: "px" } },
    tasks,
    proxyGroups,
  });
  assert.equal(bad.ready, false);
  assert.ok(bad.checks.some((c) => c.id === "engine" && !c.ok));

  const good = assessDropReady({
    engineRunning: true,
    harvest: { ready: 2, running: true, config: { desired: 2, proxyGroupId: "px" } },
    tasks,
    proxyGroups,
  });
  assert.equal(good.ready, true);
  assert.equal(good.lanes, 2);
});

test("planDropMode sets desired = lanes", () => {
  const plan = planDropMode({
    tasks: [
      {
        id: "t1",
        store: "pokemoncentre",
        pcMode: "checkout",
        enabled: true,
        quantity: 2,
        proxyGroupId: "px",
      },
    ],
    harvest: { config: { proxyGroupId: "px", locale: "en-au" } },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.desired, 2);
  assert.equal(plan.proxyGroupId, "px");
});

test("formatLaneAfterAction includes stage + harvest + tx", () => {
  const line = formatLaneAfterAction({
    ok: false,
    checkoutStage: "tokenize",
    failedStep: "ge_pay",
    harvestUsed: true,
    stickyRotates: 1,
    note: "AUTH_FAILED tx=170746422",
    elapsedMs: 42000,
  });
  assert.match(line, /tokenize/);
  assert.match(line, /harvest/);
  assert.match(line, /tx=170746422/);
});
