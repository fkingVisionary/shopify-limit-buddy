// J1m's Bot Desktop — main process.
// Owns: BrowserWindow, local store, executor sidecar, job runner, license IPC.
// Does NOT execute Kmart checkout in-process — that stays in executor/ via sidecar.

const { app, BrowserWindow, ipcMain, shell, Notification } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

// Isolated profile for smoke / live-status demo (must run before store.loadAll).
if (
  process.env.DESKTOP_FEATURE_SMOKE === "1" ||
  process.env.DESKTOP_LIVE_STATUS_DEMO === "1"
) {
  const smokeDir =
    process.env.DESKTOP_SMOKE_DIR ||
    process.env.DESKTOP_DEMO_DIR ||
    path.join(
      os.tmpdir(),
      process.env.DESKTOP_LIVE_STATUS_DEMO === "1"
        ? `j1ms-live-status-${Date.now()}`
        : `j1ms-feature-smoke-${Date.now()}`,
    );
  fs.mkdirSync(smokeDir, { recursive: true });
  app.setPath("userData", smokeDir);
  console.log(
    process.env.DESKTOP_LIVE_STATUS_DEMO === "1" ? "[live-status-demo]" : "[feature-smoke]",
    "userData →",
    smokeDir,
  );
}

const store = require("./store.cjs");
const sidecar = require("./executor-sidecar.cjs");
const runner = require("./job-runner.cjs");
const license = require("./license.cjs");
const { createHarvestPool } = require("./toymate-harvest.cjs");
const { resolveAccountForTask, emailBase } = require("./account-assign.cjs");
const {
  normalizeVaultStatus,
  shouldPersistGeneratedAccount,
  findRegisteredAccount,
  normalizeManualAccount,
  parseAccountsImport,
  formatAccountsExport,
} = require("./account-vault.cjs");
const {
  parseProfilesImport,
  formatProfilesExport,
  parseProxyGroupsImport,
  formatProxyGroupsExport,
  parseTasksImport,
  formatTasksExport,
} = require("./data-import-export.cjs");
const {
  colorForTaskGroup,
  groupKey,
  duplicateProfileDraft,
  duplicateTaskDraft,
  duplicateTaskGroupDrafts,
} = require("./task-group-style.cjs");
const { createBandaiHarvestPool } = require("./bandai-harvest.cjs");
const { createDisneyHarvestPool } = require("./disney-harvest.cjs");
const { createBandaiHarvestAutoArm } = require("./bandai-harvest-autoarm.cjs");
const {
  parseDropFireAt,
  msUntil,
  formatCountdown,
  staggerOffsets,
  listBandaiDropTasks,
  assessDropReady,
  planDropMode,
  formatLaneAfterAction,
} = require("./bandai-drop-ops.cjs");
const {
  createBandaiGlobalMonitorClient,
  formatMonitorFeedStatusLine,
} = require("./bandai-global-monitor-client.cjs");
const {
  createWatchdogCooldown,
  planWatchdogStarts,
} = require("./desktop-watchdog.cjs");
const { isMonitorSkuMuted } = require("./monitor-mute.cjs");
const { appendMonitorEvent, readMonitorEvents } = require("./monitor-event-log.cjs");
const { appendCheckoutRun, readCheckoutRuns } = require("./checkout-run-log.cjs");
const { postDiscordWebhook, checkoutResultDiscordPayload, resolveDiscordWebhookUrl, classifyCheckoutDiscordKind } = require("./discord-webhook.cjs");
const { testProxyEntries, PROXY_TEST_PRESETS } = require("./proxy-test.cjs");
const { createSmartActionsEngine } = require("./smart-actions-engine.cjs");
const { resolveTaskLabel } = require("./task-label.cjs");
const {
  defaultCatalogState,
  normalizeCatalogState,
  normalizeCatalogRow,
  parseCatalogBulk,
  applyCatalog,
  removeCatalogActions,
  listTemplates,
  describeTemplate,
  QUICK_PACK_IDS,
} = require("./smart-action-catalog.cjs");
const {
  normalizeStoreGroup,
  cloneStoreGroup,
  findStoreGroup,
} = require("./store-groups.cjs");
const productCacheLib = require("./bandai-product-cache.cjs");
const { enrichRowsWithBandaiImages } = require("./bandai-product-image.cjs");

function catalogTemplatePublic(t) {
  const desc = describeTemplate(t);
  return {
    id: t.id,
    name: t.name,
    displayName: t.displayName || t.name,
    category: t.category || "Preset",
    galleryCategory: galleryCategoryForTemplate(t),
    glyph: t.glyph || "SA",
    accent: t.accent || "silver",
    blurb: t.blurb || "",
    does: desc.does,
    explain: desc.explain,
    when: desc.when,
    steps: desc.steps,
    applies: desc.applies,
    filterCount: desc.filterCount,
    actionCount: desc.actionCount,
    trigger: t.trigger || { type: "product_monitor" },
    filters: Array.isArray(t.filters) ? t.filters : [],
    actions: Array.isArray(t.actions) ? t.actions : [],
    enabled: t.enabled !== false,
    runOnce: t.runOnce === true,
    runIntervalMs: t.runIntervalMs ?? 30000,
    notifications: t.notifications !== false,
  };
}

function galleryCategoryForTemplate(t) {
  const c = String(t?.category || "").toLowerCase();
  const trig = String(t?.trigger?.type || "").toLowerCase();
  if (c === "schedule" || trig === "schedule") return "Schedule";
  if (c === "discord" || trig === "quicktask") return "Quicktask";
  if (c === "notify") return "Notify";
  return "Product Monitor";
}
const {
  normalizeQuickTaskPreset,
  parseBandaiProductInput,
  targetFromMonitorHit,
  buildQuickTaskDraft,
  contextFromMonitorHit,
  contextFromQuickTask,
} = require("./quick-task.cjs");
const {
  PROTOCOL: QT_PROTOCOL,
  BRIDGE_PORT: QT_BRIDGE_PORT,
  parseQuickTaskDeepLink,
} = require("./deep-link.cjs");
const { createQuickTaskBridge } = require("./quick-task-bridge.cjs");

// Single instance so Discord → localhost / j1ms:// lands on the running app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win = null;
let state = store.loadAll();
if (!Array.isArray(state.db.smartActions)) state.db.smartActions = [];
if (!state.db.smartActionCatalog || typeof state.db.smartActionCatalog !== "object") {
  state.db.smartActionCatalog = defaultCatalogState();
} else {
  state.db.smartActionCatalog = normalizeCatalogState(state.db.smartActionCatalog);
}
state.settings.quickTaskPreset = normalizeQuickTaskPreset(state.settings.quickTaskPreset || {});
if (state.settings.detailedLogs == null) state.settings.detailedLogs = true;
runner.configure({ detailedLogs: state.settings.detailedLogs !== false });
if (!state.db.taskGroupColors || typeof state.db.taskGroupColors !== "object") {
  state.db.taskGroupColors = {};
}
if (!state.db.profileGroupColors || typeof state.db.profileGroupColors !== "object") {
  state.db.profileGroupColors = {};
}
if (!state.db.accountGroupColors || typeof state.db.accountGroupColors !== "object") {
  state.db.accountGroupColors = {};
}

/** @type {{ atMs: number, label: string, taskIds: string[], staggerGapMs: number, timer: NodeJS.Timeout|null, tickTimer: NodeJS.Timeout|null }|null} */
let dropSchedule = null;

/** Pending deep-link QT if app was cold-started from Discord. */
let pendingQuickTaskUrl = null;

const harvest = createHarvestPool({
  sidecar,
  emit: (evt) => send(evt),
});

const bandaiHarvest = createBandaiHarvestPool({
  sidecar,
  emit: (evt) => send(evt),
});

const disneyHarvest = createDisneyHarvestPool({
  sidecar,
  emit: (evt) => send(evt),
});

/** Auto-arm Bandai F5 harvest while Monitor → checkout jobs are live. */
const bandaiHarvestAutoArm = createBandaiHarvestAutoArm({
  harvest: bandaiHarvest,
  getEntries: () => bandaiHarvestEntries(),
  idFn: () => store.id("run"),
  log: (message) =>
    send({ type: "job", phase: "log", level: "info", message: String(message || "") }),
});

/** Smart Actions engine — main-process only; orchestrates tasks, never checkouts itself. */
const smartActions = createSmartActionsEngine({
  getActions: () => state.db.smartActions || [],
  saveActions: (actions) => {
    state.db.smartActions = Array.isArray(actions) ? actions : [];
    persistDb();
    send({ type: "smartActions", data: smartActions.snapshot() });
  },
  getSettings: () => state.settings,
  getTasks: () => state.db.tasks || [],
  getProfiles: () => state.db.profiles || [],
  getStoreGroups: () => state.db.storeGroups || [],
  idFn: (prefix) => store.id(prefix || "sa"),
  upsertTask: (task) => upsertTaskRow(task),
  startTasks: (ids, opts) => enqueueTaskIds(ids, opts || {}),
  deleteTasks: (ids) => {
    const set = new Set(ids || []);
    state.db.tasks = (state.db.tasks || []).filter((t) => !set.has(t.id));
    persistDb();
  },
  stopTasks: (ids) => {
    // Soft-disable — runner has no cancel-by-id; mark disabled so they won't re-arm.
    const set = new Set(ids || []);
    for (const t of state.db.tasks || []) {
      if (set.has(t.id)) {
        t.enabled = false;
        t.updatedAt = Date.now();
      }
    }
    persistDb();
  },
  patchTasks: (ids, patch) => {
    const set = new Set(ids || []);
    let updated = 0;
    for (const t of state.db.tasks || []) {
      if (!set.has(t.id)) continue;
      upsertTaskRow({ ...t, ...patch, id: t.id });
      updated += 1;
    }
    return { ok: true, updated };
  },
  startHarvester: async (opts = {}) => {
    if (!sidecar.status().running) {
      return { ok: false, error: "Start the engine first" };
    }
    const gid = opts.proxyGroupId || bandaiHarvest.snapshot().config.proxyGroupId;
    if (gid) bandaiHarvest.configure({ proxyGroupId: gid });
    if (opts.desired != null) bandaiHarvest.configure({ desired: opts.desired });
    const group = (state.db.proxyGroups || []).find((g) => g.id === gid);
    if (!group?.entries?.length) {
      return { ok: false, error: "Select a Proxies group on Harvest → Bandai first" };
    }
    bandaiHarvest.start({
      proxyGroupId: gid,
      desired: opts.desired,
      getEntries: bandaiHarvestEntries,
    });
    bandaiHarvestAutoArm.markManualStart();
    return { ok: true };
  },
  stopHarvester: () => {
    bandaiHarvestAutoArm.markManualStop();
    bandaiHarvest.stop();
    return { ok: true };
  },
  notifyDiscord: async (payload) => {
    const url =
      resolveDiscordWebhookUrl(state.settings, "monitor") ||
      resolveDiscordWebhookUrl(state.settings, "success") ||
      "";
    return postDiscordWebhook(url, payload);
  },
  notifyToast: (payload = {}) => {
    send({
      type: "toast",
      message: String(payload.message || "").slice(0, 240),
      level: payload.level || "ok",
      actionId: payload.actionId || null,
    });
  },
  ensureTaskGroup: (opts = {}) => {
    const group = String(opts.taskGroup || "").trim().slice(0, 80);
    if (!group) return { ok: false, error: "task group required" };
    if (!state.db.taskGroupColors || typeof state.db.taskGroupColors !== "object") {
      state.db.taskGroupColors = {};
    }
    const key = group;
    const existed = Object.prototype.hasOwnProperty.call(state.db.taskGroupColors, key);
    const color = String(opts.color || "").trim();
    if (color) state.db.taskGroupColors[key] = color;
    else if (!existed) state.db.taskGroupColors[key] = "";
    persistDb();
    return { ok: true, taskGroup: key, existed, created: !existed };
  },
  gotoTaskGroup: (opts = {}) => {
    const group = String(opts.taskGroup || "").trim();
    if (!group) return;
    // Flush DB → UI before navigate so the new group isn't empty on first paint.
    send({ type: "snapshot", data: snapshot() });
    send({ type: "gotoTaskGroup", taskGroup: group });
  },
  emit: (evt) => {
    if (
      evt?.type === "smartAction" &&
      (evt.phase === "tasks_created" || evt.phase === "goto_task_group")
    ) {
      send({ type: "snapshot", data: snapshot() });
    }
    send(evt);
  },
});

/** Smart Action schedule trigger — fires at HH:MM or HH:MM:SS in trigger tz while app is open. */
let smartActionScheduleTimer = null;
function startSmartActionScheduleTicker() {
  if (smartActionScheduleTimer) return;
  smartActionScheduleTimer = setInterval(() => {
    void smartActions.tickSchedule(Date.now()).then((results) => {
      if (Array.isArray(results) && results.some((r) => r && !r.skipped)) {
        send({ type: "snapshot", data: snapshot() });
      }
    });
  }, 1_000);
}
function stopSmartActionScheduleTicker() {
  if (smartActionScheduleTimer) clearInterval(smartActionScheduleTimer);
  smartActionScheduleTimer = null;
}
startSmartActionScheduleTicker();

/** Railway restock → Autocheckout auto-start (cooldown per task+SKU). */
const desktopWatchdogCooldown = createWatchdogCooldown({
  cooldownMs: 60_000,
});

function handleDesktopWatchdog(hit) {
  if (!sidecar.status().running) return { ok: false, started: 0, reason: "engine_off" };
  desktopWatchdogCooldown.setCooldownMs(
    Number(state.settings.desktopWatchdogCooldownMs) || 60_000,
  );
  const starts = planWatchdogStarts({
    tasks: state.db.tasks,
    hit,
    settings: {
      ...state.settings,
      // Admin mute list from Railway /health (not a per-user setting).
      monitorMutedSkus: bandaiGlobalMonitor.getAdminMutedSkus?.() || [],
    },
    cooldown: desktopWatchdogCooldown,
  });
  let started = 0;
  for (const row of starts) {
    send({
      type: "job",
      phase: "log",
      level: "info",
      taskId: row.taskId,
      message: `Watchdog → start ${row.label} (${row.productId})`,
    });
    const res = enqueueGlobalMonitorCheckout(row.checkoutTask);
    if (res?.ok !== false) {
      started += 1;
      const t = state.db.tasks.find((x) => x.id === row.taskId);
      if (t) {
        t.lastStatus = "queued";
        t.lastLabel = `Watchdog · ${row.productId}`;
        t.updatedAt = Date.now();
      }
    }
  }
  if (started) {
    persistDb();
    send({ type: "snapshot", data: snapshot() });
  }
  return { ok: true, started, matched: starts.length };
}

/** Railway global monitor SSE — subscribed while engine is running. */
const bandaiGlobalMonitor = createBandaiGlobalMonitorClient({
  getSettings: () => state.settings,
  getTasks: () => state.db.tasks,
  initialFeed: store.loadMonitorFeed?.() || [],
  emitLog: (message) =>
    send({ type: "job", phase: "log", level: "info", message: String(message || "") }),
  onCheckoutTask: async (task) => enqueueGlobalMonitorCheckout(task),
  onFeedChanged: (feed) => {
    try {
      store.saveMonitorFeed?.(feed);
    } catch {
      /* disk persist is best-effort */
    }
  },
  onFeedHit: (hit) => {
    if (
      hit?.muted === true ||
      isMonitorSkuMuted(
        { monitorMutedSkus: bandaiGlobalMonitor.getAdminMutedSkus?.() || [] },
        hit?.productId || hit?.sku,
      )
    ) {
      appendMonitorEvent(path.join(app.getPath("userData"), "j1ms-desktop"), {
        kind: "muted",
        productId: hit?.productId || hit?.sku || "",
        reason: hit?.reason || "restock",
        source: "admin",
      });
      return;
    }
    send({ type: "monitorFeed", hit });
    appendMonitorEvent(path.join(app.getPath("userData"), "j1ms-desktop"), {
      kind: "restock",
      productId: hit?.productId || hit?.sku || "",
      reason: hit?.reason || "restock",
      title: hit?.title || hit?.productName || "",
    });
    // Smart Actions Product Monitor trigger (orchestration only).
    void smartActions.handleMonitorHit(hit).then((results) => {
      const fired = (Array.isArray(results) ? results : []).filter(
        (r) => r && !r.skipped && r.outcome,
      );
      if (fired.length) {
        appendMonitorEvent(path.join(app.getPath("userData"), "j1ms-desktop"), {
          kind: "smart_action",
          productId: hit?.productId || hit?.sku || "",
          results: fired.map((r) => ({
            actionId: r.actionId,
            outcome: r.outcome,
            ok: r.ok,
          })),
        });
      }
      send({ type: "snapshot", data: snapshot() });
    });
    // Watchdog: idle Autocheckout tasks matching this SKU/keywords → start now.
    try {
      const wd = handleDesktopWatchdog(hit);
      if (wd?.started) {
        appendMonitorEvent(path.join(app.getPath("userData"), "j1ms-desktop"), {
          kind: "watchdog",
          productId: hit?.productId || hit?.sku || "",
          started: wd.started,
          matched: wd.matched,
        });
      }
    } catch (e) {
      send({
        type: "job",
        phase: "log",
        level: "err",
        message: `Watchdog error: ${e?.message || e}`,
      });
    }
  },
});
bandaiGlobalMonitor.on("feedSync", (feed) => {
  send({ type: "monitorFeed", feed: Array.isArray(feed) ? feed : [] });
});
bandaiGlobalMonitor.on("mutedHit", (hit) => {
  appendMonitorEvent(path.join(app.getPath("userData"), "j1ms-desktop"), {
    kind: "muted",
    productId: hit?.productId || hit?.sku || "",
    reason: hit?.reason || "restock",
  });
  send({
    type: "job",
    phase: "log",
    level: "muted",
    message: `Muted restock · ${hit?.productId || hit?.sku || "?"} (skipped)`,
  });
});
bandaiGlobalMonitor.on("adminWatchlist", () => {
  send({ type: "snapshot", data: snapshot() });
});

