// Vault status truth + agen persistence rules for desktop accounts.
// Bandai SoftBlock / partial states must NOT be rewritten to "ready".
// (Keep emailBase local — avoid circular require with account-assign.cjs.)

function emailBase(email) {
  const raw = String(email || "")
    .trim()
    .toLowerCase();
  const m = raw.match(/^([^@]+)@(.+)$/);
  if (!m) return "";
  let local = m[1].replace(/\+.*$/, "");
  const domain = m[2];
  if (/^(gmail|googlemail)\.com$/i.test(domain)) local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/** Statuses we persist and display as-is. */
const KNOWN_VAULT_STATUSES = [
  "ready",
  "active",
  "created",
  "needs_sms",
  "needs_terms",
  "register_failed",
  "banned",
  "burned",
  "disabled",
];

/** Account exists on the retailer (do not re-register this exact email). */
const REGISTERED_STATUSES = new Set([
  "ready",
  "active",
  "created",
  "needs_sms",
  "needs_terms",
]);

/** Auto-assign may pick these for Bandai checkout. */
const BANDAI_AUTO_STATUSES = new Set(["ready", "active"]);

/**
 * @param {string|null|undefined} status
 * @param {string} [storeId]
 */
function normalizeVaultStatus(status, storeId = "toymate") {
  const s = String(status || "").trim().toLowerCase();
  if (KNOWN_VAULT_STATUSES.includes(s)) return s;
  // Unknown / missing: never invent "ready" for Bandai SoftBlock leftovers.
  if (String(storeId) === "bandai") return s ? "created" : "created";
  return s || "active";
}

/**
 * Whether a vault row means this email already exists for the store.
 * @param {object} account
 */
function isRegisteredVaultStatus(account) {
  const s = normalizeVaultStatus(account?.status, account?.storeId);
  return REGISTERED_STATUSES.has(s);
}

/**
 * Persist agen results only when Bandai actually created a member (or Toymate equivalent).
 * Never vault register_failed / burned-without-password as checkout-ready rows.
 *
 * @param {object} result — executor finish payload
 * @param {string} [storeId]
 */
function shouldPersistGeneratedAccount(result, storeId) {
  const sid = String(storeId || result?.account?.storeId || "toymate");
  if (!result?.accountGen) return false;
  const email = String(result?.account?.email || "").trim();
  const password = String(result?.account?.password || "").trim();
  if (!email || !password) return false;

  const status = normalizeVaultStatus(result.account.status, sid);
  if (status === "register_failed" || status === "burned" || status === "banned") {
    return false;
  }
  if (sid === "bandai") {
    // ready / created / needs_* / active — member exists (login may SoftBlock).
    return REGISTERED_STATUSES.has(status);
  }
  // Toymate / others: keep prior behaviour — any email+password agen row.
  return true;
}

/**
 * Exact emails already registered for a store (for agen uniquify / collision).
 * @param {object[]} accounts
 * @param {string} storeId
 * @returns {string[]} lowercased emails
 */
function vaultRegisteredEmails(accounts, storeId) {
  const sid = String(storeId || "");
  const list = Array.isArray(accounts) ? accounts : [];
  return list
    .filter(
      (a) =>
        String(a.storeId || a.adapter || "") === sid &&
        a.email &&
        isRegisteredVaultStatus(a),
    )
    .map((a) => String(a.email).trim().toLowerCase());
}

/**
 * Find a vault account that already owns this email (exact or emailBase) for the store.
 * @param {{ accounts: object[], storeId: string, email: string, matchBase?: boolean }} opts
 */
function findRegisteredAccount({ accounts, storeId, email, matchBase = false } = {}) {
  const sid = String(storeId || "");
  const target = String(email || "").trim().toLowerCase();
  if (!target) return null;
  const base = emailBase(target);
  const list = Array.isArray(accounts) ? accounts : [];
  return (
    list.find((a) => {
      if (String(a.storeId || a.adapter || "") !== sid) return false;
      if (!isRegisteredVaultStatus(a)) return false;
      const ae = String(a.email || "").trim().toLowerCase();
      if (ae === target) return true;
      return matchBase && base && emailBase(ae) === base;
    }) || null
  );
}

/**
 * Bandai auto-assign status gate.
 * @param {object} account
 */
function bandaiAutoAssignable(account) {
  const s = normalizeVaultStatus(account?.status, "bandai");
  // Legacy rows with missing status still match.
  if (!account?.status) return true;
  return BANDAI_AUTO_STATUSES.has(s);
}

const MANUAL_STORE_IDS = new Set(["bandai", "toymate", "disney", "kmart"]);

/**
 * Normalize one manual / imported account payload (email+password required).
 * @param {object} input
 * @returns {{ ok: true, account: object } | { ok: false, error: string }}
 */
function normalizeManualAccount(input = {}) {
  const email = String(input.email || input.memberId || "").trim();
  const password = String(input.password || input.pass || "").trim();
  if (!email || !email.includes("@")) {
    return { ok: false, error: "email required (member login)" };
  }
  if (!password) return { ok: false, error: "password required" };

  let storeId = String(input.storeId || input.store || input.adapter || "bandai")
    .trim()
    .toLowerCase();
  if (storeId === "premium bandai" || storeId === "p-bandai") storeId = "bandai";
  if (!MANUAL_STORE_IDS.has(storeId)) storeId = "bandai";

  const statusRaw = input.status != null ? String(input.status).trim() : "";
  // Manual/import rows default to ready (user intends checkout use).
  const status = normalizeVaultStatus(statusRaw || "ready", storeId);
  let source;
  if (input.source != null && String(input.source).trim()) {
    source = String(input.source).trim();
  } else if (!input.id) {
    source = "manual";
  }

  return {
    ok: true,
    account: {
      id: input.id ? String(input.id) : undefined,
      email,
      emailBase: emailBase(email),
      password,
      phone: input.phone != null ? String(input.phone) : null,
      storeId,
      adapter: storeId,
      profileId: input.profileId || null,
      source,
      status,
      loginProvenAt: input.loginProvenAt || null,
      lastLoginAt: input.lastLoginAt || null,
      lastUsedAt: input.lastUsedAt || null,
      createdAt: input.createdAt || null,
      notes: input.notes != null ? String(input.notes).slice(0, 240) : null,
      accountGroup: String(input.accountGroup || input.group || "").trim().slice(0, 80),
    },
  };
}

function splitImportLine(line) {
  const s = String(line || "").trim();
  if (!s || s.startsWith("#") || s.startsWith("//")) return null;
  // email:password  |  store:email:password  |  csv commas
  if (s.includes(",") && !/^[^,]+:[^:]+$/.test(s)) {
    return s.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
  }
  // Prefer last colon split for email:password when email has no port noise.
  const parts = s.split(":").map((p) => p.trim());
  return parts;
}

/**
 * Parse JSON array / NDJSON / line list into account drafts.
 * Lines: `email:password`, `store:email:password`, or CSV `store,email,password[,status]`.
 * @param {string|object} raw
 * @returns {{ ok: boolean, accounts: object[], errors: string[], skipped: number }}
 */
function parseAccountsImport(raw) {
  const errors = [];
  const accounts = [];
  let skipped = 0;

  let parsed = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return { ok: false, accounts: [], errors: ["empty import"], skipped: 0 };
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  /** @type {object[]} */
  let drafts = [];
  if (Array.isArray(parsed)) {
    drafts = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.accounts)) {
    drafts = parsed.accounts;
  } else if (typeof parsed === "string") {
    const lines = parsed.split(/\r?\n/);
    // Optional header
    let start = 0;
    if (/store|email|password/i.test(lines[0] || "") && /,/i.test(lines[0] || "")) {
      start = 1;
    }
    for (let i = start; i < lines.length; i++) {
      const parts = splitImportLine(lines[i]);
      if (!parts) {
        skipped += 1;
        continue;
      }
      if (parts.length === 2) {
        drafts.push({ email: parts[0], password: parts[1] });
      } else if (parts.length === 3) {
        // store,email,password OR email,password,status
        if (parts[0].includes("@")) {
          drafts.push({ email: parts[0], password: parts[1], status: parts[2] });
        } else {
          drafts.push({ storeId: parts[0], email: parts[1], password: parts[2] });
        }
      } else if (parts.length >= 4) {
        drafts.push({
          storeId: parts[0],
          email: parts[1],
          password: parts[2],
          status: parts[3],
        });
      } else {
        errors.push(`line ${i + 1}: need email:password`);
      }
    }
  } else if (parsed && typeof parsed === "object" && parsed.email) {
    drafts = [parsed];
  } else {
    return { ok: false, accounts: [], errors: ["unrecognized import format"], skipped: 0 };
  }

  for (let i = 0; i < drafts.length; i++) {
    const n = normalizeManualAccount({ ...drafts[i], source: drafts[i]?.source || "import" });
    if (!n.ok) {
      errors.push(`row ${i + 1}: ${n.error}`);
      continue;
    }
    accounts.push(n.account);
  }

  return {
    ok: accounts.length > 0,
    accounts,
    errors,
    skipped,
  };
}

