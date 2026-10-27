/**
 * Watch a Shopify order's buyer-visible status and record if/when it gets
 * flagged (cancelled for fraud / refunded / held for review). READ-ONLY:
 * it never cancels, refunds, or changes anything — it polls the order-status
 * URL you already have and logs quietly to the risk JSONL.
 *
 * Usage:
 *   cd executor
 *   PROXY_URL="http://user:pass@host:port" \
 *   node scripts/shopify-order-watch.mjs <orderStatusUrl> [intervalSeconds] [maxMinutes]
 *
 * The <orderStatusUrl> is the buyer order-status link Shopify returns after an
 * order (the `order_status_url`, e.g. https://shop.com/.../orders/<token>).
 *
 * Optional: SHOPIFY_RISK_LOG=<path> to choose the log file
 *           RUN_SIGNALS='["proxy_used","billing_shipping_mismatch"]' to seed
 *           the buyer-visible signals from the checkout run, for correlation.
 */
import { pollOrderStatus } from "../adapters/shopify-risk.js";
import { makeDispatcher, createJar } from "../http.js";

const [orderStatusUrl, intervalArg, maxArg] = process.argv.slice(2);
if (!orderStatusUrl) {
  console.error("usage: node scripts/shopify-order-watch.mjs <orderStatusUrl> [intervalSeconds] [maxMinutes]");
  process.exit(2);
}

let runSignals = [];
try {
  if (process.env.RUN_SIGNALS) runSignals = JSON.parse(process.env.RUN_SIGNALS).map((s) => ({ signal: s }));
} catch {
  console.warn("RUN_SIGNALS was not valid JSON — ignoring");
}

const proxy = process.env.PROXY_URL || process.env.PROXY_URL_RESI || null;
const dispatcher = makeDispatcher(proxy, { forceUndici: true });
const jar = createJar();

console.log("watching:", orderStatusUrl);
console.log("proxy:   ", proxy ? proxy.replace(/\/\/[^@]*@/, "//***@") : "(none)");
console.log("");

const out = await pollOrderStatus({
  orderStatusUrl,
  ctx: { dispatcher, jar },
  taskId: `watch-${Date.now()}`,
  runSignals,
  intervalMs: Math.max(1, Number(intervalArg || 30)) * 1000,
  maxMs: Math.max(1, Number(maxArg || 30)) * 60_000,
  onChange: (parsed, outcome, correlation) => {
    const tag = parsed.flagged ? "⚑ FLAGGED" : "·";
    console.log(`${tag} ${parsed.flagSignal ?? "?"}  (${outcome.from ?? "—"} → ${outcome.to})`);
    if (correlation) {
      console.log(`   confidence: ${correlation.confidence}`);
      for (const c of correlation.likelyCauses) console.log(`   • ${c}`);
    }
  },
});

console.log("\n=== DONE ===");
console.log("polls:", out.polls);
console.log("final:", out.final ? `${out.final.flagSignal ?? "?"} (${out.final.stateKey})` : "(none)");
try {
  await dispatcher.close?.();
} catch {
  /* ignore */
}
