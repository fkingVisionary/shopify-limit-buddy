/**
 * Desktop app license checks — Whop-ready, not Whop-gated yet.
 *
 * DESKTOP_AUTH_MODE:
 *   - "open" (default): any non-empty API key is accepted. Use while building.
 *   - "allowlist": key must appear in DESKTOP_API_KEYS (comma-separated).
 *   - "whop": reserved — wire Whop membership validation here later.
 *
 * DESKTOP_HYPER_PROVISION=1 + HYPER_API_KEY on the server enables
 * /api/public/desktop/hyper-provision to hand the operator key to a
 * licensed desktop session (transitional; prefer BYO Hyper in the app).
 */

export type DesktopAuthMode = "open" | "allowlist" | "whop";

export function desktopAuthMode(): DesktopAuthMode {
  const m = String(process.env.DESKTOP_AUTH_MODE || "open").toLowerCase();
  if (m === "allowlist" || m === "whop") return m;
  return "open";
}

export function allowlistedKeys(): Set<string> {
  return new Set(
    String(process.env.DESKTOP_API_KEYS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export type ValidateResult =
  | { ok: true; status: string; message: string; mode: DesktopAuthMode }
  | { ok: false; status: string; message: string; mode: DesktopAuthMode };

export async function validateDesktopApiKey(apiKey: string): Promise<ValidateResult> {
  const key = String(apiKey || "").trim();
  const mode = desktopAuthMode();
  if (!key) {
    return { ok: false, status: "invalid", message: "API key required", mode };
  }

  if (mode === "open") {
    return {
      ok: true,
      status: "open",
      message: "Accepted (DESKTOP_AUTH_MODE=open — Whop gating not enabled yet)",
      mode,
    };
  }

  if (mode === "allowlist") {
    if (allowlistedKeys().has(key)) {
      return { ok: true, status: "valid", message: "API key allowlisted", mode };
    }
    return { ok: false, status: "invalid", message: "API key not in allowlist", mode };
  }

  // whop — stub until Whop is connected
  return {
    ok: false,
    status: "invalid",
    message: "DESKTOP_AUTH_MODE=whop is reserved — wire Whop validation before enabling",
    mode,
  };
}

export function hyperProvisionEnabled(): boolean {
  return String(process.env.DESKTOP_HYPER_PROVISION || "").trim() === "1";
}

export function operatorHyperApiKey(): string {
  return String(process.env.HYPER_API_KEY || "").trim();
}
