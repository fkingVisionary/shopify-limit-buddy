#!/usr/bin/env node
/**
 * Stage Windows installer resources:
 *   build/win-resources/executor/  — production executor tree
 *   build/win-resources/node/      — official Node win-x64 binary
 *
 * Usage (from desktop/):
 *   node scripts/stage-win-resources.cjs
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const https = require("https");
const { createWriteStream } = require("fs");
const { pipeline } = require("stream/promises");

const DESKTOP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_ROOT, "..");
const SRC_EXECUTOR = path.join(REPO_ROOT, "executor");
const OUT_ROOT = path.join(DESKTOP_ROOT, "build", "win-resources");
const OUT_EXECUTOR = path.join(OUT_ROOT, "executor");
const OUT_NODE = path.join(OUT_ROOT, "node");

const NODE_VERSION = process.env.J1MS_BUNDLE_NODE_VERSION || "22.14.0";
const NODE_DIST = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "coverage",
  ".nyc_output",
  "tmp",
  "logs",
  "__pycache__",
  "har",
  "experiments",
]);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyTree(src, dest, { skipDirs = SKIP_DIRS } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipDirs.has(ent.name)) continue;
    if (ent.name.startsWith(".") && ent.name !== ".env.example") continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyTree(from, to, { skipDirs });
    } else if (ent.isFile()) {
      // Skip huge lab artifacts / local secrets
      if (/\.(proxies\.local|har|log)$/i.test(ent.name)) continue;
      if (/^toymate-.*-proof\.json$/i.test(ent.name)) continue;
      fs.copyFileSync(from, to);
    }
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error("too many redirects"));
      https
        .get(u, (res) => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            return follow(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`download ${u} → HTTP ${res.statusCode}`));
          }
          const out = createWriteStream(dest);
          pipeline(res, out).then(resolve).catch(reject);
        })
        .on("error", reject);
    };
    follow(url);
  });
}

async function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // Prefer system unzip; fall back to PowerShell Expand-Archive on Windows.
  const unzipBin = spawnSync("unzip", ["-v"], { encoding: "utf8" });
  if (unzipBin.status === 0) {
    run("unzip", ["-qo", zipPath, "-d", destDir]);
    return;
  }
  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ]);
    return;
  }
  // Node fallback via adm-zip is not a dependency — require unzip.
  throw new Error("unzip not found — install unzip to stage Windows Node");
}

async function stageNode() {
  fs.mkdirSync(OUT_NODE, { recursive: true });
  const zipPath = path.join(OUT_ROOT, `node-v${NODE_VERSION}-win-x64.zip`);
  const extractRoot = path.join(OUT_ROOT, `_node_extract`);
  rmrf(extractRoot);

  if (!fs.existsSync(zipPath)) {
    console.log(`[stage] downloading Node ${NODE_VERSION} win-x64…`);
    await download(NODE_DIST, zipPath);
  } else {
    console.log(`[stage] reusing ${zipPath}`);
  }

  console.log("[stage] extracting node.exe…");
  await unzip(zipPath, extractRoot);
  const nested = path.join(extractRoot, `node-v${NODE_VERSION}-win-x64`);
  const nodeExe = path.join(nested, "node.exe");
  if (!fs.existsSync(nodeExe)) {
    throw new Error(`expected ${nodeExe} after extract`);
  }
  fs.copyFileSync(nodeExe, path.join(OUT_NODE, "node.exe"));
  // Optional: keep LICENSE for redistribution compliance
  for (const f of ["LICENSE", "LICENSE.MD", "license"]) {
    const src = path.join(nested, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT_NODE, path.basename(src)));
      break;
    }
  }
  rmrf(extractRoot);
  console.log(`[stage] node → ${path.join(OUT_NODE, "node.exe")}`);
}

function stageExecutor() {
  if (!fs.existsSync(path.join(SRC_EXECUTOR, "server.js"))) {
    throw new Error(`executor missing at ${SRC_EXECUTOR}`);
  }
  console.log(`[stage] copying executor → ${OUT_EXECUTOR}`);
  rmrf(OUT_EXECUTOR);
  copyTree(SRC_EXECUTOR, OUT_EXECUTOR);

  console.log("[stage] npm install --omit=dev in staged executor…");
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: OUT_EXECUTOR,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  });

  // Drop Playwright browser cache if any slipped in — Bandai Safe needs a
  // separate browser install; Toymate/Kmart undici paths do not.
  rmrf(path.join(OUT_EXECUTOR, "node_modules", "playwright", ".local-browsers"));
  rmrf(path.join(OUT_EXECUTOR, "node_modules", "playwright-core", ".local-browsers"));

  if (!fs.existsSync(path.join(OUT_EXECUTOR, "server.js"))) {
    throw new Error("staged executor missing server.js");
  }
  console.log("[stage] executor ready");
}

async function main() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  stageExecutor();
  await stageNode();
  console.log(`[stage] done → ${OUT_ROOT}`);
}

main().catch((e) => {
  console.error("[stage] FAILED", e.message || e);
  process.exit(1);
});
