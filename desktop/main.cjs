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
} = require("./account-vault.cjs");
const { createBandaiHarvestPool } = require("./bandai-harvest.cjs");
const { createDisneyHarvestPool } = require("./disney-harvest.cjs");

let win = null;
let state = store.loadAll();
/** In-memory monitor hit feed for Quick Task (not persisted across restarts). */
let monitorFeed = [];

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

function storeDisplayName(sid) {
  if (sid === "toymate") return "Toymate AU";
  if (sid === "bandai") return "Premium Bandai";
  if (sid === "kmart") return "Kmart AU";
  if (sid === "disney") return "Disney Store AU";
  return sid;
}

function upsertGeneratedAccount(account, { storeId, profileId, source = "generated" } = {}) {
  if (!account?.email || !account?.password) return null;
  if (!Array.isArray(state.db.accounts)) state.db.accounts = [];
  const email = String(account.email).trim();
  const sid = storeId || "toymate";
  const existing = state.db.accounts.find(
    (a) =>
      String(a.storeId || "") === sid &&
      String(a.email || "").toLowerCase() === email.toLowerCase(),
  );
  // Preserve SoftBlock / needs_* truth — never coerce Bandai unknowns to "ready".
  const status = normalizeVaultStatus(account.status, sid);
  const row = {
    id: existing?.id || store.id("acc"),
    email,
    emailBase: emailBase(email),
    password: String(account.password),
    phone: account.phone || existing?.phone || null,
    shipping: account.shipping || existing?.shipping || null,
    storeId: sid,
    adapter: sid,
    storeName: storeDisplayName(sid),
    profileId: profileId || existing?.profileId || null,
    source,
    status,
    lastUsedAt: existing?.lastUsedAt || null,
    lastLoginAt: account.lastLoginAt || existing?.lastLoginAt || null,
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

function snapshot() {
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
    monitorFeed: monitorFeed.slice(0, 80),
  };
}

function pushMonitorHit(hit) {
  if (!hit?.productId) return;
  const row = {
    id: store.id("hit"),
    store: hit.store || "disney",
    productId: String(hit.productId),
    title: hit.title || null,
    reason: hit.reason || null,
    at: hit.at || Date.now(),
  };
  monitorFeed = [row, ...monitorFeed].slice(0, 80);
  send({ type: "monitorHit", data: row });
  send({ type: "snapshot", data: snapshot() });
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

runner.setEmitter((evt) => {
  if (evt?.type === "monitorHit" && evt.data) {
    pushMonitorHit(evt.data);
    return;
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
      } else {
        t.lastStatus =
          result.consumerCode ||
          (result.ok ? (result.orderNumber ? "confirmed" : "complete") : "error");
        t.lastLabel = result.consumerLabel || (result.ok ? "Order confirmed" : result.error) || null;
        t.lastError = result.ok ? null : result.consumerLabel || result.error || null;
        t.lastOrderNumber = result.orderNumber || null;
      }
      t.lastCheckoutStage = result.checkoutStage || null;
      t.stockStatus = result.stockStatus || null;
      t.updatedAt = Date.now();
    }
  }
  persistDb();
  send({ type: "snapshot", data: snapshot() });
});

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.handle("desktop:get-state", () => snapshot());

ipcMain.handle("desktop:save-settings", async (_e, patch) => {
  state.settings = { ...state.settings, ...patch };
  runner.configure({
    maxConcurrent: state.settings.maxConcurrent,
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
  });
  runner.start();
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, snapshot: snapshot(), hyperConfigured: Boolean(hyper), capsolverConfigured: Boolean(capsolver) };
});

ipcMain.handle("desktop:stop-engine", async () => {
  harvest.stop();
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
  if (opts.dropPressure != null) disneyHarvest.configure({ dropPressure: opts.dropPressure });
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
    dropPressure: opts.dropPressure,
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
  if (opts.dropPressure != null) disneyHarvest.configure({ dropPressure: opts.dropPressure });
  const out = await disneyHarvest.harvestOne(disneyHarvestEntries());
  send({ type: "snapshot", data: snapshot() });
  return { ...out, harvest: disneyHarvest.snapshot(), snapshot: snapshot() };
});

ipcMain.handle("desktop:clear-monitor-feed", () => {
  monitorFeed = [];
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, snapshot: snapshot() };
});

/**
 * Launch Autocheckout for a monitor-feed SKU using present Quick Task defaults
 * (profile / proxy / qty / place order / harvest toggles).
 */
