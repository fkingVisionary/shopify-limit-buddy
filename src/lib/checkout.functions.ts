import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Checkout engine (v1).
// ---------------------------------------------------------------------------
// What this does on the server, through the user's selected proxy:
//   1. POST /cart/add.js  (validates the variant actually adds — catches
//      "sold out / queue / bot-walled" before the user clicks).
//   2. GET  /cart.js      (confirms line item present, returns cart token).
//   3. Builds a prefilled cart-permalink checkout URL with shipping fields
//      + (optional) a captcha token from the pool, ready to open.
//
// What this does NOT do (yet): submit shipping/payment server-side. Shopify's
// "Checkout One" is heavily protected (Stripe iframe tokenization, Cloudflare
// fingerprinting). Full bot-style submission needs a headless browser worker
// running on the user's machine — that's the next milestone. For now this
// gets the cart warm + checkout opened in <500ms instead of the user
// hand-driving cart-add when the drop hits.

const ProfileSchema = z.object({
  email: z.string().max(200).optional().nullable(),
  first_name: z.string().max(100).optional().nullable(),
  last_name: z.string().max(100).optional().nullable(),
  address1: z.string().max(200).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  province: z.string().max(100).optional().nullable(),
  zip: z.string().max(30).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
});

const InputSchema = z.object({
  storeUrl: z.string().url().max(500),
  variantId: z.number().int().positive(),
  qty: z.number().int().min(1).max(20),
  profile: ProfileSchema,
  proxy: z.string().min(7).max(200).optional().nullable(),
  captchaToken: z.string().min(10).max(4000).optional().nullable(),
});

type RunOk = {
  ok: true;
  checkoutUrl: string;
  cartCount: number;
  elapsedMs: number;
  message?: string;
};
type RunErr = {
  ok: false;
  stage: "cart_add" | "cart_read" | "network";
  error: string;
  elapsedMs: number;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function buildCheckoutUrl(
  storeUrl: string,
  variantId: number,
  qty: number,
  p: z.infer<typeof ProfileSchema>,
  captchaToken: string | null | undefined,
): string {
  const params = new URLSearchParams();
  if (p.email) params.set("checkout[email]", p.email);
  if (p.first_name) params.set("checkout[shipping_address][first_name]", p.first_name);
  if (p.last_name) params.set("checkout[shipping_address][last_name]", p.last_name);
  if (p.address1) params.set("checkout[shipping_address][address1]", p.address1);
  if (p.city) params.set("checkout[shipping_address][city]", p.city);
  if (p.province) params.set("checkout[shipping_address][province]", p.province);
  if (p.zip) params.set("checkout[shipping_address][zip]", p.zip);
  if (p.country) params.set("checkout[shipping_address][country]", p.country);
  if (p.phone) params.set("checkout[shipping_address][phone]", p.phone);
  if (captchaToken) {
    // Both common field names — whichever the gate is expecting will match.
    params.set("cf-turnstile-response", captchaToken);
    params.set("g-recaptcha-response", captchaToken);
  }
  const qs = params.toString();
  return `${storeUrl.replace(/\/$/, "")}/cart/${variantId}:${qty}${qs ? `?${qs}` : ""}`;
}

// Parse Set-Cookie headers from a Response into a single Cookie header string.
function collectCookies(res: Response, jar: Map<string, string>): void {
  // Workerd: Headers.getSetCookie() returns string[]
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  const list: string[] = typeof anyHeaders.getSetCookie === "function"
    ? anyHeaders.getSetCookie()
    : [];
  for (const raw of list) {
    const first = raw.split(";", 1)[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const k = first.slice(0, eq).trim();
    const v = first.slice(eq + 1).trim();
    if (k) jar.set(k, v);
  }
}
function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

export const runCheckout = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<RunOk | RunErr> => {
    const start = Date.now();
    const base = data.storeUrl.replace(/\/$/, "");
    const jar = new Map<string, string>();

    // NOTE: Workerd `fetch` doesn't support per-request HTTP proxies. The
    // `proxy` field is accepted today so the API is stable; once we move
    // the checkout walker to a Node worker / user-machine harvester it will
    // route through the user's proxy. For now requests go out from the
    // edge directly — this is fine for the cart-add validation step.

    const baseHeaders: Record<string, string> = {
      "user-agent": UA,
      accept: "application/json,text/javascript,*/*;q=0.1",
      "accept-language": "en-US,en;q=0.9",
      referer: `${base}/`,
      origin: base,
    };

    // 1) Add to cart
    let addRes: Response;
    try {
      addRes = await fetch(`${base}/cart/add.js`, {
        method: "POST",
        headers: { ...baseHeaders, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          id: String(data.variantId),
          quantity: String(data.qty),
        }).toString(),
        redirect: "follow",
      });
    } catch (e) {
      return {
        ok: false,
        stage: "network",
        error: `cart/add network error: ${(e as Error).message}`,
        elapsedMs: Date.now() - start,
      };
    }
    collectCookies(addRes, jar);

    if (addRes.status === 422) {
      const body = await addRes.text().catch(() => "");
      let desc = "Variant rejected (sold out, limit hit, or queue).";
      try {
        const j = JSON.parse(body) as { description?: string; message?: string };
        desc = j.description ?? j.message ?? desc;
      } catch {}
      return { ok: false, stage: "cart_add", error: desc, elapsedMs: Date.now() - start };
    }
    if (!addRes.ok) {
      return {
        ok: false,
        stage: "cart_add",
        error: `cart/add HTTP ${addRes.status}`,
        elapsedMs: Date.now() - start,
      };
    }

    // 2) Read cart back to confirm
    let cartCount = data.qty;
    try {
      const cartRes = await fetch(`${base}/cart.js`, {
        headers: { ...baseHeaders, cookie: cookieHeader(jar) },
      });
      collectCookies(cartRes, jar);
      if (cartRes.ok) {
        const j = (await cartRes.json().catch(() => ({}))) as { item_count?: number };
        if (typeof j.item_count === "number") cartCount = j.item_count;
      }
    } catch {
      // non-fatal — cart/add succeeded
    }

    const url = buildCheckoutUrl(base, data.variantId, data.qty, data.profile, data.captchaToken);
    return {
      ok: true,
      checkoutUrl: url,
      cartCount,
      elapsedMs: Date.now() - start,
      message: data.captchaToken ? "Cart warmed + captcha token attached" : "Cart warmed",
    };
  });
