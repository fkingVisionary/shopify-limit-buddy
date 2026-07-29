// Smart Actions engine — runs in Electron main process while the app is open.
// Cybersole-style: 1 Trigger → N Filters (AND) → N Actions (ordered).
// Triggers: Bandai global monitor, Quick Task, Schedule (timer).
// Actions can Wait, Update SKU/URL, and target tasks by group — not only ones just created.

const { matchAllFilters } = require("./smart-actions-keywords.cjs");
const {
  normalizeQuickTaskPreset,
  buildQuickTaskDraft,
  targetFromMonitorHit,
  parseBandaiProductInput,
  contextFromMonitorHit,
} = require("./quick-task.cjs");

const OUTCOMES = Object.freeze({
  FILTERED: "Filtered",
  FAILED: "Failed",
  COMPLETED: "Completed",
});

const TRIGGERS = Object.freeze({
  PRODUCT_MONITOR: "product_monitor",
  QUICKTASK: "quicktask",
  SCHEDULE: "schedule",
});

const ACTION_TYPES = Object.freeze({
  CREATE_TASKS: "create_tasks",
  START_TASKS: "start_tasks",
  STOP_TASKS: "stop_tasks",
  DELETE_TASKS: "delete_tasks",
  UPDATE_TASKS: "update_tasks",
  WAIT: "wait",
  NOTIFY_DISCORD: "notify_discord",
  START_HARVESTER: "start_harvester",
  STOP_HARVESTER: "stop_harvester",
});

const TARGET_SCOPES = Object.freeze({
  CREATED: "created",
  GROUP: "group",
  ALL: "all",
});

const MAX_WAIT_MS = 30 * 60 * 1000;

function blankAction(type = ACTION_TYPES.CREATE_TASKS) {
  if (type === ACTION_TYPES.CREATE_TASKS) {
    return {
      type,
      config: {
        usePreset: true,
        store: "bandai",
        bandaiMode: "checkout",
        qty: 1,
        quantity: 1,
        placeOrder: true,
        labelTemplate: "{{title}}",
        count: 1,
        taskGroup: "",
      },
    };
  }
  if (type === ACTION_TYPES.NOTIFY_DISCORD) {
    return {
      type,
      config: {
        message: "Smart Action: {{title}} ({{sku}})",
      },
    };
  }
  if (type === ACTION_TYPES.WAIT) {
    return { type, config: { delaySec: 60 } };
  }
  if (type === ACTION_TYPES.UPDATE_TASKS) {
    return {
      type,
      config: {
        target: { scope: TARGET_SCOPES.CREATED, taskGroup: "" },
        product: "{{sku}}",
        pdpUrl: "",
        qty: null,
        labelTemplate: "",
      },
    };
  }
  if (
    type === ACTION_TYPES.START_TASKS ||
    type === ACTION_TYPES.STOP_TASKS ||
    type === ACTION_TYPES.DELETE_TASKS
  ) {
    return {
      type,
      config: {
        target: { scope: TARGET_SCOPES.CREATED, taskGroup: "" },
      },
    };
  }
  if (type === ACTION_TYPES.START_HARVESTER) {
    return { type, config: {} };
  }
  if (type === ACTION_TYPES.STOP_HARVESTER) {
    return { type, config: {} };
  }
  return { type, config: {} };
}

function normalizeTarget(raw = {}, fallbackScope = TARGET_SCOPES.CREATED) {
  const scopeRaw = String(raw.scope || fallbackScope).toLowerCase();
  const scope = Object.values(TARGET_SCOPES).includes(scopeRaw)
    ? scopeRaw
    : fallbackScope;
  return {
    scope,
    taskGroup: String(raw.taskGroup || raw.group || "").trim(),
    store: String(raw.store || "").trim().toLowerCase(),
  };
}

function normalizeTrigger(raw = {}) {
  const type = String(raw?.type || TRIGGERS.PRODUCT_MONITOR).toLowerCase();
  if (type === "quicktask" || type === "quick_task" || type === "qt") {
    return { type: TRIGGERS.QUICKTASK };
  }
  if (type === "schedule" || type === "timer" || type === "cron") {
    const at = String(raw.at || raw.time || "00:00").trim();
    const m = at.match(/^(\d{1,2}):(\d{2})$/);
    const hh = m ? Math.min(23, Math.max(0, Number(m[1]))) : 0;
    const mm = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
    const repeat = String(raw.repeat || "daily").toLowerCase() === "once" ? "once" : "daily";
    return {
      type: TRIGGERS.SCHEDULE,
      at: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      tz: String(raw.tz || "Australia/Sydney").trim() || "Australia/Sydney",
      repeat,
    };
  }
  return { type: TRIGGERS.PRODUCT_MONITOR };
}

