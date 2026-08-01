/**
 * Checkout limits scoped to a task group.
 * - groupMax: max confirmed orders (orderNumber) for the whole group
 * - profileMax: max confirmed orders per profile within that group
 * Blank / 0 / null = unlimited. Race to pay is accepted; we count on confirm then stop.
 */

const { groupKey } = require("./task-group-style.cjs");

const LIMIT_REACHED = "Limit reached";
const LIMIT_REACHED_CODE = "limit_reached";

function normalizeMax(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(999, Math.floor(n));
}

function ensureStore(db) {
  if (!db.checkoutLimits || typeof db.checkoutLimits !== "object") {
    db.checkoutLimits = {};
  }
  return db.checkoutLimits;
}

function ensureBucket(db, taskGroup) {
  const key = groupKey(taskGroup);
  if (!key) return null;
  const store = ensureStore(db);
  if (!store[key] || typeof store[key] !== "object") {
    store[key] = {
      groupMax: null,
      groupUsed: 0,
      profileMax: null,
      byProfile: {},
    };
  }
  const b = store[key];
  if (!b.byProfile || typeof b.byProfile !== "object") b.byProfile = {};
  b.groupUsed = Math.max(0, Number(b.groupUsed) || 0);
  b.groupMax = normalizeMax(b.groupMax);
  b.profileMax = normalizeMax(b.profileMax);
  return b;
}

function profileEntry(bucket, profileId) {
  const pid = String(profileId || "").trim();
  if (!pid || !bucket) return null;
  if (!bucket.byProfile[pid] || typeof bucket.byProfile[pid] !== "object") {
    bucket.byProfile[pid] = { used: 0 };
  }
  const e = bucket.byProfile[pid];
  e.used = Math.max(0, Number(e.used) || 0);
  if (e.max != null) e.max = normalizeMax(e.max);
  return e;
}

function profileMaxFor(bucket, profileId) {
  if (!bucket) return null;
  const e = profileEntry(bucket, profileId);
  if (e?.max != null) return e.max;
  return bucket.profileMax;
}

/**
 * @returns {{ limited: boolean, reason: 'group'|'profile'|null, label: string|null, groupUsed: number, groupMax: number|null, profileUsed: number, profileMax: number|null }}
 */
function checkLimit(db, { taskGroup, profileId } = {}) {
  const bucket = ensureBucket(db, taskGroup);
  if (!bucket) {
    return {
      limited: false,
      reason: null,
      label: null,
      groupUsed: 0,
      groupMax: null,
      profileUsed: 0,
      profileMax: null,
    };
  }
  const groupMax = bucket.groupMax;
  const groupUsed = bucket.groupUsed;
  const pMax = profileMaxFor(bucket, profileId);
  const pEntry = profileEntry(bucket, profileId);
  const profileUsed = pEntry ? pEntry.used : 0;

  if (groupMax != null && groupUsed >= groupMax) {
    return {
      limited: true,
      reason: "group",
      label: LIMIT_REACHED,
      groupUsed,
      groupMax,
      profileUsed,
      profileMax: pMax,
    };
  }
  if (pMax != null && profileId && profileUsed >= pMax) {
    return {
      limited: true,
      reason: "profile",
      label: LIMIT_REACHED,
      groupUsed,
      groupMax,
      profileUsed,
      profileMax: pMax,
    };
  }
  return {
    limited: false,
    reason: null,
    label: null,
    groupUsed,
    groupMax,
    profileUsed,
    profileMax: pMax,
  };
}

/**
 * Record a confirmed order (orderNumber). Returns which scopes just hit their max.
 */