function harvestEntries() {
  const gid = harvest.snapshot().config.proxyGroupId;
  const group = (state.db.proxyGroups || []).find((g) => g.id === gid);
  return group?.entries || [];
}

function bandaiHarvestEntries() {
  const gid = bandaiHarvest.snapshot().config.proxyGroupId;
  const group = (state.db.proxyGroups || []).find((g) => g.id === gid);
  return group?.entries || [];
}

function runnerHarvestHooks() {
  return {
    takeBandaiHarvest: () => bandaiHarvest.take(),
    pauseBandaiHarvestRefill: () => bandaiHarvest.pauseRefill(),
    resumeBandaiHarvestRefill: () => bandaiHarvest.resumeRefill(),
  };
}

function disneyHarvestEntries() {
  const gid = disneyHarvest.snapshot().config.proxyGroupId;
  const group = (state.db.proxyGroups || []).find((g) => g.id === gid);
  return group?.entries || [];
}

function send(evt) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("desktop:event", evt);
  } catch {
    /* window tearing down */
  }
}

function persistDb() {
  store.saveDb(state.db);
}

function ensureProductCache() {
  if (!state.db.bandaiProductCache) {
    state.db.bandaiProductCache = productCacheLib.emptyCache();
  }
  return state.db.bandaiProductCache;
}

function lookupSharedProduct(sku, area = "au") {
  return productCacheLib.lookup(ensureProductCache(), { sku, area });
}

function rememberLocalProduct(entry) {
  if (!entry) return;
  const { cache, changed } = productCacheLib.mergeEntries(ensureProductCache(), entry);
  if (!changed) return;
  state.db.bandaiProductCache = cache;
  persistDb();
}

