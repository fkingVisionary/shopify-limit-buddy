import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// 2Captcha harvester. Submits a captcha to 2Captcha's API and polls for the
// solved token. Tokens are usually IP-bound by the target site — pass a
// `proxy` (user:pass@ip:port) so the solver worker uses the same exit IP as
// the checkout that will submit the token. Without it, expect ~70% rejection
// on Cloudflare Turnstile / hCaptcha.

const InputSchema = z.object({
  type: z.enum(["turnstile", "recaptchaV2", "recaptchaV3", "hcaptcha"]),
  sitekey: z.string().min(10).max(200),
  pageUrl: z.string().url().max(500),
  // Optional proxy in `user:pass@ip:port` or `ip:port` form. HTTP/HTTPS only.
  proxy: z.string().min(7).max(200).optional().nullable(),
  // reCAPTCHA v3 only
  action: z.string().min(1).max(80).optional().nullable(),
  minScore: z.number().min(0.1).max(0.9).optional().nullable(),
  // Hard cap on how long we'll poll (seconds). 2Captcha typically returns
  // in 15-45s. We bail at 120s so the request doesn't hang forever.
  timeoutSec: z.number().min(20).max(180).optional().nullable(),
});

type SolveOk = { ok: true; token: string; captchaId: string; elapsedMs: number };
type SolveErr = { ok: false; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseProxy(raw: string): { host: string; userpass: string | null } | null {
  // Strip scheme if present
  const s = raw.replace(/^https?:\/\//i, "").trim();
  if (!s) return null;
  if (s.includes("@")) {
    const [up, host] = s.split("@");
    if (!up || !host || !host.includes(":")) return null;
    return { host, userpass: up };
  }
  // ip:port  OR  user:pass:ip:port (common AIO format)
  const parts = s.split(":");
  if (parts.length === 2) return { host: s, userpass: null };
  if (parts.length === 4) {
    const [user, pass, ip, port] = parts;
    return { host: `${ip}:${port}`, userpass: `${user}:${pass}` };
  }
  return null;
}

export const solveCaptcha = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<SolveOk | SolveErr> => {
    const apiKey = process.env.TWOCAPTCHA_API_KEY;
    if (!apiKey) return { ok: false, error: "TWOCAPTCHA_API_KEY not configured" };

    const start = Date.now();
    const timeoutMs = (data.timeoutSec ?? 120) * 1000;

    // Build submit payload (2Captcha JSON API: https://2captcha.com/2captcha-api)
    const taskBase: Record<string, unknown> = {
      websiteURL: data.pageUrl,
      websiteKey: data.sitekey,
    };

    let typeField: string;
    switch (data.type) {
      case "turnstile":
        typeField = "TurnstileTaskProxyless";
        break;
      case "recaptchaV2":
        typeField = "RecaptchaV2TaskProxyless";
        break;
      case "recaptchaV3":
        typeField = "RecaptchaV3TaskProxyless";
        (taskBase as Record<string, unknown>).pageAction = data.action || "verify";
        (taskBase as Record<string, unknown>).minScore = data.minScore ?? 0.7;
        break;
      case "hcaptcha":
        typeField = "HCaptchaTaskProxyless";
        break;
    }

    // If proxy supplied, upgrade to non-proxyless variant
    let proxyFields: Record<string, unknown> = {};
    if (data.proxy) {
      const parsed = parseProxy(data.proxy);
      if (!parsed) return { ok: false, error: "Invalid proxy format. Use user:pass:ip:port" };
      typeField = typeField.replace("Proxyless", "");
      const [ip, port] = parsed.host.split(":");
      proxyFields = {
        proxyType: "http",
        proxyAddress: ip,
        proxyPort: Number(port),
      };
      if (parsed.userpass) {
        const [u, p] = parsed.userpass.split(":");
        proxyFields.proxyLogin = u;
        proxyFields.proxyPassword = p;
      }
    }

    const createBody = {
      clientKey: apiKey,
      task: { type: typeField, ...taskBase, ...proxyFields },
    };

    let createRes: Response;
    try {
      createRes = await fetch("https://api.2captcha.com/createTask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });
    } catch (e) {
      return { ok: false, error: `2Captcha submit network error: ${(e as Error).message}` };
    }

    const createJson = (await createRes.json().catch(() => ({}))) as {
      errorId?: number;
      errorCode?: string;
      errorDescription?: string;
      taskId?: number;
    };
    if (createJson.errorId && createJson.errorId !== 0) {
      return {
        ok: false,
        error: `2Captcha ${createJson.errorCode ?? "ERROR"}: ${createJson.errorDescription ?? "unknown"}`,
      };
    }
    const taskId = createJson.taskId;
    if (!taskId) return { ok: false, error: "2Captcha returned no taskId" };

    // Initial wait — solvers rarely finish under 10s
    await sleep(8000);

    while (Date.now() - start < timeoutMs) {
      let pollRes: Response;
      try {
        pollRes = await fetch("https://api.2captcha.com/getTaskResult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: apiKey, taskId }),
        });
      } catch (e) {
        await sleep(3000);
        continue;
      }
      const pollJson = (await pollRes.json().catch(() => ({}))) as {
        errorId?: number;
        errorCode?: string;
        errorDescription?: string;
        status?: "ready" | "processing";
        solution?: { token?: string; gRecaptchaResponse?: string };
      };
      if (pollJson.errorId && pollJson.errorId !== 0) {
        return {
          ok: false,
          error: `2Captcha ${pollJson.errorCode ?? "ERROR"}: ${pollJson.errorDescription ?? "unknown"}`,
        };
      }
      if (pollJson.status === "ready") {
        const token = pollJson.solution?.token ?? pollJson.solution?.gRecaptchaResponse;
        if (!token) return { ok: false, error: "2Captcha returned no token" };
        return { ok: true, token, captchaId: String(taskId), elapsedMs: Date.now() - start };
      }
      await sleep(5000);
    }
    return { ok: false, error: `Timed out after ${Math.round((Date.now() - start) / 1000)}s` };
  });

export const getCaptchaBalance = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ ok: true; balance: number } | { ok: false; error: string }> => {
    const apiKey = process.env.TWOCAPTCHA_API_KEY;
    if (!apiKey) return { ok: false, error: "TWOCAPTCHA_API_KEY not configured" };
    try {
      const res = await fetch("https://api.2captcha.com/getBalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey }),
      });
      const j = (await res.json()) as { errorId?: number; errorDescription?: string; balance?: number };
      if (j.errorId && j.errorId !== 0) return { ok: false, error: j.errorDescription ?? "error" };
      return { ok: true, balance: Number(j.balance ?? 0) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
);
