import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Checkout One (CN) GraphQL checkout engine.
// ---------------------------------------------------------------------------
// Replaces the legacy /checkouts/{token} form-POST flow which Shopify killed
// in Aug 2024. This is what current-gen bots actually do:
//
//   1. cart/add.js                       → variant in session cookie
//   2. POST /cart                        → 302 to /checkouts/cn/{token}
//   3. GET /checkouts/cn/{token}         → scrape session/queue/build tokens
//   4. POST deposit.shopifycs.com/sessions → card → session id
//   5. POST {graphqlUrl} SubmitForCompletion
//        ├─ Challenge?  → solve via 2Captcha → retry
//        └─ ReceiptId   → poll PollForReceipt until processed
//
// Captcha: reads TWOCAPTCHA_API_KEY from env. If the mutation returns a
// Challenge node and the key is missing, fails fast with `captcha_required`.
//
// Caveats:
//   • Shopify rotates GraphQL operation hashes / variable shapes every few
//     weeks. The mutation body here is the current documented shape — when
//     it breaks, the response will surface as `submit_for_completion`
//     failure with the raw error captured in `note`, so we can patch.
//   • Workerd fetch has no per-request HTTP proxy. The `proxy` field is
//     recorded for the runner path; server-side requests go from the edge.
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
  dryRun: z.boolean().default(true),
});

export type C1Step =
  | "akamai_sensor"
  | "cart_add"
  | "cart_redirect"
  | "checkout_page"
  | "scrape_tokens"
  | "card_vault"
  | "submit_for_completion"
  | "captcha_solve"
  | "poll_receipt";


export type C1StepRecord = {
  step: C1Step;
  ok: boolean;
  status: number | null;
  ms: number;
  note?: string;
};

export type C1Result =
  | {
      ok: true;
      taskId: string;
      checkoutUrl: string | null;
      orderId: string | null;
      receiptId: string | null;
      steps: C1StepRecord[];
      elapsedMs: number;
      dryRun: boolean;
    }
  | {
      ok: false;
      taskId: string;
      failedStep: C1Step;
      error: string;
      steps: C1StepRecord[];
      elapsedMs: number;
    };

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ── helpers ────────────────────────────────────────────────────────────────
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
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
function pickScript(html: string, id: string): string | null {
  // <script id="X" type="application/json">...</script>
  const re = new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`, "i");
  return html.match(re)?.[1]?.trim() ?? null;
}
function firstMatch(html: string, re: RegExp): string | null {
  return html.match(re)?.[1] ?? null;
}
function checkoutProtectionBlock(
  status: number,
  html: string,
  proxy?: string | null,
): string | null {
  const preview = html.slice(0, 180).replace(/\s+/g, " ").trim();
  if (
    status === 403 ||
    /Request Forbidden|Access Denied|Cloudflare|cf-ray|Attention Required/i.test(html)
  ) {
    const proxyNote = proxy ? " Server fetch cannot use the supplied proxy here." : "";
    return `checkout protection returned HTTP ${status}${proxyNote} Body: ${preview}`;
  }
  return null;
}

// 2Captcha solver — hCaptcha invisible / checkbox
async function solveHCaptcha(siteKey: string, pageUrl: string): Promise<string> {
  const key = process.env.TWOCAPTCHA_API_KEY;
  if (!key) throw new Error("captcha_required: TWOCAPTCHA_API_KEY not set");
  const createUrl = `https://2captcha.com/in.php?key=${key}&method=hcaptcha&sitekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
  const create = (await (await fetch(createUrl)).json()) as { status: number; request: string };
  if (create.status !== 1) throw new Error(`2captcha create failed: ${create.request}`);
  const id = create.request;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = (await (
      await fetch(`https://2captcha.com/res.php?key=${key}&action=get&id=${id}&json=1`)
    ).json()) as { status: number; request: string };
    if (poll.status === 1) return poll.request;
    if (poll.request !== "CAPCHA_NOT_READY") throw new Error(`2captcha poll: ${poll.request}`);
  }
  throw new Error("2captcha timeout after 150s");
}

