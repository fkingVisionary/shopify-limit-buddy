// Toymate Cloudflare + captcha helpers (CapSolver).
// Isolated from Kmart / Hyper — only used by adapters/toymate.js.

const CAPSOLVER_CREATE = "https://api.capsolver.com/createTask";
const CAPSOLVER_RESULT = "https://api.capsolver.com/getTaskResult";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function capsolverKey() {
  return String(process.env.CAPSOLVER_API_KEY || "").trim();
}

/**
 * CapSolver proxy string: ip:port:user:pass (no scheme).
 * Accepts http://user:pass@host:port and common AIO forms.
 */
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
    // host:port:user:pass OR user:pass:host:port
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

async function capsolverCreateAndPoll(task, { timeoutMs = 120_000 } = {}) {
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

function looksLikeCfChallenge(html, status) {
  if (status === 403 || status === 503) return true;
  const h = String(html || "");
  return (
    /cf-browser-verification|challenge-platform|just a moment|cf-challenge|__cf_chl|/i.test(h) ||
    /Attention Required|Cloudflare/i.test(h)
  );
}

/**
 * Solve Cloudflare challenge via CapSolver AntiCloudflareTask using live HTML
 * scraped through the same sticky proxy the checkout client uses.
 */
export async function solveCloudflareChallenge({
  pageUrl,
  html,
  proxyRaw,
  userAgent,
} = {}) {
  const proxy = proxyToCapsolverFormat(proxyRaw);
  if (!proxy) {
    return { ok: false, error: "AntiCloudflareTask needs a proxy (residential/ISP)" };
  }
  if (!html || html.length < 40) {
    return { ok: false, error: "AntiCloudflareTask needs challenge HTML" };
  }

  const task = {
    type: "AntiCloudflareTask",
    websiteURL: pageUrl,
    proxy,
    metadata: {
      type: "challenge",
      html: String(html).slice(0, 450_000),
    },
  };
  if (userAgent) task.userAgent = userAgent;

  const solved = await capsolverCreateAndPoll(task, { timeoutMs: 150_000 });
  if (!solved.ok) return solved;

  const sol = solved.solution || {};
  const cookies = {};
  if (typeof sol.cookies === "object" && sol.cookies) {
    for (const [k, v] of Object.entries(sol.cookies)) cookies[k] = String(v);
  } else if (Array.isArray(sol.cookies)) {
    for (const c of sol.cookies) {
      if (c?.name) cookies[c.name] = String(c.value ?? "");
    }
  }
  if (sol.token && !cookies.cf_clearance) cookies.cf_clearance = String(sol.token);
  if (sol.cf_clearance) cookies.cf_clearance = String(sol.cf_clearance);

  return {
    ok: Boolean(cookies.cf_clearance || Object.keys(cookies).length),
    cookies,
    userAgent: sol.userAgent || userAgent || null,
    elapsedMs: solved.elapsedMs,
    note: cookies.cf_clearance ? "cf_clearance minted" : "CF cookies returned",
  };
}

/**
 * Solve reCAPTCHA v2 (form captcha on create-account / spam-protection).
 */
export async function solveRecaptchaV2({ pageUrl, sitekey, proxyRaw } = {}) {
  if (!sitekey) return { ok: false, error: "reCAPTCHA sitekey missing" };
  const proxy = proxyToCapsolverFormat(proxyRaw);
  const task = {
    type: proxy ? "ReCaptchaV2Task" : "ReCaptchaV2TaskProxyLess",
    websiteURL: pageUrl,
    websiteKey: sitekey,
  };
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
  const token = solved.solution?.gRecaptchaResponse || solved.solution?.token;
  if (!token) return { ok: false, error: "CapSolver returned empty reCAPTCHA token" };
  return { ok: true, token, elapsedMs: solved.elapsedMs };
}

export function extractRecaptchaSitekey(html) {
  const h = String(html || "");
  const patterns = [
    /data-sitekey=["']([^"']+)["']/i,
    /sitekey["']\s*:\s*["']([^"']+)["']/i,
    /grecaptcha\.execute\(\s*["']([^"']+)["']/i,
    /www\.google\.com\/recaptcha\/api\.js\?[^"']*render=([^"'&]+)/i,
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (m?.[1] && m[1].length >= 20) return m[1];
  }
  return null;
}

export { looksLikeCfChallenge, capsolverKey };