function recordConfirmedOrder(db, { taskGroup, profileId } = {}) {
  const bucket = ensureBucket(db, taskGroup);
  if (!bucket) {
    return { ok: false, error: "no_task_group", groupHit: false, profileHit: false };
  }
  bucket.groupUsed += 1;
  const pEntry = profileEntry(bucket, profileId);
  if (pEntry) pEntry.used += 1;

  const groupMax = bucket.groupMax;
  const pMax = profileMaxFor(bucket, profileId);
  const groupHit = groupMax != null && bucket.groupUsed >= groupMax;
  const profileHit = Boolean(pMax != null && profileId && pEntry && pEntry.used >= pMax);

  return {
    ok: true,
    groupHit,
    profileHit,
    groupUsed: bucket.groupUsed,
    groupMax,
    profileUsed: pEntry?.used ?? 0,
    profileMax: pMax,
  };
}

/**
 * Tasks in the same group that should be marked Limit reached after a confirm.
 * Does not include the winning taskId.
 */
function siblingIdsToStop(tasks, { taskGroup, profileId, excludeTaskId, groupHit, profileHit } = {}) {
  const key = groupKey(taskGroup);
  if (!key || (!groupHit && !profileHit)) return [];
  const pid = String(profileId || "").trim();
  const out = [];
  for (const t of tasks || []) {
    if (!t || t.id === excludeTaskId) continue;
    if (groupKey(t.taskGroup) !== key) continue;
    if (groupHit) {
      out.push(t.id);
      continue;
    }
    if (profileHit && pid && String(t.profileId || "") === pid) {
      out.push(t.id);
    }
  }
  return out;
}

function markLimitReached(tasks, ids) {
  const set = new Set(ids || []);
  let n = 0;
  for (const t of tasks || []) {
    if (!set.has(t.id)) continue;
    t.enabled = false;
    t.lastStatus = LIMIT_REACHED_CODE;
    t.lastLabel = LIMIT_REACHED;
    t.lastError = null;
    t.updatedAt = Date.now();
    n += 1;
  }
  return n;
}

function setGroupLimits(db, taskGroup, { groupMax, profileMax } = {}) {
  const bucket = ensureBucket(db, taskGroup);
  if (!bucket) return { ok: false, error: "task group required" };
  if (groupMax !== undefined) bucket.groupMax = normalizeMax(groupMax);
  if (profileMax !== undefined) bucket.profileMax = normalizeMax(profileMax);
  return { ok: true, bucket: publicBucket(bucket, taskGroup) };
}

function resetGroupUses(db, taskGroup) {
  const bucket = ensureBucket(db, taskGroup);
  if (!bucket) return { ok: false, error: "task group required" };
  bucket.groupUsed = 0;
  for (const pid of Object.keys(bucket.byProfile || {})) {
    bucket.byProfile[pid].used = 0;
  }
  return { ok: true, bucket: publicBucket(bucket, taskGroup) };
}

function publicBucket(bucket, taskGroup) {
  if (!bucket) return null;
  return {
    taskGroup: String(taskGroup || "").trim(),
    groupKey: groupKey(taskGroup),
    groupMax: bucket.groupMax,
    groupUsed: bucket.groupUsed || 0,
    profileMax: bucket.profileMax,
    byProfile: Object.fromEntries(
      Object.entries(bucket.byProfile || {}).map(([pid, e]) => [
        pid,
        { used: Number(e?.used) || 0, max: e?.max != null ? normalizeMax(e.max) : null },
      ]),
    ),
  };
}

function publicSnapshot(db) {
  const store = ensureStore(db);
  const out = {};
  for (const [key, bucket] of Object.entries(store)) {
    if (!bucket || typeof bucket !== "object") continue;
    out[key] = publicBucket(bucket, key);
  }
  return out;
}

function summarizeGroup(db, taskGroup) {
  const bucket = ensureBucket(db, taskGroup);
  if (!bucket) return null;
  return publicBucket(bucket, taskGroup);
}

module.exports = {
  LIMIT_REACHED,
  LIMIT_REACHED_CODE,
  groupKey,
  normalizeMax,
  ensureStore,
  ensureBucket,
  checkLimit,
  recordConfirmedOrder,
  siblingIdsToStop,
  markLimitReached,
  setGroupLimits,
  resetGroupUses,
  publicSnapshot,
  summarizeGroup,
};
