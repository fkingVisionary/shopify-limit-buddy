/**
 * Task-group colors + duplicate helpers (profiles / tasks / groups).
 */

const GROUP_PALETTE = Object.freeze([
  "#3dd6c6",
  "#7c9cff",
  "#e6b450",
  "#f07178",
  "#c3e88d",
  "#c792ea",
  "#89ddff",
  "#ffcb6b",
  "#f78c6c",
  "#82aaff",
]);

function groupKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function hashGroupName(name) {
  const s = groupKey(name);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Stable color for a task group. Overrides map keys are lowercased names.
 * @param {string} name
 * @param {Record<string, string>} [overrides]
 */
function colorForTaskGroup(name, overrides = {}) {
  const key = groupKey(name);
  if (!key) return GROUP_PALETTE[0];
  const raw = overrides[key] || overrides[name];
  if (raw && /^#[0-9a-fA-F]{3,8}$/.test(String(raw).trim())) {
    return String(raw).trim();
  }
  return GROUP_PALETTE[hashGroupName(key) % GROUP_PALETTE.length];
}

function copyLabel(label, fallback = "Copy") {
  const base = String(label || "").trim() || fallback;
  if (/\(copy(?: \d+)?\)$/i.test(base)) {
    const m = base.match(/^(.*)\(copy(?: (\d+))?\)$/i);
    const stem = (m?.[1] || base).trim();
    const n = Number(m?.[2] || 1) + 1;
    return `${stem} (copy ${n})`.slice(0, 120);
  }
  return `${base} (copy)`.slice(0, 120);
}

/**
 * @param {object} profile
 * @param {(prefix: string) => string} idFn
 */
function duplicateProfileDraft(profile, idFn) {
  if (!profile || typeof profile !== "object") return null;
  const { id: _drop, createdAt: _c, updatedAt: _u, ...rest } = profile;
  return {
    ...rest,
    id: idFn("prof"),
    name: copyLabel(profile.name, "Profile"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * @param {object} task
 * @param {(prefix: string) => string} idFn
 * @param {{ taskGroup?: string }} [opts]
 */
function duplicateTaskDraft(task, idFn, opts = {}) {
  if (!task || typeof task !== "object") return null;
  const {
    id: _drop,
    createdAt: _c,
    updatedAt: _u,
    lastStatus: _ls,
    lastLabel: _ll,
    lastError: _le,
    lastOrderNumber: _lo,
    lastDropSummary: _ld,
    heldCart: _hc,
    ...rest
  } = task;
  const group =
    opts.taskGroup != null ? String(opts.taskGroup).trim().slice(0, 80) : rest.taskGroup || "";
  return {
    ...rest,
    id: idFn("task"),
    label: copyLabel(task.label, "Task"),
    taskGroup: group,
    lastStatus: "idle",
    lastLabel: null,
    lastError: null,
    lastOrderNumber: null,
    lastDropSummary: null,
    heldCart: undefined,
    enabled: task.enabled !== false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Clone every task in a group into a new group name.
 * @param {object[]} tasks
 * @param {string} sourceGroup
 * @param {string} [destGroup]
 * @param {(prefix: string) => string} idFn
 */
function duplicateTaskGroupDrafts(tasks, sourceGroup, destGroup, idFn) {
  const src = String(sourceGroup || "").trim();
  if (!src) return { ok: false, error: "task group required", tasks: [] };
  const dest = String(destGroup || "").trim() || copyLabel(src, "Group");
  const matched = (Array.isArray(tasks) ? tasks : []).filter(
    (t) => String(t.taskGroup || "").trim().toLowerCase() === src.toLowerCase(),
  );
  if (!matched.length) return { ok: false, error: `no tasks in group “${src}”`, tasks: [] };
  return {
    ok: true,
    sourceGroup: src,
    destGroup: dest.slice(0, 80),
    tasks: matched.map((t) => duplicateTaskDraft(t, idFn, { taskGroup: dest.slice(0, 80) })),
  };
}

module.exports = {
  GROUP_PALETTE,
  groupKey,
  colorForTaskGroup,
  copyLabel,
  duplicateProfileDraft,
  duplicateTaskDraft,
  duplicateTaskGroupDrafts,
};
