// node --test executor/run-control.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginRun,
  endRun,
  cancelRun,
  throwIfAborted,
  isRunAborted,
} from "./run-control.js";

test("cancelRun aborts registered signal", () => {
  const ac = beginRun("run_cancel_test");
  assert.equal(ac.signal.aborted, false);
  const res = cancelRun("run_cancel_test");
  assert.equal(res.ok, true);
  assert.equal(res.found, true);
  assert.equal(ac.signal.aborted, true);
  assert.equal(isRunAborted(ac.signal), true);
  assert.throws(() => throwIfAborted(ac.signal), (e) => e?.code === "RUN_CANCELLED");
  endRun("run_cancel_test", ac);
  assert.deepEqual(cancelRun("run_cancel_test"), { ok: false, found: false });
});

test("cancelRun missing taskId", () => {
  assert.deepEqual(cancelRun(""), { ok: false, found: false });
  assert.deepEqual(cancelRun("nope"), { ok: false, found: false });
});
