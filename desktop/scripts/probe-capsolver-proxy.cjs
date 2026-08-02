#!/usr/bin/env node
"use strict";

/**
 * Probe CapSolver AntiCloudflareTask against candidate proxies from a desktop proxy group.
 * Usage:
 *   CAPSOLVER_API_KEY=... node desktop/scripts/probe-capsolver-proxy.cjs [groupId] [websiteURL]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const undici = require(require.resolve("undici", {
  paths: [path.join(__dirname, "..", "..", "executor"), path.join(__dirname, "..")],
}));
const { ProxyAgent, fetch: undiciFetch } = undici;

const GROUP_ID = process.argv[2] || "px_noontide_resi_dual";
const WEBSITE_URL = process.argv[3] || "https://toymate.com.au/";
const MAX_PROXIES = Math.max(1, Number(process.env.PROBE_MAX || 4));
const API_KEY = String(process.env.CAPSOLVER_API_KEY || "").trim();
if (!API_KEY) {
  console.error("CAPSOLVER_API_KEY required");
  process.exit(2);
}

const dbPath = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "vanta-desktop",
  "j1ms-desktop",
  "db.json",
);
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const group = (db.proxyGroups || []).find((g) => g && g.id === GROUP_ID);
if (!group) {
  console.error(`proxy group not found: ${GROUP_ID}`);
  process.exit(2);
}

function parseProxy(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    return {
      host: u.hostname,
      port: u.port || "80",
      username: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      proxyUrl: s,
    };
  }
  const parts = s.split(":");
  if (parts.length < 4) return null;
  const host = parts[0];
  const port = parts[1];
  const password = parts[parts.length - 1];
  const username = parts.slice(2, -1).join(":");
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  return { host, port, username, password, proxyUrl };
}

async function fetchViaProxy(proxyUrl, url) {
  const agent = new ProxyAgent(proxyUrl);
  try {
    const res = await undiciFetch(url, {
      dispatcher: agent,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    const html = await res.text();
    return { status: res.status, html, ok: res.ok };
  } finally {
    try {
      await agent.close();
    } catch {
      /* ignore */
    }
  }
}

async function capCreate(task) {
  const res = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientKey: API_KEY, task }),
  });
  return res.json();
}

async function capResult(taskId) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey: API_KEY, taskId }),
    });
    const j = await res.json();
    if (j.status === "ready" || j.errorId) return j;
  }
  return { errorId: 1, errorDescription: "timeout waiting for CapSolver" };
}

async function probeOne(raw, idx) {
  const p = parseProxy(raw);
  if (!p) return { idx, ok: false, error: "parse_failed" };
  const out = {
    idx,
    host: p.host,
    session: (p.username.match(/session-([^-]+)/) || [])[1] || null,
  };
  try {
    const page = await fetchViaProxy(p.proxyUrl, WEBSITE_URL);
    out.fetchStatus = page.status;
    out.htmlBytes = page.html.length;
    out.hasCf = /just a moment|cf-browser-verification|challenge-platform/i.test(page.html);
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    const created = await capCreate({
      type: "AntiCloudflareTask",
      websiteURL: WEBSITE_URL,
      proxy: `${p.host}:${p.port}:${p.username}:${p.password}`,
      userAgent: ua,
      html: page.html.slice(0, 120000),
    });
    out.createErrorId = created.errorId;
    out.createError = created.errorDescription || created.errorCode || null;
    out.taskId = created.taskId || null;
    if (!created.taskId) {
      out.ok = false;
      return out;
    }
    const result = await capResult(created.taskId);
    out.resultErrorId = result.errorId;
    out.resultError = result.errorDescription || result.errorCode || null;
    out.status = result.status || null;
    out.ok = result.status === "ready" && !result.errorId;
    out.cookieCount = Array.isArray(result.solution?.cookies)
      ? result.solution.cookies.length
      : result.solution?.token
        ? 1
        : 0;
    return out;
  } catch (err) {
    out.ok = false;
    out.error = String(err?.message || err).slice(0, 240);
    return out;
  }
}

(async () => {
  const list = (group.entries || group.proxies || []).slice(0, MAX_PROXIES);
  console.log(
    JSON.stringify(
      { groupId: GROUP_ID, websiteURL: WEBSITE_URL, probing: list.length },
      null,
      2,
    ),
  );
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const r = await probeOne(list[i], i);
    results.push(r);
    console.log(JSON.stringify(r));
    if (r.ok) break;
  }
  const winner = results.find((r) => r.ok);
  console.log(
    JSON.stringify(
      {
        summary: {
          probed: results.length,
          anyOk: Boolean(winner),
          winnerIdx: winner ? winner.idx : null,
          winnerHost: winner ? winner.host : null,
        },
      },
      null,
      2,
    ),
  );
  process.exit(winner ? 0 : 1);
})().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
