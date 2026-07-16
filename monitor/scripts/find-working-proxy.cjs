// Try desktop proxies until one Hyper PDP probe succeeds.
const path = require("path");
const fs = require("fs");
const {
  loadDotEnv,
  ensureExecutorForMonitor,
  applyLocalMonitorDefaults,
  stopLocalExecutor,
  toProxyUrl,
} = require("../src/local-executor.cjs");
const { probeViaExecutor } = require("../src/executor-probe.cjs");

// export toProxyUrl - need to add if missing
function applyEnvFile(filePath) {
  const parsed = loadDotEnv(filePath);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function loadDesktopProxies() {
  const p = path.join(process.env.APPDATA || "", "j1ms-bot-desktop", "j1ms-desktop", "db.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const out = [];
  for (const g of j.proxyGroups || []) {
    for (const e of g.entries || []) {
      const raw = typeof e === "string" ? e : e?.raw || e?.url || "";
      const url = require("../src/local-executor.cjs").toProxyUrl
        ? require("../src/local-executor.cjs").toProxyUrl(raw)
        : raw;
      // inline normalize
      let u = String(raw || "").trim();
      if (u && !/^https?:\/\//i.test(u)) {
        const parts = u.split(":");
        if (parts.length >= 4) {
          const [host, port, user, ...passParts] = parts;
          u = `http://${encodeURIComponent(user)}:${encodeURIComponent(passParts.join(":"))}@${host}:${port}`;
        }
      }
      if (u) out.push({ group: g.name, url: u });
    }
  }
  return out;
}

async function main() {
  applyEnvFile(path.join(__dirname, "..", "..", ".env"));
  applyLocalMonitorDefaults();
  const exec = await ensureExecutorForMonitor();
  if (!exec.ok) throw new Error(exec.error);

  const url =
    process.argv[2] ||
    "https://www.kmart.com.au/product/junk-journal-sticker-pad-43671588/";
  const proxies = loadDesktopProxies();
  console.log(`trying ${proxies.length} desktop proxies…`);

  for (let i = 0; i < proxies.length; i++) {
    const { group, url: proxyUrl } = proxies[i];
    process.stdout.write(`[${i + 1}/${proxies.length}] ${group} … `);
    const probe = await probeViaExecutor({ url, proxyUrl, timeoutMs: 100_000 });
    if (probe.ok) {
      console.log(`OK inStock=${probe.inStock} title=${(probe.title || "").slice(0, 50)}`);
      console.log(JSON.stringify({ ok: true, index: i, group, title: probe.title, inStock: probe.inStock }, null, 2));
      await stopLocalExecutor();
      process.exit(0);
    }
    console.log(`fail blocked=${probe.blocked} ${String(probe.error || "").slice(0, 60)}`);
  }
  console.log("none succeeded");
  await stopLocalExecutor();
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