// 2Captcha Akamai sensor solver. Returns sensor_data payload to POST at scriptUrl.
// https://2captcha.com/2captcha-api#solving_akamai
async function solveAkamaiSensor(opts: {
  pageUrl: string;
  scriptUrl: string;
  userAgent: string;
}): Promise<string> {
  const key = process.env.TWOCAPTCHA_API_KEY;
  if (!key) throw new Error("captcha_required: TWOCAPTCHA_API_KEY not set");
  const createBody = new URLSearchParams({
    key,
    method: "akamai",
    pageurl: opts.pageUrl,
    script: opts.scriptUrl,
    userAgent: opts.userAgent,
    json: "1",
  });
  const create = (await (
    await fetch("https://2captcha.com/in.php", { method: "POST", body: createBody })
  ).json()) as { status: number; request: string };
  if (create.status !== 1) throw new Error(`2captcha akamai create: ${create.request}`);
  const id = create.request;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = (await (
      await fetch(`https://2captcha.com/res.php?key=${key}&action=get&id=${id}&json=1`)
    ).json()) as { status: number; request: string; sensor_data?: string };
    if (poll.status === 1) {
      // some payloads return JSON-wrapped sensor_data, some return raw string
      try {
        const parsed = JSON.parse(poll.request) as { sensor_data?: string };
        return parsed.sensor_data ?? poll.request;
      } catch {
        return poll.request;
      }
    }
    if (poll.request !== "CAPCHA_NOT_READY") throw new Error(`2captcha akamai poll: ${poll.request}`);
  }
  throw new Error("2captcha akamai timeout after 150s");
}

// Detects an Akamai bot-manager footprint in a response (cookies or body markers).
function detectAkamai(res: Response, body: string): boolean {
  const setCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (setCookie.some((c) => /^(_abck|bm_sz|ak_bmsc|bm_sv|bm_mi)=/i.test(c))) return true;
  if (/akam\/|\/_bm\/|akamai|_abck|bm_sz/i.test(body)) return true;
  return false;
}

