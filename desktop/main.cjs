// Vanta Desktop — main process.
// Owns: BrowserWindow, local store, executor sidecar, job runner, license IPC.
// Does NOT execute Kmart checkout in-process — that stays in executor/ via sidecar.

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const store = require("./store.cjs");
const sidecar = require("./executor-sidecar.cjs");
const runner = require("./job-runner.cjs");
const license = require("./license.cjs");
const { adapterForStore, normalizeStoreUrl } = require("./stores.cjs");
const { classifyProxy, normalizeKmartProxy } = require("./proxy-format.cjs");
const { resolveProbeUrl, PROXY_PROBE_STORES, DEFAULT_PROXY_PROBE_STORE_ID } = require("./proxy-probe-stores.cjs");
const {
  classifyDiagnoseProxyCheck,
  makeInvalidProbeResult,
  makeErrorProbeResult,
} = require("./proxy-probe.cjs");
const privateMonitor = require("./private-monitor.cjs");
const monitorFeed = require("./monitor-feed.cjs");
const { matchingTasks } = require("./global-matcher.cjs");
const { normalizeKmartPdpUrl, classifyMonitorInput } = require("./keyword-parse.cjs");
const { resolveMonitorFeedUrl } = require("./monitor-config.cjs");
const { probeKmartPdp } = require("./kmart-stock-probe.cjs");

let win = null;
let state = store.loadAll();
// Drop legacy user-editable feed URL — global monitor is in-house only.
if (state.settings.monitorFeedUrl != null) {
  delete state.settings.monitorFeedUrl;
  store.saveSettings(state.settings);
}
// Persist migration (Default group, store fields on legacy tasks).
store.saveDb(state.db);
store.saveSettings(state.settings);

function globalFeedUrl() {
  return resolveMonitorFeedUrl();
}

