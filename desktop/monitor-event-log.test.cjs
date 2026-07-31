// node --test desktop/monitor-event-log.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { appendMonitorEvent, readMonitorEvents } = require("./monitor-event-log.cjs");

test("append + read monitor event log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mon-log-"));
  assert.equal(
    appendMonitorEvent(dir, { kind: "restock", productId: "N1" }),
    true,
  );
  appendMonitorEvent(dir, { kind: "smart_action", productId: "N1", results: [] });
  const rows = readMonitorEvents(dir, { limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "restock");
  assert.equal(rows[1].kind, "smart_action");
});
