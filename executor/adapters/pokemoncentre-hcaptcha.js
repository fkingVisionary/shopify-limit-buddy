// CapSolver hCaptcha harvest for Pokémon Centre (Imperva / drop windows).
// Hyper does NOT solve hCaptcha — this is the gap path (P5).
// Isolated from Kmart; reuses CapSolver env key already wired for Toymate.

const CAPSOLVER_CREATE = "https://api.capsolver.com/createTask";
const CAPSOLVER_RESULT = "https://api.capsolver.com/getTaskResult";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function capsolverKey() {
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
  if (parts.length >= 4) {
    if (/^\d+$/.test(parts[1])) {
      const [host, port, user, ...passParts] = parts;
      return `${host}:${port}:${user}:${passParts.join(":")}`;
    }
    if (/^\d+$/.test(parts[parts.length - 1])) {
      const port = parts[parts.length - 1];
      const host = parts[parts.length - 2];
      const user = parts[0];
      const pass = parts.slice(1, -2).join(":");
      return `${host}:${port}:${user}:${pass}`;
    }
  }
  return s.includes("@") ? s.replace(/^https?:\/\//i, "") : s;
}

export function extractHcaptchaSitekey(html) {
  const h = String(html || "");
  const patterns = [
    /data-sitekey=["']([^"']+)["']/i,
    /sitekey["']\s*:\s*["']([^"']+)["']/i,
    /hcaptcha\.com\/1\/api\.js\?[^"']*render=([^"'&]+)/i,
    /["']sitekey["']\s*,\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (m?.[1] && m[1].length >= 10) return m[1];
  }
  return null;
}

export function looksLikeHcaptcha(html) {
  const h = String(html || "");
  return /hcaptcha\.com|h-captcha|data-sitekey/i.test(h) && Boolean(extractHcaptchaSitekey(h));
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
    let pollRes;
    try {
      pollRes = await fetch(CAPSOLVER_RESULT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey, taskId }),
      });
    } catch {
      await sleep(2500);
      continue;
    }
    const poll = await pollRes.json().catch(() => ({}));
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
 * Solve hCaptcha via CapSolver (proxy preferred for Imperva affinity).
 * @returns {{ ok, token?, error?, elapsedMs? }}
 */
export async function solveHcaptcha({ pageUrl, sitekey, proxyRaw, userAgent, rqdata } = {}) {
  if (!sitekey) return { ok: false, error: "hCaptcha sitekey missing" };
  if (!pageUrl) return { ok: false, error: "hCaptcha pageUrl missing" };
  if (!capsolverKey()) return { ok: false, error: "CAPSOLVER_API_KEY missing" };

  const proxy = proxyToCapsolverFormat(proxyRaw);
  const task = {
    type: proxy ? "HCaptchaTask" : "HCaptchaTaskProxyLess",
    websiteURL: pageUrl,
    websiteKey: sitekey,
  };
  if (userAgent) task.userAgent = userAgent;
  if (rqdata) task.enterprisePayload = { rqdata };
  if (proxy) {
    const [ip, port, user, ...passParts] = proxy.split(":");
    task.proxyType = "http";
    task.proxyAddress = ip;
    task.proxyPort = Number(port);
    if (user) {
      task.proxyLogin = user;
      task.proxyPassword = passParts.join(":");
    }
  }

  const solved = await capsolverCreateAndPoll(task, { timeoutMs: 150_000 });
  if (!solved.ok) return solved;
  const token =
    solved.solution?.gRecaptchaResponse ||
    solved.solution?.token ||
    solved.solution?.respKey ||
    null;
  if (!token) return { ok: false, error: "CapSolver returned empty hCaptcha token" };
  return { ok: true, token, elapsedMs: solved.elapsedMs, userAgent: solved.solution?.userAgent };
}

export { capsolverKey };