async function pushProductToMonitor(entry) {
  if (!entry?.sku || !productCacheLib.isBackendPid(entry.areaItemNo)) return;
  const s = state.settings || {};
  const base = String(s.bandaiGlobalMonitorUrl || s.globalMonitorUrl || "")
    .trim()
    .replace(/\/+$/, "");
  const token = String(s.bandaiGlobalMonitorToken || "").trim();
  if (!base || !token) return;
  try {
    await fetch(`${base}/product-cache`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...entry, source: entry.source || "desktop" }),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Pull shared Bandai SKU↔NAI cache from Railway monitor.
 */
async function pullProductCacheFromMonitor() {
  const s = state.settings || {};
  const base =
    String(s.bandaiGlobalMonitorUrl || s.globalMonitorUrl || "")
      .trim()
      .replace(/\/+$/, "") || "https://j1ms-bandai-monitor-production.up.railway.app";
  if (!base) return { ok: false, error: "Monitor unavailable" };
  const token = String(s.bandaiGlobalMonitorToken || "").trim();
  let res;
  try {
    res = await fetch(`${base}/product-cache`, {
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (e) {
    return { ok: false, error: e?.message || "fetch failed" };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: body.error || `HTTP ${res.status}`, status: res.status };
  }
  const { cache, changed } = productCacheLib.mergeEntries(
    ensureProductCache(),
    Array.isArray(body.entries) ? body.entries : [],
  );
  cache.pulledAt = Date.now();
  cache.updatedAt = body.updatedAt || cache.updatedAt;
  state.db.bandaiProductCache = cache;
  persistDb();
  // Stamp known NAIs onto local Bandai tasks missing backend PID.
  let stamped = 0;
  for (const t of state.db.tasks || []) {
    if (t.store !== "bandai") continue;
    if (productCacheLib.isBackendPid(t.bandaiAreaItemNo)) continue;
    const sku = String(t.bandaiWatchSku || t.input || t.pdpUrl || "").match(
      /\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*)\b/i,
    )?.[1];
    if (!sku) continue;
    const hit = lookupSharedProduct(sku, t.bandaiArea || "au");
    if (hit?.areaItemNo) {
      t.bandaiAreaItemNo = hit.areaItemNo;
      stamped += 1;
    }
  }
  if (stamped) persistDb();
  return {
    ok: true,
    count: Object.keys(cache.entries || {}).length,
    changed,
    stamped,
    updatedAt: cache.updatedAt,
  };
}

function wireProductCacheIntoRunner() {
  runner.configure({
    lookupBandaiProduct: (sku, area) => lookupSharedProduct(sku, area),
    publishBandaiProduct: (entry) => {
      rememberLocalProduct({ ...entry, source: entry.source || "resolve" });
      void pushProductToMonitor(entry);
    },
  });
}

function persistSettings() {
  store.saveSettings(state.settings);
}

/**
 * User Discord webhooks — route success / fail / 3DS.
 * Global restock pings stay on the operator Railway webhook.
 */
async function notifyUserCheckoutDiscord(result) {
  const kind = classifyCheckoutDiscordKind(result);
  if (kind === "skip") return;
  const url = resolveDiscordWebhookUrl(state.settings, kind);
  if (!url) return;
  const task = (state.db.tasks || []).find((t) => t.id === result.taskId);
  const storeId = task?.store || result.store || "checkout";
  try {
    const payload = checkoutResultDiscordPayload(result, {
      store: storeId,
      label: task?.label || result.taskId,
      kind,
    });
    await postDiscordWebhook(url, payload);
  } catch {
    /* ignore webhook errors */
  }
}

/** Flash taskbar + OS notification + renderer sound on checkout win. */
function celebrateCheckoutWin(result) {
  if (state.settings.successAlertEnabled === false) return;
  if (classifyCheckoutDiscordKind(result) !== "success") return;
  const title = "Checkout secured";
  const body = String(
    result.orderNumber ||
      result.consumerLabel ||
      result.taskLabel ||
      result.taskId ||
      "Order placed",
  ).slice(0, 160);
  try {
    if (win && !win.isDestroyed()) {
      win.flashFrame(true);
      try {
        win.setProgressBar(1);
        setTimeout(() => {
          try {
            if (win && !win.isDestroyed()) win.setProgressBar(-1);
          } catch {
            /* ignore */
          }
        }, 2800);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body });
      n.show();
    }
  } catch {
    /* ignore */
  }
  send({
    type: "checkoutWin",
    taskId: result.taskId || null,
    orderNumber: result.orderNumber || null,
    label: body,
  });
}

function tasksInGroup(taskGroup) {
  const g = String(taskGroup || "").trim().toLowerCase();
  if (!g) return [];
  return (state.db.tasks || []).filter(
    (t) => String(t.taskGroup || "").trim().toLowerCase() === g,
  );
}

function storeDisplayName(sid) {
  if (sid === "toymate") return "Toymate AU";
  if (sid === "bandai") return "Premium Bandai";
  if (sid === "kmart") return "Kmart AU";
  if (sid === "disney") return "Disney Store AU";
  return sid;
}

/**
 * Upsert a vault account by id (edit) or storeId+email (merge).
 * @param {object} account
 * @param {{ storeId?: string, profileId?: string, source?: string }} [opts]
 */
function upsertAccountRow(account, { storeId, profileId, source } = {}) {
  if (!account?.email || !account?.password) return null;
  if (!Array.isArray(state.db.accounts)) state.db.accounts = [];
  const email = String(account.email).trim();
  const sid = storeId || account.storeId || "toymate";
  const byId = account.id
    ? state.db.accounts.find((a) => a.id === String(account.id))
    : null;
  const existing =
    byId ||
    state.db.accounts.find(
      (a) =>
        String(a.storeId || "") === sid &&
        String(a.email || "").toLowerCase() === email.toLowerCase(),
    );
  // Preserve SoftBlock / needs_* truth — never coerce Bandai unknowns to "ready".
  const status = normalizeVaultStatus(account.status ?? existing?.status, sid);
  const row = {
    id: existing?.id || account.id || store.id("acc"),
    email,
    emailBase: emailBase(email),
    password: String(account.password),
    phone: account.phone || existing?.phone || null,
    shipping: account.shipping || existing?.shipping || null,
    storeId: sid,
    adapter: sid,
    storeName: storeDisplayName(sid),
    profileId: profileId || account.profileId || existing?.profileId || null,
    source: source || account.source || existing?.source || "generated",
    status,
    notes: account.notes != null ? account.notes : existing?.notes || null,
    accountGroup: String(account.accountGroup || existing?.accountGroup || "")
      .trim()
      .slice(0, 80),
    lastUsedAt: existing?.lastUsedAt || account.lastUsedAt || null,
    lastLoginAt: account.lastLoginAt || existing?.lastLoginAt || null,
    loginProvenAt: account.loginProvenAt || existing?.loginProvenAt || null,
    createdAt: existing?.createdAt || account.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  if (row.accountGroup) {
    if (!state.db.accountGroupColors || typeof state.db.accountGroupColors !== "object") {
      state.db.accountGroupColors = {};
    }
    if (!Object.prototype.hasOwnProperty.call(state.db.accountGroupColors, row.accountGroup)) {
      state.db.accountGroupColors[row.accountGroup] = "";
    }
  }
  if (existing) {
    state.db.accounts = state.db.accounts.map((a) => (a.id === existing.id ? row : a));
  } else {
    state.db.accounts.unshift(row);
  }
  state.db.accounts = state.db.accounts.slice(0, 500);
  return row;
}

function upsertGeneratedAccount(account, { storeId, profileId, source = "generated" } = {}) {
  return upsertAccountRow(account, { storeId, profileId, source });
}

function cancelDropSchedule({ silent = false } = {}) {
  if (dropSchedule?.timer) clearTimeout(dropSchedule.timer);
  if (dropSchedule?.tickTimer) clearInterval(dropSchedule.tickTimer);
  dropSchedule = null;
  if (!silent) {
    send({ type: "dropSchedule", data: { armed: false } });
  }
}

function publishDropSchedule() {
  if (!dropSchedule) {
    send({ type: "dropSchedule", data: { armed: false } });
    return;
  }
  const left = msUntil(dropSchedule.atMs);
  send({
    type: "dropSchedule",
    data: {
      armed: true,
      atMs: dropSchedule.atMs,
      label: dropSchedule.label,
      taskIds: dropSchedule.taskIds,
      countdownMs: left,
      countdown: formatCountdown(left),
    },
  });
}

function armDropSchedule({ fireAt, taskIds, staggerGapMs = 50 } = {}) {
  const parsed = parseDropFireAt(fireAt);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const ids =
    Array.isArray(taskIds) && taskIds.length
      ? taskIds.map(String)
      : listBandaiDropTasks(state.db.tasks).map((t) => t.id);
  if (!ids.length) return { ok: false, error: "No Bandai Autocheckout tasks to fire" };

  cancelDropSchedule({ silent: true });
  const delay = msUntil(parsed.atMs);
  dropSchedule = {
    atMs: parsed.atMs,
    label: parsed.label,
    taskIds: ids,
    staggerGapMs: Math.max(0, Math.min(150, Number(staggerGapMs) || 50)),
    timer: null,
    tickTimer: null,
  };
  dropSchedule.timer = setTimeout(() => {
    void fireArmedDropSchedule();
  }, delay);
  dropSchedule.tickTimer = setInterval(() => publishDropSchedule(), 1000);
  publishDropSchedule();
  send({
    type: "job",
    phase: "log",
    level: "info",
    message: `Drop schedule armed → ${parsed.label} (${ids.length} task(s), countdown ${formatCountdown(delay)})`,
  });
  return {
    ok: true,
    atMs: parsed.atMs,
    label: parsed.label,
    taskIds: ids,
    countdownMs: delay,
    countdown: formatCountdown(delay),
  };
}

async function fireArmedDropSchedule() {
  if (!dropSchedule) return;
  const { taskIds, staggerGapMs, label } = dropSchedule;
  cancelDropSchedule({ silent: true });
  send({
    type: "job",
    phase: "log",
    level: "ok",
    message: `Drop T0 — firing ${taskIds.length} task(s) (${label})`,
  });
  const res = enqueueTaskIds(taskIds, { stagger: true, staggerGapMs });
  send({ type: "dropSchedule", data: { armed: false, fired: true, result: res } });
  send({ type: "snapshot", data: snapshot() });
}

function dropReadySnapshot() {
  return assessDropReady({
    engineRunning: Boolean(sidecar.status()?.running),
    harvest: bandaiHarvest.snapshot(),
    tasks: state.db.tasks,
    accounts: state.db.accounts || [],
    proxyGroups: state.db.proxyGroups || [],
  });
}

function snapshot() {
  const schedule = dropSchedule
    ? {
        armed: true,
        atMs: dropSchedule.atMs,
        label: dropSchedule.label,
        taskIds: dropSchedule.taskIds,
        countdownMs: msUntil(dropSchedule.atMs),
        countdown: formatCountdown(msUntil(dropSchedule.atMs)),
      }
    : { armed: false };
  return {
    settings: {
      ...state.settings,
      // Never echo full secrets back longer than needed in UI — still needed for form edit.
      apiKey: state.settings.apiKey || "",
      hyperApiKey: state.settings.hyperApiKey || "",
      capsolverApiKey: state.settings.capsolverApiKey || "",
      smspoolApiKey: state.settings.smspoolApiKey || "",
      onlinesimApiKey: state.settings.onlinesimApiKey || "",
      imapAppPassword: state.settings.imapAppPassword || "",
    },
    profiles: state.db.profiles,
    proxyGroups: state.db.proxyGroups,
    tasks: state.db.tasks,
    storeGroups: state.db.storeGroups || [],
    taskGroupColors: state.db.taskGroupColors || {},
    profileGroupColors: state.db.profileGroupColors || {},
    accountGroupColors: state.db.accountGroupColors || {},
    results: state.db.results.slice(-50),
    accounts: (state.db.accounts || []).slice(0, 500),
    runner: runner.state(),
    engine: sidecar.status(),
    harvest: harvest.snapshot(),
    bandaiHarvest: bandaiHarvest.snapshot(),
    disneyHarvest: disneyHarvest.snapshot(),
    bandaiGlobalMonitor: (() => {
      const mon = bandaiGlobalMonitor.snapshot();
      return {
        ...mon,
        // Keep host out of the renderer snapshot (baked-in; not for members).
        url: undefined,
        statusLine: formatMonitorFeedStatusLine({
          connected: mon.connected,
          running: mon.running,
          hits: mon.hits,
          adminWatchCount: mon.adminWatchCount,
          watchTasks: mon.watchTasks,
          lastError: mon.lastError,
          engineRunning: Boolean(sidecar.status()?.running),
        }),
      };
    })(),
    smartActions: smartActions.snapshot(),
    smartActionCatalog: {
      ...normalizeCatalogState(state.db.smartActionCatalog),
      templates: listTemplates().map(catalogTemplatePublic),
      quickPackIds: QUICK_PACK_IDS,
      source: state.db.smartActionCatalog?.source || "local",
      remoteUpdatedAt: state.db.smartActionCatalog?.remoteUpdatedAt || null,
      pulledAt: state.db.smartActionCatalog?.pulledAt || null,
    },
    monitorFeed: bandaiGlobalMonitor.getFeed?.() || bandaiGlobalMonitor.snapshot().feed || [],
    quickTaskBridge: typeof quickTaskBridge !== "undefined" ? quickTaskBridge.snapshot() : null,
    dropSchedule: schedule,
    dropReady: dropReadySnapshot(),
  };
}

function createWindow() {
  const iconPath = path.join(__dirname, "renderer", "assets", "icon.png");
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    title: "Vanta",
    backgroundColor: "#0a0a0b",
    icon: require("fs").existsSync(iconPath) ? iconPath : undefined,
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("focus", () => {
    try {
      win.flashFrame(false);
    } catch {
      /* ignore */
    }
  });
  win.on("maximize", () => send({ type: "window", maximized: true }));
  win.on("unmaximize", () => send({ type: "window", maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

ipcMain.handle("desktop:window-minimize", () => {
  win?.minimize();
});
ipcMain.handle("desktop:window-maximize", () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle("desktop:window-close", () => {
  win?.close();
});
ipcMain.handle("desktop:window-is-maximized", () => Boolean(win?.isMaximized()));

runner.setEmitter((evt) => {
  // Live status → task row badge (Logging in / Rotating proxy / …).
  if (
    evt?.type === "job" &&
    evt.taskId &&
    (evt.phase === "start" || evt.phase === "status" || evt.phase === "progress")
  ) {
    const t = state.db.tasks.find((x) => x.id === evt.taskId);
    if (t) {
      const label =
        evt.consumerLabel ||
        evt.lastLabel ||
        (evt.phase === "start" ? "Starting" : null);
      if (label) {
        t.lastStatus = evt.lastStatus || "running";
        t.lastLabel = String(label);
        t.updatedAt = Date.now();
        send({
          type: "taskStatus",
          taskId: t.id,
          lastStatus: t.lastStatus,
          lastLabel: t.lastLabel,
        });
      }
    }
  }
  send(evt);
});
runner.setFinishedHandler((result) => {
  // Keep step tail for Results UI (same info the web dashboard surfaces).
  state.db.results.unshift({
    ok: result.ok,
    taskId: result.taskId,
    runId: result.runId,
    orderNumber: result.orderNumber || null,
    error: result.error || null,
    consumerLabel: result.consumerLabel || result.error || null,
    consumerCode: result.consumerCode || null,
    stockStatus: result.stockStatus || null,
    checkoutStage: result.checkoutStage || null,
    failedStep: result.failedStep || null,
    elapsedMs: result.elapsedMs ?? null,
    lastSteps: result.lastSteps || null,
    at: result.at || Date.now(),
  });
  state.db.results = state.db.results.slice(0, 200);

  // Local troubleshooting log (redacted) — survives UI scroll / restart.
  try {
    const taskRow = result.taskId
      ? state.db.tasks.find((x) => x.id === result.taskId) || null
      : null;
    appendCheckoutRun(path.join(app.getPath("userData"), "j1ms-desktop"), result, taskRow);
  } catch {
    /* best-effort */
  }

  // Per-user Discord: checkout success/fail only (not global restocks).
  void notifyUserCheckoutDiscord(result);
  celebrateCheckoutWin(result);

  // Vault login_check — stamp same-day proof even without a real task row.
  if (result.loginCheck && result.ok) {
    const email = String(result.account?.email || "").toLowerCase();
    const acc = (state.db.accounts || []).find(
      (a) =>
        String(a.storeId || "") === "bandai" &&
        String(a.email || "").toLowerCase() === email,
    );
    if (acc) {
      acc.status = "ready";
      acc.loginProvenAt = Date.now();
      acc.lastLoginAt = Date.now();
      acc.updatedAt = Date.now();
    }
  }
  // Mirror status onto task row
  if (result.taskId) {
    const t = state.db.tasks.find((x) => x.id === result.taskId);
    if (t) {
      if (result.accountGen) {
        const sid = t.store || result.account?.storeId || "toymate";
        const persisted = shouldPersistGeneratedAccount(result, sid)
          ? upsertGeneratedAccount(result.account, {
              storeId: sid,
              profileId: t.profileId,
              source: "generated",
            })
          : null;
        const st = result.account?.status || (persisted?.status) || "partial";
        t.lastStatus = result.ok && persisted ? "complete" : "error";
        t.lastLabel = persisted
          ? result.ok
            ? `Account ${persisted.email} (${persisted.status})`
            : `Account ${persisted.email} (${persisted.status}) — ${result.consumerLabel || result.error || "partial"}`
          : result.consumerLabel ||
            result.error ||
            (result.account?.email
              ? `Agen failed ${result.account.email} (${st}) — not vaulted`
              : "Account gen failed");
        t.lastError = result.ok && persisted ? null : result.consumerLabel || result.error || null;
        t.lastOrderNumber = null;
      } else if (result.loginCheck) {
        t.lastStatus = result.ok ? "login_ok" : "error";
        t.lastLabel = result.ok
          ? `Login proven ${result.account?.email || ""}`.trim()
          : result.consumerLabel || result.error || "Login check failed";
        t.lastError = result.ok ? null : result.consumerLabel || result.error || null;
        t.lastDropSummary = t.lastLabel;
      } else {
        t.lastStatus =
          result.consumerCode ||
          (result.ok ? (result.orderNumber ? "confirmed" : "complete") : "error");
        t.lastLabel = result.consumerLabel || (result.ok ? "Order confirmed" : result.error) || null;
        t.lastError = result.ok ? null : result.consumerLabel || result.error || null;
        t.lastOrderNumber = result.orderNumber || null;
        // Persist auto-resolved Backend PID so later lanes skip public resolve.
        if (
          result.areaItemNo &&
          /^NAI/i.test(String(result.areaItemNo)) &&
          t.store === "bandai"
        ) {
          t.bandaiAreaItemNo = String(result.areaItemNo).trim();
          const sku = String(t.bandaiWatchSku || t.input || t.pdpUrl || "").match(
            /\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*)\b/i,
          )?.[1];
          if (sku) {
            const entry = {
              sku,
              areaItemNo: t.bandaiAreaItemNo,
              title: t.title || "",
              area: t.bandaiArea || "au",
              source: "checkout",
            };
            rememberLocalProduct(entry);
            void pushProductToMonitor(entry);
          }
        }
        // Compact lane after-action for Tasks list.
        if (t.store === "bandai") {
          t.lastDropSummary = formatLaneAfterAction(result);
        }
        // Bandai: persist held cart for Retry pay (live cart is still source of truth).
        if (result.ok && result.orderNumber) {
          t.heldCart = null;
        } else if (result.heldCartGone || result.consumerCode === "held_cart_gone") {
          t.heldCart = null;
        } else if (result.heldCart && result.heldCart.cartSn && result.heldCart.cartItemSn) {
          t.heldCart = {
            ...result.heldCart,
            accountId: result.account?.id || t.heldCart?.accountId || t.accountId || null,
          };
        } else if (
          result.heldPayRetry &&
          result.cartSn &&
          result.cartItemSn
        ) {
          t.heldCart = {
            cartSn: result.cartSn,
            cartId: result.cartId || null,
            cartItemSn: result.cartItemSn,
            areaItemNo: result.areaItemNo || t.bandaiAreaItemNo || null,
            productCode: result.productCode || null,
            cartHoldAt: result.cartHoldAt || Date.now(),
            payWindowMs: 30 * 60_000,
            paymentStatus: result.paymentStatus || null,
            accountId: result.account?.id || t.accountId || null,
          };
        }
      }
      t.lastCheckoutStage = result.checkoutStage || null;
      t.stockStatus = result.stockStatus || null;
      t.updatedAt = Date.now();
    }
  }
  // Release Monitor → checkout harvest auto-arm ref (stops refill if we started it).
  if (result.runId) {
    try {
      bandaiHarvestAutoArm.release(result.runId);
    } catch {
      /* ignore */
    }
  }
  persistDb();
  send({ type: "snapshot", data: snapshot() });
});

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.handle("desktop:get-state", () => snapshot());

ipcMain.handle("desktop:save-settings", async (_e, patch) => {
  const next = { ...state.settings, ...patch };
  if (patch && Object.prototype.hasOwnProperty.call(patch, "quickTaskPreset")) {
    next.quickTaskPreset = normalizeQuickTaskPreset(patch.quickTaskPreset || {});
  }
  // Per-user monitorMutedSkus is retired — mute globally from the admin dashboard.
  if (patch && Object.prototype.hasOwnProperty.call(patch, "monitorMutedSkus")) {
    delete next.monitorMutedSkus;
  }
  state.settings = next;
  runner.configure({
    maxConcurrent: state.settings.maxConcurrent,
    detailedLogs: state.settings.detailedLogs !== false,
    ...runnerHarvestHooks(),
  });
  persistSettings();
  return snapshot();
});

ipcMain.handle("desktop:validate-license", async () => {
  const res = await license.validateApiKey({
    controlPlaneUrl: state.settings.controlPlaneUrl,
    apiKey: state.settings.apiKey,
  });
  state.settings.licenseStatus = res.status;
  state.settings.licenseMessage = res.message || "";
  persistSettings();
  return { ...res, snapshot: snapshot() };
});

async function bootEngine() {
  if (sidecar.status().running) {
    return { ok: true, already: true, snapshot: snapshot() };
  }

  const lic = await license.validateApiKey({
    controlPlaneUrl: state.settings.controlPlaneUrl,
    apiKey: state.settings.apiKey,
  });
  state.settings.licenseStatus = lic.status;
  state.settings.licenseMessage = lic.message || "";
  persistSettings();
  if (!lic.ok) {
    return { ok: false, error: lic.message || "Invalid API key", snapshot: snapshot() };
  }

  let hyper = String(state.settings.hyperApiKey || "").trim();
  if (!hyper && state.settings.controlPlaneUrl && state.settings.apiKey) {
    const prov = await license.provisionHyper({
      controlPlaneUrl: state.settings.controlPlaneUrl,
      apiKey: state.settings.apiKey,
    });
    if (prov.ok) hyper = prov.hyperApiKey;
  }
  const capsolver = String(state.settings.capsolverApiKey || "").trim();
  // Bandai F5 does not require Hyper/CapSolver — don't block boot for Bandai-only setups.
  if (!hyper && !capsolver) {
    send({
      type: "job",
      phase: "log",
      level: "info",
      message: "Engine starting without Hyper/CapSolver — Kmart/Toymate/Disney need those keys in Settings",
    });
  }

  const started = await sidecar.startSidecar({
    hyperApiKey: hyper || undefined,
    paydockPublicKey: state.settings.paydockPublicKey,
    capsolverApiKey: capsolver || state.settings.capsolverApiKey,
    maxConcurrent: state.settings.maxConcurrent,
  });
  if (!started.ok) return { ...started, snapshot: snapshot() };

  runner.configure({
    maxConcurrent: state.settings.maxConcurrent,
    detailedLogs: state.settings.detailedLogs !== false,
    ...runnerHarvestHooks(),
  });
  wireProductCacheIntoRunner();
  // Inherit admin catalog + shared NAI cache (consumer zero-config).
  void pullProductCacheFromMonitor().then((r) => {
    if (r?.ok) {
      send({
        type: "job",
        phase: "log",
        level: "info",
        message: `Bandai product cache · ${r.count} SKU(s)${r.stamped ? ` · stamped ${r.stamped} task(s)` : ""}`,
      });
    }
  });
  void pullPresetCatalogFromMonitor().then((r) => {
    if (r?.ok) {
      send({
        type: "job",
        phase: "log",
        level: "info",
        message: `Action Store · ${r.count} SKU(s)`,
      });
      send({ type: "snapshot", data: snapshot() });
    }
  });
  runner.start();
  const mon = bandaiGlobalMonitor.start();
  if (mon.ok && !mon.skipped) {
    send({
      type: "job",
      phase: "log",
      level: "info",
      message: "Monitor connected",
    });
    // Refresh UI once admin watchlist lands from /health.
    void bandaiGlobalMonitor.refreshAdminWatchlist?.().then(() => {
      send({ type: "snapshot", data: snapshot() });
    });
    const watchJobs = (state.db.tasks || [])
      .filter(
        (t) =>
          t.enabled !== false &&
          t.store === "bandai" &&
          String(t.bandaiMode || "") === "monitor" &&
          String(t.bandaiMonitorMode || "global").toLowerCase() === "global" &&
          t.bandaiCheckoutOnHit !== false,
      )
      .map((t) => ({ task: t, placeOrder: t.placeOrder !== false }));
    if (watchJobs.length) {
      try {
        bandaiHarvestAutoArm.ensureForJobs(watchJobs, {
          placeOrderDefault: state.settings.placeOrderDefault !== false,
        });
      } catch {
        /* best-effort */
      }
    }
  }
  send({ type: "snapshot", data: snapshot() });
  return {
    ok: true,
    snapshot: snapshot(),
    hyperConfigured: Boolean(hyper),
    capsolverConfigured: Boolean(capsolver),
  };
}

ipcMain.handle("desktop:start-engine", async () => bootEngine());

ipcMain.handle("desktop:stop-engine", async () => {
  bandaiGlobalMonitor.stop();
  harvest.stop();
  bandaiHarvestAutoArm.markManualStop();
  bandaiHarvest.stop();
  disneyHarvest.stop();
  try {
    await bandaiHarvest.clear();
  } catch {
    /* ignore */
  }
  try {
    disneyHarvest.clear();
  } catch {
    /* ignore */
  }
  runner.stop();
  await sidecar.stopSidecar();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, snapshot: snapshot() };
});

// ── Disney Akamai + CapSolver Harvest tab ─────────────────────────────
ipcMain.handle("desktop:disney-harvest-status", () => disneyHarvest.snapshot());

ipcMain.handle("desktop:disney-harvest-configure", (_e, patch) => {
  return disneyHarvest.configure(patch || {});
});

ipcMain.handle("desktop:disney-harvest-start", async (_e, opts = {}) => {
  const hyper = String(state.settings.hyperApiKey || "").trim();
  const capsolver = String(state.settings.capsolverApiKey || "").trim();
  if (!hyper) {
    return { ok: false, error: "Set Hyper API key in Settings first", snapshot: snapshot() };
  }
  if (!capsolver) {
    return { ok: false, error: "Set CapSolver API key in Settings first", snapshot: snapshot() };
  }
  if (!sidecar.status().running) {
    return {
      ok: false,
      error: "Start the engine first",
      harvest: disneyHarvest.snapshot(),
      snapshot: snapshot(),
    };
  }
  const gid = opts.proxyGroupId || disneyHarvest.snapshot().config.proxyGroupId;
  if (gid) disneyHarvest.configure({ proxyGroupId: gid });
  if (opts.desired != null) disneyHarvest.configure({ desired: opts.desired });
  if (opts.solveCaptcha != null) disneyHarvest.configure({ solveCaptcha: opts.solveCaptcha });
  const group = (state.db.proxyGroups || []).find((g) => g.id === gid);
  if (!group?.entries?.length) {
    return {
      ok: false,
      error: "Select a Proxies group with sticky AU ISP/residential lines",
      harvest: disneyHarvest.snapshot(),
      snapshot: snapshot(),
    };
  }
  const snap = disneyHarvest.start({
    proxyGroupId: gid,
    desired: opts.desired,
    solveCaptcha: opts.solveCaptcha,
    getEntries: disneyHarvestEntries,
  });
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:disney-harvest-stop", () => {
  const snap = disneyHarvest.stop();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:disney-harvest-clear", () => {
  const snap = disneyHarvest.clear();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:disney-harvest-once", async (_e, opts = {}) => {
  if (!sidecar.status().running) {
    return { ok: false, error: "Start the engine first", harvest: disneyHarvest.snapshot() };
  }
  if (opts.proxyGroupId) disneyHarvest.configure({ proxyGroupId: opts.proxyGroupId });
  if (opts.desired != null) disneyHarvest.configure({ desired: opts.desired });
  if (opts.solveCaptcha != null) disneyHarvest.configure({ solveCaptcha: opts.solveCaptcha });
  const out = await disneyHarvest.harvestOne(disneyHarvestEntries());
  send({ type: "snapshot", data: snapshot() });
  return { ...out, harvest: disneyHarvest.snapshot(), snapshot: snapshot() };
});

// ── Bandai F5 Harvest tab ──────────────────────────────────────────────
ipcMain.handle("desktop:bandai-harvest-status", () => bandaiHarvest.snapshot());

ipcMain.handle("desktop:bandai-harvest-configure", (_e, patch) => {
  return bandaiHarvest.configure(patch || {});
});

ipcMain.handle("desktop:bandai-harvest-start", async (_e, opts = {}) => {
  if (!sidecar.status().running) {
    return {
      ok: false,
      error: "Start the engine first",
      harvest: bandaiHarvest.snapshot(),
      snapshot: snapshot(),
    };
  }
  const gid = opts.proxyGroupId || bandaiHarvest.snapshot().config.proxyGroupId;
  if (gid) bandaiHarvest.configure({ proxyGroupId: gid });
  if (opts.desired != null) bandaiHarvest.configure({ desired: opts.desired });
  if (opts.area) bandaiHarvest.configure({ area: opts.area });
  const group = (state.db.proxyGroups || []).find((g) => g.id === gid);
  if (!group?.entries?.length) {
    return {
      ok: false,
      error: "Select a Proxies group with sticky AU ISP/residential lines",
      harvest: bandaiHarvest.snapshot(),
      snapshot: snapshot(),
    };
  }
  const snap = bandaiHarvest.start({
    proxyGroupId: gid,
    desired: opts.desired,
    area: opts.area,
    getEntries: bandaiHarvestEntries,
  });
  bandaiHarvestAutoArm.markManualStart();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:bandai-harvest-stop", () => {
  bandaiHarvestAutoArm.markManualStop();
  const snap = bandaiHarvest.stop();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:bandai-harvest-clear", async () => {
  const snap = await bandaiHarvest.clear();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:bandai-harvest-once", async (_e, opts = {}) => {
  if (!sidecar.status().running) {
    return { ok: false, error: "Start the engine first", harvest: bandaiHarvest.snapshot() };
  }
  if (opts.proxyGroupId) bandaiHarvest.configure({ proxyGroupId: opts.proxyGroupId });
  if (opts.desired != null) bandaiHarvest.configure({ desired: opts.desired });
  if (opts.area) bandaiHarvest.configure({ area: opts.area });
  const out = await bandaiHarvest.harvestOne(bandaiHarvestEntries());
  send({ type: "snapshot", data: snapshot() });
  return { ...out, harvest: bandaiHarvest.snapshot(), snapshot: snapshot() };
});

// ── Toymate Harvest tab ──────────────────────────────────────────────
ipcMain.handle("desktop:harvest-status", () => harvest.snapshot());

ipcMain.handle("desktop:harvest-configure", (_e, patch) => {
  return harvest.configure(patch || {});
});

ipcMain.handle("desktop:harvest-start", async (_e, opts = {}) => {
  const capsolver = String(state.settings.capsolverApiKey || "").trim();
  if (!capsolver) {
    return { ok: false, error: "Set CapSolver API key in Settings first", snapshot: snapshot() };
  }
  if (!sidecar.status().running) {
    const started = await sidecar.startSidecar({
      hyperApiKey: state.settings.hyperApiKey || undefined,
      paydockPublicKey: state.settings.paydockPublicKey,
      capsolverApiKey: capsolver,
      maxConcurrent: state.settings.maxConcurrent,
    });
    if (!started.ok) return { ...started, snapshot: snapshot() };
  }
  const gid = opts.proxyGroupId || harvest.snapshot().config.proxyGroupId;
  const group = state.db.proxyGroups.find((g) => g.id === gid);
  if (!group?.entries?.length) {
    return {
      ok: false,
      error: "Select a Proxies group with sticky AU ISP/residential lines",
      snapshot: snapshot(),
    };
  }
  const snap = harvest.start({
    proxyGroupId: gid,
    desired: opts.desired,
    solveSpam: opts.solveSpam,
    getEntries: harvestEntries,
  });
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:harvest-stop", () => {
  const snap = harvest.stop();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:harvest-clear", () => {
  const snap = harvest.clear();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:harvest-once", async (_e, opts = {}) => {
  const capsolver = String(state.settings.capsolverApiKey || "").trim();
  if (!capsolver) {
    return { ok: false, error: "Set CapSolver API key in Settings first" };
  }
  if (!sidecar.status().running) {
    const started = await sidecar.startSidecar({
      hyperApiKey: state.settings.hyperApiKey || undefined,
      paydockPublicKey: state.settings.paydockPublicKey,
      capsolverApiKey: capsolver,
      maxConcurrent: state.settings.maxConcurrent,
    });
    if (!started.ok) return started;
  }
  if (opts.proxyGroupId) harvest.configure({ proxyGroupId: opts.proxyGroupId });
  if (opts.desired != null) harvest.configure({ desired: opts.desired });
  if (opts.solveSpam != null) harvest.configure({ solveSpam: opts.solveSpam });
  const out = await harvest.harvestOne(harvestEntries());
  send({ type: "snapshot", data: snapshot() });
  return { ...out, harvest: harvest.snapshot(), snapshot: snapshot() };
});

// Profiles
ipcMain.handle("desktop:upsert-profile", (_e, profile) => {
  const now = Date.now();
  const profileGroup = String(profile?.profileGroup || "").trim().slice(0, 80);
  const accountGroup = String(profile?.accountGroup || "").trim().slice(0, 80);
  const proxyGroupId = profile?.proxyGroupId ? String(profile.proxyGroupId) : null;
  const next = { ...profile, profileGroup, accountGroup, proxyGroupId };
  if (profileGroup) {
    if (!state.db.profileGroupColors || typeof state.db.profileGroupColors !== "object") {
      state.db.profileGroupColors = {};
    }
    if (!Object.prototype.hasOwnProperty.call(state.db.profileGroupColors, profileGroup)) {
      state.db.profileGroupColors[profileGroup] = "";
    }
  }
  if (accountGroup) {
    if (!state.db.accountGroupColors || typeof state.db.accountGroupColors !== "object") {
      state.db.accountGroupColors = {};
    }
    if (!Object.prototype.hasOwnProperty.call(state.db.accountGroupColors, accountGroup)) {
      state.db.accountGroupColors[accountGroup] = "";
    }
  }
  if (next.id) {
    const i = state.db.profiles.findIndex((p) => p.id === next.id);
    if (i >= 0) state.db.profiles[i] = { ...state.db.profiles[i], ...next, updatedAt: now };
    else state.db.profiles.push({ ...next, createdAt: now, updatedAt: now });
  } else {
    state.db.profiles.push({ ...next, id: store.id("prof"), createdAt: now, updatedAt: now });
  }
  persistDb();
  return snapshot();
});

ipcMain.handle("desktop:delete-profile", (_e, profileId) => {
  state.db.profiles = state.db.profiles.filter((p) => p.id !== profileId);
  persistDb();
  return snapshot();
});

ipcMain.handle("desktop:duplicate-profile", (_e, profileId) => {
  const src = (state.db.profiles || []).find((p) => p.id === String(profileId || ""));
  if (!src) return { ok: false, error: "profile not found", snapshot: snapshot() };
  const draft = duplicateProfileDraft(src, (p) => store.id(p));
  state.db.profiles.push(draft);
  persistDb();
  return { ok: true, profile: draft, snapshot: snapshot() };
});

// Proxy groups — entries may include 127.0.0.1:PORT
ipcMain.handle("desktop:upsert-proxy-group", (_e, group) => {
  const now = Date.now();
  const entries = String(group.entriesText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const row = {
    id: group.id || store.id("px"),
    name: String(group.name || "Proxies").slice(0, 80),
    entries,
    updatedAt: now,
  };
  const i = state.db.proxyGroups.findIndex((g) => g.id === row.id);
  if (i >= 0) state.db.proxyGroups[i] = { ...state.db.proxyGroups[i], ...row };
  else state.db.proxyGroups.push({ ...row, createdAt: now });
  persistDb();
  return snapshot();
});

ipcMain.handle("desktop:delete-proxy-group", (_e, groupId) => {
  state.db.proxyGroups = state.db.proxyGroups.filter((g) => g.id !== groupId);
  persistDb();
  return snapshot();
});

ipcMain.handle("desktop:proxy-test-presets", () => ({
  ok: true,
  presets: PROXY_TEST_PRESETS,
}));

ipcMain.handle("desktop:test-proxy-group", async (_e, groupId, opts = {}) => {
  const group = (state.db.proxyGroups || []).find((g) => g.id === groupId);
  if (!group) return { ok: false, error: "Proxy group not found" };
  const tested = await testProxyEntries(group.entries || [], {
    timeoutMs: opts.timeoutMs,
    concurrency: opts.concurrency,
    targetUrl: opts.targetUrl,
  });
  let removed = 0;
  if (opts.removeDead === true && tested.results?.length) {
    const alive = tested.results.filter((r) => r.ok).map((r) => r.entry);
    removed = (group.entries || []).length - alive.length;
    group.entries = alive;
    group.updatedAt = Date.now();
    persistDb();
  }
  return {
    ...tested,
    groupId,
    name: group.name,
    removed,
    snapshot: snapshot(),
  };
});

ipcMain.handle("desktop:test-proxy-entries", async (_e, entriesText, opts = {}) => {
  const entries = String(entriesText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return testProxyEntries(entries, opts);
});

// Tasks
function upsertTaskRow(task) {
  const now = Date.now();
  const storeId = task.store || "kmart";
  const row = {
    id: task.id || store.id("task"),
    store: storeId,
    label: resolveTaskLabel({
      ...task,
      store: storeId,
      // Prefer PDP / watch fields already on the draft for empty labels.
      title: task.title || task.productName || task.label,
    }),
    taskGroup: String(task.taskGroup || "").trim().slice(0, 80),
    pdpUrl: String(task.pdpUrl || "").trim(),
    qty: Math.max(1, Math.min(20, Number(task.qty) || 1)),
    quantity: Math.max(1, Math.min(50, Number(task.quantity) || 1)), // how many parallel jobs
    profileId: task.profileId || null,
    proxyGroupId: task.proxyGroupId || null,
    placeOrder: task.placeOrder !== false,
    kmartMode: "current",
    // Toymate-only fields (ignored by Kmart / Bandai payload builders).
    toymateMode: storeId === "toymate" ? String(task.toymateMode || "checkout") : undefined,
    // Bandai-only fields (ignored by Kmart / Toymate payload builders).
    bandaiMode: (() => {
      if (storeId !== "bandai") return undefined;
      const raw = String(task.bandaiMode || "checkout").toLowerCase();
      // Raffle / Chance removed — coerce legacy rows to checkout.
      if (raw === "chance") return "checkout";
      if (["checkout", "atc", "monitor", "account_gen", "login_check"].includes(raw)) return raw;
      return "checkout";
    })(),
    bandaiCheckoutMode:
      storeId === "bandai"
        ? ["fast", "fast_undici", "safe"].includes(String(task.bandaiCheckoutMode || "").toLowerCase())
          ? String(task.bandaiCheckoutMode).toLowerCase()
          : "fast"
        : undefined,
    bandaiMonitorMode:
      storeId === "bandai" && String(task.bandaiMode || "") === "monitor"
        ? ["global", "local"].includes(String(task.bandaiMonitorMode || "").toLowerCase())
          ? String(task.bandaiMonitorMode).toLowerCase()
          : "local"
        : undefined,
    bandaiWatchSku:
      storeId === "bandai" && typeof task.bandaiWatchSku === "string"
        ? task.bandaiWatchSku.trim()
        : undefined,
    bandaiWatchKeywords:
      storeId === "bandai" && typeof task.bandaiWatchKeywords === "string"
        ? task.bandaiWatchKeywords.trim()
        : undefined,
    bandaiMonitorIntervalMs:
      storeId === "bandai"
        ? Math.max(2000, Number(task.bandaiMonitorIntervalMs) || 10000)
        : undefined,
    bandaiMonitorDelayMs:
      storeId === "bandai" ? Math.max(0, Number(task.bandaiMonitorDelayMs) || 0) : undefined,
    bandaiCheckoutOnHit:
      storeId === "bandai" && String(task.bandaiMode || "") === "monitor"
        ? task.bandaiCheckoutOnHit !== false
        : undefined,
    bandaiWatchdog:
      storeId === "bandai" &&
      ["checkout", "atc"].includes(String(task.bandaiMode || "checkout").toLowerCase())
        ? task.bandaiWatchdog !== false
        : undefined,
    bandaiAreaItemNo: (() => {
      if (storeId !== "bandai") return undefined;
      const raw =
        typeof task.bandaiAreaItemNo === "string"
          ? task.bandaiAreaItemNo.trim()
          : typeof task.bandaiBackendPid === "string"
            ? task.bandaiBackendPid.trim()
            : "";
      if (productCacheLib.isBackendPid(raw)) return raw;
      const sku = String(task.bandaiWatchSku || task.input || task.pdpUrl || "").match(
        /\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*)\b/i,
      )?.[1];
      const hit = sku ? lookupSharedProduct(sku, task.bandaiArea || "au") : null;
      return hit?.areaItemNo || raw || undefined;
    })(),
    campaignSn:
      storeId === "bandai" && typeof task.campaignSn === "string" ? task.campaignSn.trim() : undefined,
    // Disney Store AU fields (ignored by other stores).
    disneyMode:
      storeId === "disney"
        ? ["pay", "checkout", "atc", "warm", "monitor", "ge"].includes(
            String(task.disneyMode || "").toLowerCase(),
          )
          ? String(task.disneyMode).toLowerCase()
          : "pay"
        : undefined,
    // Pokémon Centre-only fields (ignored by other stores).
    pcMode:
      storeId === "pokemoncentre" || storeId === "pokemon" || storeId === "pokemoncenter"
        ? String(task.pcMode || "monitor")
        : undefined,
    pcLocale:
      storeId === "pokemoncentre" || storeId === "pokemon" || storeId === "pokemoncenter"
        ? String(task.pcLocale || "en-au")
        : undefined,
    paymentMethod: storeId === "toymate" ? String(task.paymentMethod || "credit_card") : undefined,
    accountPassword:
      (storeId === "toymate" || storeId === "bandai") && typeof task.accountPassword === "string"
        ? task.accountPassword
        : undefined,
    // auto = match vault by profile email; manual = accountId; guest = no login (Toymate).
    accountAssign:
      storeId === "toymate"
        ? ["auto", "manual", "guest"].includes(String(task.accountAssign || "").toLowerCase())
          ? String(task.accountAssign).toLowerCase()
          : "auto"
        : storeId === "bandai"
          ? ["auto", "manual"].includes(String(task.accountAssign || "").toLowerCase())
            ? String(task.accountAssign).toLowerCase()
            : "auto"
          : undefined,
    accountId:
      (storeId === "toymate" || storeId === "bandai") &&
      task.accountAssign === "manual" &&
      task.accountId
        ? String(task.accountId)
        : storeId === "toymate" || storeId === "bandai"
          ? null
          : undefined,
    enabled: task.enabled !== false,
    updatedAt: now,
  };
  const i = state.db.tasks.findIndex((t) => t.id === row.id);
  if (i >= 0) {
    const prev = state.db.tasks[i];
    const prevSku = String(prev.bandaiWatchSku || prev.pdpUrl || "")
      .match(/\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*)\b/i)?.[1]
      ?.toUpperCase();
    const nextSku = String(row.bandaiWatchSku || row.pdpUrl || "")
      .match(/\b(N\d{7,}[A-Za-z0-9]*|A\d{7,}[A-Za-z0-9]*)\b/i)?.[1]
      ?.toUpperCase();
    // New SKU / PDP → drop stale held cart + NAI from the previous product.
    if (prevSku && nextSku && prevSku !== nextSku) {
      row.heldCart = null;
      row.bandaiAreaItemNo = undefined;
    }
    state.db.tasks[i] = { ...prev, ...row };
  } else {
    state.db.tasks.push({ ...row, createdAt: now, lastStatus: "idle" });
  }
  persistDb();
  return state.db.tasks.find((t) => t.id === row.id);
}

ipcMain.handle("desktop:upsert-task", (_e, task) => {
  upsertTaskRow(task);
  return snapshot();
});

ipcMain.handle("desktop:delete-task", (_e, taskId) => {
  state.db.tasks = state.db.tasks.filter((t) => t.id !== taskId);
  persistDb();
  return snapshot();
});

ipcMain.handle("desktop:duplicate-task", (_e, taskId) => {
  const src = (state.db.tasks || []).find((t) => t.id === String(taskId || ""));
  if (!src) return { ok: false, error: "task not found", snapshot: snapshot() };
  const draft = duplicateTaskDraft(src, (p) => store.id(p));
  state.db.tasks.push(draft);
  persistDb();
  return { ok: true, task: draft, snapshot: snapshot() };
});

ipcMain.handle("desktop:delete-account", (_e, accountId) => {
  const id = String(accountId || "");
  state.db.accounts = (state.db.accounts || []).filter((a) => a.id !== id);
  persistDb();
  return snapshot();
});

ipcMain.handle("desktop:clear-accounts", (_e, storeId) => {
  const sid = storeId ? String(storeId) : "";
  if (sid) {
    state.db.accounts = (state.db.accounts || []).filter((a) => String(a.storeId || "") !== sid);
  } else {
    state.db.accounts = [];
  }
  persistDb();
  return snapshot();
});

ipcMain.handle("desktop:upsert-account", (_e, payload = {}) => {
  const normalized = normalizeManualAccount(payload);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error, snapshot: snapshot() };
  }
  const row = upsertAccountRow(normalized.account, {
    storeId: normalized.account.storeId,
    profileId: normalized.account.profileId,
    source: normalized.account.source || "manual",
  });
  persistDb();
  return { ok: true, account: row, snapshot: snapshot() };
});

ipcMain.handle("desktop:import-accounts", (_e, raw, opts = {}) => {
  const parsed = parseAccountsImport(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.errors.join("; ") || "import failed",
      errors: parsed.errors,
      imported: 0,
      snapshot: snapshot(),
    };
  }
  const replace = opts.replace === true;
  if (replace) state.db.accounts = [];
  let imported = 0;
  for (const draft of parsed.accounts) {
    const row = upsertAccountRow(draft, {
      storeId: draft.storeId,
      profileId: draft.profileId,
      source: draft.source || "import",
    });
    if (row) imported += 1;
  }
  persistDb();
  return {
    ok: true,
    imported,
    errors: parsed.errors,
    skipped: parsed.skipped,
    snapshot: snapshot(),
  };
});

ipcMain.handle("desktop:export-accounts", (_e, opts = {}) => {
  const sid = opts.storeId ? String(opts.storeId) : "";
  let list = Array.isArray(state.db.accounts) ? state.db.accounts : [];
  if (sid) list = list.filter((a) => String(a.storeId || "") === sid);
  const format = opts.format || "json";
  const body = formatAccountsExport(list, format);
  return {
    ok: true,
    format,
    count: list.length,
    body,
    filename: `j1ms-accounts-${sid || "all"}-${new Date().toISOString().slice(0, 10)}.${
      format === "csv" ? "csv" : format === "lines" ? "txt" : "json"
    }`,
  };
});

ipcMain.handle("desktop:import-profiles", (_e, raw, opts = {}) => {
  const parsed = parseProfilesImport(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.errors.join("; ") || "import failed",
      errors: parsed.errors,
      imported: 0,
      snapshot: snapshot(),
    };
  }
  if (opts.replace === true) state.db.profiles = [];
  let imported = 0;
  for (const draft of parsed.profiles) {
    const now = Date.now();
    const existing =
      (draft.id && state.db.profiles.find((p) => p.id === draft.id)) ||
      (draft.email &&
        state.db.profiles.find(
          (p) => String(p.email || "").toLowerCase() === String(draft.email).toLowerCase(),
        ));
    if (existing) {
      Object.assign(existing, draft, { id: existing.id, updatedAt: now });
    } else {
      state.db.profiles.push({ ...draft, id: draft.id || store.id("prof"), createdAt: now, updatedAt: now });
    }
    imported += 1;
  }
  persistDb();
  return { ok: true, imported, errors: parsed.errors, skipped: parsed.skipped, snapshot: snapshot() };
});

ipcMain.handle("desktop:export-profiles", (_e, opts = {}) => {
  const list = Array.isArray(state.db.profiles) ? state.db.profiles : [];
  const format = opts.format || "json";
  return {
    ok: true,
    format,
    count: list.length,
    body: formatProfilesExport(list, format),
    filename: `j1ms-profiles-${new Date().toISOString().slice(0, 10)}.${format === "csv" ? "csv" : "json"}`,
  };
});

ipcMain.handle("desktop:import-proxy-groups", (_e, raw, opts = {}) => {
  const parsed = parseProxyGroupsImport(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.errors.join("; ") || "import failed",
      errors: parsed.errors,
      imported: 0,
      snapshot: snapshot(),
    };
  }
  if (opts.replace === true) state.db.proxyGroups = [];
  let imported = 0;
  for (const draft of parsed.groups) {
    const now = Date.now();
    const existing =
      (draft.id && state.db.proxyGroups.find((g) => g.id === draft.id)) ||
      state.db.proxyGroups.find(
        (g) => String(g.name || "").toLowerCase() === String(draft.name || "").toLowerCase(),
      );
    if (existing) {
      existing.name = draft.name;
      existing.entries = draft.entries;
      existing.updatedAt = now;
    } else {
      state.db.proxyGroups.push({
        ...draft,
        id: draft.id || store.id("px"),
        createdAt: now,
        updatedAt: now,
      });
    }
    imported += 1;
  }
  persistDb();
  return { ok: true, imported, errors: parsed.errors, skipped: parsed.skipped, snapshot: snapshot() };
});

