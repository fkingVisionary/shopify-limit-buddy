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
  licenseStatus: "unknown", // unknown | open | valid | invalid
  licenseMessage: "",
};

const DEFAULT_DB = {
  profiles: [],
  proxyGroups: [],
  tasks: [],
  results: [],
  /** Generated retailer accounts (Toymate account gen, etc.). */
  accounts: [],
};

function loadAll() {
  const settings = { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
  const db = { ...DEFAULT_DB, ...readJson("db.json", {}) };
  db.profiles = Array.isArray(db.profiles) ? db.profiles : [];
  db.proxyGroups = Array.isArray(db.proxyGroups) ? db.proxyGroups : [];
  db.tasks = Array.isArray(db.tasks) ? db.tasks : [];
  db.results = Array.isArray(db.results) ? db.results.slice(-200) : [];
  db.accounts = Array.isArray(db.accounts) ? db.accounts : [];
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
  });
}

module.exports = {
  id,
  loadAll,
  saveSettings,
  saveDb,
  DEFAULT_SETTINGS,
};