// Tries to locate the Akamai sensor script URL in the HTML. Returns absolute URL.
function findAkamaiScriptUrl(html: string, origin: string): string | null {
  const candidates = [
    /src="([^"]*\/_bm\/[^"]+)"/i,
    /src="([^"]*akam[^"]*\.js[^"]*)"/i,
    /href="([^"]*\/_bm\/[^"]+)"/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m?.[1]) {
      try {
        return new URL(m[1], origin).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}


export const runCheckoutOne = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<C1Result> => {
    const t0 = Date.now();
    const base = data.storeUrl.replace(/\/$/, "");
    const jar = new Map<string, string>();
    const steps: C1StepRecord[] = [];
    let lastStep: C1Step = "cart_add";

    const baseHeaders: Record<string, string> = {
      "user-agent": UA,
      accept: "text/html,application/json,*/*;q=0.1",
      "accept-language": "en-US,en;q=0.9",
      referer: `${base}/`,
      origin: base,
    };
    const record = (
      step: C1Step,
      ok: boolean,
      status: number | null,
      ms: number,
      note?: string,
    ) => {
      steps.push({ step, ok, status, ms, note });
    };
    const fail = (failedStep: C1Step, error: string): C1Result => ({
      ok: false,
      taskId: data.taskId,
      failedStep,
      error,
      steps,
      elapsedMs: Date.now() - t0,
    });

    // ── 0. Akamai warm-up ──────────────────────────────────────────────────
    // GET the homepage to seed cookies. If the store is behind Akamai BMP
    // (JB Hi-Fi, Kmart, Big W, Coles, Myer, etc.) the response carries
    // _abck/bm_sz cookies or returns 403. We solve the sensor via 2Captcha
    // and POST it back to the sensor endpoint to upgrade _abck to a "valid"
    // state — Akamai usually requires 2 posts before accepting downstream
    // requests. Skipped silently when no Akamai footprint is detected.
    try {
      lastStep = "akamai_sensor";
      const s = Date.now();
      const probe = await fetch(`${base}/`, {
        headers: { ...baseHeaders, accept: "text/html,application/xhtml+xml" },
      });
      collectCookies(probe, jar);
      const probeBody = await probe.text();
      const isAkamai = probe.status === 403 || detectAkamai(probe, probeBody);
      if (!isAkamai) {
        record("akamai_sensor", true, probe.status, Date.now() - s, "no Akamai detected — skipped");
      } else {
        const scriptUrl = findAkamaiScriptUrl(probeBody, base);
        if (!scriptUrl) {
          record(
            "akamai_sensor",
            false,
            probe.status,
            Date.now() - s,
            "Akamai detected but sensor script URL not found",
          );
          return fail("akamai_sensor", "could not locate Akamai sensor script in HTML");
        }
        // Two-pass sensor post — first pass gets an invalid _abck, second
        // upgrades it. Some Akamai configs need a third pass.
        let abckValid = false;
        for (let pass = 0; pass < 3 && !abckValid; pass++) {
          const sensorData = await solveAkamaiSensor({
            pageUrl: `${base}/`,
            scriptUrl,
            userAgent: UA,
          });
          const postRes = await fetch(scriptUrl, {
            method: "POST",
            headers: {
              ...baseHeaders,
              "content-type": "text/plain;charset=UTF-8",
              cookie: cookieHeader(jar),
              accept: "*/*",
            },
            body: JSON.stringify({ sensor_data: sensorData }),
          });
          collectCookies(postRes, jar);
          const abck = jar.get("_abck") ?? "";
          // Valid _abck cookies do NOT contain "~0~" in the second segment.
          // Invalid sensor responses leave it as "~-1~..." or "~0~...".
          abckValid = /~-?\d+~[^~]*~[^~]*~/.test(abck) && !/~0~/.test(abck) && !/~-1~/.test(abck);
        }
        record(
          "akamai_sensor",
          abckValid,
          probe.status,
          Date.now() - s,
          abckValid ? "sensor solved, _abck upgraded" : "sensor failed to upgrade _abck",
        );
        if (!abckValid) return fail("akamai_sensor", "Akamai _abck did not validate after 3 passes");
      }
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    // ── 1. cart/add ────────────────────────────────────────────────────────

    try {
      lastStep = "cart_add";
      const s = Date.now();
      const res = await fetch(`${base}/cart/add.js`, {
        method: "POST",
        headers: { ...baseHeaders, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          id: String(data.variantId),
          quantity: String(data.qty),
        }).toString(),
      });
      collectCookies(res, jar);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        let desc = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(body) as { description?: string; message?: string };
          desc = j.description ?? j.message ?? desc;
        } catch {
          desc = body.slice(0, 160) || desc;
        }
        record("cart_add", false, res.status, Date.now() - s, desc);
        return fail("cart_add", desc);
      }
      record("cart_add", true, res.status, Date.now() - s);
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    // ── 2. POST /cart → 302 to /checkouts/cn/{token}, capture HTML ───────
    let checkoutUrl: string | null = null;
    let html = "";
    try {
      lastStep = "cart_redirect";
      const s = Date.now();
      const res = await fetch(`${base}/cart`, {
        method: "POST",
        headers: {
          ...baseHeaders,
          cookie: cookieHeader(jar),
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html,application/xhtml+xml",
        },
        body: new URLSearchParams({ checkout: "Check out", updates: String(data.qty) }).toString(),
        redirect: "follow",
      });
      collectCookies(res, jar);
      checkoutUrl = res.url;
      const landed = /\/checkouts?\//i.test(checkoutUrl);
      // Capture HTML from the same response — the _r queue token is single-use,
      // re-GETting the URL invalidates the session.
      html = await res.text();
      const blocked = checkoutProtectionBlock(res.status, html, data.proxy);
      record(
        "cart_redirect",
        landed && !blocked,
        res.status,
        Date.now() - s,
        blocked ?? `${checkoutUrl} (${html.length}b)`,
      );
      if (!landed) return fail("cart_redirect", `bad redirect: ${res.status} ${checkoutUrl}`);
      if (blocked) return fail("cart_redirect", blocked);
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    // ── 3. checkout_page (already loaded above, just sanity-check) ────────
    {
      const s = Date.now();
      const looksLikeCheckout = /checkout-web|serialized-session-token|shopify-checkout/i.test(
        html,
      );
      record(
        "checkout_page",
        looksLikeCheckout,
        null,
        Date.now() - s,
        looksLikeCheckout ? "OK" : html.slice(0, 200),
      );
      if (!looksLikeCheckout) return fail("checkout_page", "response is not a checkout page");
    }

    // ── 4. Scrape Checkout One tokens ─────────────────────────────────────
    // Checkout One embeds its bootstrap as several <script> JSON blobs:
    //   #serialized-session-token  →  JWT used as x-checkout-one-session-token
    //   #shopify-features          →  feature flags
    //   #checkout-context          →  shopId, queueToken, checkoutToken, buildId
    // Different store versions name them slightly differently — we try
    // multiple shapes.
    let sessionToken: string | null = null;
    let queueToken: string | null = null;
    let buildId: string | null = null;
    let shopId: string | null = null;
    let checkoutToken: string | null = null;
    let hcaptchaSiteKey: string | null = null;
    let graphqlUrl: string | null = null;

    try {
      lastStep = "scrape_tokens";
      const s = Date.now();

      const sessionJson = pickScript(html, "serialized-session-token");
      if (sessionJson) {
        try {
          const parsed = JSON.parse(sessionJson) as string | { sessionToken?: string };
          sessionToken = typeof parsed === "string" ? parsed : (parsed.sessionToken ?? null);
        } catch {
          sessionToken = sessionJson.replace(/^"|"$/g, "");
        }
      }
      sessionToken ??= firstMatch(html, /"sessionToken":"([^"]+)"/);

      // queueToken comes either from the _r param or embedded in JSON
      try {
        const u = new URL(checkoutUrl!);
        queueToken = u.searchParams.get("_r");
      } catch {
        queueToken = null;
      }
      queueToken ??= firstMatch(html, /"queueToken":"([^"]+)"/);

      buildId =
        firstMatch(html, /\/cdn\/shopifycloud\/checkout-web\/assets\/[^"']*?-([a-f0-9]{8,})\./i) ??
        firstMatch(html, /"buildId":"([^"]+)"/);

      shopId = firstMatch(html, /"shopId":(\d+)/) ?? firstMatch(html, /shop-id="(\d+)"/);

      // checkoutToken is the cn/xxx in the URL
      const m = checkoutUrl!.match(/\/checkouts\/cn\/([^/?#]+)/);
      checkoutToken = m?.[1] ?? null;

      hcaptchaSiteKey =
        firstMatch(html, /data-hcaptcha-sitekey="([^"]+)"/) ??
        firstMatch(html, /"hcaptchaSiteKey":"([^"]+)"/);

      // GraphQL endpoint. Modern stores use:
      //   {storeOrigin}/checkouts/unstable/graphql?operationName=...
      graphqlUrl = `${base}/checkouts/unstable/graphql`;

      const missing: string[] = [];
      if (!sessionToken) missing.push("sessionToken");
      if (!checkoutToken) missing.push("checkoutToken");
      if (!buildId) missing.push("buildId");

      record(
        "scrape_tokens",
        missing.length === 0,
        null,
        Date.now() - s,
        missing.length === 0
          ? `session+queue+build+shop+ck${hcaptchaSiteKey ? "+hcaptcha" : ""}`
          : `missing: ${missing.join(",")}`,
      );
      if (missing.length > 0) return fail("scrape_tokens", `missing tokens: ${missing.join(",")}`);
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    if (data.dryRun) {
      return {
        ok: true,
        taskId: data.taskId,
        checkoutUrl,
        orderId: null,
        receiptId: null,
        steps,
        elapsedMs: Date.now() - t0,
        dryRun: true,
      };
    }

    // ── 5. Vault card → session id ────────────────────────────────────────
    let cardSessionId: string | null = null;
    if (data.card) {
      try {
        lastStep = "card_vault";
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
        cardSessionId = j.id ?? null;
        record(
          "card_vault",
          !!cardSessionId,
          res.status,
          Date.now() - s,
          cardSessionId ? "vaulted" : "no id",
        );
        if (!cardSessionId) return fail("card_vault", "vault returned no session id");
      } catch (e) {
        return fail(lastStep, (e as Error).message);
      }
    }

    // ── 6. SubmitForCompletion mutation ───────────────────────────────────
    // Documented mutation shape. Variables match what the Checkout One
    // React app sends. Will need patching when Shopify rotates the schema.
    const buildSubmitVariables = (captchaToken?: string) => ({
      sessionInput: { sessionToken },
      queueToken,
      discountCodes: [] as string[],
      gateValues: [] as string[],
      analytics: { requestUrl: checkoutUrl, pageId: crypto.randomUUID() },
      noteAttributes: [] as { name: string; value: string }[],
      attemptToken: crypto.randomUUID(),
      payment: cardSessionId
        ? {
            totalAmount: { any: { amount: "0", currencyCode: "USD" } },
            paymentLines: [
              {
                amount: { any: { amount: "0", currencyCode: "USD" } },
                paymentMethod: {
                  directPaymentMethod: {
                    paymentMethodIdentifier: "shopify_payments",
                    cardSource: null,
                    sessionId: cardSessionId,
                    billingAddress: {
                      streetAddress: {
                        address1: data.profile.address1,
                        address2: data.profile.address2 ?? "",
                        city: data.profile.city,
                        countryCode: data.profile.country,
                        postalCode: data.profile.zip,
                        firstName: data.profile.first_name,
                        lastName: data.profile.last_name,
                        phone: data.profile.phone,
                        zone: data.profile.province,
                      },
                    },
                  },
                },
              },
            ],
          }
        : null,
      delivery: {
        deliveryLines: [
          {
            destination: {
              streetAddress: {
                address1: data.profile.address1,
                address2: data.profile.address2 ?? "",
                city: data.profile.city,
                countryCode: data.profile.country,
                postalCode: data.profile.zip,
                firstName: data.profile.first_name,
                lastName: data.profile.last_name,
                phone: data.profile.phone,
                zone: data.profile.province,
              },
            },
            selectedDeliveryStrategy: { deliveryOptionHandle: null },
          },
        ],
      },
      buyerIdentity: {
        email: data.profile.email,
        phone: data.profile.phone,
        countryCode: data.profile.country,
      },
      captchaV3Tokens: [] as string[],
      hcaptchaToken: captchaToken ?? null,
    });

    const SUBMIT_MUTATION = `
      mutation SubmitForCompletion($sessionInput: SessionInput!, $queueToken: String, $payment: PaymentInput, $delivery: DeliveryInput!, $buyerIdentity: BuyerIdentityInput!, $analytics: AnalyticsInput, $hcaptchaToken: String, $attemptToken: String!, $discountCodes: [String!]!, $gateValues: [String!]!, $noteAttributes: [AttributeInput!]!, $captchaV3Tokens: [String!]!) {
        submitForCompletion(sessionInput: $sessionInput, queueToken: $queueToken, payment: $payment, delivery: $delivery, buyerIdentity: $buyerIdentity, analytics: $analytics, hcaptchaToken: $hcaptchaToken, attemptToken: $attemptToken, discountCodes: $discountCodes, gateValues: $gateValues, noteAttributes: $noteAttributes, captchaV3Tokens: $captchaV3Tokens) {
          ... on SubmitSuccess { receipt { id processedAt token } }
          ... on SubmitAlreadyAccepted { receipt { id token } }
          ... on SubmitFailed { reason }
          ... on SubmitRejected { buyerErrors { code message } }
          ... on Throttled { pollAfter }
          ... on SubmitChallenged { challenge { ... on HCaptchaChallenge { siteKey } } }
        }
      }
    `;

    const callSubmit = async (captchaToken?: string) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": UA,
        cookie: cookieHeader(jar),
        referer: checkoutUrl!,
        origin: base,
        "x-checkout-one-session-token": sessionToken!,
        "x-checkout-one-deploy-stage": "production",
      };
      if (buildId) headers["x-checkout-web-build-id"] = buildId;
      if (shopId) headers["x-checkout-web-source-id"] = shopId;
      return fetch(`${graphqlUrl}?operationName=SubmitForCompletion`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationName: "SubmitForCompletion",
          query: SUBMIT_MUTATION,
          variables: buildSubmitVariables(captchaToken),
        }),
      });
    };

    let receiptId: string | null = null;
    try {
      lastStep = "submit_for_completion";
      const s = Date.now();
      let res = await callSubmit();
      let body = (await res.json().catch(() => ({}))) as {
        data?: { submitForCompletion?: Record<string, unknown> };
        errors?: { message: string }[];
      };
      let node = body.data?.submitForCompletion as Record<string, unknown> | undefined;
      const typename = node?.__typename as string | undefined;

      // Challenge → solve and retry
      if (typename === "SubmitChallenged" || (node && "challenge" in node)) {
        record("submit_for_completion", false, res.status, Date.now() - s, "challenge issued");
        const challenge = (node?.challenge ?? {}) as { siteKey?: string };
        const siteKey = challenge.siteKey ?? hcaptchaSiteKey;
        if (!siteKey) return fail("submit_for_completion", "challenge with no siteKey");
        try {
          lastStep = "captcha_solve";
          const cs = Date.now();
          const token = await solveHCaptcha(siteKey, checkoutUrl!);
          record("captcha_solve", true, null, Date.now() - cs, "solved");
          lastStep = "submit_for_completion";
          const rs = Date.now();
          res = await callSubmit(token);
          body = (await res.json().catch(() => ({}))) as typeof body;
          node = body.data?.submitForCompletion as Record<string, unknown> | undefined;
          record(
            "submit_for_completion",
            res.ok,
            res.status,
            Date.now() - rs,
            JSON.stringify(node).slice(0, 200),
          );
        } catch (e) {
          return fail("captcha_solve", (e as Error).message);
        }
      } else {
        record(
          "submit_for_completion",
          res.ok,
          res.status,
          Date.now() - s,
          JSON.stringify(node ?? body).slice(0, 200),
        );
      }

      if (body.errors?.length)
        return fail("submit_for_completion", body.errors.map((e) => e.message).join("; "));
      const finalType = (node?.__typename as string | undefined) ?? "";
      if (finalType === "SubmitFailed")
        return fail("submit_for_completion", String(node?.reason ?? "SubmitFailed"));
      if (finalType === "SubmitRejected") {
        const errs = node?.buyerErrors as { code: string; message: string }[] | undefined;
        return fail(
          "submit_for_completion",
          errs?.map((e) => `${e.code}:${e.message}`).join("; ") ?? "SubmitRejected",
        );
      }
      if (finalType === "Throttled")
        return fail("submit_for_completion", `throttled, retry after ${node?.pollAfter}`);
      const receipt = (node?.receipt ?? {}) as { id?: string };
      receiptId = receipt.id ?? null;
      if (!receiptId) return fail("submit_for_completion", `unexpected node: ${finalType}`);
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    // ── 7. Poll receipt ───────────────────────────────────────────────────
    let orderId: string | null = null;
    try {
      lastStep = "poll_receipt";
      const s = Date.now();
      const POLL_QUERY = `
        query PollForReceipt($receiptId: ID!, $sessionToken: String!) {
          receipt(receiptId: $receiptId, sessionToken: $sessionToken) {
            id
            ... on ProcessedReceipt { orderIdentity { id } token }
            ... on FailedReceipt { processingError { code messageHtml } }
            ... on ActionRequiredReceipt { action { __typename } }
          }
        }
      `;
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`${graphqlUrl}?operationName=PollForReceipt`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": UA,
            cookie: cookieHeader(jar),
            "x-checkout-one-session-token": sessionToken!,
          },
          body: JSON.stringify({
            operationName: "PollForReceipt",
            query: POLL_QUERY,
            variables: { receiptId, sessionToken },
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          data?: { receipt?: Record<string, unknown> };
        };
        const r = j.data?.receipt as Record<string, unknown> | undefined;
        const t = r?.__typename as string | undefined;
        if (t === "ProcessedReceipt") {
          const ord = r?.orderIdentity as { id?: string } | undefined;
          orderId = ord?.id ?? null;
          break;
        }
        if (t === "FailedReceipt") {
          const err = r?.processingError as { code?: string; messageHtml?: string } | undefined;
          record(
            "poll_receipt",
            false,
            res.status,
            Date.now() - s,
            `${err?.code}: ${err?.messageHtml}`,
          );
          return fail("poll_receipt", `${err?.code ?? "FailedReceipt"}: ${err?.messageHtml ?? ""}`);
        }
        await new Promise((rr) => setTimeout(rr, 1500));
      }
      record("poll_receipt", !!orderId, null, Date.now() - s, orderId ?? "no order id (timeout)");
      if (!orderId) return fail("poll_receipt", "no orderId after 30s polling");
    } catch (e) {
      return fail(lastStep, (e as Error).message);
    }

    return {
      ok: true,
      taskId: data.taskId,
      checkoutUrl,
      orderId,
      receiptId,
      steps,
      elapsedMs: Date.now() - t0,
      dryRun: false,
    };
  });
