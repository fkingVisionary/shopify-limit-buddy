// Resolve retailer vault accounts for checkout tasks.
// Default: auto-match by profile email base (handles +tag / gmail-dot uniquify).
// Manual: task.accountId. Guest: skip login.

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

function emailsMatch(a, b) {
  const ba = emailBase(a);
  const bb = emailBase(b);
  return Boolean(ba && bb && ba === bb);
}

function storeMatches(account, storeId) {
  const sid = String(storeId || "toymate");
  const as = String(account?.storeId || account?.adapter || "");
  if (!as) return sid === "toymate";
  return as === sid || as === "toymate" && sid === "toymate";
}

/**
 * @param {object} opts
 * @param {object} opts.task
 * @param {object|null} opts.profile
 * @param {object[]} opts.accounts
 * @param {string[]} [opts.excludeIds] — already claimed in this batch
 * @returns {{ account: object|null, source: string, error?: string, candidates: number }}
 */
function resolveAccountForTask({ task, profile, accounts, excludeIds = [] } = {}) {
  const mode = String(task?.toymateMode || task?.mode || "checkout").toLowerCase();
  if (mode === "account_gen" || mode === "monitor") {
    return { account: null, source: "n/a", candidates: 0 };
  }

  const assign = String(task?.accountAssign || "auto").toLowerCase();
  const list = Array.isArray(accounts) ? accounts : [];
  const excluded = new Set((excludeIds || []).map(String));
  const storeId = task?.store || "toymate";

  if (assign === "guest" || assign === "none") {
    return { account: null, source: "guest", candidates: 0 };
  }

  if (assign === "manual") {
    const id = String(task?.accountId || "");
    if (!id) {
      return { account: null, source: "manual", error: "Pick a vault account (manual assign)", candidates: 0 };
    }
    const hit = list.find((a) => a.id === id);
    if (!hit) {
      return { account: null, source: "manual", error: "Assigned account missing from vault", candidates: 0 };
    }
    return { account: hit, source: "manual", candidates: 1 };
  }

  // auto — profileId link first, then email base
  const profileId = profile?.id || task?.profileId || null;
  const profileEmail = profile?.email || null;
  const pool = list.filter(
    (a) =>
      storeMatches(a, storeId) &&
      a.status !== "disabled" &&
      !excluded.has(String(a.id)) &&
      a.email &&
      a.password,
  );

  const byProfileId = profileId
    ? pool.filter((a) => String(a.profileId || "") === String(profileId))
    : [];
  const byEmail = profileEmail ? pool.filter((a) => emailsMatch(a.email, profileEmail)) : [];

  // Prefer intersection, then profileId, then email.
  let candidates = byProfileId.filter((a) => byEmail.some((b) => b.id === a.id));
  if (!candidates.length) candidates = byProfileId.length ? byProfileId : byEmail;

  candidates.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0) || (a.createdAt || 0) - (b.createdAt || 0));

  if (!candidates.length) {
    return {
      account: null,
      source: "auto",
      error: profileEmail
        ? `No vault account matches profile email (${profileEmail}) — generate one or assign manually`
        : "No profile email to auto-match — assign an account manually",
      candidates: 0,
    };
  }

  return { account: candidates[0], source: "auto", candidates: candidates.length };
}

module.exports = {
  emailBase,
  emailsMatch,
  resolveAccountForTask,
};
