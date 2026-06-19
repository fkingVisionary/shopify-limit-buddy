import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Checkout cross-store compatibility self-test.
// ---------------------------------------------------------------------------
// Runs Shopify's documented standardized path against a store URL using only
// HTTP fetches — no browser. Reports which steps work so we know whether the
// store is compatible with the bot before users waste a real task on it.
//
//   1. cart/add.js                       → variant accepted?
//   2. POST /cart                        → /checkouts/... redirect?
//   3. Detect Checkout One (`/cn/`) vs legacy
//   4. POST contact + shipping address   → accepted?
//   5. Poll /shipping_rates.json         → rates available?
//   6. Vault TEST card on deposit.us.shopifycs.com → returns id?
//
// This is store-agnostic; it does not submit a real order.
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  storeUrl: z.string().url().max(500),
  variantId: z.number().int().positive(),
  qty: z.number().int().min(1).max(5).default(1),
});

export type CompatStep =
  | "cart_add"
  | "cart_redirect"
  | "checkout_load"
  | "version_detect"
  | "contact_submit"
  | "shipping_rates"
  | "vault_card";

export type CompatStepRecord = {
  step: CompatStep;
  ok: boolean;
  status: number | null;
  ms: number;
  note?: string;
};

export type CompatReport = {
  storeUrl: string;
  ok: boolean;
  version: "checkout_one" | "legacy" | "unknown";
  checkoutUrl: string | null;
  steps: CompatStepRecord[];
  elapsedMs: number;
  summary: string;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function collectCookies(res: Response, jar: Map<string, string>): void {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  const list = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
  for (const raw of list) {
    const first = raw.split(";", 1)[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}
function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

export const runCheckoutCompatTest = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<CompatReport> => {
    const t0 = Date.now();
    const base = data.storeUrl.replace(/\/$/, "");
    const jar = new Map<string, string>();
    const steps: CompatStepRecord[] = [];
    let version: CompatReport["version"] = "unknown";
    let checkoutUrl: string | null = null;

    const baseHeaders: Record<string, string> = {
      "user-agent": UA,
      accept: "application/json,text/html,*/*;q=0.1",
      "accept-language": "en-US,en;q=0.9",
      referer: `${base}/`,
      origin: base,
    };
    const rec = (s: CompatStep, ok: boolean, status: number | null, ms: number, note?: string) => {
      steps.push({ step: s, ok, status, ms, note });
    };
    const done = (ok: boolean, summary: string): CompatReport => ({
      storeUrl: base, ok, version, checkoutUrl, steps, elapsedMs: Date.now() - t0, summary,
    });

    // 1. cart/add
    try {
      const s = Date.now();
      const res = await fetch(`${base}/cart/add.js`, {
        method: "POST",
        headers: { ...baseHeaders, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id: String(data.variantId), quantity: String(data.qty) }).toString(),
      });
      collectCookies(res, jar);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        let desc = `HTTP ${res.status}`;
        try { const j = JSON.parse(body) as { description?: string }; desc = j.description ?? desc; } catch {}
        rec("cart_add", false, res.status, Date.now() - s, desc);
        return done(false, `cart_add failed: ${desc}`);
      }
      rec("cart_add", true, res.status, Date.now() - s);
    } catch (e) {
      rec("cart_add", false, null, 0, (e as Error).message);
      return done(false, `cart_add error: ${(e as Error).message}`);
    }

    // 2. POST /cart → redirect
    try {
      const s = Date.now();
      const res = await fetch(`${base}/cart`, {
        method: "POST",
        headers: {
          ...baseHeaders, cookie: cookieHeader(jar),
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html,application/xhtml+xml",
        },
        body: new URLSearchParams({ checkout: "Check out", updates: String(data.qty) }).toString(),
        redirect: "follow",
      });
      collectCookies(res, jar);
      checkoutUrl = res.url;
      const landed = /\/checkouts?\//i.test(checkoutUrl);
      rec("cart_redirect", landed, res.status, Date.now() - s, checkoutUrl);
      if (!landed) return done(false, `cart_redirect did not land on /checkouts/: ${checkoutUrl}`);

      // 3. version detect
      version = /\/checkouts\/cn\//i.test(checkoutUrl) ? "checkout_one"
        : /\/checkouts\//i.test(checkoutUrl) ? "legacy" : "unknown";
      rec("version_detect", version !== "unknown", null, 0, version);
    } catch (e) {
      rec("cart_redirect", false, null, 0, (e as Error).message);
      return done(false, `cart_redirect error: ${(e as Error).message}`);
    }

    // 4. GET checkout page (smoke)
    let authenticityToken: string | null = null;
    try {
      const s = Date.now();
      const res = await fetch(checkoutUrl!, { headers: { ...baseHeaders, cookie: cookieHeader(jar) } });
      collectCookies(res, jar);
      const html = await res.text();
      authenticityToken = html.match(/name="authenticity_token"\s+value="([^"]+)"/)?.[1] ?? null;
      rec("checkout_load", res.ok, res.status, Date.now() - s,
        version === "checkout_one"
          ? (/serialized-session-token|checkout-web/i.test(html) ? "checkout-one bootstrap present" : "no checkout-one bootstrap")
          : (authenticityToken ? "legacy token scraped" : "no legacy token"));
      if (!res.ok) return done(false, `checkout_load HTTP ${res.status}`);
    } catch (e) {
      rec("checkout_load", false, null, 0, (e as Error).message);
      return done(false, `checkout_load error: ${(e as Error).message}`);
    }

    // Legacy path: try contact + shipping form-post; CN: skip (handled by GraphQL pipeline).
    if (version === "legacy") {
      try {
        const s = Date.now();
        const body = new URLSearchParams();
        if (authenticityToken) body.set("authenticity_token", authenticityToken);
        body.set("previous_step", "contact_information");
        body.set("step", "shipping_method");
        body.set("checkout[email]", "compat-test@example.com");
        body.set("checkout[shipping_address][first_name]", "Compat");
        body.set("checkout[shipping_address][last_name]", "Test");
        body.set("checkout[shipping_address][address1]", "1 Test Street");
        body.set("checkout[shipping_address][city]", "Sydney");
        body.set("checkout[shipping_address][country]", "Australia");
        body.set("checkout[shipping_address][province]", "New South Wales");
        body.set("checkout[shipping_address][zip]", "2000");
        body.set("checkout[shipping_address][phone]", "0400000000");
        const res = await fetch(checkoutUrl!, {
          method: "POST",
          headers: {
            ...baseHeaders, cookie: cookieHeader(jar),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
          redirect: "follow",
        });
        collectCookies(res, jar);
        checkoutUrl = res.url || checkoutUrl;
        rec("contact_submit", res.ok, res.status, Date.now() - s, checkoutUrl);
      } catch (e) {
        rec("contact_submit", false, null, 0, (e as Error).message);
      }

      // 5. shipping rates poll
      try {
        const s = Date.now();
        const ratesUrl = `${checkoutUrl!.split("?")[0].replace(/\/$/, "")}/shipping_rates.json`;
        let rateId: string | null = null;
        for (let i = 0; i < 6 && !rateId; i++) {
          const res = await fetch(ratesUrl, { headers: { ...baseHeaders, cookie: cookieHeader(jar) } });
          collectCookies(res, jar);
          if (res.ok) {
            const j = (await res.json().catch(() => ({}))) as { shipping_rates?: Array<{ id: string }> };
            rateId = j.shipping_rates?.[0]?.id ?? null;
          }
          if (!rateId) await new Promise((r) => setTimeout(r, 500));
        }
        rec("shipping_rates", !!rateId, null, Date.now() - s, rateId ?? "no rates");
      } catch (e) {
        rec("shipping_rates", false, null, 0, (e as Error).message);
      }
    } else {
      rec("contact_submit", true, null, 0, "skipped (checkout one — uses GraphQL submitForCompletion)");
      rec("shipping_rates", true, null, 0, "skipped (checkout one)");
    }

    // 6. Vault a TEST card — fully store-agnostic
    try {
      const s = Date.now();
      const hostname = new URL(base).hostname;
      const res = await fetch("https://deposit.us.shopifycs.com/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify({
          credit_card: {
            number: "4111111111111111",
            name: "Compat Test",
            month: 12,
            year: 2030,
            verification_value: "123",
          },
          payment_session_scope: hostname,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { id?: string };
      const ok = !!j.id;
      rec("vault_card", ok, res.status, Date.now() - s, ok ? `session ${j.id!.slice(0, 12)}…` : `no id`);
    } catch (e) {
      rec("vault_card", false, null, 0, (e as Error).message);
    }

    const failed = steps.filter((x) => !x.ok && !(x.note ?? "").startsWith("skipped"));
    const allOk = failed.length === 0;
    const summary = allOk
      ? `Compatible (${version}) — vault + all preflight steps OK in ${Date.now() - t0}ms.`
      : `Failed at: ${failed.map((f) => f.step).join(", ")}`;
    return done(allOk, summary);
  });
