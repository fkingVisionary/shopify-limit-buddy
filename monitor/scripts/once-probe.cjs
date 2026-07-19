// One-shot Hyper stock probe (uses same boot path as npm start).
const path = require("path");
const {
  loadDotEnv,
  ensureExecutorForMonitor,
  applyLocalMonitorDefaults,
  stopLocalExecutor,
} = require("../src/local-executor.cjs");
const { probeViaExecutor } = require("../src/executor-probe.cjs");

function applyEnvFile(filePath) {
  const parsed = loadDotEnv(filePath);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

async function main() {
  applyEnvFile(path.join(__dirname, "..", "..", ".env"));
  applyEnvFile(path.join(__dirname, "..", ".env"));
  applyLocalMonitorDefaults();
  process.env.MONITOR_PROBE_TIMEOUT_MS = process.env.MONITOR_PROBE_TIMEOUT_MS || "120000";

  const exec = await ensureExecutorForMonitor();
  if (!exec.ok) {
    console.error(exec.error);
    process.exit(1);
  }
  console.log("executor", exec.mode, exec.url);

  const url =
    process.argv[2] ||
    "https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/";
  const proxy =
    process.argv[3] === "direct"
      ? null
      : process.env.MONITOR_FALLBACK_PROXY || null;

  console.log("proxy", proxy ? "desktop/fallback" : "direct");
  const probe = await probeViaExecutor({ url, proxyUrl: proxy, timeoutMs: 120_000 });
  console.log(
    JSON.stringify(
      {
        ok: probe.ok,
        inStock: probe.inStock,
        sku: probe.sku,
        title: probe.title,
        blocked: probe.blocked,
        error: probe.error,
        status: probe.status,
        elapsedMs: probe.elapsedMs,
        lastSteps: (probe.steps || []).slice(-10).map((s) => ({
          step: s.step,
          ok: s.ok,
          note: String(s.note || "").slice(0, 140),
        })),
      },
      null,
      2,
    ),
  );
  await stopLocalExecutor();
  process.exit(probe.ok ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
