import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Browserless checkout worker (v1).
// ---------------------------------------------------------------------------
// This drives a REAL browser (running on browserless.io) all the way from the
// product page through to the order confirmation page. Because workerd has no
// Playwright/Puppeteer runtime, we POST a self-contained script string to
// Browserless's /function endpoint — they execute it in headless Chrome with
// the user's proxy attached, return the JSON result.
//
// Same state machine will be reused by the Electron runner later — just
// swap the transport from `fetch(/function)` to a local Playwright instance.
//
// What it does, in order:
//   1. Goto product page → add variant to cart (via /cart/add.js inside the
//      browser, so cookies/__cf_bm get set under a real TLS fingerprint).
//   2. Goto checkout permalink with prefilled contact + shipping.
//   3. Click "Continue to shipping" → wait for shipping methods.
//   4. Click "Continue to payment".
//   5. Fill Stripe iframe (card #, exp, cvv).
//   6. Inject captcha token if pool provided one.
//   7. Click "Pay now" → wait for /thank_you or order id in URL.
//   8. Return { ok, orderId, screenshotB64, stepsTimeline }.

const ProfileSchema = z.object({
  email: z.string().max(200),
  first_name: z.string().max(100),
  last_name: z.string().max(100),
  address1: z.string().max(200),
  address2: z.string().max(200).optional().nullable(),
  city: z.string().max(100),
  province: z.string().max(100), // 2-letter for US/CA
  zip: z.string().max(30),
  country: z.string().max(100),  // 2-letter ISO
  phone: z.string().max(40),
});

const CardSchema = z.object({
  number: z.string().min(12).max(25),
  name: z.string().min(1).max(100),
  exp_month: z.string().regex(/^\d{1,2}$/),
  exp_year: z.string().regex(/^\d{2,4}$/),
  cvv: z.string().regex(/^\d{3,4}$/),
});

const InputSchema = z.object({
  storeUrl: z.string().url().max(500),
  variantId: z.number().int().positive(),
  qty: z.number().int().min(1).max(20),
  profile: ProfileSchema,
  card: CardSchema,
  proxy: z.string().min(7).max(200).optional().nullable(),
  captchaToken: z.string().min(10).max(4000).optional().nullable(),
  dryRun: z.boolean().optional(), // if true, stops BEFORE clicking final "Pay now"
});

export type CheckoutStep =
  | "launch"
  | "cart_add"
  | "checkout_load"
  | "contact_fill"
  | "shipping_continue"
  | "shipping_method"
  | "payment_continue"
  | "card_fill"
  | "captcha_inject"
  | "submit"
  | "confirm";

type StepRecord = { step: CheckoutStep; t: number; ok: boolean; note?: string };

export type BrowserlessOk = {
  ok: true;
  orderId: string | null;
  finalUrl: string;
  steps: StepRecord[];
  screenshotB64: string | null;
  elapsedMs: number;
  dryRun: boolean;
};
export type BrowserlessErr = {
  ok: false;
  failedStep: CheckoutStep | "transport";
  error: string;
  steps: StepRecord[];
  screenshotB64: string | null;
  elapsedMs: number;
};

