// License + Hyper provision client.
// Whop-ready: today DESKTOP_AUTH_MODE=open on the control plane accepts any
// non-empty API key. Later the same endpoints check Whop / your issuer.

async function validateApiKey({ controlPlaneUrl, apiKey }) {
  const base = String(controlPlaneUrl || "").replace(/\/$/, "");
  const key = String(apiKey || "").trim();
  if (!key) {
    return { ok: false, status: "invalid", message: "API key required" };
  }
  // Local-only mode: no control plane → treat key as present (dev / early access).
  if (!base) {
    return {
      ok: true,
      status: "open",
      message: "Local mode — control plane not set (Whop gating not enabled yet)",
      mode: "local",
    };
  }
  try {
    const res = await fetch(`${base}/api/public/desktop/validate-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      return {
        ok: false,
        status: "invalid",
        message: json.message || json.error || `HTTP ${res.status}`,
        mode: json.mode,
      };
    }
    return {
      ok: true,
      status: json.status || "valid",
      message: json.message || "OK",
      mode: json.mode,
    };
  } catch (e) {
    return { ok: false, status: "invalid", message: e.message || String(e) };
  }
}

/**
 * Optional: fetch operator Hyper key after license check.
 * Prefer BYO Hyper in settings when you don't want the key leaving the server
 * long-term — this is a transitional provision endpoint.
 */
async function provisionHyper({ controlPlaneUrl, apiKey }) {
  const base = String(controlPlaneUrl || "").replace(/\/$/, "");
  const key = String(apiKey || "").trim();
  if (!base || !key) return { ok: false, error: "control plane + API key required to provision Hyper" };
  try {
    const res = await fetch(`${base}/api/public/desktop/hyper-provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      return { ok: false, error: json.message || json.error || `HTTP ${res.status}` };
    }
    if (!json.hyperApiKey) return { ok: false, error: "provision returned no key" };
    return { ok: true, hyperApiKey: json.hyperApiKey };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { validateApiKey, provisionHyper };
