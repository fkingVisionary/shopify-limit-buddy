// One-command monitor start for operators who are not wiring Fly by hand.
// 1) Load .env  2) Start local Hyper executor (or use Fly)  3) Run SSE monitor

const path = require("path");
const fs = require("fs");
const { loadDotEnv, ensureExecutorForMonitor, applyLocalMonitorDefaults } = require("./local-executor.cjs");

function applyEnvFile(filePath) {
  const parsed = loadDotEnv(filePath);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

applyEnvFile(path.join(__dirname, "..", "..", ".env"));
applyEnvFile(path.join(__dirname, "..", ".env"));
applyLocalMonitorDefaults();

// Local-friendly defaults so the feed works in the desktop app without secrets juggling.
if (!process.env.MONITOR_AUTH_MODE) process.env.MONITOR_AUTH_MODE = "open";
if (!process.env.MONITOR_API_KEYS) process.env.MONITOR_API_KEYS = "local-dev";
if (!process.env.PORT) process.env.PORT = "8091";

// Point desktop Monitor tab at this machine when running locally.
const feedHint = `http://127.0.0.1:${process.env.PORT}/feed`;

async function main() {
  console.log("");
  console.log("=== J1m's Kmart Monitor ===");
  console.log("Detect only — never places orders.");
  console.log("");

  const ispFile = path.join(__dirname, "..", "isp.proxies");
  const hasIsp = fs.existsSync(ispFile);
  console.log(`ISP proxies file: ${hasIsp ? "found" : "MISSING (will try direct / env)"}`);
  console.log(
    `Hyper fallback proxy: ${process.env.MONITOR_FALLBACK_PROXY ? "yes (from desktop / env)" : "no — ISP/direct only"}`,
  );

  const exec = await ensureExecutorForMonitor();
  if (!exec.ok) {
    console.error("");
    console.error("Could not start Hyper probe path:");
    console.error(`  ${exec.error}`);
    console.error("");
    console.error("Pick ONE of these:");
    console.error("  A) Open desktop app → Settings → paste Hyper API key → Save");
    console.error("     then run:  npm start   (again)");
    console.error("  B) Create monitor/.env with:");
    console.error("       HYPER_API_KEY=your_hyper_key");
    console.error("  C) Use your existing Fly executor — monitor/.env with:");
    console.error("       EXECUTOR_TOKEN=same_token_as_fly");
    console.error("     (URL defaults to https://j1ms-bot-executor.fly.dev)");
    console.error("");
    process.exit(1);
  }

  console.log(`Executor: ${exec.mode} → ${exec.url}`);
  console.log(`Feed (for desktop): set MONITOR_FEED_URL=${feedHint}`);
  console.log("Or open desktop with that env, or later deploy this service to Fly.");
  console.log("");

  // Hand off to the real server (pollers + SSE). Server shutdown stops the sidecar.
  require("./server.cjs");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