ipcMain.handle("desktop:quick-task", async (_e, opts = {}) => {
  const storeId = String(opts.store || "disney").toLowerCase();
  const productId = String(opts.productId || "").trim();
  if (!productId) return { ok: false, error: "productId required", snapshot: snapshot() };
  if (!sidecar.status().running) {
    return { ok: false, error: "Start the engine first", snapshot: snapshot() };
  }

  const profileId = opts.profileId || state.settings?.disneyQuickTask?.profileId || null;
  const proxyGroupId = opts.proxyGroupId || state.settings?.disneyQuickTask?.proxyGroupId || null;
  const profile = (state.db.profiles || []).find((p) => p.id === profileId);
  if (!profile) {
    return { ok: false, error: "Pick a Quick Task profile", snapshot: snapshot() };
  }
  const group = (state.db.proxyGroups || []).find((g) => g.id === proxyGroupId);
  if (!group?.entries?.length) {
    return { ok: false, error: "Pick a Quick Task proxy group", snapshot: snapshot() };
  }

  const qty = Math.max(1, Math.min(20, Number(opts.qty) || 1));
  const placeOrder = opts.placeOrder === true;
  const useHarvest = opts.useHarvest !== false;
  const preferLastGood = opts.preferLastGood !== false;
  const title = String(opts.title || "").trim();

  // Persist defaults for next Quick Task.
  state.settings.disneyQuickTask = {
    profileId,
    proxyGroupId,
    qty,
    placeOrder,
    useHarvest,
    preferLastGood,
  };
  persistSettings();

  let task;
  if (storeId === "disney") {
    task = {
      id: store.id("task"),
      label: title ? `QT ${title.slice(0, 40)}` : `QT Disney ${productId}`,
      store: "disney",
      enabled: true,
      pdpUrl: /^\d{6,}$/.test(productId) ? productId : productId,
      qty,
      quantity: 1,
      profileId,
      proxyGroupId,
      placeOrder,
      disneyMode: "pay",
      disneyUseHarvest: useHarvest,
      disneyRequireHarvestCaptcha: false,
      disneyPreferLastGoodProxy: preferLastGood,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } else if (storeId === "bandai") {
    task = {
      id: store.id("task"),
      label: title ? `QT ${title.slice(0, 40)}` : `QT Bandai ${productId}`,
      store: "bandai",
      enabled: true,
      pdpUrl: productId,
      qty,
      quantity: 1,
      profileId,
      proxyGroupId,
      placeOrder,
      bandaiMode: "checkout",
      bandaiCheckoutMode: "fast",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } else {
    return { ok: false, error: `Quick Task not supported for store ${storeId}`, snapshot: snapshot() };
  }

  // Ephemeral — do not pollute the saved task list unless user wants; keep in results via run.
  const taskCopy = { ...task };
  let jobProxyRaw = group.entries[0];
  let jobProxyEntries = group.entries.slice();
  let proxyIndex = 0;

  if (
    storeId === "disney" &&
    useHarvest &&
    ["pay", "checkout", "atc", "ge"].includes(String(task.disneyMode || "pay"))
  ) {
    const session = disneyHarvest.take({
      preferCaptcha: true,
      requireCaptcha: false,
    });
    if (session?.cookies) {
      taskCopy.harvestedSession = session;
      taskCopy.recaptchaToken = session.captchaToken || null;
      if (session.proxy) {
        jobProxyRaw = session.proxy;
        jobProxyEntries = [session.proxy];
        proxyIndex = 0;
      }
      send({
        type: "job",
        phase: "log",
        taskId: task.id,
        level: "info",
        message: `Quick Task using harvested Disney session (${session.proxyHost || "proxy"}${session.captchaToken ? " + captcha" : ""})`,
      });
    } else {
      send({
        type: "job",
        phase: "log",
        taskId: task.id,
        level: "info",
        message: "Quick Task harvest empty/stale → cold path (warm + CapSolver)",
      });
    }
  }

  runner.enqueue([
    {
      task: taskCopy,
      profile,
      proxyRaw: jobProxyRaw,
      proxyEntries: jobProxyEntries,
      proxyIndex,
      placeOrder,
      accounts: state.db.accounts || [],
      settings: state.settings,
    },
  ]);
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, taskId: task.id, snapshot: snapshot() };
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
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, harvest: snap, snapshot: snapshot() };
});

