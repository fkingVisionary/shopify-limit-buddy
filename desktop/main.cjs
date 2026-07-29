// J1m's Bot Desktop — main process.
// Owns: BrowserWindow, local store, executor sidecar, job runner, license IPC.
// Does NOT execute Kmart checkout in-process — that stays in executor/ via sidecar.

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
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
const { createBandaiGlobalMonitorClient } = require("./bandai-global-monitor-client.cjs");
const { postDiscordWebhook, checkoutResultDiscordPayload } = require("./discord-webhook.cjs");
const { createSmartActionsEngine } = require("./smart-actions-engine.cjs");
const {
  defaultCatalogState,
  normalizeCatalogState,
  normalizeCatalogRow,
  parseCatalogBulk,
  applyCatalog,
  removeCatalogActions,
  listTemplates,
} = require("./smart-action-catalog.cjs");
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
    const url = state.settings.discordCheckoutWebhook || "";
    return postDiscordWebhook(url, payload);
  },
  emit: (evt) => send(evt),
});

/** Smart Action schedule trigger — fires at HH:MM in trigger tz while app is open. */
let smartActionScheduleTimer = null;
function startSmartActionScheduleTicker() {
  if (smartActionScheduleTimer) return;
  smartActionScheduleTimer = setInterval(() => {
    void smartActions.tickSchedule(Date.now()).then((results) => {
      if (Array.isArray(results) && results.some((r) => r && !r.skipped)) {
        send({ type: "snapshot", data: snapshot() });
      }
    });
  }, 15_000);
}
function stopSmartActionScheduleTicker() {
  if (smartActionScheduleTimer) clearInterval(smartActionScheduleTimer);
  smartActionScheduleTimer = null;
}
startSmartActionScheduleTicker();

/** Railway global monitor SSE — subscribed while engine is running. */
const bandaiGlobalMonitor = createBandaiGlobalMonitorClient({
  getSettings: () => state.settings,
  getTasks: () => state.db.tasks,
  emitLog: (message) =>
    send({ type: "job", phase: "log", level: "info", message: String(message || "") }),
  onCheckoutTask: async (task) => enqueueGlobalMonitorCheckout(task),
  onFeedHit: (hit) => {
    send({ type: "monitorFeed", hit });
    // Smart Actions Product Monitor trigger (orchestration only).
    void smartActions.handleMonitorHit(hit).then(() => {
      send({ type: "snapshot", data: snapshot() });
    });
  },
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
  win?.webContents.send("desktop:event", evt);
}

function persistDb() {
  store.saveDb(state.db);
}

function persistSettings() {
  store.saveSettings(state.settings);
}

/**
 * User Discord webhook — checkout success/fail only.
 * Global restock pings stay on the operator Railway webhook.
 */
async function notifyUserCheckoutDiscord(result) {
  if (!result || result.monitor === true && !result.checkout) return;
  if (result.accountGen || result.loginCheck) return;
  const url =
    state.settings.discordCheckoutWebhook ||
    state.settings.discordMonitorWebhook || // legacy key
    state.settings.discordWebhookUrl ||
    "";
  if (!url) return;
  const task = (state.db.tasks || []).find((t) => t.id === result.taskId);
  const storeId = task?.store || result.store || "checkout";
  // Skip pure monitor poll finishes with no checkout attempt.
  if (String(task?.bandaiMode || "") === "monitor" && !result.checkout && result.monitor) return;
  try {
    const payload = checkoutResultDiscordPayload(result, {
      store: storeId,
      label: task?.label || result.taskId,
    });
    await postDiscordWebhook(url, payload);
  } catch {
    /* ignore webhook errors */
  }
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
    lastUsedAt: existing?.lastUsedAt || account.lastUsedAt || null,
    lastLoginAt: account.lastLoginAt || existing?.lastLoginAt || null,
    loginProvenAt: account.loginProvenAt || existing?.loginProvenAt || null,
    createdAt: existing?.createdAt || account.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
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
    results: state.db.results.slice(-50),
    accounts: (state.db.accounts || []).slice(0, 500),
    runner: runner.state(),
    engine: sidecar.status(),
    harvest: harvest.snapshot(),
    bandaiHarvest: bandaiHarvest.snapshot(),
    disneyHarvest: disneyHarvest.snapshot(),
    bandaiGlobalMonitor: bandaiGlobalMonitor.snapshot(),
    smartActions: smartActions.snapshot(),
    smartActionCatalog: {
      ...normalizeCatalogState(state.db.smartActionCatalog),
      templates: listTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        blurb: t.blurb || "",
      })),
    },
    monitorFeed: bandaiGlobalMonitor.getFeed?.() || bandaiGlobalMonitor.snapshot().feed || [],
    quickTaskBridge: typeof quickTaskBridge !== "undefined" ? quickTaskBridge.snapshot() : null,
    dropSchedule: schedule,
    dropReady: dropReadySnapshot(),
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: "J1m's Bot",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

