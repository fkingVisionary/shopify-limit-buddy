/**
 * Quick Noontide sticky probe — homepage + login status via undici.
 *   BANDAI_PROXY_FILE=artifacts/noontide-fresh.proxies.txt node executor/scripts/bandai-proxy-probe.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, fetch as ufetch } from "undici";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const file =
  process.env.BANDAI_PROXY_FILE || path.join(root, "artifacts/noontide-fresh.proxies.txt");
const remint = process.env.BANDAI_ROTATE_PROXY_SESSION === "1";

function toUrl(raw) {
  const parts = String(raw).split(":");
  if (parts.length < 4) return null;
  const [host, port, user, ...rest] = parts;
  const pass = rest.join(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

function remintSession(raw) {
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return String(raw).replace(/-session-[^-]+-/, `-session-${sid}-`);
}

const lines = fs
  .readFileSync(file, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => (remint ? remintSession(l) : l));

const out = [];
for (const raw of lines) {
  const sid = (raw.match(/-session-([^-]+)/i) || [])[1] || "?";
  const proxyUrl = toUrl(raw);
  const agent = new ProxyAgent(proxyUrl);
  const row = { sid, home: null, login: null, err: null };
  try {
    const h = await ufetch("https://p-bandai.com/au/", {
      dispatcher: agent,
      headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    });
    row.home = h.status;
    await h.body?.cancel?.().catch(() => {});
    const l = await ufetch("https://p-bandai.com/au/login", {
      dispatcher: agent,
      headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    });
    row.login = l.status;
    await l.body?.cancel?.().catch(() => {});
  } catch (e) {
    row.err = String(e?.cause?.code || e?.message || e).slice(0, 80);
  }
  try {
    await agent.close();
  } catch {
    /* ignore */
  }
  out.push(row);
  console.log(
    `${sid.padEnd(12)} home=${row.home ?? "-"} login=${row.login ?? "-"} ${row.err || "ok"}`,
  );
}

const good = out.filter((r) => r.home === 200 || r.login === 200);
const pathOut = path.join(root, "artifacts/noontide-probe.json");
fs.writeFileSync(pathOut, JSON.stringify({ remint, out, goodSids: good.map((g) => g.sid) }, null, 2));
console.log(`good=${good.length}/${out.length} → ${pathOut}`);
if (remint && good.length) {
  // Rewrite fresh file with reminted lines that at least hit home 200.
  const kept = lines.filter((raw) => {
    const sid = (raw.match(/-session-([^-]+)/i) || [])[1];
    return good.some((g) => g.sid === sid);
  });
  if (kept.length) {
    fs.writeFileSync(file, kept.join("\n") + "\n");
    console.log(`rewrote ${file} with ${kept.length} live reminted stickies`);
  }
}