ipcMain.handle("desktop:export-proxy-groups", (_e, opts = {}) => {
  const list = Array.isArray(state.db.proxyGroups) ? state.db.proxyGroups : [];
  const format = opts.format || "json";
  return {
    ok: true,
    format,
    count: list.length,
    body: formatProxyGroupsExport(list, format),
    filename: `j1ms-proxies-${new Date().toISOString().slice(0, 10)}.${format === "csv" ? "csv" : "json"}`,
  };
});

ipcMain.handle("desktop:import-tasks", (_e, raw, opts = {}) => {
  const profilesByName = new Map(
    (state.db.profiles || []).map((p) => [String(p.name || "").toLowerCase(), p.id]),
  );
  const proxiesByName = new Map(
    (state.db.proxyGroups || []).map((g) => [String(g.name || "").toLowerCase(), g.id]),
  );
  const parsed = parseTasksImport(raw, { profilesByName, proxiesByName });
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.errors.join("; ") || "import failed",
      errors: parsed.errors,
      imported: 0,
      snapshot: snapshot(),
    };
  }
  if (opts.replace === true) state.db.tasks = [];
  let imported = 0;
  for (const draft of parsed.tasks) {
    const existing =
      (draft.id && state.db.tasks.find((t) => t.id === draft.id)) ||
      state.db.tasks.find(
        (t) =>
          String(t.label || "") === String(draft.label || "") &&
          String(t.taskGroup || "") === String(draft.taskGroup || "") &&
          String(t.store || "") === String(draft.store || ""),
      );
    upsertTaskRow({ ...draft, id: existing?.id || draft.id });
    imported += 1;
  }
  return { ok: true, imported, errors: parsed.errors, skipped: parsed.skipped, snapshot: snapshot() };
});