function normalizeFilter(raw = {}) {
  return {
    field: String(raw.field || "title").toLowerCase(),
    op: String(raw.op || "matches").toLowerCase(),
    value: String(raw.value ?? ""),
  };
}

function normalizeAction(raw = {}) {
  const type = String(raw.type || ACTION_TYPES.CREATE_TASKS).toLowerCase();
  const allowed = Object.values(ACTION_TYPES);
  const t = allowed.includes(type) ? type : ACTION_TYPES.CREATE_TASKS;
  const base = blankAction(t);
  const cfg = raw.config && typeof raw.config === "object" ? { ...base.config, ...raw.config } : { ...base.config };
  if (cfg.target) cfg.target = normalizeTarget(cfg.target, base.config?.target?.scope || TARGET_SCOPES.CREATED);
  return { type: t, config: cfg };
}

/**
 * Normalize / validate a Smart Action document for persistence.
 */
function normalizeSmartAction(raw = {}, idFn) {
  const now = Date.now();
  const id = raw.id || (idFn ? idFn("sa") : `sa_${now}`);
  const actions = Array.isArray(raw.actions) ? raw.actions.map(normalizeAction) : [];
  const filters = Array.isArray(raw.filters) ? raw.filters.map(normalizeFilter) : [];
  return {
    id,
    name: String(raw.name || "Untitled action").slice(0, 120),
    enabled: raw.enabled !== false,
    runOnce: raw.runOnce === true,
    runIntervalMs: Math.max(0, Number(raw.runIntervalMs) || 0),
    notifications: raw.notifications !== false,
    trigger: normalizeTrigger(raw.trigger),
    filters,
    actions: actions.length
      ? actions
      : [blankAction(ACTION_TYPES.CREATE_TASKS), blankAction(ACTION_TYPES.START_TASKS)],
    lastResult: raw.lastResult || null,
    lastRunAt: raw.lastRunAt || null,
    lastLog: Array.isArray(raw.lastLog) ? raw.lastLog.slice(-80) : [],
    firedOnce: raw.firedOnce === true,
    lastScheduleKey: raw.lastScheduleKey || null,
    // Preset catalog provenance (template × SKU matrix)
    catalogKey: raw.catalogKey ? String(raw.catalogKey) : null,
    catalogTemplateId: raw.catalogTemplateId ? String(raw.catalogTemplateId) : null,
    catalogRowId: raw.catalogRowId ? String(raw.catalogRowId) : null,
    createdAt: raw.createdAt || now,
    updatedAt: now,
  };
}

function applyTemplate(str, ctx) {
  return String(str || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = ctx[key];
    return v == null ? "" : String(v);
  });
}

function clockPartsInTz(tz, atMs = Date.now()) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(atMs)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  // en-CA can yield hour "24" at midnight in some engines — normalize
  let hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    hour: Number(hour),
    minute: Number(parts.minute),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} deps
 * @param {() => object[]} deps.getActions
 * @param {(actions: object[]) => void} deps.saveActions
 * @param {() => object} deps.getSettings
 * @param {() => object[]} [deps.getTasks]
 * @param {(task: object) => object} deps.upsertTask
 * @param {(ids: string[], opts?: object) => object} deps.startTasks
 * @param {(ids: string[]) => void} [deps.deleteTasks]
 * @param {(ids: string[]) => void} [deps.stopTasks]
 * @param {(ids: string[], patch: object) => object} [deps.patchTasks]
 * @param {(opts?: object) => Promise<object>|object} [deps.startHarvester]
 * @param {() => object} [deps.stopHarvester]
 * @param {(payload: object) => Promise<object>} [deps.notifyDiscord]
 * @param {(evt: object) => void} [deps.emit]
 * @param {() => string} [deps.idFn]
 */
