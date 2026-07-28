// Smart Actions engine — runs in Electron main process while the app is open.
// Cybersole-style: 1 Trigger → N Filters (AND) → N Actions (ordered).
// Wired to Bandai global monitor SSE + Quick Task entry points — not a parallel poller.

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
});

const ACTION_TYPES = Object.freeze({
  CREATE_TASKS: "create_tasks",
  START_TASKS: "start_tasks",
  NOTIFY_DISCORD: "notify_discord",
  STOP_TASKS: "stop_tasks",
  DELETE_TASKS: "delete_tasks",
});

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
  return { type, config: {} };
}

function normalizeTrigger(raw) {
  const type = String(raw?.type || TRIGGERS.PRODUCT_MONITOR).toLowerCase();
  if (type === "quicktask" || type === "quick_task" || type === "qt") {
    return { type: TRIGGERS.QUICKTASK };
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
  return {
    type: t,
    config: raw.config && typeof raw.config === "object" ? { ...raw.config } : blankAction(t).config,
  };
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
    actions: actions.length ? actions : [blankAction(ACTION_TYPES.CREATE_TASKS), blankAction(ACTION_TYPES.START_TASKS)],
    lastResult: raw.lastResult || null,
    lastRunAt: raw.lastRunAt || null,
    lastLog: Array.isArray(raw.lastLog) ? raw.lastLog.slice(-80) : [],
    firedOnce: raw.firedOnce === true,
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

/**
 * @param {object} deps
 * @param {() => object[]} deps.getActions
 * @param {(actions: object[]) => void} deps.saveActions
 * @param {() => object} deps.getSettings
 * @param {(task: object) => object} deps.upsertTask — returns saved task row
 * @param {(ids: string[], opts?: object) => object} deps.startTasks
 * @param {(ids: string[]) => void} [deps.deleteTasks]
 * @param {(ids: string[]) => void} [deps.stopTasks]
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
      return { skip: true, reason: "run_interval", remainingMs: interval - (now - sa.lastRunAt) };
    }
    return { skip: false };
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
        if (type === ACTION_TYPES.CREATE_TASKS) {
          const created = await actionCreateTasks(sa, step.config || {}, runCtx);
          appendLog(sa, {
            step: `action:${i}:create_tasks`,
            level: "ok",
            message: `Created ${created.length} task(s): ${created.join(", ") || "—"}`,
          });
        } else if (type === ACTION_TYPES.START_TASKS) {
          const ids = runCtx.createdTaskIds.length
            ? [...runCtx.createdTaskIds]
            : [...runCtx.touchedTaskIds];
          if (!ids.length) {
            appendLog(sa, {
              step: `action:${i}:start_tasks`,
              level: "warn",
              message: "No tasks to start (Create Tasks produced none)",
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
            message: `Started ${res.enqueued ?? ids.length} job(s)`,
          });
        } else if (type === ACTION_TYPES.NOTIFY_DISCORD) {
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
            // Non-fatal — continue
          } else {
            appendLog(sa, {
              step: `action:${i}:notify_discord`,
              level: res?.skipped ? "warn" : "ok",
              message: res?.skipped ? "No webhook configured" : "Discord notified",
            });
          }
        } else if (type === ACTION_TYPES.DELETE_TASKS) {
          const ids = runCtx.createdTaskIds.length
            ? [...runCtx.createdTaskIds]
            : [...runCtx.touchedTaskIds];
          deps.deleteTasks?.(ids);
          appendLog(sa, {
            step: `action:${i}:delete_tasks`,
            level: "ok",
            message: `Deleted ${ids.length} task(s)`,
          });
        } else if (type === ACTION_TYPES.STOP_TASKS) {
          const ids = runCtx.createdTaskIds.length
            ? [...runCtx.createdTaskIds]
            : [...runCtx.touchedTaskIds];
          deps.stopTasks?.(ids);
          appendLog(sa, {
            step: `action:${i}:stop_tasks`,
            level: "ok",
            message: `Stop signalled for ${ids.length} task(s)`,
          });
        } else {
          appendLog(sa, {
            step: `action:${i}`,
            level: "warn",
            message: `Unknown action type: ${type}`,
          });
        }
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

  async function actionCreateTasks(sa, config, runCtx) {
    const settings = deps.getSettings?.() || {};
    const preset = normalizeQuickTaskPreset(settings.quickTaskPreset || {});
    const usePreset = config.usePreset !== false;
    const count = Math.max(1, Math.min(20, Number(config.count) || 1));
    const mode = String(config.bandaiMode || (usePreset ? preset.bandaiMode : "checkout"));
    const store = String(config.store || (usePreset ? preset.store : "bandai"));

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
      throw new Error("Create Tasks: no product context");
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
      // Interval skip is silent (avoid log spam); run-once gets a Filtered-style note once.
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
      message: `Triggered (${ctx.source || sa.trigger?.type}) ${ctx.sku || ctx.title || ""}`.trim(),
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

  function upsert(raw) {
    const actions = deps.getActions?.() || [];
    const row = normalizeSmartAction(raw, deps.idFn);
    // Preserve runtime fields when updating
    const existing = actions.find((a) => a.id === row.id);
    if (existing) {
      row.lastResult = raw.lastResult !== undefined ? raw.lastResult : existing.lastResult;
      row.lastRunAt = raw.lastRunAt !== undefined ? raw.lastRunAt : existing.lastRunAt;
      row.lastLog = Array.isArray(raw.lastLog) ? raw.lastLog : existing.lastLog;
      row.firedOnce = raw.firedOnce !== undefined ? raw.firedOnce === true : existing.firedOnce;
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
    evaluateOne,
    normalizeSmartAction,
    OUTCOMES,
    TRIGGERS,
    ACTION_TYPES,
    blankAction,
  };
}

module.exports = {
  createSmartActionsEngine,
  normalizeSmartAction,
  blankAction,
  OUTCOMES,
  TRIGGERS,
  ACTION_TYPES,
};