ipcMain.handle("desktop:export-tasks", (_e, opts = {}) => {
  const list = Array.isArray(state.db.tasks) ? state.db.tasks : [];
  const format = opts.format || "json";
  const body = formatTasksExport(list, format, {
    profileName: (id) => (state.db.profiles || []).find((p) => p.id === id)?.name || "",
    proxyGroupName: (id) => (state.db.proxyGroups || []).find((g) => g.id === id)?.name || "",
  });
  return {
    ok: true,
    format,
    count: list.length,
    body,
    filename: `j1ms-tasks-${new Date().toISOString().slice(0, 10)}.${format === "csv" ? "csv" : "json"}`,
  };
});

ipcMain.handle("desktop:run-tasks", (_e, taskIds, opts = {}) => enqueueTaskIds(taskIds, opts));

ipcMain.handle("desktop:run-task-group", (_e, opts = {}) => {
  const group = String(opts.taskGroup || "").trim();
  if (!group) return { ok: false, error: "Pick a task group" };
  const ids = tasksInGroup(group).map((t) => t.id);
  if (!ids.length) return { ok: false, error: `No tasks in group “${group}”` };
  // Re-enable before start so soft-stopped groups can fire again.
  for (const t of state.db.tasks || []) {
    if (ids.includes(t.id)) {
      t.enabled = true;
      t.updatedAt = Date.now();
    }
  }
  persistDb();
  const res = enqueueTaskIds(ids, opts);
  return { ...res, taskGroup: group, matched: ids.length, snapshot: snapshot() };
});

ipcMain.handle("desktop:stop-task-group", (_e, opts = {}) => {
  const group = String(opts.taskGroup || "").trim();
  if (!group) return { ok: false, error: "Pick a task group" };
  const ids = tasksInGroup(group).map((t) => t.id);
  if (!ids.length) return { ok: false, error: `No tasks in group “${group}”` };
  const set = new Set(ids);
  for (const t of state.db.tasks || []) {
    if (set.has(t.id)) {
      t.enabled = false;
      t.updatedAt = Date.now();
    }
  }
  persistDb();
  return { ok: true, taskGroup: group, stopped: ids.length, snapshot: snapshot() };
});

ipcMain.handle("desktop:patch-task-group", (_e, opts = {}) => {
  const group = String(opts.taskGroup || "").trim();
  if (!group) return { ok: false, error: "Pick a task group" };
  const ids = tasksInGroup(group).map((t) => t.id);
  if (!ids.length) return { ok: false, error: `No tasks in group “${group}”` };
  const patch = {};
  if (opts.qty != null && opts.qty !== "") {
    patch.qty = Math.max(1, Math.min(20, Number(opts.qty) || 1));
  }
  if (opts.quantity != null && opts.quantity !== "") {
    patch.quantity = Math.max(1, Math.min(50, Number(opts.quantity) || 1));
  }
  if (opts.bandaiMonitorDelayMs != null && opts.bandaiMonitorDelayMs !== "") {
    patch.bandaiMonitorDelayMs = Math.max(0, Number(opts.bandaiMonitorDelayMs) || 0);
  }
  if (!Object.keys(patch).length) {
    return { ok: false, error: "Set qty, parallel, or delay to apply" };
  }
  const set = new Set(ids);
  let updated = 0;
  for (const t of state.db.tasks || []) {
    if (!set.has(t.id)) continue;
    upsertTaskRow({ ...t, ...patch, id: t.id });
    updated += 1;
  }
  return { ok: true, taskGroup: group, updated, patch, snapshot: snapshot() };
});

ipcMain.handle("desktop:duplicate-task-group", (_e, opts = {}) => {
  const sourceGroup = String(opts.taskGroup || opts.sourceGroup || "").trim();
  const destGroup = String(opts.destGroup || "").trim() || undefined;
  const built = duplicateTaskGroupDrafts(
    state.db.tasks || [],
    sourceGroup,
    destGroup,
    (p) => store.id(p),
  );
  if (!built.ok) return { ok: false, error: built.error, snapshot: snapshot() };
  for (const draft of built.tasks) {
    state.db.tasks.push(draft);
  }
  // Carry color to the copy when source had an override.
  const srcKey = groupKey(sourceGroup);
  const destKey = groupKey(built.destGroup);
  const srcColor = state.db.taskGroupColors?.[srcKey];
  if (srcColor && destKey) {
    state.db.taskGroupColors[destKey] = srcColor;
  }
  persistDb();
  return {
    ok: true,
    sourceGroup,
    destGroup: built.destGroup,
    duplicated: built.tasks.length,
    snapshot: snapshot(),
  };
});

ipcMain.handle("desktop:set-task-group-color", (_e, opts = {}) => {
  const key = groupKey(opts.taskGroup || opts.group || "");
  if (!key) return { ok: false, error: "task group required", snapshot: snapshot() };
  const color = String(opts.color || "").trim();
  if (!state.db.taskGroupColors || typeof state.db.taskGroupColors !== "object") {
    state.db.taskGroupColors = {};
  }
  if (!color || color === "auto") {
    delete state.db.taskGroupColors[key];
  } else if (/^#[0-9a-fA-F]{3,8}$/.test(color)) {
    state.db.taskGroupColors[key] = color;
  } else {
    return { ok: false, error: "color must be #hex", snapshot: snapshot() };
  }
  persistDb();
  return {
    ok: true,
    taskGroup: key,
    color: colorForTaskGroup(key, state.db.taskGroupColors),
    snapshot: snapshot(),
  };
});

ipcMain.handle("desktop:discord-test", async (_e, opts = {}) => {
  const kind = ["success", "fail", "threeds", "monitor"].includes(String(opts.kind || ""))
    ? String(opts.kind)
    : "success";
  const url =
    resolveDiscordWebhookUrl(state.settings, kind) ||
    String(opts.url || "").trim() ||
    null;
  if (!url) {
    return { ok: false, error: `No webhook configured for ${kind}` };
  }
  const colors = { success: 0x8a9a8a, fail: 0xb07070, threeds: 0xc4b08a, monitor: 0x9098a8 };
  const payload = {
    username: "Vanta",
    embeds: [
      {
        title: `Webhook test · ${kind}`,
        description: "Desktop Settings ping — routing works if you see this.",
        color: colors[kind] || 0xc8c8cc,
        fields: [{ name: "Route", value: kind, inline: true }],
        timestamp: new Date().toISOString(),
        footer: { text: "Vanta · desktop" },
      },
    ],
  };
  const res = await postDiscordWebhook(url, payload);
  return { ...res, kind, urlHost: (() => { try { return new URL(url).host; } catch { return ""; } })() };
});

/**
 * Fire Autocheckout / ATC from a Railway global-monitor SSE hit
 * (monitor → checkout handoff, or watchdog on an idle Autocheckout/ATC lane).
 */
function enqueueGlobalMonitorCheckout(checkoutTask) {
  if (!sidecar.status().running) {
    return { ok: false, error: "engine not running" };
  }
  const mode = String(checkoutTask?.bandaiMode || "checkout").toLowerCase();
  const task = {
    ...checkoutTask,
    // Preserve ATC-only drop lanes; everything else runs full checkout.
    bandaiMode: mode === "atc" ? "atc" : "checkout",
  };
  const profile = (state.db.profiles || []).find((p) => p.id === task.profileId) || null;
  const group = (state.db.proxyGroups || []).find((g) => g.id === task.proxyGroupId);
  const entries = group?.entries || [];
  let proxyRaw = entries[0] || null;

  const resolved = resolveAccountForTask({
    task,
    profile,
    accounts: state.db.accounts || [],
  });
  if (resolved.error) {
    send({
      type: "job",
      phase: "log",
      level: "err",
      taskId: task.id,
      message: `Checkout blocked: ${resolved.error}`,
    });
    return { ok: false, error: resolved.error };
  }
  if (resolved.account) {
    task.account = {
      email: resolved.account.email,
      password: resolved.account.password,
      id: resolved.account.id,
    };
    task.accountAssignSource = resolved.source;
  }

  const harvestSession = bandaiHarvest.take();
  if (harvestSession?.id) {
    task.harvestedBridgeId = harvestSession.id;
    task.harvestedProxy = harvestSession.proxy;
    task.proxyOverride = harvestSession.proxy;
    proxyRaw = harvestSession.proxy;
    send({
      type: "job",
      phase: "log",
      level: "info",
      taskId: task.id,
      message: `Using warm harvest session (${harvestSession.proxyHost || "proxy"})`,
    });
  }

  const job = {
    task,
    profile,
    proxyRaw,
    proxyEntries: proxyRaw ? [proxyRaw] : entries.filter(Boolean),
    proxyIndex: 0,
    placeOrder: task.placeOrder !== false,
    accounts: state.db.accounts || [],
    settings: state.settings,
  };
  send({
    type: "job",
    phase: "log",
    level: "ok",
    taskId: task.id,
    message: `Global restock → Autocheckout ${task.pdpUrl || task.input || task.id}`,
  });
  runner.enqueue([job]);
  persistDb();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, enqueued: 1 };
}

/**
 * Build + enqueue jobs for task ids. Supports staggered fire for drop T0.
 */
function enqueueTaskIds(taskIds, opts = {}) {
  if (!sidecar.status().running) {
    return { ok: false, error: "Start the engine first (app must stay open)" };
  }
  const payFromCart = opts?.payFromCart === true;
  const ids = Array.isArray(taskIds) && taskIds.length ? taskIds : state.db.tasks.filter((t) => t.enabled).map((t) => t.id);
  const jobs = [];
  const claimedAccountIds = [];
  for (const tid of ids) {
    const task = state.db.tasks.find((t) => t.id === tid);
    if (!task) continue;
    if (payFromCart && task.store === "bandai" && !task.heldCart?.cartSn) {
      send({
        type: "job",
        phase: "done",
        taskId: tid,
        ok: false,
        error: "No held cart on this task — run checkout first",
      });
      continue;
    }
    const profile = state.db.profiles.find((p) => p.id === task.profileId);
    if (!profile) {
      send({ type: "job", phase: "done", taskId: tid, ok: false, error: "Assign a profile first" });
      continue;
    }
    const group = state.db.proxyGroups.find((g) => g.id === task.proxyGroupId);
    const entries = group?.entries?.length ? group.entries : [null];
    const n = payFromCart ? 1 : Math.max(1, Math.min(50, Number(task.quantity) || 1));
    let assignError = null;
    for (let i = 0; i < n; i++) {
      let proxyIndex = i % entries.length;
      const proxyRaw = entries[proxyIndex];
      const taskCopy = { ...task };
      if (payFromCart && task.store === "bandai") {
        taskCopy.bandaiPayFromCart = true;
        taskCopy.bandaiMode = "checkout";
        taskCopy.placeOrder = true;
        if (task.heldCart?.areaItemNo) {
          taskCopy.bandaiAreaItemNo = task.heldCart.areaItemNo;
        }
        taskCopy.heldCart = task.heldCart;
        send({
          type: "job",
          phase: "log",
          taskId: tid,
          level: "info",
          message: `Retry pay from held cart (cartSn=${task.heldCart.cartSn} — live verify)`,
        });
      }
      // Wire vault account into Toymate / Bandai checkout (auto by profile email, or manual).
      const needsVault =
        (task.store === "toymate" && String(task.toymateMode || "checkout") === "checkout") ||
        (task.store === "bandai" &&
          (["checkout", "atc", "login_check"].includes(String(task.bandaiMode || "checkout")) ||
            (String(task.bandaiMode || "") === "monitor" &&
              task.bandaiCheckoutOnHit !== false &&
              task.placeOrder !== false)));
      if (needsVault) {
        const resolved = resolveAccountForTask({
          task,
          profile,
          accounts: state.db.accounts || [],
          excludeIds: claimedAccountIds,
        });
        if (resolved.error) {
          assignError = resolved.error;
          break;
        }
        if (resolved.account) {
          claimedAccountIds.push(resolved.account.id);
          const acc = (state.db.accounts || []).find((a) => a.id === resolved.account.id);
          if (acc) {
            acc.lastUsedAt = Date.now();
            acc.updatedAt = Date.now();
          }
          taskCopy.account = {
            email: resolved.account.email,
            password: resolved.account.password,
            id: resolved.account.id,
          };
          taskCopy.accountAssignSource = resolved.source;
          taskCopy.resolvedAccountEmail = resolved.account.email;
        } else {
          taskCopy.account = null;
          taskCopy.accountAssignSource = "guest";
        }
      }
      let jobProxyRaw = proxyRaw;
      let jobProxyEntries = entries.filter(Boolean);
      // Toymate checkout: claim a harvested CF (+ spam) session when available.
      if (
        task.store === "toymate" &&
        String(task.toymateMode || "checkout") === "checkout"
      ) {
        const session = harvest.take({ preferSpam: true });
        if (session) {
          taskCopy.harvestedSession = session;
          taskCopy.captchaToken = session.captchaToken || taskCopy.captchaToken || null;
          if (session.proxy) {
            jobProxyRaw = session.proxy;
            jobProxyEntries = [session.proxy];
            proxyIndex = 0;
          }
          send({
            type: "job",
            phase: "log",
            taskId: tid,
            level: "info",
            message: `Using harvested CF session (${session.proxyHost || "proxy"}${session.captchaToken ? " + spam" : ""})`,
          });
        }
      }
      // Bandai Autocheckout: F5 harvest is claimed at run-start in job-runner
      // (not enqueue) so bank TTL stays fresh through the queue.
      // Disney checkout/pay: claim Akamai+CapSolver session when Harvest is armed.
      // Empty bank → cold path (warm + CapSolver on critical path) — unchanged.
      if (
        task.store === "disney" &&
        ["pay", "checkout", "atc", "ge"].includes(
          String(task.disneyMode || "pay").toLowerCase(),
        )
      ) {
        const session = disneyHarvest.take({ preferCaptcha: true });
        if (session?.cookies) {
          taskCopy.harvestedSession = session;
          taskCopy.recaptchaToken = session.captchaToken || taskCopy.recaptchaToken || null;
          if (session.proxy) {
            jobProxyRaw = session.proxy;
            jobProxyEntries = [session.proxy];
            proxyIndex = 0;
          }
          send({
            type: "job",
            phase: "log",
            taskId: tid,
            level: "info",
            message: `Using harvested Disney session (${session.proxyHost || "proxy"}${session.captchaToken ? " + captcha" : ""} age≈${Math.round((Date.now() - session.harvestedAt) / 1000)}s)`,
          });
        }
      }
      jobs.push({
        task: taskCopy,
        profile,
        proxyRaw: jobProxyRaw,
        proxyEntries: jobProxyEntries,
        proxyIndex,
        placeOrder: payFromCart ? true : task.placeOrder !== false,
        accounts: state.db.accounts || [],
        settings: state.settings,
      });
    }
    if (assignError) {
      send({ type: "job", phase: "done", taskId: tid, ok: false, error: assignError });
      task.lastStatus = "error";
      task.lastLabel = assignError;
      task.updatedAt = Date.now();
      continue;
    }
    task.lastStatus = "queued";
    task.lastLabel = "Queued";
    task.updatedAt = Date.now();
  }
  // Monitor → checkout: arm Bandai F5 harvest at enqueue (claim still at restock).
  try {
    const arm = bandaiHarvestAutoArm.ensureForJobs(jobs, {
      placeOrderDefault: state.settings.placeOrderDefault !== false,
    });
    if (arm?.armed) {
      send({
        type: "job",
        phase: "log",
        level: "info",
        message: `Harvest bank ${arm.ready ?? 0}/${arm.desired ?? "–"} (auto-arm for Monitor)`,
      });
    } else if (arm && arm.ok === false && arm.error) {
      send({ type: "job", phase: "log", level: "info", message: arm.error });
    }
  } catch (e) {
    send({
      type: "job",
      phase: "log",
      level: "err",
      message: `Bandai Harvest auto-arm failed: ${e?.message || e}`,
    });
  }
  persistDb();

  const useStagger = opts.stagger === true || opts.staggerGapMs != null;
  if (useStagger && jobs.length > 1) {
    const offsets = staggerOffsets(jobs.length, {
      gapMs: opts.staggerGapMs ?? 50,
      maxSpreadMs: 150,
    });
    jobs.forEach((job, i) => {
      setTimeout(() => {
        runner.enqueue([job]);
      }, offsets[i] || 0);
    });
    send({
      type: "job",
      phase: "log",
      level: "info",
      message: `Staggered enqueue ${jobs.length} lane(s) over ${offsets[offsets.length - 1] || 0}ms`,
    });
  } else {
    runner.enqueue(jobs);
  }
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, enqueued: jobs.length, staggered: useStagger, snapshot: snapshot() };
}

ipcMain.handle("desktop:drop-ready", () => ({ ok: true, ...dropReadySnapshot() }));

ipcMain.handle("desktop:drop-schedule-arm", (_e, opts = {}) => {
  const res = armDropSchedule(opts || {});
  return { ...res, snapshot: snapshot() };
});

ipcMain.handle("desktop:drop-schedule-cancel", () => {
  cancelDropSchedule();
  send({
    type: "job",
    phase: "log",
    level: "muted",
    message: "Drop schedule cancelled",
  });
  return { ok: true, snapshot: snapshot() };
});

ipcMain.handle("desktop:drop-mode-arm", async (_e, opts = {}) => {
  if (!sidecar.status().running) {
    return { ok: false, error: "Start the engine first", snapshot: snapshot() };
  }
  const plan = planDropMode({
    tasks: state.db.tasks,
    harvest: bandaiHarvest.snapshot(),
  });
  if (!plan.ok) return { ...plan, snapshot: snapshot() };

  bandaiHarvest.configure({
    proxyGroupId: plan.proxyGroupId,
    desired: plan.desired,
    area: plan.area || "au",
  });
  const snap = bandaiHarvest.start({
    proxyGroupId: plan.proxyGroupId,
    desired: plan.desired,
    area: plan.area || "au",
    getEntries: bandaiHarvestEntries,
  });
  bandaiHarvestAutoArm.markManualStart();
  send({
    type: "job",
    phase: "log",
    level: "ok",
    message: `Drop Mode armed — harvest desired ${plan.desired} for ${plan.lanes} lane(s)`,
  });

  // Optional: also arm schedule if fireAt provided
  let schedule = null;
  if (opts.fireAt) {
    schedule = armDropSchedule({
      fireAt: opts.fireAt,
      taskIds: plan.taskIds,
      staggerGapMs: opts.staggerGapMs ?? 50,
    });
  }

  return {
    ok: true,
    ...plan,
    harvest: snap,
    schedule,
    dropReady: dropReadySnapshot(),
    snapshot: snapshot(),
  };
});

