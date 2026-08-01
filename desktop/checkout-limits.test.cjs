const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkLimit,
  recordConfirmedOrder,
  siblingIdsToStop,
  markLimitReached,
  setGroupLimits,
  resetGroupUses,
  LIMIT_REACHED,
  LIMIT_REACHED_CODE,
} = require("./checkout-limits.cjs");

function db() {
  return { checkoutLimits: {} };
}

test("unlimited by default", () => {
  const d = db();
  const c = checkLimit(d, { taskGroup: "Drop", profileId: "prof_a" });
  assert.equal(c.limited, false);
});

test("profile max within group stops siblings of that profile only", () => {
  const d = db();
  setGroupLimits(d, "Drop", { groupMax: null, profileMax: 1 });
  const rec = recordConfirmedOrder(d, { taskGroup: "Drop", profileId: "prof_a" });
  assert.equal(rec.profileHit, true);
  assert.equal(rec.groupHit, false);

  const tasks = [
    { id: "t1", taskGroup: "Drop", profileId: "prof_a" },
    { id: "t2", taskGroup: "Drop", profileId: "prof_a" },
    { id: "t3", taskGroup: "Drop", profileId: "prof_b" },
    { id: "t4", taskGroup: "Other", profileId: "prof_a" },
  ];
  const ids = siblingIdsToStop(tasks, {
    taskGroup: "Drop",
    profileId: "prof_a",
    excludeTaskId: "t1",
    groupHit: rec.groupHit,
    profileHit: rec.profileHit,
  });
  assert.deepEqual(ids.sort(), ["t2"]);
});

test("group max stops all other tasks in group", () => {
  const d = db();
  setGroupLimits(d, "Drop", { groupMax: 1, profileMax: 5 });
  const rec = recordConfirmedOrder(d, { taskGroup: "Drop", profileId: "prof_a" });
  assert.equal(rec.groupHit, true);

  const tasks = [
    { id: "t1", taskGroup: "Drop", profileId: "prof_a" },
    { id: "t2", taskGroup: "Drop", profileId: "prof_b" },
    { id: "t3", taskGroup: "Other", profileId: "prof_a" },
  ];
  const ids = siblingIdsToStop(tasks, {
    taskGroup: "Drop",
    profileId: "prof_a",
    excludeTaskId: "t1",
    groupHit: true,
    profileHit: true,
  });
  assert.deepEqual(ids.sort(), ["t2"]);
});

test("checkLimit blocks enqueue after profile max", () => {
  const d = db();
  setGroupLimits(d, "Drop", { profileMax: 1 });
  recordConfirmedOrder(d, { taskGroup: "Drop", profileId: "prof_a" });
  const blocked = checkLimit(d, { taskGroup: "Drop", profileId: "prof_a" });
  assert.equal(blocked.limited, true);
  assert.equal(blocked.reason, "profile");
  const other = checkLimit(d, { taskGroup: "Drop", profileId: "prof_b" });
  assert.equal(other.limited, false);
});

test("reset clears used counts", () => {
  const d = db();
  setGroupLimits(d, "Drop", { groupMax: 2, profileMax: 1 });
  recordConfirmedOrder(d, { taskGroup: "Drop", profileId: "prof_a" });
  resetGroupUses(d, "Drop");
  const c = checkLimit(d, { taskGroup: "Drop", profileId: "prof_a" });
  assert.equal(c.limited, false);
  assert.equal(c.groupUsed, 0);
});

test("markLimitReached sets status", () => {
  const tasks = [
    { id: "t1", enabled: true, lastStatus: "queued" },
    { id: "t2", enabled: true, lastStatus: "running" },
  ];
  markLimitReached(tasks, ["t2"]);
  assert.equal(tasks[1].enabled, false);
  assert.equal(tasks[1].lastStatus, LIMIT_REACHED_CODE);
  assert.equal(tasks[1].lastLabel, LIMIT_REACHED);
  assert.equal(tasks[0].enabled, true);
});

test("ungrouped tasks ignore limits", () => {
  const d = db();
  setGroupLimits(d, "Drop", { groupMax: 1 });
  recordConfirmedOrder(d, { taskGroup: "Drop", profileId: "p" });
  const c = checkLimit(d, { taskGroup: "", profileId: "p" });
  assert.equal(c.limited, false);
});
