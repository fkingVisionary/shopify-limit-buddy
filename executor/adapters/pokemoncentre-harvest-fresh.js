/**
 * Pure freshness helpers for Pokémon Centre harvest sessions (no HTTP deps).
 */

/** Edge cookie usefulness window on sticky ISP (conservative). */
export const PC_EDGE_TTL_MS = 3 * 60_000;
/** CapSolver / hCaptcha token window. */
export const PC_HCAPTCHA_TTL_MS = 100_000;

export function isPcHarvestFresh(session, { requireCaptcha = false } = {}) {
  if (!session || typeof session !== "object") return false;
  if (!session.cookies || typeof session.cookies !== "object") return false;
  const t = Date.now();
  if (session.edgeExpiresAt != null && Number(session.edgeExpiresAt) <= t) return false;
  if (requireCaptcha) {
    if (!session.captchaToken) return false;
    if (session.captchaExpiresAt != null && Number(session.captchaExpiresAt) <= t) {
      return false;
    }
  }
  const reese = session.cookies.reese84 || "";
  const dd = session.cookies.datadome || "";
  return Boolean(String(reese).length > 20 && String(dd).length > 8);
}