ipcMain.handle("desktop:bandai-harvest-stop", () => {
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
ipcMain.handle("desktop:upsert-task", (_e, task) => {
  const now = Date.now();
  const storeId = task.store || "kmart";
  const row = {
    id: task.id || store.id("task"),
    store: storeId,
    label: String(task.label || "").slice(0, 120),
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
        ? ["fast", "safe"].includes(String(task.bandaiCheckoutMode || "").toLowerCase())
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
    disneyMonitorMode:
      storeId === "disney" && String(task.disneyMode || "") === "monitor"
        ? ["global", "local"].includes(String(task.disneyMonitorMode || "").toLowerCase())
          ? String(task.disneyMonitorMode).toLowerCase()
          : "local"
        : undefined,
    disneyWatchSku:
      storeId === "disney" && typeof task.disneyWatchSku === "string"
        ? task.disneyWatchSku.trim()
        : undefined,
    disneyWatchKeywords:
      storeId === "disney" && typeof task.disneyWatchKeywords === "string"
        ? task.disneyWatchKeywords.trim()
        : undefined,
    disneyMonitorIntervalMs:
      storeId === "disney" && task.disneyMode === "monitor"
        ? Math.max(2000, Number(task.disneyMonitorIntervalMs) || 10000)
        : undefined,
    disneyMonitorDelayMs:
      storeId === "disney" && task.disneyMode === "monitor"
        ? Math.max(0, Number(task.disneyMonitorDelayMs) || 0)
        : undefined,
    disneyUseHarvest:
      storeId === "disney" ? task.disneyUseHarvest !== false : undefined,
    disneyRequireHarvestCaptcha:
      storeId === "disney" ? task.disneyRequireHarvestCaptcha === true : undefined,
    disneyPreferLastGoodProxy:
      storeId === "disney" ? task.disneyPreferLastGoodProxy !== false : undefined,
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

ipcMain.handle("desktop:run-tasks", (_e, taskIds) => {
  if (!sidecar.status().running) {
    return { ok: false, error: "Start the engine first (app must stay open)" };
  }
  const ids = Array.isArray(taskIds) && taskIds.length ? taskIds : state.db.tasks.filter((t) => t.enabled).map((t) => t.id);
  const jobs = [];
  const claimedAccountIds = [];
  for (const tid of ids) {
    const task = state.db.tasks.find((t) => t.id === tid);
    if (!task) continue;
    const profile = state.db.profiles.find((p) => p.id === task.profileId);
    if (!profile) {
      send({ type: "job", phase: "done", taskId: tid, ok: false, error: "Assign a profile first" });
      continue;
    }
    const group = state.db.proxyGroups.find((g) => g.id === task.proxyGroupId);
    const entries = group?.entries?.length ? group.entries : [null];
    const n = Math.max(1, Math.min(50, Number(task.quantity) || 1));
    let assignError = null;
    for (let i = 0; i < n; i++) {
      const proxyIndex = i % entries.length;
      const proxyRaw = entries[proxyIndex];
      const taskCopy = { ...task };
      // Wire vault account into Toymate / Bandai checkout (auto by profile email, or manual).
      const needsVault =
        (task.store === "toymate" && String(task.toymateMode || "checkout") === "checkout") ||
        (task.store === "bandai" &&
          ["checkout", "chance"].includes(String(task.bandaiMode || "checkout")));
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
      // Bandai checkout: claim a pre-warmed F5 bridge when Harvest is armed.
      if (
        task.store === "bandai" &&
        ["checkout", "chance"].includes(String(task.bandaiMode || "checkout"))
      ) {
        const session = bandaiHarvest.take();
        if (session?.id) {
          taskCopy.harvestedBridgeId = session.id;
          taskCopy.harvestedProxy = session.proxy;
          taskCopy.proxyOverride = session.proxy;
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
            message: `Using harvested F5 bridge (${session.proxyHost || "proxy"} age≈${Math.round((Date.now() - session.harvestedAt) / 1000)}s)`,
          });
        }
      }
      // Disney checkout/pay: claim harvest when task opts in (default on).
      // Off / empty / stale captcha → cold path (warm + CapSolver) — unchanged.
      if (
        task.store === "disney" &&
        task.disneyUseHarvest !== false &&
        ["pay", "checkout", "atc", "ge"].includes(
          String(task.disneyMode || "pay").toLowerCase(),
        )
      ) {
        const requireCaptcha = task.disneyRequireHarvestCaptcha === true;
        const session = disneyHarvest.take({
          preferCaptcha: true,
          requireCaptcha,
        });
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
        } else {
          send({
            type: "job",
            phase: "log",
            taskId: tid,
            level: "info",
            message: requireCaptcha
              ? "Harvest require-captcha miss/stale → cold path (warm + CapSolver)"
              : "Harvest empty/stale → cold path (warm + CapSolver)",
          });
        }
      } else if (
        task.store === "disney" &&
        task.disneyUseHarvest === false &&
        ["pay", "checkout", "atc", "ge"].includes(
          String(task.disneyMode || "pay").toLowerCase(),
        )
      ) {
        send({
          type: "job",
          phase: "log",
          taskId: tid,
          level: "info",
          message: "Harvest disabled on task → cold path",
        });
      }
      jobs.push({
        task: taskCopy,
        profile,
        proxyRaw: jobProxyRaw,
        proxyEntries: jobProxyEntries,
        proxyIndex,
        placeOrder: task.placeOrder !== false,
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
  persistDb();
  runner.enqueue(jobs);
  send({ type: "snapshot", data: snapshot() });
  return { ok: true, enqueued: jobs.length, snapshot: snapshot() };
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
      paydockPublicKey: state.settings.paydockPublicKey,
      capsolverApiKey: state.settings.capsolverApiKey,
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
  harvest.stop();
  bandaiHarvest.stop();
  try {
    await bandaiHarvest.clear();
  } catch {
    /* ignore */
  }
  runner.stop();
  await sidecar.stopSidecar();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  harvest.stop();
  bandaiHarvest.stop();
  try {
    await bandaiHarvest.clear();
  } catch {
    /* ignore */
  }
  runner.stop();
  await sidecar.stopSidecar();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
