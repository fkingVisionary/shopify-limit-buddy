import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// ---------------------------------------------------------------------------
// HTTP-mode Shopify checkout engine.
// ---------------------------------------------------------------------------
// Executes one checkout task as a chain of fetches — the same model the
// real bots (Cybersole/Valor/Wrath) use. No browser, ~5 MB RAM per task,
// fully parallelisable. The client drives concurrency by calling this
// serverFn N times in parallel.
//
// Limitations:
//  • Workerd fetch has no per-request HTTP proxy support, so the `proxy`
//    field is recorded for the timeline/runner path but the request goes
//    out from the edge IP when run server-side. The Electron runner (Node
//    + undici) honours it for real.
//  • Submission stops at the point where the card vault POST would happen.
//    We capture enough state for a successful dry-run timeline. Real
//    submit needs Stripe vault token + valid checkout step, which is
//    store-specific. The engine is structured so adding the final
//    `payments` POST is a one-step extension.
// ---------------------------------------------------------------------------

const ProfileSchema = z.object({
  email: z.string().max(200),
  first_name: z.string().max(100),
  last_name: z.string().max(100),
  address1: z.string().max(200),
  address2: z.string().max(200).optional().nullable(),
  city: z.string().max(100),
  province: z.string().max(100),
  zip: z.string().max(30),
  country: z.string().max(100),
  phone: z.string().max(40),
});

const CardSchema = z.object({
  number: z.string().min(12).max(25),
  name: z.string().max(120),
  exp_month: z.string().max(2),
  exp_year: z.string().max(4),
  cvv: z.string().max(5),
});

const InputSchema = z.object({
  taskId: z.string().min(1).max(100),
  storeUrl: z.string().url().max(500),
  variantId: z.number().int().positive(),
  qty: z.number().int().min(1).max(20),
  profile: ProfileSchema,
  card: CardSchema.optional().nullable(),
  proxy: z.string().min(7).max(200).optional().nullable(),
  captchaToken: z.string().min(10).max(4000).optional().nullable(),
  dryRun: z.boolean().default(true),
});

export type HttpCheckoutStep =
  | "cart_add"
  | "cart_read"
  | "checkout_redirect"
  | "checkout_load"
  | "contact_submit"
  | "shipping_rates"
  | "shipping_submit"
  | "payment_vault"
  | "payment_submit"
  | "payment_poll";

export type HttpStepRecord = {
  step: HttpCheckoutStep;
  ok: boolean;
  status: number | null;
  ms: number;
  note?: string;
};

