const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPokemonCentreHarvestAutoArm,
  isPcMonitorCheckoutJob,
} = require("./pokemoncentre-harvest-autoarm.cjs");

function makeJob(overrides = {}) {
  return {
    runId: overrides.runId,
    placeOrder: overrides.placeOrder !== false,
    task: {
      store: "pokemoncentre",
      pcMode: "monitor",
      pcCheckoutOnHit: true,
      pcLocale: "en-au",
      proxyGroupId: "mon-px",
      pcHarvestProxyGroupId: "checkout-px",
      ...overrides.task,
    },
  };
}

function fakeHarvest(initial = {}) {
  let running = Boolean(initial.running);
  let config = {
    proxyGroupId: initial.proxyGroupId ?? null,
    desired: initial.desired ?? 2,
    locale: initial.locale ?? "en-au",
    solveCaptcha: false,
  };
  let ready = Number(initial.ready) || 0;
  const calls = { start: 0, stop: 0, configure: 0 };
  return {
    calls,
    snapshot: () => ({ running, ready, config: { ...config } }),
    configure(patch = {}) {
      calls.configure += 1;
      if (patch.proxyGroupId != null) config.proxyGroupId = patch.proxyGroupId;
      if (patch.desired != null) config.desired = patch.desired;
      if (patch.locale != null) config.locale = patch.locale;
      if (patch.solveCaptcha != null) config.solveCaptcha = patch.solveCaptcha;
      return this.snapshot();
    },
    start(opts = {}) {
      calls.start += 1;
      running = true;
      if (opts.proxyGroupId) config.proxyGroupId = opts.proxyGroupId;
      if (opts.desired != null) config.desired = opts.desired;
      if (opts.locale) config.locale = opts.locale;
      return this.snapshot();
    },
    stop() {
      calls.stop += 1;
      running = false;
      return this.snapshot();
    },
  };
}

test("isPcMonitorCheckoutJob requires monitor + checkout on hit", () => {
  assert.equal(isPcMonitorCheckoutJob(makeJob()), true);
  assert.equal(
    isPcMonitorCheckoutJob(makeJob({ task: { pcCheckoutOnHit: false } })),
    false,
  );
  assert.equal(
    isPcMonitorCheckoutJob(makeJob({ task: { pcMode: "checkout" } })),
    false,
  );
  assert.equal(
    isPcMonitorCheckoutJob(makeJob({ task: { pcAutoHarvest: false } })),
    false,
  );
});

test("auto-arm starts harvest and stops when last ref releases", () => {
  const logs = [];
  const harvest = fakeHarvest({ desired: 0 });
  const auto = createPokemonCentreHarvestAutoArm({
    harvest,
    getEntries: () => ["host:1:u:p"],
    idFn: () => "run_fixed",
    log: (m) => logs.push(m),
  });

  const jobs = [makeJob()];
  const armed = auto.ensureForJobs(jobs);
  assert.equal(armed.ok, true);
  assert.equal(armed.armed, true);
  assert.equal(armed.weStarted, true);
  assert.equal(jobs[0].runId, "run_fixed");
  assert.equal(harvest.calls.start, 1);
  assert.equal(harvest.snapshot().running, true);
  assert.equal(harvest.snapshot().config.proxyGroupId, "checkout-px");
  assert.equal(harvest.snapshot().config.desired, 1);

  const rel = auto.release("run_fixed");
  assert.equal(rel.stopped, true);
  assert.equal(harvest.calls.stop, 1);
  assert.equal(harvest.snapshot().running, false);
  assert.ok(logs.some((l) => /auto-armed/i.test(l)));
  assert.ok(logs.some((l) => /auto-stopped/i.test(l)));
});

test("manual start prevents auto-stop", () => {
  const harvest = fakeHarvest({ running: true, proxyGroupId: "checkout-px", desired: 2 });
  const auto = createPokemonCentreHarvestAutoArm({
    harvest,
    getEntries: () => [],
    idFn: () => "run_a",
  });
  auto.markManualStart();
  const armed = auto.ensureForJobs([makeJob({ runId: "run_a" })]);
  assert.equal(armed.ok, true);
  assert.equal(armed.wasRunning, true);
  assert.equal(armed.weStarted, false);
  assert.equal(harvest.calls.start, 0);

  const rel = auto.release("run_a");
  assert.equal(rel.stopped, false);
  assert.equal(harvest.calls.stop, 0);
  assert.equal(harvest.snapshot().running, true);
});

test("missing proxy group skips arm", () => {
  const harvest = fakeHarvest();
  const auto = createPokemonCentreHarvestAutoArm({
    harvest,
    getEntries: () => [],
    idFn: () => "run_x",
  });
  const out = auto.ensureForJobs([
    makeJob({ task: { proxyGroupId: null, pcHarvestProxyGroupId: null } }),
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "missing_proxy_group");
  assert.equal(harvest.calls.start, 0);
  assert.equal(harvest.snapshot().running, false);
});
