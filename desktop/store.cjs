// Local JSON persistence for profiles, proxies, tasks, groups, stores, and settings.
// Source of truth for the desktop app — nothing here is required on the cloud.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const crypto = require("crypto");
const { PRESET_STORES, adapterForStore } = require("./stores.cjs");

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
  hyperApiKey: "",
  paydockPublicKey: "",
  maxConcurrent: 5,
  placeOrderDefault: true,
  licenseStatus: "unknown",
  licenseMessage: "",
  activeGroupId: null,
};

const DEFAULT_DB = {
  profiles: [],
  proxyGroups: [],
  taskGroups: [],
  customStores: [],
  tasks: [],
  results: [],
};

function migrateDb(db, settings) {
  db.profiles = Array.isArray(db.profiles) ? db.profiles : [];
  db.proxyGroups = Array.isArray(db.proxyGroups) ? db.proxyGroups : [];
  db.taskGroups = Array.isArray(db.taskGroups) ? db.taskGroups : [];
  db.customStores = Array.isArray(db.customStores) ? db.customStores : [];
  db.tasks = Array.isArray(db.tasks) ? db.tasks : [];
  db.results = Array.isArray(db.results) ? db.results.slice(-200) : [];

  if (db.taskGroups.length === 0) {
    db.taskGroups.push({ id: id("grp"), name: "Default", createdAt: Date.now() });
  }
  if (!settings.activeGroupId || !db.taskGroups.some((g) => g.id === settings.activeGroupId)) {
    settings.activeGroupId = db.taskGroups[0].id;
  }

  const kmart = PRESET_STORES.find((s) => s.adapter === "kmart") || PRESET_STORES[0];
  for (const t of db.tasks) {
    if (!t.groupId) t.groupId = settings.activeGroupId;
    if (!t.storeId) {
      t.storeId = kmart.id;
      t.storeName = kmart.name;
      t.storeUrl = kmart.url;
    }
    if (!t.store) t.store = adapterForStore({ id: t.storeId, url: t.storeUrl, adapter: t.store });
    if (t.quantity == null) t.quantity = 1;
  }
  return { db, settings };
}

function loadAll() {
  const settings = { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
  const db = { ...DEFAULT_DB, ...readJson("db.json", {}) };
  return migrateDb(db, settings);
}

function saveSettings(settings) {
  writeJson("settings.json", settings);
}

function saveDb(db) {
  writeJson("db.json", {
    profiles: db.profiles,
    proxyGroups: db.proxyGroups,
    taskGroups: db.taskGroups,
    customStores: db.customStores,
    tasks: db.tasks,
    results: (db.results || []).slice(-200),
  });
}

function allStores(db) {
  return [...PRESET_STORES, ...(db.customStores || [])];
}

module.exports = {
  id,
  loadAll,
  saveSettings,
  saveDb,
  allStores,
  DEFAULT_SETTINGS,
  PRESET_STORES,
};
