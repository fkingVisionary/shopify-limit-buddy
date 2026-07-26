/**
 * Disney Store AU — CapSolver reCAPTCHA Enterprise (AddToCart).
 *
 * Storefront uses grecaptcha.enterprise.execute(sitekey, { action: "AddToCart" })
 * then POST Google-reCaptchaEnterprise { token }.
 *
 * CapSolver: ReCaptchaV3EnterpriseTask / ProxyLess (action-based enterprise).
 * Key: CAPSOLVER_API_KEY (env / Desktop Settings) — never commit.
 */

import {
  DISNEY_ORIGIN,
  DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
} from "./disney-session.js";

const CAPSOLVER_CREATE = "https://api.capsolver.com/createTask";
const CAPSOLVER_RESULT = "https://api.capsolver.com/getTaskResult";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function capsolverKey() {
  return String(process.env.CAPSOLVER_API_KEY || "").trim();
}

/** CapSolver proxy: ip:port:user:pass */
export function proxyToCapsolverFormat(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const host = u.hostname;
      const port = u.port || (u.protocol === "https:" ? "443" : "80");
      if (u.username) {
        return `${host}:${port}:${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || "")}`;
      }
      return `${host}:${port}`;
    }
  } catch {
    /* fall through */
  }
  const parts = s.split(":");
  if (parts.length === 2) return s;
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    const [host, port, user, ...passParts] = parts;
    return `${host}:${port}:${user}:${passParts.join(":")}`;
  }
  return s;
}

async function capsolverCreateAndPoll(task, { timeoutMs = 150_000 } = {}) {
  const clientKey = capsolverKey();
  if (!clientKey) return { ok: false, error: "CAPSOLVER_API_KEY missing" };

  const start = Date.now();
  let createRes;
  try {
    createRes = await fetch(CAPSOLVER_CREATE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey, task }),
    });
  } catch (e) {
    return { ok: false, error: `CapSolver create network: ${e?.message || e}` };
  }
  const createJson = await createRes.json().catch(() => ({}));
  if (createJson.errorId && createJson.errorId !== 0) {
    return {
      ok: false,
      error: `CapSolver ${createJson.errorCode || "ERROR"}: ${createJson.errorDescription || "create failed"}`,
    };
  }
  const taskId = createJson.taskId;
  if (!taskId) return { ok: false, error: "CapSolver returned no taskId" };

  await sleep(3000);
  while (Date.now() - start < timeoutMs) {
    let poll;
    try {
      const pollRes = await fetch(CAPSOLVER_RESULT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey, taskId }),
      });
      poll = await pollRes.json().catch(() => ({}));
    } catch {
      await sleep(2500);
      continue;
    }
    if (poll.errorId && poll.errorId !== 0) {
      return {
        ok: false,
        error: `CapSolver ${poll.errorCode || "ERROR"}: ${poll.errorDescription || "poll failed"}`,
      };
    }
    if (poll.status === "ready" && poll.solution) {
      return { ok: true, solution: poll.solution, taskId, elapsedMs: Date.now() - start };
    }
    if (poll.status === "failed") {
      return { ok: false, error: "CapSolver task failed" };
    }
    await sleep(2500);
  }
  return { ok: false, error: "CapSolver timeout" };
}

/**
 * Solve Disney ATC reCAPTCHA Enterprise (action AddToCart).
 * Tries Enterprise V3 task first, then V2 Enterprise as fallback.
 */
export async function solveDisneyRecaptchaEnterprise({
  pageUrl = DISNEY_ORIGIN + "/",
  sitekey = DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
  action = "AddToCart",
  proxyRaw = null,
  // Wire-proven 2026-07-26: ProxyLess Enterprise V3 succeeds for Disney ATC sitekey.
  proxyless = true,
  minScore = 0.7,
} = {}) {
  if (!sitekey) return { ok: false, error: "sitekey missing" };
  if (!capsolverKey()) return { ok: false, error: "CAPSOLVER_API_KEY missing" };

  const proxy = proxyless ? null : proxyToCapsolverFormat(proxyRaw);
  const applyProxy = (task) => {
    if (!proxy) return task;
    const [ip, port, user, ...passParts] = proxy.split(":");
    task.proxyType = "http";
    task.proxyAddress = ip;
    task.proxyPort = Number(port);
    if (user) {
      task.proxyLogin = user;
      task.proxyPassword = passParts.join(":");
    }
    return task;
  };

  const attempts = [
    applyProxy({
      type: proxy ? "ReCaptchaV3EnterpriseTask" : "ReCaptchaV3EnterpriseTaskProxyLess",
      websiteURL: pageUrl,
      websiteKey: sitekey,
      pageAction: action,
      minScore,
    }),
    // Some CapSolver accounts expose isEnterprise flag on V3 instead.
    applyProxy({
      type: proxy ? "ReCaptchaV3Task" : "ReCaptchaV3TaskProxyLess",
      websiteURL: pageUrl,
      websiteKey: sitekey,
      pageAction: action,
      minScore,
      isEnterprise: true,
    }),
    applyProxy({
      type: proxy ? "ReCaptchaV2EnterpriseTask" : "ReCaptchaV2EnterpriseTaskProxyLess",
      websiteURL: pageUrl,
      websiteKey: sitekey,
      pageAction: action,
      isEnterprise: true,
    }),
  ];

  const errors = [];
  for (const task of attempts) {
    const solved = await capsolverCreateAndPoll(task, { timeoutMs: 150_000 });
    if (!solved.ok) {
      errors.push(`${task.type}: ${solved.error}`);
      continue;
    }
    const token = solved.solution?.gRecaptchaResponse || solved.solution?.token;
    if (!token) {
      errors.push(`${task.type}: empty token`);
      continue;
    }
    return {
      ok: true,
      token,
      elapsedMs: solved.elapsedMs,
      via: task.type,
      action,
      sitekey,
    };
  }

  return {
    ok: false,
    error: `CapSolver enterprise failed: ${errors.join(" | ")}`,
    errors,
  };
}

export default {
  capsolverKey,
  solveDisneyRecaptchaEnterprise,
  proxyToCapsolverFormat,
};
