/**
 * Prove sticky-rotate / Bandai outer loop does NOT re-enter placeOrder after
 * a wire-touched issuer POST — and that a sibling job on the same profile is
 * unaffected (concurrent multi-task still allowed).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const runner = require("./job-runner.cjs");

function waitFinished() {
  return new Promise((resolve) => {
    runner.setFinishedHandler((result) => resolve(result));
  });
}

test("legacy rotate: RESPONSE_LOST latches — only one executeOnce", async () => {
  let calls = 0;
  runner.__setExecuteOnceForTests(async (job, opts) => {
    calls += 1;
    return {
      ok: false,
      taskId: job.task.id,
      runId: job.runId,
      failedStep: "ge_issuer",
      paymentStatus: "issuer_http_failed",
      chargeReqCount: 1,
      undiciAttempts: 1,
      responseLost: true,
      paymentAttempted: true,
      debugError: "timeout / ECONNRESET after issuer POST",
      consumerLabel: "Something went wrong",
      consumerCode: "error",
      attempt: opts.attemptLabel,
      at: Date.now(),
    };
  });

  runner.configure({ maxConcurrent: 2, detailedLogs: false });
  runner.start();
  const done = waitFinished();
  runner.enqueue({
    runId: "run_latch_legacy",
    task: {
      id: "task_disney_latch",
      store: "disney",
      profileId: "prof_1",
      placeOrder: true,
      label: "Disney latch",
    },
    profile: { id: "prof_1" },
    proxyRaw: "http://user-session-abc:pass@resi.example:8000",
    proxyEntries: [
      "http://user-session-abc:pass@resi.example:8000",
      "http://user-session-def:pass@resi.example:8000",
    ],
    proxyIndex: 0,
    placeOrder: true,
  });

  const result = await done;
  runner.stop();
  runner.__setExecuteOnceForTests(null);

  assert.equal(calls, 1, "must not sticky-rotate into a second placeOrder");
  assert.equal(result.paymentAttempted, true);
  assert.match(String(result.consumerLabel || ""), /Payment submitted|check bank|went wrong/i);
});

test("Bandai soft-retry: posts>=1 stops — sibling same profile still runs", async () => {
  const callsByTask = { a: 0, b: 0 };
  runner.__setExecuteOnceForTests(async (job) => {
    const tid = job.task.id;
    if (tid === "task_a") {
      callsByTask.a += 1;
      return {
        ok: false,
        taskId: tid,
        runId: job.runId,
        failedStep: "ge_payment",
        paymentStatus: "issuer_http_failed",
        chargeReqCount: 1,
        undiciAttempts: 1,
        responseLost: true,
        debugError: "RESPONSE_LOST posts=1 — check bank",
        note: "HTTP issuer POST in-flight/sent but response lost",
        at: Date.now(),
      };
    }
    callsByTask.b += 1;
    // EndOfSale → stop immediately (SoldOut would wait_restock 10s/loop).
    return {
      ok: false,
      taskId: tid,
      runId: job.runId,
      failedStep: "addToCart",
      debugError: "CouldNotAddToCartByEndOfSale cart=[]",
      lastSteps: [{ step: "addToCart", ok: false, note: "CouldNotAddToCartByEndOfSale cart=[]" }],
      at: Date.now(),
    };
  });

  runner.configure({ maxConcurrent: 2, detailedLogs: false });
  runner.start();

  const results = [];
  runner.setFinishedHandler((r) => {
    results.push(r);
  });

  runner.enqueue([
    {
      runId: "run_a",
      task: {
        id: "task_a",
        store: "bandai",
        bandaiMode: "checkout",
        profileId: "prof_shared",
        placeOrder: true,
        bandaiMaxLoops: 4,
      },
      profile: { id: "prof_shared" },
      proxyRaw: "http://user-session-a:pass@resi.example:8000",
      proxyEntries: ["http://user-session-a:pass@resi.example:8000"],
      placeOrder: true,
    },
    {
      runId: "run_b",
      task: {
        id: "task_b",
        store: "bandai",
        bandaiMode: "checkout",
        profileId: "prof_shared",
        placeOrder: true,
        bandaiMaxLoops: 4,
      },
      profile: { id: "prof_shared" },
      proxyRaw: "http://user-session-b:pass@resi.example:8000",
      proxyEntries: ["http://user-session-b:pass@resi.example:8000"],
      placeOrder: true,
    },
  ]);

  const t0 = Date.now();
  while (results.length < 2 && Date.now() - t0 < 10_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  runner.stop();
  runner.__setExecuteOnceForTests(null);

  assert.equal(results.length, 2, "both sibling tasks must finish");
  assert.equal(callsByTask.a, 1, "latched Bandai task must not soft-retry pay");
  assert.ok(callsByTask.b >= 1, "sibling on same profile must still execute");
  const a = results.find((r) => r.taskId === "task_a");
  assert.ok(a);
  assert.match(String(a.consumerLabel || a.debugError || ""), /Payment submitted|RESPONSE_LOST|check bank/i);
});