export type HttpCheckoutResult =
  | {
      ok: true;
      taskId: string;
      checkoutUrl: string | null;
      orderId: string | null;
      steps: HttpStepRecord[];
      elapsedMs: number;
      dryRun: boolean;
    }
  | {
      ok: false;
      taskId: string;
      failedStep: HttpCheckoutStep;
      error: string;
      steps: HttpStepRecord[];
      elapsedMs: number;
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
function extractToken(html: string, name: string): string | null {
  const re = new RegExp(`name="${name}"\\s+value="([^"]+)"`, "i");
  const m = html.match(re) ?? html.match(new RegExp(`"${name}":\\s*"([^"]+)"`));
  return m?.[1] ?? null;
}

export const runHttpCheckout = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<HttpCheckoutResult> => {
    const t0 = Date.now();
    const base = data.storeUrl.replace(/\/$/, "");
    const jar = new Map<string, string>();
    const steps: HttpStepRecord[] = [];
    let lastStep: HttpCheckoutStep = "cart_add";

    const baseHeaders: Record<string, string> = {
      "user-agent": UA,
      accept: "application/json,text/javascript,text/html,*/*;q=0.1",
      "accept-language": "en-US,en;q=0.9",
      referer: `${base}/`,
      origin: base,
    };

    const record = (step: HttpCheckoutStep, ok: boolean, status: number | null, ms: number, note?: string) => {
      steps.push({ step, ok, status, ms, note });
    };
    const fail = (failedStep: HttpCheckoutStep, error: string): HttpCheckoutResult => ({
      ok: false, taskId: data.taskId, failedStep, error, steps, elapsedMs: Date.now() - t0,
    });

    // ── 1. cart/add ────────────────────────────────────────────────────────
    try {
      lastStep = "cart_add";
      const s = Date.now();
      const res = await fetch(`${base}/cart/add.js`, {
        method: "POST",
        headers: { ...baseHeaders, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id: String(data.variantId), quantity: String(data.qty) }).toString(),
        redirect: "follow",
      });
      collectCookies(res, jar);
      if (res.status === 422) {
        const body = await res.text().catch(() => "");
        let desc = "Variant rejected";
        try {
          const j = JSON.parse(body) as { description?: string; message?: string };
          desc = j.description ?? j.message ?? desc;
        } catch {}
        record("cart_add", false, res.status, Date.now() - s, desc);
        return fail("cart_add", desc);
      }
      if (!res.ok) {
        record("cart_add", false, res.status, Date.now() - s, `HTTP ${res.status}`);
        return fail("cart_add", `cart/add HTTP ${res.status}`);
      }
      record("cart_add", true, res.status, Date.now() - s);
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    // ── 2. cart.js read ────────────────────────────────────────────────────
    let itemCount = data.qty;
    try {
      lastStep = "cart_read";
      const s = Date.now();
      const res = await fetch(`${base}/cart.js`, { headers: { ...baseHeaders, cookie: cookieHeader(jar) } });
      collectCookies(res, jar);
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { item_count?: number };
        if (typeof j.item_count === "number") itemCount = j.item_count;
      }
      record("cart_read", res.ok, res.status, Date.now() - s, `items=${itemCount}`);
    } catch (e) {
      record("cart_read", false, null, 0, (e as Error).message);
    }

    // ── 3. POST /cart → redirect to /checkouts/cn/{token} ──────────────────
    let checkoutUrl: string | null = null;
    try {
      lastStep = "checkout_redirect";
      const s = Date.now();
      const res = await fetch(`${base}/cart`, {
        method: "POST",
        headers: {
          ...baseHeaders,
          cookie: cookieHeader(jar),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ checkout: "Check out", updates: String(data.qty) }).toString(),
        redirect: "follow",
      });
      collectCookies(res, jar);
      checkoutUrl = res.url;
      record("checkout_redirect", res.ok, res.status, Date.now() - s, checkoutUrl);
      if (!res.ok || !/checkouts?\//i.test(checkoutUrl)) {
        return fail("checkout_redirect", `bad redirect: ${checkoutUrl}`);
      }
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    // ── 4. GET checkout page → scrape tokens ───────────────────────────────
    let authenticityToken: string | null = null;
    try {
      lastStep = "checkout_load";
      const s = Date.now();
      const res = await fetch(checkoutUrl, { headers: { ...baseHeaders, cookie: cookieHeader(jar) } });
      collectCookies(res, jar);
      const html = await res.text();
      authenticityToken = extractToken(html, "authenticity_token");
      record("checkout_load", res.ok, res.status, Date.now() - s, authenticityToken ? "token ok" : "no token");
      if (!res.ok) return fail("checkout_load", `HTTP ${res.status}`);
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    // ── 5. POST contact + shipping address ────────────────────────────────
    try {
      lastStep = "contact_submit";
      const s = Date.now();
      const body = new URLSearchParams();
      if (authenticityToken) body.set("authenticity_token", authenticityToken);
      body.set("previous_step", "contact_information");
      body.set("step", "shipping_method");
      body.set("checkout[email]", data.profile.email);
      body.set("checkout[shipping_address][first_name]", data.profile.first_name);
      body.set("checkout[shipping_address][last_name]", data.profile.last_name);
      body.set("checkout[shipping_address][address1]", data.profile.address1);
      if (data.profile.address2) body.set("checkout[shipping_address][address2]", data.profile.address2);
      body.set("checkout[shipping_address][city]", data.profile.city);
      body.set("checkout[shipping_address][country]", data.profile.country);
      body.set("checkout[shipping_address][province]", data.profile.province);
      body.set("checkout[shipping_address][zip]", data.profile.zip);
      body.set("checkout[shipping_address][phone]", data.profile.phone);
      if (data.captchaToken) {
        body.set("g-recaptcha-response", data.captchaToken);
        body.set("cf-turnstile-response", data.captchaToken);
      }
      const res = await fetch(checkoutUrl, {
        method: "POST",
        headers: {
          ...baseHeaders,
          cookie: cookieHeader(jar),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        redirect: "follow",
      });
      collectCookies(res, jar);
      checkoutUrl = res.url || checkoutUrl;
      record("contact_submit", res.ok, res.status, Date.now() - s, checkoutUrl);
      if (!res.ok) return fail("contact_submit", `HTTP ${res.status}`);
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    // ── 6. Poll shipping rates ────────────────────────────────────────────
    let shippingRateId: string | null = null;
    try {
      lastStep = "shipping_rates";
      const s = Date.now();
      const ratesUrl = `${checkoutUrl.split("?")[0].replace(/\/$/, "")}/shipping_rates.json`;
      let attempt = 0;
      while (attempt < 6) {
        const res = await fetch(ratesUrl, { headers: { ...baseHeaders, cookie: cookieHeader(jar) } });
        collectCookies(res, jar);
        if (res.ok) {
          const j = (await res.json().catch(() => ({}))) as { shipping_rates?: Array<{ id: string; price: string }> };
          const r = j.shipping_rates?.[0];
          if (r) { shippingRateId = r.id; break; }
        }
        attempt++;
        await new Promise((r) => setTimeout(r, 500));
      }
      record("shipping_rates", !!shippingRateId, null, Date.now() - s, shippingRateId ?? "no rates");
      if (!shippingRateId && !data.dryRun) {
        return fail("shipping_rates", "no shipping rates after 6 attempts");
      }
    } catch (e) {
      record("shipping_rates", false, null, 0, (e as Error).message);
    }

    if (data.dryRun) {
      return {
        ok: true, taskId: data.taskId, checkoutUrl, orderId: null, steps,
        elapsedMs: Date.now() - t0, dryRun: true,
      };
    }

    // ── 7. Submit shipping method ─────────────────────────────────────────
    try {
      lastStep = "shipping_submit";
      const s = Date.now();
      const body = new URLSearchParams();
      if (authenticityToken) body.set("authenticity_token", authenticityToken);
      body.set("previous_step", "shipping_method");
      body.set("step", "payment_method");
      if (shippingRateId) body.set("checkout[shipping_rate][id]", shippingRateId);
      const res = await fetch(checkoutUrl, {
        method: "POST",
        headers: { ...baseHeaders, cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        redirect: "follow",
      });
      collectCookies(res, jar);
      checkoutUrl = res.url || checkoutUrl;
      record("shipping_submit", res.ok, res.status, Date.now() - s);
      if (!res.ok) return fail("shipping_submit", `HTTP ${res.status}`);
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    // ── 8. Vault card → session id ────────────────────────────────────────
    let sessionId: string | null = null;
    if (data.card) {
      try {
        lastStep = "payment_vault";
        const s = Date.now();
        const res = await fetch("https://deposit.us.shopifycs.com/sessions", {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": UA },
          body: JSON.stringify({
            credit_card: {
              number: data.card.number,
              name: data.card.name,
              month: Number(data.card.exp_month),
              year: 2000 + (Number(data.card.exp_year) % 100),
              verification_value: data.card.cvv,
            },
            payment_session_scope: new URL(base).hostname,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as { id?: string };
        sessionId = j.id ?? null;
        record("payment_vault", !!sessionId, res.status, Date.now() - s, sessionId ? "vaulted" : "no session id");
        if (!sessionId) return fail("payment_vault", "vault returned no session id");
      } catch (e) {
        return fail(lastStep, (e as Error).message);
      }
    }

    // ── 9. Submit payment ─────────────────────────────────────────────────
    // NOTE: real submission needs total_price + correct payment_gateway id
    // scraped from the payment_method page. Marked as TODO_REAL_SUBMIT to
    // make it obvious this is the next thing to wire when going live.
    record("payment_submit", false, null, 0, "TODO_REAL_SUBMIT — wire total + gateway id");
    return fail("payment_submit", "real submission not wired yet (dry-run only)");
  });