function createSmartActionsEngine(deps = {}) {
  const running = new Set(); // sa ids currently executing

  function list() {
    return (deps.getActions?.() || []).map((a) => ({ ...a }));
  }

  function persist(next) {
    deps.saveActions?.(next);
  }

  function patchAction(id, patch) {
    const actions = deps.getActions?.() || [];
    const i = actions.findIndex((a) => a.id === id);
    if (i < 0) return null;
    actions[i] = { ...actions[i], ...patch, updatedAt: Date.now() };
    persist(actions);
    return actions[i];
  }

  function appendLog(sa, entry) {
    const row = {
      at: Date.now(),
      step: entry.step || "run",
      level: entry.level || "info",
      message: String(entry.message || "").slice(0, 400),
    };
    const lastLog = [...(sa.lastLog || []), row].slice(-80);
    return patchAction(sa.id, { lastLog }) || { ...sa, lastLog };
  }

  function finish(sa, outcome, message) {
    const patch = {
      lastResult: outcome,
      ...(outcome === OUTCOMES.COMPLETED
        ? {
            lastRunAt: Date.now(),
            ...(sa.runOnce ? { firedOnce: true } : {}),
          }
        : outcome === OUTCOMES.FAILED
          ? { lastRunAt: Date.now() }
          : {}),
    };
    const patched = patchAction(sa.id, patch);
    const cur = patched || sa;
    appendLog(cur, {
      step: "result",
      level: outcome === OUTCOMES.FAILED ? "err" : outcome === OUTCOMES.FILTERED ? "warn" : "ok",
      message: message || outcome,
    });
    deps.emit?.({
      type: "smartAction",
      phase: "done",
      actionId: sa.id,
      outcome,
      message: message || outcome,
    });
    return { ok: outcome === OUTCOMES.COMPLETED, outcome, actionId: sa.id };
  }

  function shouldSkipDebounce(sa, now = Date.now()) {
    if (sa.runOnce && sa.firedOnce) return { skip: true, reason: "run_once_done" };
    const interval = Math.max(0, Number(sa.runIntervalMs) || 0);
    if (interval > 0 && sa.lastRunAt && now - sa.lastRunAt < interval) {
      return { skip: true, reason: "run_interval", remainingMs: interval - (sa.lastRunAt ? now - sa.lastRunAt : 0) };
    }
    return { skip: false };
  }

  function resolveTargetIds(config, runCtx) {
    const target = normalizeTarget(config?.target || {}, TARGET_SCOPES.CREATED);
    if (target.scope === TARGET_SCOPES.CREATED) {
      const ids = runCtx.createdTaskIds.length
        ? [...runCtx.createdTaskIds]
        : [...(runCtx.touchedTaskIds || [])];
      return { ids, target, label: `created (${ids.length})` };
    }

    const tasks = deps.getTasks?.() || [];
    let filtered = tasks.filter((t) => t && t.enabled !== false);
    if (target.scope === TARGET_SCOPES.GROUP) {
      const g = target.taskGroup.toLowerCase();
      if (!g) return { ids: [], target, label: "group (empty name)", error: "Task group name required" };
      filtered = filtered.filter((t) => String(t.taskGroup || "").trim().toLowerCase() === g);
    }
    if (target.store) {
      filtered = filtered.filter((t) => String(t.store || "").toLowerCase() === target.store);
    }
    const ids = filtered.map((t) => t.id).filter(Boolean);
    for (const id of ids) {
      if (!runCtx.touchedTaskIds.includes(id)) runCtx.touchedTaskIds.push(id);
    }
    const label =
      target.scope === TARGET_SCOPES.GROUP
        ? `group "${target.taskGroup}" (${ids.length})`
        : `all (${ids.length})`;
    return { ids, target, label };
  }

  async function runActions(sa, ctx) {
    const runCtx = {
      ...ctx,
      createdTaskIds: [],
      touchedTaskIds: [],
    };
    const steps = Array.isArray(sa.actions) ? sa.actions : [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const type = step.type;
      try {
        if (type === ACTION_TYPES.WAIT) {
          // Prefer explicit delayMs (tests / advanced); else delaySec from UI.
          const hasMs =
            step.config?.delayMs != null && step.config.delayMs !== "";
          const msRaw = hasMs
            ? Number(step.config.delayMs) || 0
            : (Number(step.config?.delaySec) || 0) * 1000;
          const ms = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(msRaw)));
          appendLog(sa, {
            step: `action:${i}:wait`,
            level: "info",
            message: `Waiting ${Math.round(ms / 1000)}s…`,
          });
          if (ms > 0) await sleep(ms);
          continue;
        }

        if (type === ACTION_TYPES.CREATE_TASKS) {
          const created = await actionCreateTasks(sa, step.config || {}, runCtx);
          appendLog(sa, {
            step: `action:${i}:create_tasks`,
            level: "ok",
            message: `Created ${created.length} task(s): ${created.join(", ") || "—"}`,
          });
          continue;
        }

        if (type === ACTION_TYPES.UPDATE_TASKS) {
          const { ids, label, error } = resolveTargetIds(step.config || {}, runCtx);
          if (error) {
            appendLog(sa, { step: `action:${i}:update_tasks`, level: "err", message: error });
            return finish(sa, OUTCOMES.FAILED, error);
          }
          if (!ids.length) {
            appendLog(sa, {
              step: `action:${i}:update_tasks`,
              level: "warn",
              message: `No tasks to update (${label})`,
            });
            continue;
          }
          const patch = buildUpdatePatch(step.config || {}, runCtx);
          if (!Object.keys(patch).length) {
            appendLog(sa, {
              step: `action:${i}:update_tasks`,
              level: "warn",
              message: "Update Tasks: nothing to patch (set product / URL / qty)",
            });
            continue;
          }
          const res = deps.patchTasks?.(ids, patch) || { ok: false, error: "patchTasks unavailable" };
          if (res.ok === false) {
            appendLog(sa, {
              step: `action:${i}:update_tasks`,
              level: "err",
              message: res.error || "update failed",
            });
            return finish(sa, OUTCOMES.FAILED, res.error || "Update Tasks failed");
          }
          appendLog(sa, {
            step: `action:${i}:update_tasks`,
            level: "ok",
            message: `Updated ${res.updated ?? ids.length} task(s) · ${label}`,
          });
          continue;
        }

        if (type === ACTION_TYPES.START_TASKS) {
          const { ids, label, error } = resolveTargetIds(step.config || {}, runCtx);
          if (error) {
            appendLog(sa, { step: `action:${i}:start_tasks`, level: "err", message: error });
            return finish(sa, OUTCOMES.FAILED, error);
          }
          if (!ids.length) {
            appendLog(sa, {
              step: `action:${i}:start_tasks`,
              level: "warn",
              message: `No tasks to start (${label})`,
            });
            continue;
          }
          const res = deps.startTasks?.(ids, {}) || { ok: false, error: "startTasks unavailable" };
          if (!res.ok) {
            appendLog(sa, {
              step: `action:${i}:start_tasks`,
              level: "err",
              message: res.error || "start failed",
            });
            return finish(sa, OUTCOMES.FAILED, res.error || "Start Tasks failed");
          }
          appendLog(sa, {
            step: `action:${i}:start_tasks`,
            level: "ok",
            message: `Started ${res.enqueued ?? ids.length} job(s) · ${label}`,
          });
          continue;
        }

        if (type === ACTION_TYPES.STOP_TASKS) {
          const { ids, label, error } = resolveTargetIds(step.config || {}, runCtx);
          if (error) {
            appendLog(sa, { step: `action:${i}:stop_tasks`, level: "err", message: error });
            return finish(sa, OUTCOMES.FAILED, error);
          }
          deps.stopTasks?.(ids);
          appendLog(sa, {
            step: `action:${i}:stop_tasks`,
            level: "ok",
            message: `Stop signalled for ${ids.length} task(s) · ${label}`,
          });
          continue;
        }

        if (type === ACTION_TYPES.DELETE_TASKS) {
          const { ids, label, error } = resolveTargetIds(step.config || {}, runCtx);
          if (error) {
            appendLog(sa, { step: `action:${i}:delete_tasks`, level: "err", message: error });
            return finish(sa, OUTCOMES.FAILED, error);
          }
          deps.deleteTasks?.(ids);
          appendLog(sa, {
            step: `action:${i}:delete_tasks`,
            level: "ok",
            message: `Deleted ${ids.length} task(s) · ${label}`,
          });
          continue;
        }

        if (type === ACTION_TYPES.START_HARVESTER) {
          const res = await deps.startHarvester?.(step.config || {});
          if (res && res.ok === false) {
            appendLog(sa, {
              step: `action:${i}:start_harvester`,
              level: "err",
              message: res.error || "harvester start failed",
            });
            return finish(sa, OUTCOMES.FAILED, res.error || "Start Harvester failed");
          }
          appendLog(sa, {
            step: `action:${i}:start_harvester`,
            level: "ok",
            message: "Bandai harvester started",
          });
          continue;
        }

        if (type === ACTION_TYPES.STOP_HARVESTER) {
          deps.stopHarvester?.();
          appendLog(sa, {
            step: `action:${i}:stop_harvester`,
            level: "ok",
            message: "Bandai harvester stopped",
          });
          continue;
        }

        if (type === ACTION_TYPES.NOTIFY_DISCORD) {
          if (sa.notifications === false) {
            appendLog(sa, {
              step: `action:${i}:notify_discord`,
              level: "info",
              message: "Skipped (notifications off)",
            });
            continue;
          }
          const tmpl =
            step.config?.message ||
            `Smart Action **${sa.name}**: {{title}} (\`{{sku}}\`) — {{reason}}`;
          const content = applyTemplate(tmpl, runCtx);
          const res = await deps.notifyDiscord?.({
            content,
            username: "J1m Smart Actions",
          });
          if (res && res.ok === false && !res.skipped) {
            appendLog(sa, {
              step: `action:${i}:notify_discord`,
              level: "err",
              message: res.error || "discord failed",
            });
          } else {
            appendLog(sa, {
              step: `action:${i}:notify_discord`,
              level: res?.skipped ? "warn" : "ok",
              message: res?.skipped ? "No webhook configured" : "Discord notified",
            });
          }
          continue;
        }

        appendLog(sa, {
          step: `action:${i}`,
          level: "warn",
          message: `Unknown action type: ${type}`,
        });
      } catch (e) {
        appendLog(sa, {
          step: `action:${i}:${type}`,
          level: "err",
          message: e?.message || String(e),
        });
        return finish(sa, OUTCOMES.FAILED, e?.message || String(e));
      }
    }
    return finish(sa, OUTCOMES.COMPLETED, "All actions completed");
  }

  function buildUpdatePatch(config, runCtx) {
    const patch = {};
    const productRaw = applyTemplate(config.product || "", runCtx).trim();
    const urlRaw = applyTemplate(config.pdpUrl || config.url || "", runCtx).trim();
    const input = urlRaw || productRaw;
    if (input) {
      const parsed = parseBandaiProductInput(input, { area: "au" });
      if (parsed.ok) {
        if (parsed.pdpUrl) patch.pdpUrl = parsed.pdpUrl;
        if (parsed.productId && !/^NAI/i.test(parsed.productId)) {
          patch.pdpUrl =
            patch.pdpUrl || `https://p-bandai.com/${parsed.area || "au"}/item/${parsed.productId}`;
          patch.bandaiWatchSku = parsed.productId;
        }
        if (parsed.areaItemNo) patch.bandaiAreaItemNo = parsed.areaItemNo;
        else if (parsed.productId && /^NAI/i.test(parsed.productId)) {
          patch.bandaiAreaItemNo = parsed.productId;
          patch.bandaiWatchSku = parsed.productId;
        } else if (parsed.productId) {
          patch.bandaiWatchSku = parsed.productId;
        }
      } else if (/^https?:\/\//i.test(input)) {
        patch.pdpUrl = input;
      }
    }
    if (config.qty != null && config.qty !== "" && Number.isFinite(Number(config.qty))) {
      patch.qty = Math.max(1, Math.min(20, Number(config.qty)));
    }
    const labelT = String(config.labelTemplate || "").trim();
    if (labelT) patch.label = applyTemplate(labelT, runCtx).slice(0, 120);
    const group = String(config.taskGroup || "").trim();
    if (group) patch.taskGroup = group.slice(0, 80);
    return patch;
  }

  async function actionCreateTasks(sa, config, runCtx) {
    const settings = deps.getSettings?.() || {};
    const preset = normalizeQuickTaskPreset(settings.quickTaskPreset || {});
    const usePreset = config.usePreset !== false;
    const count = Math.max(1, Math.min(20, Number(config.count) || 1));
    const mode = String(config.bandaiMode || (usePreset ? preset.bandaiMode : "checkout"));
    const store = String(config.store || (usePreset ? preset.store : "bandai"));
    const taskGroup = String(config.taskGroup || "").trim().slice(0, 80);

    let target;
    if (runCtx.hit) {
      target = targetFromMonitorHit(runCtx.hit, { area: "au" });
    } else if (runCtx.sku || runCtx.productId || runCtx.url) {
      target = parseBandaiProductInput(runCtx.url || runCtx.sku || runCtx.productId, {
        area: "au",
      });
      if (target.ok && runCtx.title) target.title = runCtx.title;
      if (runCtx.areaItemNo) target.areaItemNo = runCtx.areaItemNo;
    } else {
      throw new Error("Create Tasks: no product context (use Schedule + Update, or Monitor/QT)");
    }
    if (!target.ok) throw new Error(target.error || "Create Tasks: bad product");

    const label = applyTemplate(
      config.labelTemplate || "{{title}}",
      { ...runCtx, title: runCtx.title || target.title || target.productId },
    );

    const mergedPreset = {
      ...preset,
      store,
      bandaiMode: mode,
      bandaiCheckoutMode: config.bandaiCheckoutMode || preset.bandaiCheckoutMode,
      qty: config.qty != null ? Number(config.qty) : preset.qty,
      quantity: config.quantity != null ? Number(config.quantity) : preset.quantity,
      placeOrder: config.placeOrder != null ? config.placeOrder !== false : preset.placeOrder,
      profileId: config.profileId || (usePreset ? preset.profileId : null),
      proxyGroupId: config.proxyGroupId || (usePreset ? preset.proxyGroupId : null),
      accountAssign: config.accountAssign || preset.accountAssign,
      accountId: config.accountId || preset.accountId,
      startAfterCreate: false,
    };

    const ids = [];
    for (let n = 0; n < count; n++) {
      const built = buildQuickTaskDraft(mergedPreset, target, {
        label: count > 1 ? `${label} #${n + 1}` : label,
      });
      if (!built.ok) throw new Error(built.error);
      if (taskGroup) built.task.taskGroup = taskGroup;
      const saved = deps.upsertTask?.(built.task);
      const id = saved?.id || built.task.id;
      if (!id) throw new Error("upsertTask did not return id");
      ids.push(id);
      runCtx.createdTaskIds.push(id);
      runCtx.touchedTaskIds.push(id);
    }
    return ids;
  }

  /**
   * Evaluate + possibly run one Smart Action against an event context.
   */
  async function evaluateOne(sa, ctx) {
    if (!sa || sa.enabled === false) return { ok: false, skipped: true, reason: "disabled" };
    if (running.has(sa.id)) return { ok: false, skipped: true, reason: "busy" };

    const debounce = shouldSkipDebounce(sa);
    if (debounce.skip) {
      if (debounce.reason === "run_once_done") {
        return { ok: false, skipped: true, reason: debounce.reason, outcome: OUTCOMES.FILTERED };
      }
      return { ok: false, skipped: true, reason: debounce.reason, remainingMs: debounce.remainingMs };
    }

    const filterResult = matchAllFilters(sa.filters, ctx);
    if (!filterResult.ok) {
      appendLog(sa, {
        step: "filters",
        level: "warn",
        message: `Filtered — ${filterResult.failed.field} ${filterResult.failed.op} "${filterResult.failed.value}"`,
      });
      return finish(sa, OUTCOMES.FILTERED, `Filter miss on ${filterResult.failed.field}`);
    }

    appendLog(sa, {
      step: "trigger",
      level: "info",
      message: `Triggered (${ctx.source || sa.trigger?.type}) ${ctx.sku || ctx.title || sa.name || ""}`.trim(),
    });

    running.add(sa.id);
    try {
      return await runActions(sa, ctx);
    } finally {
      running.delete(sa.id);
    }
  }

  async function handleEvent(triggerType, ctx) {
    const actions = deps.getActions?.() || [];
    const results = [];
    for (const sa of actions) {
      if (sa.enabled === false) continue;
      const t = normalizeTrigger(sa.trigger).type;
      if (t !== triggerType) continue;
      try {
        results.push(await evaluateOne(sa, ctx));
      } catch (e) {
        results.push(finish(sa, OUTCOMES.FAILED, e?.message || String(e)));
      }
    }
    return results;
  }

  async function handleMonitorHit(hit) {
    const ctx = contextFromMonitorHit(hit, { store: "bandai", area: "au" });
    return handleEvent(TRIGGERS.PRODUCT_MONITOR, ctx);
  }

  async function handleQuickTaskContext(ctx) {
    return handleEvent(TRIGGERS.QUICKTASK, {
      ...ctx,
      source: "quicktask",
    });
  }

  /**
   * Tick from main-process interval. Fires due schedule triggers once per slot.
   */
  async function tickSchedule(nowMs = Date.now()) {
    const actions = deps.getActions?.() || [];
    const results = [];
    for (const sa of actions) {
      if (sa.enabled === false) continue;
      const trig = normalizeTrigger(sa.trigger);
      if (trig.type !== TRIGGERS.SCHEDULE) continue;
      const clock = clockPartsInTz(trig.tz, nowMs);
      if (clock.time !== trig.at) continue;
      const key = `${clock.date}T${trig.at}`;
      if (sa.lastScheduleKey === key) continue;
      if (trig.repeat === "once" && sa.firedOnce) continue;

      patchAction(sa.id, { lastScheduleKey: key });
      const fresh = (deps.getActions?.() || []).find((a) => a.id === sa.id) || sa;
      try {
        results.push(
          await evaluateOne(fresh, {
            store: "bandai",
            title: fresh.name,
            sku: "",
            productId: "",
            url: "",
            pdpUrl: "",
            reason: "schedule",
            source: "schedule",
            scheduleAt: trig.at,
            scheduleTz: trig.tz,
          }),
        );
      } catch (e) {
        results.push(finish(fresh, OUTCOMES.FAILED, e?.message || String(e)));
      }
    }
    return results;
  }

  function upsert(raw) {
    const actions = deps.getActions?.() || [];
    const row = normalizeSmartAction(raw, deps.idFn);
    const existing = actions.find((a) => a.id === row.id);
    if (existing) {
      row.lastResult = raw.lastResult !== undefined ? raw.lastResult : existing.lastResult;
      row.lastRunAt = raw.lastRunAt !== undefined ? raw.lastRunAt : existing.lastRunAt;
      row.lastLog = Array.isArray(raw.lastLog) ? raw.lastLog : existing.lastLog;
      row.firedOnce = raw.firedOnce !== undefined ? raw.firedOnce === true : existing.firedOnce;
      row.lastScheduleKey =
        raw.lastScheduleKey !== undefined ? raw.lastScheduleKey : existing.lastScheduleKey;
      row.createdAt = existing.createdAt || row.createdAt;
      const i = actions.findIndex((a) => a.id === row.id);
      actions[i] = row;
    } else {
      actions.push(row);
    }
    persist(actions);
    return row;
  }

  function remove(id) {
    const next = (deps.getActions?.() || []).filter((a) => a.id !== id);
    persist(next);
    return true;
  }

  function setEnabled(id, enabled) {
    return patchAction(id, { enabled: enabled !== false });
  }

  function getLogs(id) {
    const sa = (deps.getActions?.() || []).find((a) => a.id === id);
    return sa?.lastLog || [];
  }

  function snapshot() {
    return {
      actions: list(),
      outcomes: OUTCOMES,
      triggers: TRIGGERS,
      actionTypes: ACTION_TYPES,
      targetScopes: TARGET_SCOPES,
    };
  }

  return {
    list,
    upsert,
    remove,
    setEnabled,
    getLogs,
    snapshot,
    handleMonitorHit,
    handleQuickTaskContext,
    tickSchedule,
    evaluateOne,
    normalizeSmartAction,
    OUTCOMES,
    TRIGGERS,
    ACTION_TYPES,
    TARGET_SCOPES,
    blankAction,
    clockPartsInTz,
  };
}

module.exports = {
  createSmartActionsEngine,
  normalizeSmartAction,
  blankAction,
  normalizeTrigger,
  normalizeTarget,
  clockPartsInTz,
  OUTCOMES,
  TRIGGERS,
  ACTION_TYPES,
  TARGET_SCOPES,
};