ipcMain.handle("desktop:bandai-vault-login-check", async (_e, opts = {}) => {
  if (!sidecar.status().running) {
    return { ok: false, error: "Start the engine first", snapshot: snapshot() };
  }
  const accountIds = Array.isArray(opts.accountIds) ? opts.accountIds.map(String) : null;
  let accounts = (state.db.accounts || []).filter((a) => String(a.storeId || "") === "bandai");
  if (accountIds?.length) {
    accounts = accounts.filter((a) => accountIds.includes(a.id));
  } else {
    // Default: accounts tied to enabled drop tasks, else all ready/active Bandai.
    const dropTasks = listBandaiDropTasks(state.db.tasks);
    const linked = new Set();
    for (const t of dropTasks) {
      if (t.accountAssign === "manual" && t.accountId) linked.add(String(t.accountId));
    }
    if (linked.size) {
      accounts = accounts.filter((a) => linked.has(a.id));
    } else {
      accounts = accounts.filter((a) =>
        ["ready", "active", "created", "needs_sms"].includes(String(a.status || "").toLowerCase()),
      );
    }
  }
  accounts = accounts.filter((a) => a.email && a.password).slice(0, 8);
  if (!accounts.length) {
    return { ok: false, error: "No Bandai vault accounts to check", snapshot: snapshot() };
  }

  const harvestPx = bandaiHarvest.snapshot().config?.proxyGroupId;
  const group =
    (harvestPx && state.db.proxyGroups.find((g) => g.id === harvestPx)) ||
    state.db.proxyGroups.find((g) => g.entries?.length) ||
    null;
  const entries = group?.entries || [];
  if (!entries.length) {
    return { ok: false, error: "Pick a sticky proxy group on Harvest → Bandai first", snapshot: snapshot() };
  }

  const profile =
    state.db.profiles[0] || {
      id: "login-check-profile",
      email: accounts[0].email,
      first_name: "Alex",
      last_name: "Buyer",
    };

  const jobs = accounts.map((acc, i) => ({
    task: {
      id: `login_check_${acc.id}`,
      store: "bandai",
      bandaiMode: "login_check",
      label: `Login check ${acc.email}`,
      placeOrder: false,
      account: { email: acc.email, password: acc.password, id: acc.id },
      accountAssignSource: "vault_check",
      proxyGroupId: group.id,
    },
    profile,
    proxyRaw: entries[i % entries.length],
    proxyEntries: entries,
    proxyIndex: i % entries.length,
    placeOrder: false,
    accounts: state.db.accounts || [],
    settings: state.settings,
  }));

  send({
    type: "job",
    phase: "log",
    level: "info",
    message: `Vault login check — ${jobs.length} account(s)`,
  });
  runner.enqueue(jobs);
  return { ok: true, enqueued: jobs.length, snapshot: snapshot() };
});

// ── Monitor Feed / Quick Task / Smart Actions ──────────────────────────────

ipcMain.handle("desktop:monitor-feed", () => ({
  ok: true,
  feed: bandaiGlobalMonitor.getFeed?.() || [],
  monitor: bandaiGlobalMonitor.snapshot(),
}));

ipcMain.handle("desktop:monitor-feed-clear", () => {
  bandaiGlobalMonitor.clearFeed?.();
  try {
    store.saveMonitorFeed?.([]);
  } catch {
    /* ignore */
  }
  send({ type: "monitorFeed", cleared: true, feed: [] });
  return { ok: true, feed: [], snapshot: snapshot() };
});

ipcMain.handle("desktop:monitor-mute-sku", () => ({
  ok: false,
  error: "Mute SKUs from the admin dashboard (global), not per Desktop",
  snapshot: snapshot(),
}));

ipcMain.handle("desktop:monitor-event-log", (_e, opts = {}) => ({
  ok: true,
  events: readMonitorEvents(path.join(app.getPath("userData"), "j1ms-desktop"), {
    limit: Number(opts.limit) || 100,
  }),
}));

ipcMain.handle("desktop:checkout-run-log", (_e, opts = {}) => ({
  ok: true,
  runs: readCheckoutRuns(path.join(app.getPath("userData"), "j1ms-desktop"), {
    limit: Number(opts.limit) || 100,
  }),
}));

/**
 * Quick Task from pasted SKU/URL, monitor feed hit, or Discord deep-link.
 * Creates a task from Settings → Quick Task preset, optionally starts it,
 * and fires Smart Actions with trigger=quicktask.
 */
async function runQuickTaskPayload(payload = {}) {
  const preset = normalizeQuickTaskPreset(state.settings.quickTaskPreset || {});
  let target;
  if (payload.hit && payload.hit.productId) {
    target = targetFromMonitorHit(payload.hit, { area: payload.area || "au" });
  } else {
    target = parseBandaiProductInput(payload.input || payload.sku || payload.url || "", {
      area: payload.area || "au",
    });
  }
  if (!target.ok) {
    return { ok: false, error: target.error || "Invalid product", snapshot: snapshot() };
  }
  if (payload.title) target.title = payload.title;
  if (payload.hit?.areaItemNo && !target.areaItemNo) {
    target.areaItemNo = payload.hit.areaItemNo;
  }

  const built = buildQuickTaskDraft(preset, target, {
    // Only pass an explicit custom label — otherwise defaultTaskLabel builds SKU · title.
    label: payload.label || "",
  });
  if (!built.ok) {
    return { ok: false, error: built.error, snapshot: snapshot() };
  }
  if (!built.task.profileId) {
    return {
      ok: false,
      error: "Set a default profile in Settings → Quick Task preset",
      snapshot: snapshot(),
    };
  }

  const row = upsertTaskRow(built.task);
  const start =
    payload.start != null ? payload.start !== false : built.startAfterCreate !== false;
  let enqueue = null;
  if (start) {
    if (!sidecar.status().running) {
      return {
        ok: false,
        error: "Start the engine first (app must stay open)",
        task: row,
        snapshot: snapshot(),
      };
    }
    enqueue = enqueueTaskIds([row.id], {});
    if (!enqueue.ok) {
      return {
        ok: false,
        error: enqueue.error || "Could not start task",
        task: row,
        snapshot: snapshot(),
      };
    }
  }

  const ctx = contextFromQuickTask(target, {
    store: preset.store,
    label: row.label,
  });
  void smartActions.handleQuickTaskContext(ctx);

  const src = payload.source ? ` (${payload.source})` : "";
  send({
    type: "job",
    phase: "log",
    level: "ok",
    message: `Quick Task ${start ? "started" : "created"}${src} — ${row.label || row.id}`,
  });
  send({ type: "snapshot", data: snapshot() });
  try {
    win?.show();
    win?.focus();
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    task: row,
    started: Boolean(start && enqueue?.ok),
    enqueued: enqueue?.enqueued || 0,
    snapshot: snapshot(),
  };
}

async function handleQuickTaskDeepLink(rawUrl) {
  const parsed = parseQuickTaskDeepLink(rawUrl);
  if (!parsed.ok) {
    send({
      type: "job",
      phase: "log",
      level: "err",
      message: `Quick Task link failed: ${parsed.error}`,
    });
    return { ok: false, error: parsed.error };
  }
  return runQuickTaskPayload({ ...parsed.payload, source: parsed.payload.source || "discord" });
}

const quickTaskBridge = createQuickTaskBridge({
  onQuickTask: (payload) => runQuickTaskPayload({ ...payload, source: "discord" }),
  onOpenSetup: () => {
    try {
      win?.show();
      win?.focus();
    } catch {
      /* ignore */
    }
    send({ type: "navigate", tab: "settings", focus: "quickTaskPreset" });
    send({
      type: "job",
      phase: "log",
      level: "info",
      message: "Opened Settings → Quick Task preset (Discord)",
    });
  },
  port: QT_BRIDGE_PORT,
  log: (message) =>
    send({ type: "job", phase: "log", level: "info", message: String(message || "") }),
});

ipcMain.handle("desktop:quick-task", async (_e, payload = {}) => runQuickTaskPayload(payload));

ipcMain.handle("desktop:smart-actions-list", () => ({
  ok: true,
  ...smartActions.snapshot(),
}));

ipcMain.handle("desktop:store-groups-list", () => ({
  ok: true,
  storeGroups: state.db.storeGroups || [],
}));

ipcMain.handle("desktop:store-group-upsert", (_e, raw = {}) => {
  const list = Array.isArray(state.db.storeGroups) ? [...state.db.storeGroups] : [];
  const row = normalizeStoreGroup(raw, (p) => store.id(p || "sg"));
  if (!row.stores.length) {
    return { ok: false, error: "Pick at least one store", snapshot: snapshot() };
  }
  const i = list.findIndex((g) => g.id === row.id);
  if (i >= 0) {
    row.createdAt = list[i].createdAt || row.createdAt;
    list[i] = row;
  } else {
    if (list.length >= 50) {
      return { ok: false, error: "Store group limit (50) reached", snapshot: snapshot() };
    }
    list.push(row);
  }
  state.db.storeGroups = list;
  persistDb();
  return { ok: true, storeGroup: row, snapshot: snapshot() };
});

ipcMain.handle("desktop:store-group-delete", (_e, groupId) => {
  const id = String(groupId || "");
  state.db.storeGroups = (state.db.storeGroups || []).filter((g) => g.id !== id);
  persistDb();
  return { ok: true, snapshot: snapshot() };
});