// The script we ship to Browserless. Authored as a function so it's
// type-checked here, then `.toString()`'d before send. Receives Browserless's
// `{ page, context, browser }` API — same shape Puppeteer exposes.
function browserlessScript() {
  return async ({ page, context }: any) => {
    const { input } = context as {
      input: {
        storeUrl: string;
        variantId: number;
        qty: number;
        profile: any;
        card: any;
        captchaToken: string | null;
        dryRun: boolean;
      };
    };

    const steps: StepRecord[] = [];
    const t0 = Date.now();
    const log = (step: CheckoutStep, ok: boolean, note?: string) =>
      steps.push({ step, t: Date.now() - t0, ok, note });

    let lastStep: CheckoutStep = "launch";
    const fail = async (err: string) => {
      let shot: string | null = null;
      try {
        shot = await page.screenshot({ encoding: "base64", fullPage: false });
      } catch {}
      return { ok: false, failedStep: lastStep, error: err, steps, screenshotB64: shot };
    };

    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      );
      await page.setViewport({ width: 1280, height: 800 });
      log("launch", true);

      // ── 1. Warm cookies + add to cart from within the browser ──
      lastStep = "cart_add";
      await page.goto(input.storeUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      const addRes: { status: number; body: string } = await page.evaluate(
        async (storeUrl: string, vid: number, q: number) => {
          const r = await fetch(`${storeUrl.replace(/\/$/, "")}/cart/add.js`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ id: String(vid), quantity: String(q) }).toString(),
            credentials: "include",
          });
          return { status: r.status, body: await r.text() };
        },
        input.storeUrl,
        input.variantId,
        input.qty,
      );
      if (addRes.status >= 400) {
        log("cart_add", false, `HTTP ${addRes.status}`);
        return await fail(`cart_add failed: ${addRes.body.slice(0, 200)}`);
      }
      log("cart_add", true);

      // ── 2. Go to checkout (Shopify will create a new checkout session) ──
      lastStep = "checkout_load";
      await page.goto(`${input.storeUrl.replace(/\/$/, "")}/checkout`, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
      log("checkout_load", true, page.url());

      // ── 3. Contact + shipping ──
      lastStep = "contact_fill";
      const p = input.profile;
      const fill = async (sel: string, val: string) => {
        const el = await page.$(sel);
        if (!el) return false;
        await el.click({ clickCount: 3 }).catch(() => {});
        await el.type(val, { delay: 15 });
        return true;
      };
      // Shopify uses different selectors across themes / Checkout One — try the common ones.
      await fill('input[name="checkout[email]"], input[name="email"]', p.email);
      await fill('input[name="checkout[shipping_address][first_name]"], input[name="firstName"]', p.first_name);
      await fill('input[name="checkout[shipping_address][last_name]"], input[name="lastName"]', p.last_name);
      await fill('input[name="checkout[shipping_address][address1]"], input[name="address1"]', p.address1);
      if (p.address2) await fill('input[name="checkout[shipping_address][address2]"], input[name="address2"]', p.address2);
      await fill('input[name="checkout[shipping_address][city]"], input[name="city"]', p.city);
      await fill('input[name="checkout[shipping_address][zip]"], input[name="postalCode"]', p.zip);
      await fill('input[name="checkout[shipping_address][phone]"], input[name="phone"]', p.phone);
      // Country + province selects
      try {
        await page.select('select[name="checkout[shipping_address][country]"]', p.country);
        await page.select('select[name="checkout[shipping_address][province]"]', p.province);
      } catch {}
      log("contact_fill", true);

      // ── 4. Continue to shipping ──
      lastStep = "shipping_continue";
      const clickContinue = async () => {
        const candidates = [
          'button#continue_button',
          'button[type="submit"][name="button"]',
          'button:has-text("Continue to shipping")',
          'button:has-text("Continue")',
        ];
        for (const sel of candidates) {
          const btn = await page.$(sel).catch(() => null);
          if (btn) { await btn.click(); return true; }
        }
        return false;
      };
      await clickContinue();
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      log("shipping_continue", true, page.url());

      // ── 5. Shipping method (pick first available) → continue to payment ──
      lastStep = "shipping_method";
      await page.waitForSelector('input[name="checkout[shipping_rate][id]"], [data-shipping-method]', { timeout: 15_000 }).catch(() => {});
      const firstRate = await page.$('input[name="checkout[shipping_rate][id]"]');
      if (firstRate) await firstRate.click().catch(() => {});
      log("shipping_method", true);

      lastStep = "payment_continue";
      await clickContinue();
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      log("payment_continue", true, page.url());

      // ── 6. Card fill (Stripe iframe) ──
      lastStep = "card_fill";
      await page.waitForSelector('iframe[name^="card-fields-number"]', { timeout: 15_000 });
      const frames = page.frames();
      const numFrame = frames.find((f: any) => /card-fields-number/.test(f.name()));
      const expFrame = frames.find((f: any) => /card-fields-expiry/.test(f.name()));
      const cvvFrame = frames.find((f: any) => /card-fields-verification/.test(f.name()));
      const nameFrame = frames.find((f: any) => /card-fields-name/.test(f.name()));
      if (!numFrame || !expFrame || !cvvFrame) {
        log("card_fill", false, "card iframes missing");
        return await fail("card iframes not found");
      }
      await (await numFrame.$('input'))?.type(input.card.number, { delay: 20 });
      await (await expFrame.$('input'))?.type(`${input.card.exp_month.padStart(2, "0")}/${input.card.exp_year.slice(-2)}`, { delay: 20 });
      await (await cvvFrame.$('input'))?.type(input.card.cvv, { delay: 20 });
      if (nameFrame) await (await nameFrame.$('input'))?.type(input.card.name, { delay: 20 });
      log("card_fill", true);

      // ── 7. Inject captcha token if we have a pre-harvested one ──
      if (input.captchaToken) {
        lastStep = "captcha_inject";
        await page.evaluate((tok: string) => {
          const set = (name: string) => {
            let el = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
            if (!el) {
              el = document.createElement("input");
              el.type = "hidden";
              el.name = name;
              document.querySelector("form")?.appendChild(el);
            }
            el.value = tok;
          };
          set("cf-turnstile-response");
          set("g-recaptcha-response");
          set("h-captcha-response");
        }, input.captchaToken);
        log("captcha_inject", true);
      }

      // ── 8. Submit (or stop here if dry run) ──
      if (input.dryRun) {
        const shot = await page.screenshot({ encoding: "base64", fullPage: false });
        return { ok: true, orderId: null, finalUrl: page.url(), steps, screenshotB64: shot, dryRun: true };
      }

      lastStep = "submit";
      await clickContinue();
      log("submit", true);

      // ── 9. Wait for /thank_you or order id in URL ──
      lastStep = "confirm";
      await page.waitForFunction(
        () => /\/thank_you|orders\/|checkouts\/.+\/thank/i.test(location.href),
        { timeout: 25_000 },
      );
      const finalUrl = page.url();
      const orderMatch = finalUrl.match(/orders\/(\d+)|checkouts\/[^/]+\/([a-z0-9]+)\/thank_you/i);
      const orderId = orderMatch ? (orderMatch[1] ?? orderMatch[2] ?? null) : null;
      const shot = await page.screenshot({ encoding: "base64", fullPage: false });
      log("confirm", true, orderId ?? finalUrl);
      return { ok: true, orderId, finalUrl, steps, screenshotB64: shot, dryRun: false };
    } catch (e: any) {
      return await fail(e?.message ?? String(e));
    }
  };
}

