import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeDispatcher, createJar } from "../http.js";
import { detectChallenge, pickProvider, solveChallenge } from "./shopify-captcha.js";
import { runShopify } from "./shopify.js";

// Fast solver polling for tests.
process.env.CAPTCHA_FIRST_POLL_MS = "20";
process.env.CAPTCHA_POLL_MS = "20";

function fakeRes(status, { body = "", setCookie = [], headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 400,
    headers: {
      get: (n) => headers[n.toLowerCase()] ?? null,
      getSetCookie: () => setCookie,
    },
  };
}

// ── Detection ───────────────────────────────────────────────────────────────

test("detectChallenge: a normal 200 checkout page is NOT a challenge", () => {
  const html =
    '<html><head><meta name="serialized-session-token" content="x"/>' +
    '<script src="https://www.google.com/recaptcha/api.js"></script></head><body>Checkout</body></html>';
  assert.equal(detectChallenge(fakeRes(200), html).type, "none");
});

test("detectChallenge: Cloudflare interstitial (403 + markers + turnstile) → cloudflare_waf with sitekey", () => {
  const html =
    '<html><head><title>Just a moment...</title></head><body>' +
    '<div class="cf-turnstile" data-sitekey="0xAAAAtestkey"></div>' +
    '<script>window._cf_chl_opt={}</script></body></html>';
  const c = detectChallenge(fakeRes(403), html);
  assert.equal(c.type, "cloudflare_waf");
  assert.equal(c.siteKey, "0xAAAAtestkey");
});

test("detectChallenge: cf-mitigated header → cloudflare_waf even on 200", () => {
  assert.equal(detectChallenge(fakeRes(200, { headers: { "cf-mitigated": "challenge" } }), "").type, "cloudflare_waf");
});

test("detectChallenge: blocking 403 reCAPTCHA v3 render → recaptcha_v3 + sitekey", () => {
  const html =
    '<script src="https://www.google.com/recaptcha/enterprise.js?render=6LdTESTkeyTESTkeyTESTkeyTESTkey01"></script>';
  const c = detectChallenge(fakeRes(403), html);
  assert.equal(c.type, "recaptcha_v3");
  assert.equal(c.enterprise, true);
  assert.equal(c.siteKey, "6LdTESTkeyTESTkeyTESTkeyTESTkey01");
});

