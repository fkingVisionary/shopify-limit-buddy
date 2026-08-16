// Resolve paths for both `npm start` (repo) and packaged Electron builds.
// Packaged layout (electron-builder extraResources):
//   resources/executor/   — checkout engine + production node_modules
//   resources/node/node.exe — Windows Node runtime for the sidecar

const path = require("path");
const fs = require("fs");

function hasServer(dir) {
  try {
    return Boolean(dir && fs.existsSync(path.join(dir, "server.js")));
  } catch {
    return false;
  }
}

/**
 * Directory that contains executor `server.js`.
 */
function resolveExecutorDir() {
  const envDir = String(process.env.J1MS_EXECUTOR_DIR || "").trim();
  if (envDir && hasServer(envDir)) return path.resolve(envDir);

  const resources = process.resourcesPath || "";
  const packagedCandidates = [
    path.join(resources, "executor"),
    path.join(resources, "app.asar.unpacked", "executor"),
    path.join(resources, "app", "executor"),
  ];
  for (const c of packagedCandidates) {
    if (hasServer(c)) return c;
  }

  // Dev / unpackaged: desktop/ sits next to executor/
  const sibling = path.join(__dirname, "..", "executor");
  if (hasServer(sibling)) return sibling;

  // Fallback: executor copied beside desktop sources (rare)
  const nested = path.join(__dirname, "executor");
  if (hasServer(nested)) return nested;

  return sibling;
}

/**
 * Node binary used to spawn the executor sidecar.
 * Packaged Windows builds ship resources/node/node.exe so end users do not
 * need a system Node install.
 */
function resolveNodeBinary() {
  const envBin = String(process.env.J1MS_NODE_BIN || "").trim();
  if (envBin && fs.existsSync(envBin)) return envBin;

  const resources = process.resourcesPath || "";
  const win = path.join(resources, "node", "node.exe");
  if (fs.existsSync(win)) return win;
  const nix = path.join(resources, "node", "node");
  if (fs.existsSync(nix)) return nix;

  return process.platform === "win32" ? "node.exe" : "node";
}

/**
 * Optional .env next to the app (dev) or in userData (packaged).
 * Does not invent secrets — only loads if the file exists.
 */
function resolveDotEnvPath(userDataPath) {
  const resources = process.resourcesPath || "";
  const candidates = [
    path.join(__dirname, "..", ".env"),
    userDataPath ? path.join(userDataPath, ".env") : null,
    resources ? path.join(resources, ".env") : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

module.exports = {
  resolveExecutorDir,
  resolveNodeBinary,
  resolveDotEnvPath,
};
