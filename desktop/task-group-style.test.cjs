// node --test desktop/task-group-style.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  colorForTaskGroup,
  copyLabel,
  duplicateProfileDraft,
  duplicateTaskDraft,
  duplicateTaskGroupDrafts,
} = require("./task-group-style.cjs");

test("colorForTaskGroup is stable + honors overrides", () => {
  const a = colorForTaskGroup("Drop A");
  const b = colorForTaskGroup("drop a");
  assert.equal(a, b);
  assert.match(a, /^#/);
  assert.equal(colorForTaskGroup("Drop A", { "drop a": "#ff00aa" }), "#ff00aa");
});

test("copyLabel increments", () => {
  assert.equal(copyLabel("Drop A"), "Drop A (copy)");
  assert.equal(copyLabel("Drop A (copy)"), "Drop A (copy 2)");
  assert.equal(copyLabel("Drop A (copy 2)"), "Drop A (copy 3)");
});

test("duplicate profile + task + group", () => {
  let n = 0;
  const idFn = (p) => `${p}_${++n}`;
  const prof = duplicateProfileDraft(
    { id: "prof_1", name: "Alex", email: "a@b.com", city: "Sydney" },
    idFn,
  );
  assert.equal(prof.id, "prof_1");
  assert.equal(prof.name, "Alex (copy)");
  assert.equal(prof.email, "a@b.com");

  const task = duplicateTaskDraft(
    {
      id: "task_1",
      label: "Gundam",
      taskGroup: "Drop A",
      store: "bandai",
      lastStatus: "confirmed",
      lastOrderNumber: "X",
      heldCart: { cartSn: "1" },
    },
    idFn,
  );
  assert.equal(task.label, "Gundam (copy)");
  assert.equal(task.taskGroup, "Drop A");
  assert.equal(task.lastStatus, "idle");
  assert.equal(task.lastOrderNumber, null);
  assert.equal(task.heldCart, undefined);

  const group = duplicateTaskGroupDrafts(
    [
      { id: "t1", label: "A", taskGroup: "Drop A", store: "bandai" },
      { id: "t2", label: "B", taskGroup: "Drop A", store: "bandai" },
      { id: "t3", label: "C", taskGroup: "Other", store: "bandai" },
    ],
    "Drop A",
    null,
    idFn,
  );
  assert.equal(group.ok, true);
  assert.equal(group.destGroup, "Drop A (copy)");
  assert.equal(group.tasks.length, 2);
  assert.ok(group.tasks.every((t) => t.taskGroup === "Drop A (copy)"));
});