test("detectChallenge: blocking 429 hCaptcha → hcaptcha", () => {
  const html = '<div class="h-captcha" data-sitekey="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"></div><script src="https://hcaptcha.com/1/api.js"></script>';
  const c = detectChallenge(fakeRes(429), html);
  assert.equal(c.type, "hcaptcha");
  assert.equal(c.siteKey, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("detectChallenge: DataDome block → datadome; Akamai block → akamai", () => {
  assert.equal(detectChallenge(fakeRes(403), "blocked by geo.captcha-delivery.com").type, "datadome");
  assert.equal(detectChallenge(fakeRes(403), "Access Denied _abck bm_sz").type, "akamai");
});

// ── Provider routing ──────────────────────────────────────────────────────

test("pickProvider routes by type and honours configured keys / overrides", () => {
  const save = { ...process.env };
  delete process.env.UNCAPTCHA_API_KEY;
  delete process.env.CAPSOLVER_API_KEY;
  delete process.env.TWOCAPTCHA_API_KEY;
  delete process.env.HYPER_API_KEY;

  assert.equal(pickProvider("turnstile", "auto"), null); // nothing configured

  process.env.TWOCAPTCHA_API_KEY = "k";
  assert.equal(pickProvider("recaptcha_v2", "auto"), "2captcha");
  assert.equal(pickProvider("turnstile", "auto"), "2captcha"); // only one configured

  process.env.UNCAPTCHA_API_KEY = "k";
  assert.equal(pickProvider("turnstile", "auto"), "uncaptcha"); // preferred for turnstile

  // Override forces a provider only if it is capable + keyed.
  assert.equal(pickProvider("turnstile", "capsolver"), null); // capsolver not keyed
  process.env.CAPSOLVER_API_KEY = "k";
  assert.equal(pickProvider("turnstile", "capsolver"), "capsolver");
  assert.equal(pickProvider("recaptcha_v2", "uncaptcha"), null); // uncaptcha can't do recaptcha

  Object.assign(process.env, save);
  for (const k of ["UNCAPTCHA_API_KEY", "CAPSOLVER_API_KEY", "TWOCAPTCHA_API_KEY", "HYPER_API_KEY"])
    if (!(k in save)) delete process.env[k];
});

// ── Solver HTTP (mock provider servers via *_BASE overrides) ────────────────

function startJsonServer(handler) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        /* ignore */
      }
      const out = handler(req, parsed);
      res.writeHead(out.code ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("solveChallenge: capsolver AntiCloudflareTask returns cf_clearance + userAgent", async () => {
  const { server, port } = await startJsonServer((req, body) => {
    if (req.url === "/createTask") {
      assert.equal(body.task.type, "AntiCloudflareTask");
      return { body: { errorId: 0, taskId: "T1" } };
    }
    return {
      body: {
        errorId: 0,
        status: "ready",
        solution: { token: "cftok", cookies: { cf_clearance: "CLEAR123" }, userAgent: "UA/solver" },
      },
    };
  });
  const save = process.env.CAPSOLVER_API_KEY;
  const saveBase = process.env.CAPSOLVER_BASE;
  process.env.CAPSOLVER_API_KEY = "k";
  process.env.CAPSOLVER_BASE = `http://127.0.0.1:${port}`;
  try {
    const out = await solveChallenge(
      { type: "cloudflare_waf", siteKey: null },
      { pageUrl: "https://shop.example/checkouts/cn/x", provider: "capsolver" },
    );
    assert.equal(out.ok, true);
    assert.equal(out.provider, "capsolver");
    assert.deepEqual(out.cookies, { cf_clearance: "CLEAR123" });
    assert.equal(out.userAgent, "UA/solver");
  } finally {
    process.env.CAPSOLVER_API_KEY = save;
    if (saveBase === undefined) delete process.env.CAPSOLVER_BASE;
    else process.env.CAPSOLVER_BASE = saveBase;
    await new Promise((r) => server.close(r));
  }
});

test("solveChallenge: uncaptcha turnstile returns a token", async () => {
  const { server, port } = await startJsonServer((req, body) => {
    assert.equal(req.url, "/v1/task/execute");
    assert.equal(body.task_type, "turnstile");
    assert.equal(body.task_data.sitekey, "0xKEY");
    return { body: { success: true, data: { solution: { token: "ts-token" } } } };
  });
  const save = process.env.UNCAPTCHA_API_KEY;
  const saveBase = process.env.UNCAPTCHA_BASE;
  process.env.UNCAPTCHA_API_KEY = "k";
  process.env.UNCAPTCHA_BASE = `http://127.0.0.1:${port}`;
  try {
    const out = await solveChallenge(
      { type: "turnstile", siteKey: "0xKEY" },
      { pageUrl: "https://shop.example/", provider: "uncaptcha" },
    );
    assert.equal(out.ok, true);
    assert.equal(out.token, "ts-token");
    assert.equal(out.provider, "uncaptcha");
  } finally {
    process.env.UNCAPTCHA_API_KEY = save;
    if (saveBase === undefined) delete process.env.UNCAPTCHA_BASE;
    else process.env.UNCAPTCHA_BASE = saveBase;
    await new Promise((r) => server.close(r));
  }
});

// ── End-to-end: ATC through a Cloudflare interstitial, cleared by a solver ──

function startCfGatedStore() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const cookie = req.headers.cookie || "";
    const cleared = /cf_clearance=CLEAR123/.test(cookie);
    const json = (code, obj, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const html = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8", server: "cloudflare", ...headers });
      res.end(body);
    };
    if (u.pathname === "/") return html(200, "<html><body>home</body></html>", { "set-cookie": "cart_currency=USD; path=/" });
    if (req.method === "POST" && u.pathname === "/cart/add.js")
      return json(200, { item_count: 1 }, { "set-cookie": "cart=TOK; path=/" });
    if (u.pathname === "/cart.js")
      return json(200, { token: "TOK", item_count: 1, total_price: 1999, currency: "USD" });
    if (req.method === "POST" && u.pathname === "/cart") {
      res.writeHead(302, { location: `http://${req.headers.host}/checkouts/cn/TOK?_r=1` });
      return res.end();
    }
    if (/^\/checkouts\/cn\//.test(u.pathname)) {
      if (!cleared) {
        // Cloudflare interstitial until cf_clearance is presented.
        return html(
          403,
          '<html><head><title>Just a moment...</title></head><body>' +
            '<div class="cf-turnstile" data-sitekey="0xWAFKEY"></div><script>window._cf_chl_opt={}</script></body></html>',
          { "cf-mitigated": "challenge" },
        );
      }
      return html(200, '<html><head><meta name="serialized-session-token" content="x"/></head><body>Checkout</body></html>');
    }
    res.writeHead(404);
    res.end("nf");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("runShopify: clears a Cloudflare interstitial via the solver and reaches checkout_ready", async () => {
  const store = await startCfGatedStore();
  const solver = await startJsonServer((req) => {
    if (req.url === "/createTask") return { body: { errorId: 0, taskId: "T" } };
    return {
      body: {
        errorId: 0,
        status: "ready",
        solution: { token: "cftok", cookies: { cf_clearance: "CLEAR123" }, userAgent: "UA/solver" },
      },
    };
  });
  const save = { k: process.env.CAPSOLVER_API_KEY, b: process.env.CAPSOLVER_BASE };
  process.env.CAPSOLVER_API_KEY = "k";
  process.env.CAPSOLVER_BASE = `http://127.0.0.1:${solver.port}`;

  const dispatcher = makeDispatcher(null, { forceUndici: true });
  const jar = createJar();
  const ctx = { dispatcher, jar, onProgress: () => {} };
  try {
    const out = await runShopify(
      {
        storeUrl: store.base,
        taskId: "cf1",
        variantId: 1001,
        qty: 1,
        proxy: "http://user:pass@127.0.0.1:1", // passed to solver (mocked)
        captchaProvider: "capsolver",
      },
      ctx,
    );
    assert.equal(out.ok, true);
    assert.equal(out.checkoutStage, "checkout_ready");
    assert.equal(out.shopify.reachedCheckout, true);
    assert.equal(jar.get("cf_clearance"), "CLEAR123");
    assert.ok(out.shopify.captcha.solved.some((s) => s.type === "cloudflare_waf"));
    const names = out.steps.map((s) => s.step);
    assert.ok(names.includes("captcha_detect"));
    assert.ok(names.includes("captcha_solve"));
  } finally {
    process.env.CAPSOLVER_API_KEY = save.k;
    if (save.b === undefined) delete process.env.CAPSOLVER_BASE;
    else process.env.CAPSOLVER_BASE = save.b;
    try {
      await dispatcher.close?.();
    } catch {
      /* ignore */
    }
    await new Promise((r) => store.server.close(r));
    await new Promise((r) => solver.server.close(r));
  }
});
