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

module.exports = {
  KNOWN_VAULT_STATUSES,
  REGISTERED_STATUSES,
  BANDAI_AUTO_STATUSES,
  normalizeVaultStatus,
  isRegisteredVaultStatus,
  shouldPersistGeneratedAccount,
  vaultRegisteredEmails,
  findRegisteredAccount,
  bandaiAutoAssignable,
};