export const runBrowserlessCheckout = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<BrowserlessOk | BrowserlessErr> => {
    const start = Date.now();
    const apiKey = process.env.BROWSERLESS_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        failedStep: "transport",
        error: "BROWSERLESS_API_KEY missing on server",
        steps: [],
        screenshotB64: null,
        elapsedMs: Date.now() - start,
      };
    }

    // Browserless /function endpoint: { code: string, context: any }
    // The proxy is attached via the URL `?proxy=<...>` (browserless format).
    const url = new URL("https://production-sfo.browserless.io/function");
    url.searchParams.set("token", apiKey);
    if (data.proxy) {
      // Accept ip:port or user:pass@ip:port; pass as residential-style proxy.
      url.searchParams.set("proxy", `http://${data.proxy}`);
      url.searchParams.set("proxySticky", "true");
    }
    url.searchParams.set("timeout", "120000");

    const fnSource = `module.exports = ${browserlessScript().toString()}`;

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: fnSource,
          context: {
            input: {
              storeUrl: data.storeUrl,
              variantId: data.variantId,
              qty: data.qty,
              profile: data.profile,
              card: data.card,
              captchaToken: data.captchaToken ?? null,
              dryRun: data.dryRun ?? false,
            },
          },
        }),
      });
    } catch (e) {
      return {
        ok: false,
        failedStep: "transport",
        error: `Browserless transport error: ${(e as Error).message}`,
        steps: [],
        screenshotB64: null,
        elapsedMs: Date.now() - start,
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        failedStep: "transport",
        error: `Browserless HTTP ${res.status}: ${body.slice(0, 300)}`,
        steps: [],
        screenshotB64: null,
        elapsedMs: Date.now() - start,
      };
    }

    const result = (await res.json().catch(() => null)) as any;
    if (!result || typeof result !== "object") {
      return {
        ok: false,
        failedStep: "transport",
        error: "Browserless returned non-JSON",
        steps: [],
        screenshotB64: null,
        elapsedMs: Date.now() - start,
      };
    }

    const elapsedMs = Date.now() - start;
    if (result.ok) {
      return {
        ok: true,
        orderId: result.orderId ?? null,
        finalUrl: result.finalUrl ?? "",
        steps: Array.isArray(result.steps) ? result.steps : [],
        screenshotB64: result.screenshotB64 ?? null,
        elapsedMs,
        dryRun: !!result.dryRun,
      };
    }
    return {
      ok: false,
      failedStep: (result.failedStep ?? "transport") as CheckoutStep | "transport",
      error: result.error ?? "Unknown failure",
      steps: Array.isArray(result.steps) ? result.steps : [],
      screenshotB64: result.screenshotB64 ?? null,
      elapsedMs,
    };
  });