/**
 * @param {object[]} accounts
 * @param {"json"|"csv"|"lines"} [format]
 */
function formatAccountsExport(accounts, format = "json") {
  const list = (Array.isArray(accounts) ? accounts : []).map((a) => ({
    storeId: a.storeId || "bandai",
    email: a.email,
    password: a.password,
    status: a.status || "ready",
    source: a.source || null,
    phone: a.phone || null,
    emailBase: a.emailBase || emailBase(a.email),
    loginProvenAt: a.loginProvenAt || null,
    createdAt: a.createdAt || null,
  }));
  const fmt = String(format || "json").toLowerCase();
  if (fmt === "csv") {
    const header = "storeId,email,password,status,source";
    const rows = list.map(
      (a) =>
        [a.storeId, a.email, a.password, a.status, a.source || ""]
          .map((c) => {
            const s = String(c ?? "");
            return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(","),
    );
    return [header, ...rows].join("\n") + (rows.length ? "\n" : "");
  }
  if (fmt === "lines") {
    return list.map((a) => `${a.storeId}:${a.email}:${a.password}`).join("\n") + (list.length ? "\n" : "");
  }
  return `${JSON.stringify({ exportedAt: new Date().toISOString(), accounts: list }, null, 2)}\n`;
}

module.exports = {
  KNOWN_VAULT_STATUSES,
  REGISTERED_STATUSES,
  BANDAI_AUTO_STATUSES,
  MANUAL_STORE_IDS,
  normalizeVaultStatus,
  isRegisteredVaultStatus,
  shouldPersistGeneratedAccount,
  vaultRegisteredEmails,
  findRegisteredAccount,
  bandaiAutoAssignable,
  normalizeManualAccount,
  parseAccountsImport,
  formatAccountsExport,
  emailBase,
};