runner.setEmitter((evt) => send(evt));
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

  // Per-user Discord: checkout success/fail only (not global restocks).
  void notifyUserCheckoutDiscord(result);

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
  state.settings = next;
  runner.configure({
    maxConcurrent: state.settings.maxConcurrent,
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

ipcMain.handle("desktop:start-engine", async () => {
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
  if (!hyper && !capsolver) {
    return {
      ok: false,
      error:
        "Need Hyper (Kmart) and/or CapSolver (Toymate) in Settings before starting the engine",
      snapshot: snapshot(),
    };
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
    ...runnerHarvestHooks(),
  });
  runner.start();
  const mon = bandaiGlobalMonitor.start();
  if (mon.ok && !mon.skipped) {
    send({
      type: "job",
      phase: "log",
      level: "info",
      message: `Bandai global monitor subscribe → ${mon.url || state.settings.bandaiGlobalMonitorUrl}`,
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
  } else if (mon.skipped && mon.reason === "missing_url") {
    send({
      type: "job",
      phase: "log",
      level: "info",
      message: "Bandai global monitor skipped — set URL in Settings",
    });
  }
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, snapshot: snapshot(), hyperConfigured: Boolean(hyper), capsolverConfigured: Boolean(capsolver) };
});

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
  if (profile.id) {
    const i = state.db.profiles.findIndex((p) => p.id === profile.id);
    if (i >= 0) state.db.profiles[i] = { ...state.db.profiles[i], ...profile, updatedAt: now };
    else state.db.profiles.push({ ...profile, createdAt: now, updatedAt: now });
  } else {
    state.db.profiles.push({ ...profile, id: store.id("prof"), createdAt: now, updatedAt: now });
  }
  persistDb();
  return snapshot();
});

ipcMain.handle("desktop:delete-profile", (_e, profileId) => {
  state.db.profiles = state.db.profiles.filter((p) => p.id !== profileId);
  persistDb();
  return snapshot();
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

// Tasks
function upsertTaskRow(task) {
  const now = Date.now();
  const storeId = task.store || "kmart";
  const row = {
    id: task.id || store.id("task"),
    store: storeId,
    label: String(task.label || "").slice(0, 120),
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
    bandaiMode: storeId === "bandai" ? String(task.bandaiMode || "checkout") : undefined,
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
      storeId === "bandai" && task.bandaiMode === "monitor"
        ? Math.max(2000, Number(task.bandaiMonitorIntervalMs) || 10000)
        : undefined,
    bandaiMonitorDelayMs:
      storeId === "bandai" && task.bandaiMode === "monitor"
        ? Math.max(0, Number(task.bandaiMonitorDelayMs) || 0)
        : undefined,
    bandaiCheckoutOnHit:
      storeId === "bandai" && String(task.bandaiMode || "") === "monitor"
        ? task.bandaiCheckoutOnHit !== false
        : undefined,
    bandaiAreaItemNo:
      storeId === "bandai" && typeof task.bandaiAreaItemNo === "string"
        ? task.bandaiAreaItemNo.trim()
        : storeId === "bandai" && typeof task.bandaiBackendPid === "string"
          ? task.bandaiBackendPid.trim()
          : undefined,
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
  if (i >= 0) state.db.tasks[i] = { ...state.db.tasks[i], ...row };
  else state.db.tasks.push({ ...row, createdAt: now, lastStatus: "idle" });
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

ipcMain.handle("desktop:run-tasks", (_e, taskIds, opts = {}) => enqueueTaskIds(taskIds, opts));

/**
 * Fire Autocheckout from a Railway global-monitor SSE hit (task already switched to checkout).
 */
function enqueueGlobalMonitorCheckout(checkoutTask) {
  if (!sidecar.status().running) {
    return { ok: false, error: "engine not running" };
  }
  const task = { ...checkoutTask, bandaiMode: "checkout" };
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
      message: `Global monitor checkout blocked: ${resolved.error}`,
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
      message: `Using harvested F5 bridge (${harvestSession.proxyHost || "proxy"})`,
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
          (["checkout", "chance", "login_check"].includes(String(task.bandaiMode || "checkout")) ||
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
  send({ type: "monitorFeed", cleared: true, feed: [] });
  return { ok: true, feed: [], snapshot: snapshot() };
});

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
    label: payload.label || target.title || target.productId,
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

ipcMain.handle("desktop:smart-action-upsert", (_e, action) => {
  const row = smartActions.upsert(action || {});
  return { ok: true, action: row, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-delete", (_e, actionId) => {
  smartActions.remove(String(actionId || ""));
  return { ok: true, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-set-enabled", (_e, actionId, enabled) => {
  const row = smartActions.setEnabled(String(actionId || ""), enabled !== false);
  return { ok: Boolean(row), action: row, snapshot: snapshot() };
});

ipcMain.handle("desktop:smart-action-logs", (_e, actionId) => ({
  ok: true,
  logs: smartActions.getLogs(String(actionId || "")),
}));

ipcMain.handle("desktop:smart-action-catalog-get", () => ({
  ok: true,
  catalog: normalizeCatalogState(state.db.smartActionCatalog),
  templates: listTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    blurb: t.blurb || "",
  })),
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
            labelTemplate: "{{title}}",
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
    if (!hyper && !capsolver) {
      return { ok: false, error: "Need Hyper and/or CapSolver in Settings" };
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
        ["checkout", "chance", "login_check"].includes(String(task.bandaiMode || "checkout")));
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
    if (remaining <= 0) {
      const bankHit = results.some(
        (r) =>
          r.transactionId &&
          String(r.transactionId) !== "0" &&
          !/RELOAD_ONLY|DataCorruption/i.test(String(r.note || "")),
      );
      const payload = {
        ok: results.every((r) => r.ok),
        bankHit,
        viaElectron: true,
        results,
        at: Date.now(),
      };
      require("fs").writeFileSync(outPath, JSON.stringify(payload, null, 2));
      console.log("[e2e] wrote", outPath, "ok=", payload.ok, "bankHit=", bankHit);
      setTimeout(() => app.quit(), 500);
    }
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

  if (process.env.DESKTOP_E2E_AUTORUN === "1") {
    try {
      await e2eAutorun();
    } catch (e) {
      console.error("[e2e] fatal", e);
      app.quit();
    }
  }
});

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
