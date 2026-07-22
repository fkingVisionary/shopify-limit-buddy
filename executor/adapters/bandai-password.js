// Premium Bandai AU signup password rules (from BANDAI_AU_MODULE §4.2).

const SEQUENTIAL_ASC = "abcdefghijklmnopqrstuvwxyz0123456789";
const SEQUENTIAL_DESC = "zyxwvutsrqponmlkjihgfedcba9876543210";

function hasSequentialRun(s, minLen = 3) {
  const lower = String(s).toLowerCase();
  for (let i = 0; i <= lower.length - minLen; i++) {
    const slice = lower.slice(i, i + minLen);
    if (SEQUENTIAL_ASC.includes(slice) || SEQUENTIAL_DESC.includes(slice)) return true;
  }
  return false;
}

/**
 * @param {string} password
 * @param {string} [email]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateBandaiPassword(password, email = "") {
  const p = String(password || "");
  const errors = [];
  if (p.length <= 7) errors.push("length_gt_7");
  if (p.length > 20) errors.push("length_max_20");
  if (/(.)\1{2,}/.test(p)) errors.push("triple_repeat");
  if (hasSequentialRun(p, 3)) errors.push("sequential_run");
  const local = String(email || "").split("@")[0] || "";
  if (local && p.toLowerCase().includes(local.toLowerCase())) {
    errors.push("contains_email_local");
  }
  if (!/[A-Z]/.test(p)) errors.push("need_upper");
  if (!/[a-z]/.test(p)) errors.push("need_lower");
  if (!/[0-9]/.test(p)) errors.push("need_digit");
  if (!/[^A-Za-z0-9]/.test(p)) errors.push("need_symbol");
  // half-width only — reject common fullwidth / non-ascii
  if (/[^\x20-\x7E]/.test(p)) errors.push("half_width_only");
  return { ok: errors.length === 0, errors };
}

/** Generate a password that passes AU Bandai rules. */
export function generateBandaiPassword(email = "") {
  const symbols = "!@#$%&*";
  for (let attempt = 0; attempt < 40; attempt++) {
    const stamp = Date.now().toString(36).slice(-4);
    const rand = Math.random().toString(36).slice(2, 6);
    const p = `Ab1!${stamp}${rand}`.slice(0, 16);
    const v = validateBandaiPassword(p, email);
    if (v.ok) return p;
    // mutate
    const alt = `Kx9#${rand}${stamp}${symbols[attempt % symbols.length]}`.slice(0, 18);
    if (validateBandaiPassword(alt, email).ok) return alt;
  }
  return `Ab1!xY${Date.now().toString(36).slice(-6)}`;
}

export default { validateBandaiPassword, generateBandaiPassword };