ipcMain.handle("desktop:store-group-clone", (_e, groupId) => {
  const src = findStoreGroup(state.db.storeGroups || [], groupId);
  if (!src) return { ok: false, error: "Store group not found", snapshot: snapshot() };
  const list = Array.isArray(state.db.storeGroups) ? [...state.db.storeGroups] : [];
  if (list.length >= 50) {
    return { ok: false, error: "Store group limit (50) reached", snapshot: snapshot() };
  }
  const row = cloneStoreGroup(src, (p) => store.id(p || "sg"));
  list.push(row);
  state.db.storeGroups = list;
  persistDb();
  return { ok: true, storeGroup: row, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-upsert", (_e, action) => {
  const row = smartActions.upsert(action || {});
  return { ok: true, action: row, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-delete", (_e, actionId) => {
  smartActions.remove(String(actionId || ""));
  return { ok: true, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-set-enabled", (_e, actionId, enabled) => {
  const on = enabled !== false;
  const row = smartActions.setEnabled(String(actionId || ""), on);
  if (row && !on) {
    send({
      type: "toast",
      message:
        "Smart Action off — in-flight waits cancelled. Watchdog / muted SKUs are separate.",
      level: "muted",
    });
  }
  return { ok: Boolean(row), action: row, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-logs", (_e, actionId) => ({
  ok: true,
  logs: smartActions.getLogs(String(actionId || "")),
}));

ipcMain.handle("desktop:smart-action-catalog-get", () => ({
  ok: true,
  catalog: normalizeCatalogState(state.db.smartActionCatalog),
  templates: listTemplates().map(catalogTemplatePublic),
  quickPackIds: QUICK_PACK_IDS,
}));

ipcMain.handle("desktop:smart-action-catalog-save", (_e, patch = {}) => {
  const cur = normalizeCatalogState(state.db.smartActionCatalog);
  if (Array.isArray(patch.rows)) {
    cur.rows = patch.rows.map((r) => normalizeCatalogRow(r, (p) => store.id(p)));
  }
  if (patch.enabledTemplateIds !== undefined) {
    cur.enabledTemplateIds = Array.isArray(patch.enabledTemplateIds)
      ? patch.enabledTemplateIds.map(String)
      : null;
  }
  state.db.smartActionCatalog = cur;
  persistDb();
  return { ok: true, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-catalog-add-bulk", (_e, text = "", opts = {}) => {
  const cur = normalizeCatalogState(state.db.smartActionCatalog);
  const parsed = parseCatalogBulk(text, { defaultStore: opts.defaultStore || "bandai" });
  const byKey = new Map(cur.rows.map((r) => [`${r.store}::${r.sku}`, r]));
  let added = 0;
  for (const row of parsed) {
    const key = `${row.store}::${row.sku}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.title = row.title || existing.title;
      existing.taskGroup = row.taskGroup || existing.taskGroup;
      existing.enabled = true;
    } else {
      const next = normalizeCatalogRow(
        { ...row, id: store.id("cat") },
        (p) => store.id(p),
      );
      cur.rows.push(next);
      byKey.set(key, next);
      added += 1;
    }
  }
  state.db.smartActionCatalog = cur;
  persistDb();
  return { ok: true, added, total: cur.rows.length, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-catalog-apply", (_e, opts = {}) => {
  const catalog = normalizeCatalogState(state.db.smartActionCatalog);
  if (Array.isArray(opts.enabledTemplateIds)) {
    catalog.enabledTemplateIds = opts.enabledTemplateIds.map(String);
    state.db.smartActionCatalog = catalog;
    persistDb();
  }
  const result = applyCatalog({
    catalog,
    upsert: (draft) => smartActions.upsert(draft),
    list: () => smartActions.list(),
    remove: (id) => smartActions.remove(id),
    pruneMissing: opts.pruneMissing === true,
  });
  return { ok: true, ...result, snapshot: snapshot() };
});

/**
 * Toggle packs on/off: persist selection, upsert actions for ON packs,
 * enable/disable existing catalog actions to match (no install step).
 */
/**
 * Pull Action Store SKU library from Railway monitor admin (source of truth).
 */
async function pullPresetCatalogFromMonitor() {
  const s = state.settings || {};
  const base =
    String(s.bandaiGlobalMonitorUrl || s.globalMonitorUrl || "")
      .trim()
      .replace(/\/+$/, "") || "https://j1ms-bandai-monitor-production.up.railway.app";
  if (!base) return { ok: false, error: "Monitor unavailable" };
  const token = String(s.bandaiGlobalMonitorToken || "").trim();
  const url = `${base}/preset-catalog`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (e) {
    return { ok: false, error: e?.message || "fetch failed" };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: body.error || `HTTP ${res.status}`, status: res.status };
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  // Also refresh shared NAI cache so members skip public resolve.
  const cachePull = await pullProductCacheFromMonitor().catch(() => ({ ok: false }));
  const cur = normalizeCatalogState(state.db.smartActionCatalog);
  const prevByKey = new Map(
    (cur.rows || []).map((r) => [`${r.store}::${r.sku}`.toLowerCase(), r]),
  );
  const draftRows = rows.map((r) => {
    const hit = lookupSharedProduct(r.sku, r.area || "au");
    const prev = prevByKey.get(
      `${String(r.store || "bandai").toLowerCase()}::${String(r.sku || "").toLowerCase()}`,
    );
    return normalizeCatalogRow(
      {
        ...r,
        areaItemNo: r.areaItemNo || hit?.areaItemNo || "",
        title: r.title || hit?.title || r.sku,
        imageUrl:
          r.imageUrl ||
          r.image ||
          hit?.imageUrl ||
          prev?.imageUrl ||
          "",
        // Keep local per-SKU pack choices across Refresh
        enabledTemplateIds: Array.isArray(r.enabledTemplateIds)
          ? r.enabledTemplateIds
          : prev?.enabledTemplateIds || [],
        id: r.id || prev?.id || store.id("cat"),
      },
      (p) => store.id(p),
    );
  });
  // Pull storefront images for Bandai SKUs that still lack one.
  const imageEnrich = await enrichRowsWithBandaiImages(draftRows).catch(() => ({
    rows: draftRows,
    filled: 0,
  }));
  cur.rows = imageEnrich.rows || draftRows;
  // Seed local cache from catalog rows that already carry NAI / image.
  for (const r of cur.rows) {
    if (r.store === "bandai" && r.sku) {
      rememberLocalProduct({
        sku: r.sku,
        areaItemNo: r.areaItemNo,
        title: r.title,
        imageUrl: r.imageUrl,
        area: r.area || "au",
        source: "catalog",
      });
    }
  }
  cur.source = "monitor";
  cur.remoteUpdatedAt = body.updatedAt || null;
  cur.pulledAt = Date.now();
  state.db.smartActionCatalog = cur;
  persistDb();
  return {
    ok: true,
    count: cur.rows.length,
    imagesFilled: imageEnrich.filled || 0,
    updatedAt: cur.remoteUpdatedAt,
    rows: cur.rows,
    productCacheCount: cachePull.ok ? cachePull.count : Object.keys(ensureProductCache().entries || {}).length,
  };
}

function syncCatalogActionsFromRows() {
  const catalog = normalizeCatalogState(state.db.smartActionCatalog);
  state.db.smartActionCatalog = catalog;
  persistDb();

  const keepIds = new Set();
  let applied = { createdOrUpdated: 0, rowCount: 0, templateCount: 0, pairs: 0 };
  if ((catalog.rows || []).some((r) => r.enabled !== false && r.sku)) {
    applied = applyCatalog({
      catalog,
      upsert: (draft) => {
        const row = smartActions.upsert({ ...draft, enabled: true });
        keepIds.add(row?.id || draft.id);
        return row;
      },
      list: () => smartActions.list(),
      remove: (id) => smartActions.remove(id),
      pruneMissing: true,
    });
    for (const d of applied.actions || []) keepIds.add(d.id);
  }

  // Disable (or prune) catalog actions that are no longer selected on any SKU.
  let enabled = 0;
  let disabled = 0;
  for (const sa of smartActions.list()) {
    if (!sa?.catalogKey && !String(sa.id || "").startsWith("sa_cat_")) continue;
    const on = keepIds.has(sa.id);
    smartActions.setEnabled(sa.id, on);
    if (on) enabled += 1;
    else disabled += 1;
  }

  return {
    ok: true,
    enabled,
    disabled,
    createdOrUpdated: applied.createdOrUpdated || 0,
    rowCount: applied.rowCount || catalog.rows.length,
    templateCount: applied.templateCount || 0,
    pairs: applied.pairs || 0,
    snapshot: snapshot(),
  };
}

ipcMain.handle("desktop:smart-action-catalog-pull", async () => {
  const pulled = await pullPresetCatalogFromMonitor();
  if (!pulled.ok) return { ...pulled, snapshot: snapshot() };
  const synced = syncCatalogActionsFromRows();
  return {
    ok: true,
    count: pulled.count,
    updatedAt: pulled.updatedAt,
    snapshot: synced.snapshot,
  };
});

ipcMain.handle("desktop:smart-action-catalog-sync", (_e, opts = {}) => {
  const catalog = normalizeCatalogState(state.db.smartActionCatalog);
  // Legacy global pack list (optional)
  if (Array.isArray(opts.enabledTemplateIds)) {
    catalog.enabledTemplateIds = opts.enabledTemplateIds.map(String);
  } else if (opts.enabledTemplateIds === null) {
    catalog.enabledTemplateIds = null;
  }
  // Per-SKU pack patch
  if (opts.rowId != null && Array.isArray(opts.rowEnabledTemplateIds)) {
    const id = String(opts.rowId);
    catalog.rows = catalog.rows.map((r) =>
      r.id === id
        ? {
            ...r,
            enabledTemplateIds: opts.rowEnabledTemplateIds.map(String).filter(Boolean),
          }
        : r,
    );
  }
  if (Array.isArray(opts.rows)) {
    catalog.rows = opts.rows.map((r) => normalizeCatalogRow(r, (p) => store.id(p)));
  }
  state.db.smartActionCatalog = catalog;
  persistDb();
  return syncCatalogActionsFromRows();
});

ipcMain.handle("desktop:smart-action-catalog-set-row-packs", (_e, opts = {}) => {
  const rowId = String(opts.rowId || "");
  const packs = Array.isArray(opts.enabledTemplateIds)
    ? opts.enabledTemplateIds.map(String).filter(Boolean)
    : [];
  if (!rowId) return { ok: false, error: "rowId required", snapshot: snapshot() };
  const catalog = normalizeCatalogState(state.db.smartActionCatalog);
  const idx = catalog.rows.findIndex((r) => r.id === rowId);
  if (idx < 0) return { ok: false, error: "SKU not found", snapshot: snapshot() };
  catalog.rows[idx] = { ...catalog.rows[idx], enabledTemplateIds: packs };
  state.db.smartActionCatalog = catalog;
  persistDb();
  return syncCatalogActionsFromRows();
});

ipcMain.handle("desktop:smart-action-catalog-remove-actions", (_e, opts = {}) => {
  const ids = removeCatalogActions(smartActions.list(), opts || {});
  for (const id of ids) smartActions.remove(id);
  return { ok: true, removed: ids.length, ids, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-catalog-delete-row", (_e, rowId) => {
  const cur = normalizeCatalogState(state.db.smartActionCatalog);
  const id = String(rowId || "");
  cur.rows = cur.rows.filter((r) => r.id !== id);
  state.db.smartActionCatalog = cur;
  // Also remove materialized actions for this row
  const ids = removeCatalogActions(smartActions.list(), { rowId: id });
  for (const saId of ids) smartActions.remove(saId);
  persistDb();
  return { ok: true, removedActions: ids.length, snapshot: snapshot() };
});

/** Seed creator from a feed hit (returns draft filters — UI opens SA editor). */
ipcMain.handle("desktop:smart-action-from-hit", (_e, hit = {}) => {
  const ctx = contextFromMonitorHit(hit, { store: "bandai", area: "au" });
  const draft = smartActions.normalizeSmartAction(
    {
      name: `Monitor ${ctx.sku || ctx.title || "hit"}`.slice(0, 120),
      enabled: true,
      runOnce: false,
      runIntervalMs: 30000,
      notifications: true,
      trigger: { type: "product_monitor" },
      filters: [
        ...(ctx.sku
          ? [{ field: "sku", op: "matches", value: String(ctx.sku) }]
          : []),
        ...(ctx.title && ctx.title !== ctx.sku
          ? [{ field: "title", op: "matches", value: String(ctx.title).slice(0, 80) }]
          : []),
      ],
      actions: [
        {
          type: "create_tasks",
          config: {
            usePreset: true,
            store: "bandai",
            bandaiMode: "checkout",
            labelTemplate: "{{sku}} · {{title}}",
            count: 1,
          },
        },
        { type: "start_tasks", config: {} },
      ],
    },
    (prefix) => store.id(prefix || "sa"),
  );
  // Don't persist — UI decides Save.
  return { ok: true, draft, context: ctx };
});

async function featureSmokeToday() {
  // DESKTOP_FEATURE_SMOKE=1 — exercise today's Desktop builds then quit.
  const outPath =
    process.env.DESKTOP_SMOKE_OUT ||
    path.join(app.getPath("userData"), "j1ms-desktop", "feature-smoke.json");
  const checks = [];
  const pass = (name, ok, detail = "") => {
    checks.push({ name, ok: Boolean(ok), detail: String(detail || "") });
    console.log(`[feature-smoke] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    // Seed local license so engine can boot.
    if (!String(state.settings.apiKey || "").trim()) {
      state.settings.apiKey = "smoke-local-key";
      state.settings.controlPlaneUrl = "";
      persistSettings();
    }

    // ── Bulk import / export ──────────────────────────────────────────
    const profCsv =
      "name,email,first_name,last_name,phone,address1,address2,city,province,zip,country\n" +
      "Smoke,smoke@test.com,Smoke,Test,0400000000,1 Test St,,Sydney,NSW,2000,AU\n";
    const profParsed = parseProfilesImport(profCsv);
    pass("import_profiles_parse", profParsed.ok && profParsed.profiles.length === 1);
    for (const draft of profParsed.profiles) {
      state.db.profiles.push({
        ...draft,
        id: draft.id || store.id("prof"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    const pxParsed = parseProxyGroupsImport("name: Smoke ISP\n127.0.0.1:60000:u:p");
    pass("import_proxy_groups_parse", pxParsed.ok && pxParsed.groups[0]?.entries?.length === 1);
    for (const draft of pxParsed.groups) {
      state.db.proxyGroups.push({
        ...draft,
        id: draft.id || store.id("px"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    const taskParsed = parseTasksImport(
      "label,store,bandaiWatchSku,profileName,proxyGroupName,qty,bandaiMonitorDelayMs\nSmoke Gundam,bandai,N2890904001,Smoke,Smoke ISP,1,15000\n",
      {
        profilesByName: new Map([["smoke", state.db.profiles[0].id]]),
        proxiesByName: new Map([["smoke isp", state.db.proxyGroups[0].id]]),
      },
    );
    pass(
      "import_tasks_parse",
      taskParsed.ok &&
        taskParsed.tasks[0]?.bandaiWatchSku === "N2890904001" &&
        taskParsed.tasks[0]?.bandaiMonitorDelayMs === 15000,
      `sku=${taskParsed.tasks[0]?.bandaiWatchSku} delay=${taskParsed.tasks[0]?.bandaiMonitorDelayMs}`,
    );
    for (const draft of taskParsed.tasks) {
      state.db.tasks.push({
        ...draft,
        id: draft.id || store.id("task"),
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    persistDb();
    const expTasks = formatTasksExport(state.db.tasks, "csv", {
      profileName: (id) => state.db.profiles.find((p) => p.id === id)?.name || "",
      proxyGroupName: (id) => state.db.proxyGroups.find((g) => g.id === id)?.name || "",
    });
    pass("export_tasks_csv", /N2890904001/.test(expTasks) && /bandaiMonitorDelayMs/.test(expTasks));

    // ── Richer QT (Create only) ───────────────────────────────────────
    const { buildQuickTaskDeepLink, quickTaskDiscordComponents } = require("./deep-link.cjs");
    const createUrl = buildQuickTaskDeepLink(
      { productId: "N2890904001", title: "Smoke Gundam", area: "au" },
      { start: false },
    );
    pass("qt_create_only_url", /start=0/.test(createUrl), createUrl);
    const comps = quickTaskDiscordComponents({
      productId: "N2890904001",
      title: "Smoke Gundam",
      area: "au",
    });
    const labels = (comps?.[0]?.components || []).map((c) => c.label);
    pass(
      "qt_discord_create_only_button",
      labels.some((l) => /Create only/i.test(l)) &&
        /start=0/.test(comps[0].components.find((c) => /Create only/i.test(c.label))?.url || ""),
      labels.join(", "),
    );

    // ── Pre-drop delay tighten ────────────────────────────────────────
    const templates = listTemplates();
    const tighten = templates.find((t) => t.id === "drop_delay_tighten");
    pass(
      "sa_catalog_delay_tighten",
      Boolean(tighten) && String(tighten.trigger?.at || "") === "12:59:30",
      tighten?.trigger?.at || "missing",
    );
    const taskRow = state.db.tasks[0];
    taskRow.taskGroup = "SmokeDrop";
    taskRow.bandaiMonitorDelayMs = 15000;
    persistDb();
    smartActions.upsert({
      id: "sa_smoke_tighten",
      name: "Smoke delay tighten",
      enabled: true,
      runIntervalMs: 0,
      trigger: { type: "schedule", at: "12:59:30", tz: "UTC", repeat: "once" },
      actions: [
        {
          type: "update_tasks",
          config: {
            target: { scope: "group", taskGroup: "SmokeDrop" },
            bandaiMonitorDelayMs: 0,
          },
        },
      ],
    });
    const r2 = await smartActions.evaluateOne(
      smartActions.list().find((a) => a.id === "sa_smoke_tighten"),
      { source: "schedule", reason: "schedule" },
    );
    const after = state.db.tasks.find((t) => t.id === taskRow.id);
    pass(
      "sa_update_delay_zero",
      after?.bandaiMonitorDelayMs === 0 && r2?.outcome,
      `delay=${after?.bandaiMonitorDelayMs} outcome=${r2?.outcome}`,
    );

    const now = Date.UTC(2026, 6, 29, 12, 59, 30);
    smartActions.upsert({
      id: "sa_smoke_sec",
      name: "Smoke sec",
      enabled: true,
      runIntervalMs: 0,
      trigger: { type: "schedule", at: "12:59:30", tz: "UTC", repeat: "once" },
      actions: [{ type: "wait", config: { delayMs: 1 } }],
    });
    const miss = await smartActions.tickSchedule(now - 1000);
    const hit = await smartActions.tickSchedule(now);
    pass(
      "schedule_hhmmss",
      miss.length === 0 && hit.some((x) => x && !x.skipped),
      `miss=${miss.length} hit=${hit.length}`,
    );

    // ── Engine auto-start + UI chrome ─────────────────────────────────
    let engineOk = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (sidecar.status().running) {
        engineOk = true;
        break;
      }
      // Kick boot if auto-start hasn't landed yet.
      if (i === 2) await bootEngine();
    }
    pass("engine_running", engineOk, JSON.stringify(sidecar.status()));

    if (win && !win.isDestroyed()) {
      const dom = await win.webContents.executeJavaScript(`({
        exportTasks: !!document.getElementById("btnExportTasks"),
        exportProfiles: !!document.getElementById("btnExportProfiles"),
        exportProxies: !!document.getElementById("btnExportProxies"),
        importTasks: !!document.getElementById("btnImportTasks"),
        schedulePh: document.getElementById("saScheduleAt")?.getAttribute("placeholder") || "",
        scheduleLabel: document.querySelector("label[for=saScheduleAt], #saScheduleOpts label")?.textContent || "",
        delayHint: Array.from(document.querySelectorAll(".field-hint")).some(el => /pre-drop tighten|HH:MM:SS/i.test(el.textContent||"")),
        titlebar: !!document.querySelector(".titlebar"),
        homeTab: !!document.getElementById("tab-home"),
        taskDialog: !!document.getElementById("taskDialog"),
        toastHost: !!document.getElementById("toastHost"),
        settingsNav: !!document.querySelector(".settings-nav"),
        taskTable: !!document.getElementById("taskList") && document.getElementById("taskList").tagName === "TBODY",
        brand: document.querySelector(".titlebar-brand")?.textContent || "",
        homeStartBandai: !!document.getElementById("homeStartBandai"),
        homeChecklist: !!document.getElementById("homeChecklist"),
        homeStartCheckout: !!document.getElementById("homeStartCheckout"),
        topnavSep: !!document.querySelector(".topnav-sep"),
        saSkuGrid: !!document.querySelector("#saCatalogRows.sa-sku-grid"),
        saSkuDialog: !!document.getElementById("saSkuDialog"),
        saTemplateDialog: !!document.getElementById("saTemplateDialog"),
        saBuilder: !!document.getElementById("saBuilder"),
        saActionDialog: !!document.getElementById("saActionDialog"),
        saFilterDialog: !!document.getElementById("saFilterDialog"),
        saBuilderSave: !!document.getElementById("btnSaBuilderSave"),
      })`);
      pass(
        "ui_import_export_buttons",
        dom.exportTasks && dom.exportProfiles && dom.exportProxies && dom.importTasks,
        JSON.stringify(dom),
      );
      pass(
        "ui_schedule_seconds",
        /12:59:30/.test(dom.schedulePh) || /HH:MM:SS/i.test(dom.scheduleLabel) || dom.delayHint,
        JSON.stringify({ ph: dom.schedulePh, label: dom.scheduleLabel, hint: dom.delayHint }),
      );
      pass(
        "ui_vanta_shell",
        dom.titlebar &&
          dom.homeTab &&
          dom.taskDialog &&
          dom.toastHost &&
          dom.settingsNav &&
          dom.taskTable &&
          /VANTA/i.test(dom.brand),
        JSON.stringify(dom),
      );
      pass(
        "ui_home_start_here",
        dom.homeStartBandai && dom.homeChecklist && dom.homeStartCheckout && dom.topnavSep,
        JSON.stringify({
          homeStartBandai: dom.homeStartBandai,
          homeChecklist: dom.homeChecklist,
          homeStartCheckout: dom.homeStartCheckout,
          topnavSep: dom.topnavSep,
        }),
      );
      pass(
        "ui_sa_sku_store",
        dom.saSkuGrid && dom.saSkuDialog,
        JSON.stringify({ saSkuGrid: dom.saSkuGrid, saSkuDialog: dom.saSkuDialog }),
      );
      pass(
        "ui_sa_builder",
        dom.saTemplateDialog &&
          dom.saBuilder &&
          dom.saActionDialog &&
          dom.saFilterDialog &&
          dom.saBuilderSave,
        JSON.stringify({
          saTemplateDialog: dom.saTemplateDialog,
          saBuilder: dom.saBuilder,
          saActionDialog: dom.saActionDialog,
          saFilterDialog: dom.saFilterDialog,
          saBuilderSave: dom.saBuilderSave,
        }),
      );
    } else {
      pass("ui_import_export_buttons", false, "no window");
      pass("ui_schedule_seconds", false, "no window");
      pass("ui_vanta_shell", false, "no window");
      pass("ui_home_start_here", false, "no window");
      pass("ui_sa_sku_store", false, "no window");
      pass("ui_sa_builder", false, "no window");
    }

    const failed = checks.filter((c) => !c.ok);
    const payload = {
      ok: failed.length === 0,
      at: new Date().toISOString(),
      checks,
      failed: failed.map((c) => c.name),
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log("[feature-smoke] wrote", outPath, "ok=", payload.ok);
    if (process.env.DESKTOP_SMOKE_OUT) {
      try {
        fs.writeFileSync(process.env.DESKTOP_SMOKE_OUT, JSON.stringify(payload, null, 2));
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    const payload = { ok: false, error: e?.stack || String(e), checks };
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
      if (process.env.DESKTOP_SMOKE_OUT) {
        fs.writeFileSync(process.env.DESKTOP_SMOKE_OUT, JSON.stringify(payload, null, 2));
      }
    } catch {
      /* ignore */
    }
    console.error("[feature-smoke] fatal", e);
  }
  app.quit();
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

async function e2eAutorun() {
  // DESKTOP_E2E_AUTORUN=1 — start engine via Electron sidecar, enqueue like the UI
  // (vault account + settings), wait for completion, write result JSON, quit.
  // DESKTOP_E2E_PLACE_ORDER=1 → real pay. DESKTOP_E2E_TASK_ID=task_… → one task.
  const outPath = process.env.DESKTOP_E2E_OUT || require("path").join(app.getPath("userData"), "j1ms-desktop", "e2e-last.json");
  console.log("[e2e] autorun starting →", outPath);

  const started = await (async () => {
    // Reuse start-engine handler logic without license round-trip duplication.
    const lic = await license.validateApiKey({
      controlPlaneUrl: state.settings.controlPlaneUrl,
      apiKey: state.settings.apiKey,
    });
    if (!lic.ok) return { ok: false, error: lic.message || "license failed" };
    let hyper = String(state.settings.hyperApiKey || "").trim();
    const capsolver = String(state.settings.capsolverApiKey || "").trim();
    // Bandai F5 checkout does not need Hyper/CapSolver — match bootEngine.
    if (!hyper && !capsolver) {
      console.log(
        "[e2e] starting without Hyper/CapSolver — Bandai OK; Kmart/Toymate/Disney need keys",
      );
    }
    return sidecar.startSidecar({
      hyperApiKey: hyper || undefined,
      paydockPublicKey: state.settings.paydockPublicKey,
      capsolverApiKey: capsolver || state.settings.capsolverApiKey,
      maxConcurrent: state.settings.maxConcurrent,
    });
  })();

  if (!started.ok) {
    require("fs").writeFileSync(outPath, JSON.stringify({ ok: false, phase: "engine", error: started.error }, null, 2));
    console.error("[e2e] engine failed:", started.error);
    app.quit();
    return;
  }

  runner.configure({
    maxConcurrent: state.settings.maxConcurrent,
    detailedLogs: state.settings.detailedLogs !== false,
    ...runnerHarvestHooks(),
  });
  runner.start();

  const placeOrder = process.env.DESKTOP_E2E_PLACE_ORDER === "1";
  const onlyId = String(process.env.DESKTOP_E2E_TASK_ID || "").trim();
  const jobs = [];
  const claimedAccountIds = [];
  for (const task of state.db.tasks.filter((t) => t.enabled !== false)) {
    if (onlyId && task.id !== onlyId) continue;
    const profile = state.db.profiles.find((p) => p.id === task.profileId);
    if (!profile) {
      console.error("[e2e] task missing profile", task.id);
      continue;
    }
    const group = state.db.proxyGroups.find((g) => g.id === task.proxyGroupId);
    const entries = group?.entries?.length ? group.entries : [null];
    const taskCopy = { ...task, placeOrder, pwEdgeRetries: 5 };
    const needsVault =
      (task.store === "toymate" && String(task.toymateMode || "checkout") === "checkout") ||
      (task.store === "bandai" &&
        ["checkout", "atc", "login_check"].includes(String(task.bandaiMode || "checkout")));
    if (needsVault) {
      const resolved = resolveAccountForTask({
        task,
        profile,
        accounts: state.db.accounts || [],
        excludeIds: claimedAccountIds,
      });
      if (resolved.error) {
        console.error("[e2e] account assign failed", task.id, resolved.error);
        continue;
      }
      if (resolved.account) {
        claimedAccountIds.push(resolved.account.id);
        taskCopy.account = {
          email: resolved.account.email,
          password: resolved.account.password,
          id: resolved.account.id,
        };
        taskCopy.accountAssignSource = resolved.source;
      }
    }
    // One attempt for e2e (ignore quantity) — sticky retries can advance entries.
    jobs.push({
      task: taskCopy,
      profile,
      proxyRaw: entries[0] ?? null,
      proxyEntries: entries.filter(Boolean),
      proxyIndex: 0,
      placeOrder,
      accounts: state.db.accounts || [],
      settings: state.settings,
    });
  }

  if (!jobs.length) {
    require("fs").writeFileSync(
      outPath,
      JSON.stringify(
        {
          ok: false,
          phase: "enqueue",
          error: onlyId
            ? `no job for DESKTOP_E2E_TASK_ID=${onlyId}`
            : "no enabled tasks with profiles",
        },
        null,
        2,
      ),
    );
    console.error("[e2e] no jobs");
    app.quit();
    return;
  }

  let remaining = jobs.length;
  const results = [];
  const skuPoolPath = path.join(path.dirname(outPath), "e2e-sku-pool.json");
  const reachedPayment = (r) => {
    if (!r) return false;
    if (r.transactionId && String(r.transactionId) !== "0") return true;
    if (/declined|auth_failed|fraud/i.test(String(r.paymentStatus || ""))) return true;
    if (/^(tokenize|threeds|declined|payment)$/i.test(String(r.checkoutStage || ""))) return true;
    if (/ge_payment|tokenize|threeds|place_order|charge/i.test(String(r.failedStep || ""))) {
      return true;
    }
    if (/Payment declined|declined/i.test(String(r.consumerLabel || r.error || ""))) return true;
    // GetCartToken / GE after cart hold counts as payment path once ATC worked.
    const steps = Array.isArray(r.lastSteps) ? r.lastSteps : [];
    if (steps.some((s) => /ge_payment|threeds|place_order/i.test(String(s.step || "")))) {
      return true;
    }
    return false;
  };
  const isOosEnd = (r) => {
    if (!r || r.ok) return false;
    if (r.stockStatus === "oos" || r.consumerCode === "oos") return true;
    const blob = [r.error, r.debugError, r.consumerLabel, r.failedStep, ...(r.lastSteps || []).map((s) => s.note)]
      .filter(Boolean)
      .join("\n");
    return /EndOfSale|SoldOut|OutOfStock|CouldNotAddToCartBy(SoldOut|OutOfStock|EndOfSale)/i.test(blob);
  };
  const advanceSkuAndRequeue = (taskId) => {
    let poolDoc = null;
    try {
      poolDoc = JSON.parse(fs.readFileSync(skuPoolPath, "utf8"));
    } catch {
      return null;
    }
    const pool = Array.isArray(poolDoc?.pool) ? poolDoc.pool : [];
    let idx = Number(poolDoc.index) + 1;
    if (!Number.isFinite(idx) || idx < 0) idx = 1;
    if (idx >= pool.length) return null;
    const next = pool[idx];
    if (!next?.sku) return null;
    const t = state.db.tasks.find((x) => x.id === taskId);
    const baseJob = jobs.find((j) => j.task?.id === taskId) || jobs[0];
    if (!t || !baseJob) return null;
    t.bandaiWatchSku = next.sku;
    t.pdpUrl = `https://p-bandai.com/au/item/${next.sku}`;
    t.label = `${next.sku} · ${next.title || next.sku}`.slice(0, 120);
    t.bandaiAreaItemNo = next.areaItemNo || null;
    t.heldCart = null;
    t.bandaiPayFromCart = false;
    t.lastStatus = "idle";
    t.lastLabel = null;
    t.lastError = null;
    t.updatedAt = Date.now();
    persistDb();
    poolDoc.index = idx;
    fs.writeFileSync(skuPoolPath, JSON.stringify(poolDoc, null, 2));
    const taskCopy = {
      ...baseJob.task,
      ...t,
      placeOrder,
      pwEdgeRetries: 5,
      heldCart: null,
      bandaiPayFromCart: false,
      account: baseJob.task.account,
      accountAssignSource: baseJob.task.accountAssignSource,
    };
    const job = {
      ...baseJob,
      task: taskCopy,
      placeOrder,
    };
    console.log(
      "[e2e] OOS → next SKU",
      JSON.stringify({ sku: next.sku, index: idx, poolSize: pool.length }),
    );
    remaining += 1;
    runner.enqueue([job]);
    return next;
  };
  const finishE2e = () => {
    const bankHit = results.some(
      (r) =>
        r.transactionId &&
        String(r.transactionId) !== "0" &&
        !/RELOAD_ONLY|DataCorruption/i.test(String(r.note || "")),
    );
    const paymentAttempted = results.some(reachedPayment);
    const payload = {
      ok: results.some((r) => r.ok) || paymentAttempted,
      bankHit,
      paymentAttempted,
      viaElectron: true,
      results,
      at: Date.now(),
    };
    require("fs").writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(
      "[e2e] wrote",
      outPath,
      "ok=",
      payload.ok,
      "bankHit=",
      bankHit,
      "paymentAttempted=",
      paymentAttempted,
    );
    void (async () => {
      try {
        if (win) {
          await win.webContents.executeJavaScript(
            `document.querySelector('[data-tab="tasks"]')?.click(); true`,
          );
          await new Promise((r) => setTimeout(r, 400));
          const shotDir = path.dirname(outPath);
          fs.mkdirSync(shotDir, { recursive: true });
          const png = await win.capturePage();
          const shotPath = path.join(shotDir, "e2e-tasks-final.png");
          fs.writeFileSync(shotPath, png.toPNG());
          console.log("[e2e] screenshot", shotPath);
        }
      } catch (e) {
        console.warn("[e2e] screenshot failed", e?.message || e);
      } finally {
        setTimeout(() => app.quit(), 300);
      }
    })();
  };
  runner.setFinishedHandler((result) => {
    // Preserve normal persist path then capture for e2e.
    state.db.results.unshift({
      ok: result.ok,
      taskId: result.taskId,
      runId: result.runId,
      orderNumber: result.orderNumber || null,
      error: result.error || null,
      consumerLabel: result.consumerLabel || result.error || null,
      consumerCode: result.consumerCode || null,
      stockStatus: result.stockStatus || null,
      checkoutStage: result.checkoutStage || null,
      failedStep: result.failedStep || null,
      paymentStatus: result.paymentStatus || null,
      transactionId: result.transactionId || null,
      via: result.via || null,
      note: result.note || null,
      elapsedMs: result.elapsedMs ?? null,
      lastSteps: result.lastSteps || null,
      at: result.at || Date.now(),
    });
    state.db.results = state.db.results.slice(0, 200);
    if (result.taskId) {
      const t = state.db.tasks.find((x) => x.id === result.taskId);
      if (t) {
        t.lastStatus =
          result.consumerCode ||
          (result.ok ? (result.orderNumber ? "confirmed" : "complete") : "error");
        t.lastLabel = result.consumerLabel || (result.ok ? "Order confirmed" : result.error) || null;
        t.lastError = result.ok ? null : result.consumerLabel || result.error || null;
        t.lastOrderNumber = result.orderNumber || null;
        t.lastCheckoutStage = result.checkoutStage || null;
        t.stockStatus = result.stockStatus || null;
        t.updatedAt = Date.now();
      }
    }
    persistDb();
    results.push({
      ok: result.ok,
      taskId: result.taskId,
      runId: result.runId,
      checkoutStage: result.checkoutStage,
      failedStep: result.failedStep,
      paymentStatus: result.paymentStatus || null,
      transactionId: result.transactionId || null,
      via: result.via || null,
      note: result.note || null,
      isSameCartToken: result.isSameCartToken ?? null,
      error: result.error,
      consumerLabel: result.consumerLabel || null,
      elapsedMs: result.elapsedMs,
      lastSteps: (result.lastSteps || []).slice(-20).map((s) => ({
        step: s.step,
        ok: s.ok,
        status: s.status,
        note: String(s.note || "").slice(0, 280),
      })),
    });
    remaining -= 1;
    console.log(
      "[e2e] job done",
      JSON.stringify({
        ok: result.ok,
        failedStep: result.failedStep,
        stage: result.checkoutStage,
        paymentStatus: result.paymentStatus,
        tx: result.transactionId,
        remaining,
      }),
    );
    // Catalog items are often EndOfSale — advance SKU until payment (expect decline).
    if (!reachedPayment(result) && isOosEnd(result) && result.taskId) {
      const next = advanceSkuAndRequeue(result.taskId);
      if (next) return;
    }
    if (remaining <= 0) finishE2e();
  });

  runner.enqueue(jobs);
  console.log(
    "[e2e] enqueued",
    jobs.length,
    "placeOrder=",
    placeOrder,
    "task=",
    jobs.map((j) => j.task.id).join(","),
  );
}

app.whenReady().then(async () => {
  runner.configure({
    maxConcurrent: state.settings.maxConcurrent,
    detailedLogs: state.settings.detailedLogs !== false,
    ...runnerHarvestHooks(),
  });

  // Discord LINK buttons → http://127.0.0.1:17865/quicktask (app must stay open).
  try {
    await quickTaskBridge.start();
  } catch (e) {
    console.warn("[qt-bridge]", e?.message || e);
  }
  try {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(QT_PROTOCOL, process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient(QT_PROTOCOL);
    }
  } catch (e) {
    console.warn("[qt-protocol]", e?.message || e);
  }

  createWindow();

  // Engine boots with the app — users shouldn't manage Start/Stop.
  setTimeout(() => {
    void bootEngine().then((res) => {
      if (res?.ok) {
        send({
          type: "job",
          phase: "log",
          level: "info",
          message: res.already ? "Engine already running" : "Engine started with app",
        });
      } else if (res?.error) {
        send({
          type: "job",
          phase: "log",
          level: "err",
          message: `Engine auto-start: ${res.error}`,
        });
        send({ type: "snapshot", data: res.snapshot || snapshot() });
      }
    });
  }, 400);

  // Cold-start from j1ms:// or argv URL
  const argvUrl = [...process.argv, pendingQuickTaskUrl].find(
    (a) => typeof a === "string" && (/^j1ms:/i.test(a) || /\/quicktask\?/i.test(a)),
  );
  if (argvUrl) {
    setTimeout(() => {
      void handleQuickTaskDeepLink(argvUrl);
    }, 800);
  }
  pendingQuickTaskUrl = null;

  if (process.env.DESKTOP_FEATURE_SMOKE === "1") {
    // Let window + auto engine boot settle, then exercise today's features.
    setTimeout(() => {
      void featureSmokeToday();
    }, 2500);
  } else if (process.env.DESKTOP_LIVE_STATUS_DEMO === "1") {
    setTimeout(() => {
      void liveStatusDemo().catch((e) => {
        console.error("[live-status-demo] fatal", e);
        app.quit();
      });
    }, 2000);
  } else if (process.env.DESKTOP_E2E_AUTORUN === "1") {
    try {
      await e2eAutorun();
    } catch (e) {
      console.error("[e2e] fatal", e);
      app.quit();
    }
  }
});

/**
 * DESKTOP_LIVE_STATUS_DEMO=1 — drive live task-row statuses + PNG screenshots, then quit.
 * Does not place orders; exercises UI + emitter path only.
 */
async function liveStatusDemo() {
  const outDir =
    process.env.DESKTOP_DEMO_OUT ||
    (fs.existsSync("/opt/cursor/artifacts")
      ? "/opt/cursor/artifacts/bandai-live-status"
      : path.join(app.getPath("userData"), "live-status-demo"));
  fs.mkdirSync(outDir, { recursive: true });
  console.log("[live-status-demo] out →", outDir);

  // Seed a Bandai Autocheckout task for the Tasks table.
  const demoTask = upsertTaskRow({
    store: "bandai",
    label: "N2847890001 · Demo Gundam",
    bandaiWatchSku: "N2847890001",
    bandaiMode: "checkout",
    bandaiCheckoutMode: "fast",
    pdpUrl: "https://p-bandai.com/au/item/N2847890001",
    qty: 1,
    quantity: 1,
    placeOrder: false,
    enabled: true,
  });
  send({ type: "snapshot", data: snapshot() });

  // Open Tasks tab.
  for (let i = 0; i < 20 && !win; i++) await new Promise((r) => setTimeout(r, 200));
  if (!win) throw new Error("no window");
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-tab="tasks"]')?.click(); true`,
  );
  await new Promise((r) => setTimeout(r, 400));

  const frames = [
    { status: "queued", label: "Queued" },
    { status: "running", label: "Starting" },
    { status: "running", label: "Logging in" },
    { status: "running", label: "Loading product" },
    { status: "running", label: "Adding to cart" },
    { status: "running", label: "Checking out" },
    { status: "rotating", label: "Rotating proxy" },
    { status: "retry_atc", label: "Retrying ATC" },
    { status: "retry_pay", label: "Retrying pay" },
    { status: "waiting_restock", label: "Waiting for restock" },
    { status: "waiting_restock", label: "Out of stock — waiting" },
    { status: "declined", label: "Payment declined" },
  ];

  const saved = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    // Same path as real job-runner live status.
    send({
      type: "job",
      phase: "status",
      taskId: demoTask.id,
      consumerLabel: f.label,
      lastLabel: f.label,
      lastStatus: f.status,
    });
    send({
      type: "taskStatus",
      taskId: demoTask.id,
      lastStatus: f.status,
      lastLabel: f.label,
    });
    const t = state.db.tasks.find((x) => x.id === demoTask.id);
    if (t) {
      t.lastStatus = f.status;
      t.lastLabel = f.label;
    }
    await new Promise((r) => setTimeout(r, 350));
    const png = await win.capturePage();
    const name = `${String(i + 1).padStart(2, "0")}-${f.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")}.png`;
    const file = path.join(outDir, name);
    fs.writeFileSync(file, png.toPNG());
    saved.push(file);
    console.log("[live-status-demo] shot", name);
  }

  // Policy sanity board (text artifact).
  const {
    classifyBandaiRunResult,
  } = require("./bandai-retry-policy.cjs");
  const policyBoard = [
    {
      name: "403 SoftBlock",
      d: classifyBandaiRunResult({
        ok: false,
        failedStep: "login",
        debugError: "SoftBlock 403",
      }),
    },
    {
      name: "soft pay process",
      d: classifyBandaiRunResult({
        ok: false,
        failedStep: "ge_payment",
        debugError: "failed to process payment — try again",
        cartSn: 1,
        cartItemSn: 2,
        heldPayRetry: true,
        heldCart: { cartSn: 1, cartItemSn: 2 },
      }),
    },
    {
      name: "hard decline",
      d: classifyBandaiRunResult({
        ok: false,
        failedStep: "ge_payment",
        debugError: "do not honor",
        paymentStatus: "declined",
      }),
    },
    {
      name: "OOS",
      d: classifyBandaiRunResult(
        { ok: false, failedStep: "addToCart", debugError: "SoldOut" },
        { mode: "checkout" },
      ),
    },
  ].map((r) => ({
    case: r.name,
    action: r.d.action,
    liveLabel: r.d.liveLabel,
    reason: r.d.reason,
  }));
  fs.writeFileSync(
    path.join(outDir, "policy-board.json"),
    JSON.stringify({ ok: true, taskId: demoTask.id, frames: saved, policyBoard }, null, 2),
  );

  console.log("[live-status-demo] done", saved.length, "shots");
  app.quit();
}

if (gotLock) {
  app.on("second-instance", (_event, argv) => {
    const url = (argv || []).find(
      (a) => typeof a === "string" && (/^j1ms:/i.test(a) || /\/quicktask\?/i.test(a)),
    );
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (url) void handleQuickTaskDeepLink(url);
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) void handleQuickTaskDeepLink(url);
  else pendingQuickTaskUrl = url;
});

app.on("window-all-closed", async () => {
  stopSmartActionScheduleTicker();
  harvest.stop();
  bandaiHarvestAutoArm.markManualStop();
  bandaiHarvest.stop();
  try {
    await bandaiHarvest.clear();
  } catch {
    /* ignore */
  }
  try {
    await quickTaskBridge.stop();
  } catch {
    /* ignore */
  }
  runner.stop();
  await sidecar.stopSidecar();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  stopSmartActionScheduleTicker();
  harvest.stop();
  bandaiHarvestAutoArm.markManualStop();
  bandaiHarvest.stop();
  try {
    await bandaiHarvest.clear();
  } catch {
    /* ignore */
  }
  try {
    await quickTaskBridge.stop();
  } catch {
    /* ignore */
  }
  runner.stop();
  await sidecar.stopSidecar();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
