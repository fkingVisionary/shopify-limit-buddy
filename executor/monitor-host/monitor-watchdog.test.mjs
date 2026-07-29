// node --test executor/monitor-host/monitor-watchdog.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { computeMonitorStale, shouldWatchdogRestart } from "./monitor-watchdog.mjs";

test("healthy while polling recently", () => {
  const now = 1_000_000;
  const s = computeMonitorStale({
    running: true,
    lastPollAt: now - 10_000,
    intervalMs: 5_000,
    now,
  });
  assert.equal(s.healthy, true);
  assert.equal(shouldWatchdogRestart(s).restart, false);
});

test("stale poll triggers restart", () => {
  const now = 1_000_000;
  const s = computeMonitorStale({
    running: true,
    lastPollAt: now - 400_000,
    intervalMs: 5_000,
    now,
  });
  assert.equal(s.healthy, false);
  assert.equal(s.reason, "stale_poll");
  assert.equal(shouldWatchdogRestart(s).restart, true);
});

test("not_running triggers restart when expected", () => {
  const s = computeMonitorStale({
    running: false,
    lastPollAt: Date.now(),
    intervalMs: 5_000,
  });
  assert.equal(s.reason, "not_running");
  assert.equal(shouldWatchdogRestart(s).restart, true);
  assert.equal(shouldWatchdogRestart(s, { expectRunning: false }).restart, false);
});

test("grace before first poll uses startedAt", () => {
  const now = 1_000_000;
  const fresh = computeMonitorStale({
    running: true,
    lastPollAt: null,
    startedAt: now - 30_000,
    intervalMs: 5_000,
    now,
  });
  assert.equal(fresh.healthy, true);

  const hungBoot = computeMonitorStale({
    running: true,
    lastPollAt: null,
    startedAt: now - 400_000,
    intervalMs: 5_000,
    now,
  });
  assert.equal(hungBoot.healthy, false);
  assert.equal(hungBoot.reason, "stale_poll");
});
