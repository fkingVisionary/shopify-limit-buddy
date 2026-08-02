#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const GROUP_ID = "px_noontide_resi_dual";
const TASK_ID = "task_toymate_dual_e2e";

const RAW = String(process.env.NOONTIDE_PROXY_LINES || "").trim();
if (!RAW) {
  console.error("Set NOONTIDE_PROXY_LINES to host:port:user:pass lines (newline or | separated)");
  process.exit(2);
}

const lines = RAW.split(/[\r\n|]+/)
  .map((s) => s.trim())
  .filter(Boolean);

function parseLine(line) {
  const parts = line.split(":");
  if (parts.length < 4) throw new Error(`bad proxy line: ${line.slice(0, 40)}`);
  const host = parts[0];
  const port = parts[1];
  const password = parts[parts.length - 1];
  const username = parts.slice(2, -1).join(":");
  return { host, port, username, password, raw: `${host}:${port}:${username}:${password}` };
}

const proxies = lines.map(parseLine);
const dbPath = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "vanta-desktop",
  "j1ms-desktop",
  "db.json",
);

const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const now = new Date().toISOString();

db.proxyGroups = Array.isArray(db.proxyGroups) ? db.proxyGroups : [];
db.proxyGroups = db.proxyGroups.filter((g) => g && g.id !== GROUP_ID);
// Desktop job-runner / e2e read `entries` (not `proxies`).
db.proxyGroups.push({
  id: GROUP_ID,
  name: "noontide-resi-au",
  entries: proxies.map((p) => p.raw),
  createdAt: now,
  updatedAt: now,
});

const task = (db.tasks || []).find((t) => t && t.id === TASK_ID);
if (task) {
  task.proxyGroupId = GROUP_ID;
  task.updatedAt = now;
  task.status = "idle";
  task.lastError = null;
  task.running = false;
}

fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok: true,
      groupId: GROUP_ID,
      proxyCount: proxies.length,
      taskId: TASK_ID,
      taskProxyGroupId: task ? task.proxyGroupId : null,
      sampleHost: proxies[0]?.host || null,
    },
    null,
    2,
  ),
);