function connectGlobalFeed() {
  monitorFeed.configure({
    monitorFeedUrl: globalFeedUrl(),
    apiKey: state.settings.apiKey,
  });
  return monitorFeed.start();
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

function snapshot() {
  return {
    settings: {
      ...state.settings,
      apiKey: state.settings.apiKey || "",
      hyperApiKey: state.settings.hyperApiKey || "",
    },
    profiles: state.db.profiles,
    proxyGroups: state.db.proxyGroups,
    taskGroups: state.db.taskGroups,
    stores: store.allStores(state.db),
    customStores: state.db.customStores,
    tasks: state.db.tasks,
    results: state.db.results.slice(-50),
    runner: runner.state(),
    engine: sidecar.status(),
    monitorFeed: {
      ...monitorFeed.getStatus(),
      feedUrl: globalFeedUrl(),
    },
  };
}

function resolveStore(storeId) {
  return store.allStores(state.db).find((s) => s.id === storeId) || null;
}

function buildTaskRow(task, now) {
  const resolved = resolveStore(task.storeId) || resolveStore("preset-kmart");
  const adapter = task.store || adapterForStore(resolved);
  const monitorInput = String(
    task.monitorInput || task.pdpUrl || task.input || "",
  ).trim();
  const classified = classifyMonitorInput(monitorInput);
  let pdpUrl = String(task.pdpUrl || "").trim();
  if (!pdpUrl && classified.kind === "url") pdpUrl = normalizeKmartPdpUrl(classified.value) || classified.value;
  if (!pdpUrl && classified.kind === "sku") pdpUrl = normalizeKmartPdpUrl(classified.value) || "";
  if (!pdpUrl && task.resolvedPdpUrl) pdpUrl = String(task.resolvedPdpUrl).trim();

  const sourceRaw = String(task.monitorSource || "global").toLowerCase();
  const monitorSource = sourceRaw === "private" ? "private" : "global";
  // Explicit off by default — only wait on feed/poll when user opts in for restocks.
  const monitorEnabled =
    task.monitorEnabled === true ||
    task.monitorEnabled === "true" ||
    task.monitorEnabled === 1;

  return {
    id: task.id || store.id("task"),
    groupId: task.groupId || state.settings.activeGroupId,
    storeId: resolved?.id || task.storeId || "preset-kmart",
    storeName: resolved?.name || task.storeName || "Kmart AU",
    storeUrl: resolved?.url || task.storeUrl || "https://www.kmart.com.au",
    store: adapter,
    label: String(task.label || "").slice(0, 120),
    monitorInput,
    monitorEnabled,
    monitorSource,
    pdpUrl,
    resolvedPdpUrl: task.resolvedPdpUrl ? String(task.resolvedPdpUrl).trim() : undefined,
    resolvedSku: task.resolvedSku ? String(task.resolvedSku).trim() : undefined,
    monitorDelayMs: Math.max(1000, Number(task.monitorDelayMs) || 3500),
    retryDelayMs: Math.max(1500, Number(task.retryDelayMs) || 5000),
    qty: Math.max(1, Math.min(20, Number(task.qty) || 1)),
    quantity: 1, // one list row = one startable task (matches web Task Quantity clones)
    profileId: task.profileId || null,
    proxyGroupId: task.proxyGroupId || null,
    placeOrder: task.placeOrder !== false,
    kmartMode: "current",
    enabled: task.enabled !== false,
    updatedAt: now,
  };
}

function normalizeProxyEntry(raw) {
  if (raw == null || raw === "") return null;
  const norm = normalizeKmartProxy(raw);
  return norm.ok ? norm.proxy : null;
}

function proxyEntriesForTask(task) {
  const group = state.db.proxyGroups.find((g) => g.id === task.proxyGroupId);
  const entries = group?.entries?.length ? group.entries : [null];
  return entries.map((e) => (e == null ? null : normalizeProxyEntry(e)));
}

/** After a checkout attempt, keep waiting for restock when monitor is enabled. */
function armTaskForRestock(t, message) {
  if (!t?.monitorEnabled) return;
  if (t.monitorSource === "global") {
    connectGlobalFeed().catch(() => {});
    t.lastStatus = "monitoring";
    t.lastProgress = message || "Waiting on global feed…";
    return;
  }
  const entries = proxyEntriesForTask(t);
  privateMonitor.startTaskMonitor({
    task: { ...t },
    proxyEntries: entries,
    waitForRestock: true,
  });
  t.lastStatus = "monitoring";
  t.lastProgress = message || "Monitoring for restock…";
}

async function enqueueCheckoutFromMatch({ task, resolvedPdpUrl, resolvedSku, title, proxyRaw }) {
  const t = state.db.tasks.find((x) => x.id === task.id);
  if (!t) return;
  t.resolvedPdpUrl = resolvedPdpUrl;
  t.resolvedSku = resolvedSku || t.resolvedSku;
  if (resolvedPdpUrl) t.pdpUrl = resolvedPdpUrl;
  if (title && !t.label) t.label = String(title).slice(0, 120);
  t.lastStatus = "checking_out";
  t.lastProgress = "Matched — checking out…";
  t.lastError = null;
  t.updatedAt = Date.now();
  persistDb();
  send({ type: "snapshot", data: snapshot() });

  if (!sidecar.status().running) {
    const started = await startEngine();
    if (!started.ok) {
      t.lastStatus = "failed";
      t.lastError = started.error || "Engine failed";
      persistDb();
      send({ type: "snapshot", data: snapshot() });
      return;
    }
  }

  const profile = state.db.profiles.find((p) => p.id === t.profileId);
  if (!profile) {
    t.lastStatus = "failed";
    t.lastError = "Assign a profile first";
    persistDb();
    send({ type: "snapshot", data: snapshot() });
    return;
  }

  const entries = proxyEntriesForTask(t);
  const useProxy = proxyRaw || entries.find(Boolean) || null;
  runner.enqueue([
    {
      task: { ...t, pdpUrl: resolvedPdpUrl || t.pdpUrl },
      profile,
      proxyRaw: useProxy,
      proxyEntries: entries.filter(Boolean),
      proxyIndex: 0,
      placeOrder: t.placeOrder !== false,
    },
  ]);
}

function wireMonitors() {
  privateMonitor.setEmitter((evt) => {
    if (evt?.taskId) {
      const t = state.db.tasks.find((x) => x.id === evt.taskId);
      if (t) {
        if (evt.phase === "start" || evt.phase === "discovery" || evt.phase === "poll") {
          t.lastStatus = "monitoring";
          t.lastProgress = evt.message || t.lastProgress;
        } else if (evt.phase === "matched") {
          t.lastStatus = "matched";
          t.lastProgress = evt.message || "Matched";
          if (evt.resolvedPdpUrl) {
            t.resolvedPdpUrl = evt.resolvedPdpUrl;
            t.pdpUrl = evt.resolvedPdpUrl;
          }
          if (evt.resolvedSku) t.resolvedSku = evt.resolvedSku;
        } else if (evt.phase === "error") {
          t.lastProgress = evt.message || "Monitor error";
        } else if (evt.phase === "stop" && t.lastStatus === "monitoring") {
          t.lastStatus = "idle";
          t.lastProgress = null;
        }
        t.updatedAt = Date.now();
      }
    }
    send(evt);
  });

  privateMonitor.setMatchHandler((payload) => enqueueCheckoutFromMatch(payload));

  monitorFeed.setEmitter((evt) => send(evt));
  monitorFeed.setEventHandler((monitorEvent) => {
    const hits = matchingTasks(monitorEvent, state.db.tasks);
    for (const task of hits) {
      enqueueCheckoutFromMatch({
        task,
        resolvedPdpUrl: normalizeKmartPdpUrl(monitorEvent.url) || monitorEvent.url,
        resolvedSku: monitorEvent.sku,
        title: monitorEvent.title,
        proxyRaw: proxyEntriesForTask(task).find(Boolean) || null,
      });
    }
  });

  connectGlobalFeed().catch(() => {});
}

wireMonitors();

function createWindow() {
  const iconPath = path.join(__dirname, "renderer", "assets", "icon.png");
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    title: "Vanta",
    backgroundColor: "#0a0a0b",
    icon: iconPath,
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

runner.setEmitter((evt) => {
  if (evt?.type === "job" && evt.taskId) {
    const t = state.db.tasks.find((x) => x.id === evt.taskId);
    if (t) {
      if (evt.phase === "start") {
        t.lastStatus = "running";
        t.lastProgress = "Starting…";
        t.lastError = null;
        t.updatedAt = Date.now();
      } else if (evt.phase === "progress") {
        t.lastStatus = "running";
        t.lastProgress =
          evt.message ||
          [evt.progress?.label || evt.progress?.stage, evt.progress?.detail || evt.progress?.hint]
            .filter(Boolean)
            .join(" — ") ||
          t.lastProgress;
        t.updatedAt = Date.now();
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
    checkoutStage: result.checkoutStage || null,
    failedStep: result.failedStep || null,
    elapsedMs: result.elapsedMs ?? null,
    lastSteps: result.lastSteps || null,
    at: result.at || Date.now(),
  });
  state.db.results = state.db.results.slice(0, 200);
  // Mirror status onto task row
  if (result.taskId) {
    const t = state.db.tasks.find((x) => x.id === result.taskId);
    if (t) {
      if (result.cancelled) {
        t.lastStatus = "idle";
        t.lastError = null;
        t.lastProgress = null;
      } else if (result.ok) {
        t.lastStatus = result.orderNumber ? "confirmed" : "ok";
        t.lastError = null;
        t.lastOrderNumber = result.orderNumber || null;
        t.lastCheckoutStage = result.checkoutStage || null;
        t.lastProgress = null;
        if (t.monitorEnabled) {
          armTaskForRestock(t, "Confirmed — monitoring for restock…");
        }
      } else {
        t.lastStatus = "failed";
        t.lastError = result.error || null;
        t.lastOrderNumber = result.orderNumber || null;
        t.lastCheckoutStage = result.checkoutStage || null;
        t.lastProgress = null;
        if (t.monitorEnabled) {
          armTaskForRestock(t, "Checkout failed — still monitoring…");
        }
      }
      t.updatedAt = Date.now();
    }
  }
  persistDb();
  send({ type: "snapshot", data: snapshot() });
});

async function startEngine() {
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
  if (!hyper) {
    return {
      ok: false,
      error:
        "Hyper API key required — paste yours in Settings (BYO), or configure control-plane hyper-provision",
      snapshot: snapshot(),
    };
  }

  const started = await sidecar.startSidecar({
    hyperApiKey: hyper,
    paydockPublicKey: state.settings.paydockPublicKey,
    maxConcurrent: state.settings.maxConcurrent,
  });
  if (!started.ok) return { ...started, snapshot: snapshot() };

  runner.configure({
    maxConcurrent: state.settings.maxConcurrent,
  });
  runner.start();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, snapshot: snapshot() };
}

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.handle("desktop:get-state", () => snapshot());

ipcMain.handle("desktop:save-settings", async (_e, patch) => {
  // Never persist a user feed URL — global monitor is baked in.
  if (patch && Object.prototype.hasOwnProperty.call(patch, "monitorFeedUrl")) {
    delete patch.monitorFeedUrl;
  }
  state.settings = { ...state.settings, ...patch };
  delete state.settings.monitorFeedUrl;
  runner.configure({
    maxConcurrent: state.settings.maxConcurrent,
  });
  persistSettings();
  // Re-auth global feed if API key changed.
  connectGlobalFeed().catch(() => {});
  return snapshot();
});

ipcMain.handle("desktop:monitor-feed-status", () => ({
  ...monitorFeed.getStatus(),
  feedUrl: globalFeedUrl(),
}));

ipcMain.handle("desktop:monitor-feed-connect", async () => connectGlobalFeed());

ipcMain.handle("desktop:monitor-feed-disconnect", () => {
  // Global feed is always-on for the product; reconnect instead of true disconnect.
  connectGlobalFeed().catch(() => {});
  return { ok: true, ...monitorFeed.getStatus(), feedUrl: globalFeedUrl() };
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

ipcMain.handle("desktop:start-engine", async () => startEngine());

ipcMain.handle("desktop:stop-engine", async () => {
  runner.stop();
  await sidecar.stopSidecar();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, snapshot: snapshot() };
});

ipcMain.handle("desktop:stop-task", (_e, taskId) => {
  const removed = runner.cancelTask(taskId);
  privateMonitor.stopTaskMonitor(taskId);
  const t = state.db.tasks.find((x) => x.id === taskId);
  if (t) {
    t.lastStatus = "idle";
    t.lastProgress = null;
    t.lastError = null;
    t.updatedAt = Date.now();
    persistDb();
  }
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, removed: removed.removed, snapshot: snapshot() };
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

ipcMain.handle("desktop:list-proxy-probe-stores", () => ({
  stores: PROXY_PROBE_STORES,
  defaultStoreId: DEFAULT_PROXY_PROBE_STORE_ID,
}));

/**
 * Bulk-test a proxy group against a store via local executor /health/diagnose.
 * Emits desktop:event { type: "proxy-test", ... } per entry for live UI.
 */
ipcMain.handle("desktop:test-proxy-group", async (_e, payload) => {
  const groupId = String(payload?.groupId || "");
  const storeId = String(payload?.storeId || DEFAULT_PROXY_PROBE_STORE_ID);
  const customUrl = payload?.customUrl ? String(payload.customUrl) : null;
  const group = state.db.proxyGroups.find((g) => g.id === groupId);
  if (!group) return { ok: false, error: "Proxy group not found" };

  const entries = Array.isArray(group.entries) ? group.entries.map((e) => String(e || "").trim()).filter(Boolean) : [];
  if (!entries.length) return { ok: false, error: "No proxy entries in group" };

  const { targetUrl } = resolveProbeUrl(storeId, customUrl);

  // Start sidecar without requiring Hyper — diagnose does not need sensors.
  const hyper =
    String(state.settings.hyperApiKey || "").trim() ||
    String(process.env.HYPER_API_KEY || "").trim() ||
    null;
  const started = await sidecar.startSidecar({
    hyperApiKey: hyper,
    paydockPublicKey: state.settings.paydockPublicKey,
    maxConcurrent: state.settings.maxConcurrent,
  });
  if (!started.ok) {
    return { ok: false, error: started.error || "Failed to start local executor" };
  }

  const results = [];
  const n = entries.length;
  const concurrency = 2;
  let next = 0;

  async function runOne(i) {
    const entry = entries[i];
    const classified = classifyProxy(entry);
    let result;
    if (classified.kind === "invalid") {
      result = makeInvalidProbeResult(classified.reason || "invalid format");
    } else if (classified.kind === "template") {
      result = makeInvalidProbeResult(
        "URL-template proxies are not supported for store probes — use host:port:user:pass",
      );
    } else {
      const norm = normalizeKmartProxy(entry);
      if (!norm.ok) {
        result = makeInvalidProbeResult(norm.error || "invalid proxy");
      } else {
        const t0 = Date.now();
        try {
          const { httpStatus, result: body } = await sidecar.diagnoseProxy({
            proxy: norm.proxy,
            targetUrl: targetUrl || "https://www.kmart.com.au/",
          });
          const proxyCheck = body?.checks?.proxy;
          if (!proxyCheck) {
            result = makeErrorProbeResult(
              body?.error || `diagnose HTTP ${httpStatus}`,
              Date.now() - t0,
            );
          } else {
            result = classifyDiagnoseProxyCheck(proxyCheck, Date.now() - t0);
          }
        } catch (e) {
          result = makeErrorProbeResult(e?.message || String(e), Date.now() - t0);
        }
      }
    }
    results[i] = result;
    send({
      type: "proxy-test",
      groupId,
      index: i,
      n,
      entry,
      result,
    });
    return result;
  }

  const workers = Array.from({ length: Math.min(concurrency, n) }, async () => {
    while (next < n) {
      const i = next;
      next += 1;
      await runOne(i);
    }
  });
  await Promise.all(workers);

  const okCount = results.filter((r) => r?.ok).length;
  return {
    ok: true,
    groupId,
    storeId,
    targetUrl,
    results,
    summary: { total: n, ok: okCount, fail: n - okCount },
  };
});

// Task groups
ipcMain.handle("desktop:set-active-group", (_e, groupId) => {
  if (state.db.taskGroups.some((g) => g.id === groupId)) {
    state.settings.activeGroupId = groupId;
    persistSettings();
  }
  return snapshot();
});

ipcMain.handle("desktop:upsert-task-group", (_e, group) => {
  const now = Date.now();
  const name = String(group.name || "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "Name required", snapshot: snapshot() };
  if (group.id) {
    const i = state.db.taskGroups.findIndex((g) => g.id === group.id);
    if (i >= 0) state.db.taskGroups[i] = { ...state.db.taskGroups[i], name, updatedAt: now };
  } else {
    const row = { id: store.id("grp"), name, createdAt: now };
    state.db.taskGroups.push(row);
    state.settings.activeGroupId = row.id;
    persistSettings();
  }
  persistDb();
  return { ok: true, snapshot: snapshot() };
});

ipcMain.handle("desktop:delete-task-group", (_e, groupId) => {
  if (state.db.taskGroups.length <= 1) {
    return { ok: false, error: "Keep at least one group", snapshot: snapshot() };
  }
  state.db.taskGroups = state.db.taskGroups.filter((g) => g.id !== groupId);
  for (const t of state.db.tasks) {
    if (t.groupId === groupId) t.groupId = null;
  }
  if (state.settings.activeGroupId === groupId) {
    state.settings.activeGroupId = state.db.taskGroups[0]?.id || null;
    persistSettings();
  }
  persistDb();
  return { ok: true, snapshot: snapshot() };
});

// Custom stores
ipcMain.handle("desktop:add-custom-store", (_e, { name, url }) => {
  const n = String(name || "").trim().slice(0, 80);
  const u = normalizeStoreUrl(url);
  if (!n || !u) return { ok: false, error: "Name and URL required", snapshot: snapshot() };
  const row = {
    id: store.id("store"),
    name: n,
    url: u,
    preset: false,
    adapter: adapterForStore({ name: n, url: u }),
  };
  state.db.customStores.push(row);
  persistDb();
  return { ok: true, store: row, snapshot: snapshot() };
});

// Tasks
ipcMain.handle("desktop:upsert-task", (_e, task) => {
  const now = Date.now();
  const row = buildTaskRow(task, now);
  const i = state.db.tasks.findIndex((t) => t.id === row.id);
  if (i >= 0) state.db.tasks[i] = { ...state.db.tasks[i], ...row };
  else state.db.tasks.push({ ...row, createdAt: now, lastStatus: "idle" });
  persistDb();
  return snapshot();
});

/** Create N task rows (web Task Quantity semantics). */
ipcMain.handle("desktop:create-tasks", (_e, task, count) => {
  const now = Date.now();
  const n = Math.max(1, Math.min(100, Number(count) || 1));
  const base = buildTaskRow({ ...task, id: undefined }, now);
  for (let i = 0; i < n; i++) {
    state.db.tasks.push({
      ...base,
      id: store.id("task"),
      label: n > 1 && base.label ? `${base.label} (${i + 1})` : base.label,
      createdAt: now,
      lastStatus: "idle",
    });
  }
  persistDb();
  return { ok: true, created: n, snapshot: snapshot() };
});

ipcMain.handle("desktop:delete-task", (_e, taskId) => {
  state.db.tasks = state.db.tasks.filter((t) => t.id !== taskId);
  persistDb();
  return snapshot();
});

ipcMain.handle("desktop:run-tasks", async (_e, taskIds) => {
  const ids =
    Array.isArray(taskIds) && taskIds.length
      ? taskIds
      : state.db.tasks.filter((t) => t.enabled).map((t) => t.id);

  let startedCheckout = 0;
  let startedPrivate = 0;
  let startedGlobal = 0;

  for (const tid of ids) {
    const task = state.db.tasks.find((t) => t.id === tid);
    if (!task) continue;
    if (task.store && task.store !== "kmart") {
      task.lastStatus = "failed";
      task.lastError = `Store adapter not installed yet: ${task.storeName || task.store}`;
      continue;
    }
    const profile = state.db.profiles.find((p) => p.id === task.profileId);
    if (!profile) {
      task.lastStatus = "failed";
      task.lastError = "Assign a profile first";
      continue;
    }

    const input = String(task.monitorInput || task.pdpUrl || "").trim();
    if (!input) {
      task.lastStatus = "failed";
      task.lastError = "Product input required (URL, SKU, or keywords)";
      continue;
    }

    task.lastError = null;
    task.updatedAt = Date.now();
    const entries = proxyEntriesForTask(task);
    const proxyRaw = entries.find(Boolean) || null;
    const classified = classifyMonitorInput(input);
    const monitorOn = task.monitorEnabled === true;

    // Keywords without a resolved PDP: can't stock-check yet.
    if (classified.kind === "keywords") {
      if (!monitorOn) {
        task.lastStatus = "failed";
        task.lastError = "Keywords need Monitor for restock enabled (or paste a URL/SKU)";
        continue;
      }
      if (task.monitorSource === "global") {
        connectGlobalFeed().catch(() => {});
        task.lastStatus = "monitoring";
        task.lastProgress = "Waiting on global feed…";
        startedGlobal += 1;
        continue;
      }
      privateMonitor.startTaskMonitor({ task: { ...task }, proxyEntries: entries });
      task.lastStatus = "monitoring";
      task.lastProgress = "Searching / monitoring…";
      startedPrivate += 1;
      continue;
    }

    const pdpUrl =
      normalizeKmartPdpUrl(classified.value) ||
      normalizeKmartPdpUrl(task.resolvedPdpUrl || task.pdpUrl) ||
      null;
    if (!pdpUrl) {
      task.lastStatus = "failed";
      task.lastError = "Could not resolve Kmart PDP URL";
      continue;
    }

    task.lastStatus = "monitoring";
    task.lastProgress = "Checking stock…";
    persistDb();
    send({ type: "snapshot", data: snapshot() });

    const probe = await probeKmartPdp({
      url: pdpUrl,
      proxyUrl: proxyRaw,
      timeoutMs: 15_000,
    });

    if (probe.ok && probe.inStock === true) {
      await enqueueCheckoutFromMatch({
        task,
        resolvedPdpUrl: probe.url || pdpUrl,
        resolvedSku: probe.sku || (classified.kind === "sku" ? classified.value : null),
        title: probe.title,
        proxyRaw,
      });
      // Restock arming (if monitorEnabled) happens after checkout finishes.
      startedCheckout += 1;
      continue;
    }

    // OOS / unknown / blocked
    if (!monitorOn) {
      task.lastStatus = "failed";
      task.lastError =
        probe.inStock === false
          ? "Out of stock — enable Monitor for restock to wait"
          : probe.error || "Stock check failed — enable Monitor for restock to wait";
      task.lastProgress = null;
      continue;
    }

    task.resolvedPdpUrl = probe.url || pdpUrl;
    task.pdpUrl = probe.url || pdpUrl;
    if (probe.sku) task.resolvedSku = probe.sku;

    if (task.monitorSource === "global") {
      connectGlobalFeed().catch(() => {});
      task.lastStatus = "monitoring";
      task.lastProgress =
        probe.inStock === false ? "OOS — waiting on global feed…" : "Waiting on global feed…";
      startedGlobal += 1;
      continue;
    }

    privateMonitor.startTaskMonitor({
      task: { ...task, pdpUrl: task.pdpUrl, resolvedPdpUrl: task.resolvedPdpUrl },
      proxyEntries: entries,
    });
    task.lastStatus = "monitoring";
    task.lastProgress =
      probe.inStock === false ? "OOS — monitoring privately…" : "Monitoring privately…";
    startedPrivate += 1;
  }

  persistDb();
  send({ type: "snapshot", data: snapshot() });
  return {
    ok: true,
    checkout: startedCheckout,
    monitoring: startedPrivate + startedGlobal,
    private: startedPrivate,
    global: startedGlobal,
    snapshot: snapshot(),
  };
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

async function e2eAutorun() {
  // DESKTOP_E2E_AUTORUN=1 — start engine, enqueue enabled tasks (dry-run unless
  // DESKTOP_E2E_PLACE_ORDER=1), wait for completion, write result JSON, quit.
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
    if (!hyper) return { ok: false, error: "Hyper API key required in Settings" };
    return sidecar.startSidecar({
      hyperApiKey: hyper,
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
  });
  runner.start();

  const placeOrder = process.env.DESKTOP_E2E_PLACE_ORDER === "1";
  const jobs = [];
  for (const task of state.db.tasks.filter((t) => t.enabled !== false)) {
    const profile = state.db.profiles.find((p) => p.id === task.profileId);
    if (!profile) {
      console.error("[e2e] task missing profile", task.id);
      continue;
    }
    const group = state.db.proxyGroups.find((g) => g.id === task.proxyGroupId);
    const entries = group?.entries?.length ? group.entries : [null];
    // One attempt for e2e (ignore quantity) — sticky retries can advance entries.
    jobs.push({
      task: { ...task, placeOrder, pwEdgeRetries: 5 },
      profile,
      proxyRaw: entries[0] ?? null,
      proxyEntries: entries.filter(Boolean),
      proxyIndex: 0,
      placeOrder,
    });
  }

  if (!jobs.length) {
    require("fs").writeFileSync(outPath, JSON.stringify({ ok: false, phase: "enqueue", error: "no enabled tasks with profiles" }, null, 2));
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
      checkoutStage: result.checkoutStage || null,
      failedStep: result.failedStep || null,
      elapsedMs: result.elapsedMs ?? null,
      lastSteps: result.lastSteps || null,
      at: result.at || Date.now(),
    });
    state.db.results = state.db.results.slice(0, 200);
    if (result.taskId) {
      const t = state.db.tasks.find((x) => x.id === result.taskId);
      if (t) {
        t.lastStatus = result.ok ? (result.orderNumber ? "confirmed" : "ok") : "failed";
        t.lastError = result.error || null;
        t.lastOrderNumber = result.orderNumber || null;
        t.lastCheckoutStage = result.checkoutStage || null;
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
      error: result.error,
      elapsedMs: result.elapsedMs,
      lastSteps: (result.lastSteps || []).slice(-15).map((s) => ({
        step: s.step,
        ok: s.ok,
        status: s.status,
        note: String(s.note || "").slice(0, 240),
      })),
    });
    remaining -= 1;
    console.log("[e2e] job done", JSON.stringify({ ok: result.ok, failedStep: result.failedStep, stage: result.checkoutStage, remaining }));
    if (remaining <= 0) {
      const payload = { ok: results.every((r) => r.ok), results, at: Date.now() };
      require("fs").writeFileSync(outPath, JSON.stringify(payload, null, 2));
      console.log("[e2e] wrote", outPath, "ok=", payload.ok);
      setTimeout(() => app.quit(), 500);
    }
  });

  runner.enqueue(jobs);
  console.log("[e2e] enqueued", jobs.length, "dryRun=", !placeOrder);
}

app.whenReady().then(async () => {
  runner.configure({
    maxConcurrent: state.settings.maxConcurrent,
  });
  createWindow();
  // Auto-start checkout engine so users never manage Start/Stop manually.
  try {
    const started = await startEngine();
    if (!started.ok) {
      console.warn("[vanta] engine auto-start deferred:", started.error || "unknown");
    }
  } catch (e) {
    console.warn("[vanta] engine auto-start failed:", e.message || e);
  }
  // Always attach to the in-house global monitor (same URL for all users).
  connectGlobalFeed().catch((e) => {
    console.warn("[vanta] global monitor connect deferred:", e?.message || e);
  });
  if (process.env.DESKTOP_E2E_AUTORUN === "1") {
    try {
      await e2eAutorun();
    } catch (e) {
      console.error("[e2e] fatal", e);
      app.quit();
    }
  }
});

app.on("window-all-closed", async () => {
  privateMonitor.stopAll();
  monitorFeed.stop();
  runner.stop();
  await sidecar.stopSidecar();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  privateMonitor.stopAll();
  monitorFeed.stop();
  runner.stop();
  await sidecar.stopSidecar();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
