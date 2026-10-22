/**
 * Live dry-run smoke for the Shopify ATC adapter (NO order is placed).
 *
 * Runs warm → add-to-cart → cart read → checkout-URL resolution against a real
 * store, through your residential/ISP proxy, solving any Cloudflare / captcha
 * challenge with whichever solver keys are in the environment. It stops before
 * payment by design.
 *
 * Usage:
 *   cd executor
 *   PROXY_URL="http://user:pass@host:port" \
 *   CAPSOLVER_API_KEY=... UNCAPTCHA_API_KEY=... TWOCAPTCHA_API_KEY=... HYPER_API_KEY=... \
 *   node scripts/shopify-live-smoke.mjs <storeUrl> <variantId> [qty] [handle]
 *
 * Example:
 *   node scripts/shopify-live-smoke.mjs https://www.deathwishcoffee.com 39983629828151 1
 *
 * Optional: CAPTCHA_PROVIDER=auto|2captcha|capsolver|uncaptcha|hyper
 *           UNCAPTCHA_WAF_TASK_TYPE=<your account's Cloudflare-WAF task string>
 */
import { runShopify } from "../adapters/shopify.js";
import { makeDispatcher, createJar } from "../http.js";
import { anyProviderConfigured } from "../adapters/shopify-captcha.js";

const [storeUrl, variantArg, qtyArg, handleArg] = process.argv.slice(2);
if (!storeUrl || !variantArg) {
  console.error("usage: node scripts/shopify-live-smoke.mjs <storeUrl> <variantId> [qty] [handle]");
  process.exit(2);
}

const proxy = process.env.PROXY_URL || process.env.PROXY_URL_RESI || null;
console.log("store:   ", storeUrl);
console.log("variant: ", variantArg, "qty", qtyArg || 1, handleArg ? `handle=${handleArg}` : "");
console.log("proxy:   ", proxy ? proxy.replace(/\/\/[^@]*@/, "//***@") : "(none — expect Cloudflare 403 from datacenter IP)");
console.log("solvers: ", anyProviderConfigured() ? "configured" : "NONE (set a provider key to clear challenges)");
console.log("provider:", process.env.CAPTCHA_PROVIDER || "auto");
console.log("");

const dispatcher = makeDispatcher(proxy, { forceUndici: true });
if (dispatcher.proxyParseFailed) {
  console.error("proxy string not recognised — use http://user:pass@host:port");
  process.exit(2);
}
const jar = createJar();
const ctx = { dispatcher, jar, onProgress: (s) => process.stdout.write(`  → ${s}\n`) };

const out = await runShopify(
  {
    storeUrl,
    taskId: `live-${Date.now()}`,
    variantId: Number(variantArg),
    qty: Number(qtyArg || 1),
    handle: handleArg || undefined,
    proxy,
    captchaProvider: process.env.CAPTCHA_PROVIDER || "auto",
  },
  ctx,
);

console.log("\n=== RESULT ===");
console.log("ok:", out.ok, "| stage:", out.checkoutStage, "| dryRun:", out.dryRun);
console.log("reachedCheckout:", out.shopify?.reachedCheckout);
console.log("checkoutUrl:", out.shopify?.checkoutUrl);
console.log("cart:", JSON.stringify(out.shopify?.cart));
console.log("variant:", JSON.stringify(out.shopify?.variant));
console.log("captcha:", JSON.stringify(out.shopify?.captcha));
console.log("\nsteps:");
for (const s of out.steps) {
  console.log(`  ${s.ok ? "✓" : "✗"} ${s.step} [${s.status ?? "-"}] ${s.note ?? ""}`);
}

try {
  await dispatcher.close?.();
} catch {
  /* ignore */
}
process.exit(out.ok ? 0 : 1);
