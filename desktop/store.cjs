// Local JSON persistence for profiles, proxies, tasks, and settings.
// Source of truth for the desktop app — nothing here is required on the cloud.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const crypto = require("crypto");

function dataDir() {
  const dir = path.join(app.getPath("userData"), "j1ms-desktop");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath(name) {
  return path.join(dataDir(), name);
}

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(filePath(name), "utf8");
    return JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(name, value) {
  const tmp = filePath(`${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath(name));
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

const DEFAULT_SETTINGS = {
  apiKey: "",
  controlPlaneUrl: "",
  hyperApiKey: "", // BYO Hyper; empty = try control-plane provision later
  /** Kmart Paydock widget public key (static client key — not a secret). */
  paydockPublicKey: "",
  /** Toymate Cloudflare + form captcha (CapSolver). Not used by Kmart. */
  capsolverApiKey: "",
  /** Shared agen OTP — Bandai first; future store agen reuses these. Never commit. */
  /** SMSPool preferred for Bandai (US/UK numbers). Users paste their own key. */
  smspoolApiKey: "",
  smspoolCountry: "GB", // GB | US — AU Bandai accepts both
  smsProvider: "auto", // auto | smspool | onlinesim
  onlinesimApiKey: "",
  onlinesimMode: "rent", // rent | activation
  onlinesimServiceSlug: "other",
  imapHost: "",
  imapPort: 993,
  imapUser: "",
  imapAppPassword: "",
  imapMailbox: "INBOX",
  maxConcurrent: 5,
  placeOrderDefault: true,
  /** Flash taskbar + play sound + OS toast on checkout win. */
  successAlertEnabled: true,
  /**
   * When true, UI live log shows failedStep / detail / monitor polls.
   * Keep on while solo-testing; turn off for beta-facing consumer logs.
   * Console + disk checkout-run log always keep analytical detail.
   */
  detailedLogs: true,
  licenseStatus: "unknown", // unknown | open | valid | invalid
  licenseMessage: "",
  /**
   * Consumer: follow Railway admin watchlist via public SSE while engine runs.
   * No local Monitor→Global tasks required for feed.
   */
  bandaiGlobalMonitorEnabled: true,
  bandaiGlobalMonitorUrl: "https://j1ms-bandai-monitor-production.up.railway.app",
  /** Optional operator override only — feed/catalog reads are public on Railway. */
  bandaiGlobalMonitorToken: "",
  /**
   * Watchdog: Railway restock hit → auto-start matching Bandai Autocheckout tasks
   * (PDP / Watch SKU / keywords). Per-task opt-out via bandaiWatchdog=false.
   */
  desktopWatchdogEnabled: true,
  desktopWatchdogCooldownMs: 60_000,
  /**
   * Muted product ids / SKUs — suppress Monitor Feed rows, Smart Actions,
   * Watchdog, and Monitor→checkout handoff for these restocks.
   */
  monitorMutedSkus: [],
  /**
   * Per-user Discord webhook for checkout success (also fallback for other routes).
   * Prefer discordSuccessWebhook when set; discordCheckoutWebhook kept for compat.
   */
  discordCheckoutWebhook: "",
  discordSuccessWebhook: "",
  discordFailWebhook: "",
  discord3dsWebhook: "",
  /** Smart Actions Notify Discord + optional monitor-task pings (not Railway restock). */
  discordMonitorWebhook: "",
  /**
   * Which fields appear on personal Success / Decline Discord embeds.
   * Public checkout feed never includes these (server-side sanitize).
   */
  discordEmbedFields: {
    product: true,
    store: true,
    price: true,
    profile: true,
    order: true,
    mode: true,
    payment: true,
    source: true,
    email: true,
    proxy: true,
  },
  /**
   * Quick Task defaults (Monitor Feed row / paste SKU → create+start).
   * Used by Smart Actions Create Tasks when usePreset is on.
   */
  quickTaskPreset: {
    store: "bandai",
    bandaiMode: "checkout",
    bandaiCheckoutMode: "fast",
    profileId: null,
    proxyGroupId: null,
    qty: 1,
    quantity: 1,
    placeOrder: true,
    accountAssign: "auto",
    accountId: null,
    startAfterCreate: true,
  },
};

const DEFAULT_DB = {
  profiles: [],
  proxyGroups: [],
  tasks: [],
  results: [],
  /** Generated retailer accounts (Toymate account gen, etc.). */
  accounts: [],
  /** Cybersole-style Smart Actions (desktop-local; not synced to web). */
  smartActions: [],
  /** Named lists of store IDs for Smart Action filters / targets. */
  storeGroups: [],
};

function loadAll() {
  const settings = { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
  settings.quickTaskPreset = {
    ...DEFAULT_SETTINGS.quickTaskPreset,
    ...(settings.quickTaskPreset && typeof settings.quickTaskPreset === "object"
      ? settings.quickTaskPreset
      : {}),
  };
  settings.monitorMutedSkus = Array.isArray(settings.monitorMutedSkus)
    ? settings.monitorMutedSkus.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  settings.discordEmbedFields = {
    ...DEFAULT_SETTINGS.discordEmbedFields,
    ...(settings.discordEmbedFields && typeof settings.discordEmbedFields === "object"
      ? settings.discordEmbedFields
      : {}),
  };
  const db = { ...DEFAULT_DB, ...readJson("db.json", {}) };
  db.profiles = Array.isArray(db.profiles) ? db.profiles : [];
  db.proxyGroups = Array.isArray(db.proxyGroups) ? db.proxyGroups : [];
  db.tasks = Array.isArray(db.tasks) ? db.tasks : [];
  db.results = Array.isArray(db.results) ? db.results.slice(-200) : [];
  db.accounts = Array.isArray(db.accounts) ? db.accounts : [];
  db.smartActions = Array.isArray(db.smartActions) ? db.smartActions : [];
  db.storeGroups = Array.isArray(db.storeGroups) ? db.storeGroups : [];
  if (!db.smartActionCatalog || typeof db.smartActionCatalog !== "object") {
    db.smartActionCatalog = { rows: [], enabledTemplateIds: null };
  }
  if (!db.taskGroupColors || typeof db.taskGroupColors !== "object") db.taskGroupColors = {};
  if (!db.profileGroupColors || typeof db.profileGroupColors !== "object") db.profileGroupColors = {};
  if (!db.accountGroupColors || typeof db.accountGroupColors !== "object") db.accountGroupColors = {};
  return { settings, db };
}

function saveSettings(settings) {
  writeJson("settings.json", settings);
}

function saveDb(db) {
  writeJson("db.json", {
    profiles: db.profiles,
    proxyGroups: db.proxyGroups,
    tasks: db.tasks,
    results: (db.results || []).slice(-200),
    accounts: (db.accounts || []).slice(0, 500),
    smartActions: Array.isArray(db.smartActions) ? db.smartActions.slice(0, 100) : [],
    storeGroups: Array.isArray(db.storeGroups) ? db.storeGroups.slice(0, 50) : [],
    smartActionCatalog: db.smartActionCatalog || { rows: [], enabledTemplateIds: null },
    taskGroupColors: db.taskGroupColors || {},
    profileGroupColors: db.profileGroupColors || {},
    accountGroupColors: db.accountGroupColors || {},
    bandaiProductCache: db.bandaiProductCache || undefined,
  });
}

const MONITOR_FEED_MAX = 80;

function loadMonitorFeed() {
  const rows = readJson("monitor-feed.json", []);
  return (Array.isArray(rows) ? rows : [])
    .filter((h) => h && (h.productId || h.sku))
    .slice(0, MONITOR_FEED_MAX);
}

function saveMonitorFeed(feed) {
  const rows = (Array.isArray(feed) ? feed : [])
    .filter((h) => h && (h.productId || h.sku))
    .slice(0, MONITOR_FEED_MAX);
  writeJson("monitor-feed.json", rows);
  return rows;
}

module.exports = {
  id,
  loadAll,
  saveSettings,
  saveDb,
  loadMonitorFeed,
  saveMonitorFeed,
  MONITOR_FEED_MAX,
  DEFAULT_SETTINGS,
};
