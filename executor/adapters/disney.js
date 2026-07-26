/**
 * Disney Store AU adapter — SFCC + Akamai (Hyper) + reCAPTCHA Enterprise + Global-e 1696.
 *
 * Modes (task.disneyMode / mode):
 *   warm | edge     — Akamai cookie/sensor warm + minicart probe
 *   monitor         — sitemap / PDP availability
 *   atc | checkout  — warm → CSRF → ATC (needs recaptchaToken) → minibag → optional GE
 *   ge              — warm → GE handoff only (expects existing bag)
 *
 * Constraints: do not touch kmart.js. GE mid 1696 parameterized (not Bandai 1925).
 * HAR still needed for issuer encoded-merchant + empty-bag GetCartToken edge cases.
 */

import {
  createDisneySession,
  resolveDisneyPid,
  resolveDisneyPdpUrl,
  DISNEY_GE_MID,
  DISNEY_ORIGIN,
  DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
} from "./disney-session.js";
import { warmDisneyAkamai } from "./disney-akamai.js";
import {
  fetchDisneyPdp,
  fetchDisneyMiniCart,
  generateDisneyCsrf,
  addDisneyToCart,
} from "./disney-cart.js";
import { runDisneyGeHandoff, fetchDisneyGeScriptLoader } from "./disney-ge.js";
import {
  capsolverKey,
  solveDisneyRecaptchaEnterprise,
} from "./disney-recaptcha.js";
import { hyperConfigured } from "../antibot.js";

function makeStep(steps, ctx) {
  return async (name, fn) => {
    const s0 = Date.now();
    try {
      const out = await fn();
      const row = {
        step: name,
        ok: out?.ok !== false,
        status: out?.status ?? null,
        ms: Date.now() - s0,
        note: out?.note ?? null,
      };
      steps.push(row);
      ctx.onProgress?.(name, out?.note || null);
      return out;
    } catch (e) {
      const row = {
        step: name,
        ok: false,
        status: null,
        ms: Date.now() - s0,
        note: e?.message || String(e),
      };
      steps.push(row);
      throw e;
    }
  };
}

function normalizeMode(task) {
  const raw = String(task.disneyMode || task.mode || "checkout").toLowerCase();
  if (raw === "mon" || raw === "watch") return "monitor";
  if (raw === "warm" || raw === "edge" || raw === "edge_only") return "warm";
  if (raw === "atc" || raw === "cart") return "atc";
  if (raw === "ge" || raw === "globale" || raw === "ge_handoff") return "ge";
  return raw;
}

async function runWarm(task, ctx, session, tStep, steps) {
  const warm = await warmDisneyAkamai(session, ctx, { tStep });
  let mini = null;
  if (warm.ok || task.forceMiniCart) {
    mini = await fetchDisneyMiniCart(session, { tStep });
  }
  let loader = null;
  if (task.disneyGeProbe || task.geProbe) {
    loader = await fetchDisneyGeScriptLoader(session, { tStep });
  }
  return {
    ok: warm.ok,
    steps,
    dryRun: true,
    checkoutStage: "pre_cart",
    finalUrl: `${session.state.origin}/`,
    cookies: ctx.jar?.dump?.() ?? {},
    note: warm.note,
    warm,
    mini,
    geLoader: loader,
    hyperConfigured: hyperConfigured(),
    merchantId: DISNEY_GE_MID,
  };
}

async function runMonitor(task, ctx, session, tStep, steps) {
  const warm = await warmDisneyAkamai(session, ctx, { tStep });
  const pdpUrl = resolveDisneyPdpUrl({ ...task, useDefaultPdp: true });
  const pid = resolveDisneyPid(task) || null;

  // Sitemap probe (soft — no Akamai POST).
  let sitemap = null;
  if (task.disneySitemap !== false) {
    sitemap = await tStep("sitemap", async () => {
      const res = await session.get(session.urls.sitemap0, {
        referer: `${session.state.origin}/`,
      });
      const locs = [...String(res.text || "").matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]);
      const hit = pid ? locs.find((u) => u.includes(pid)) : null;
      return {
        ok: res.ok,
        status: res.status,
        note: res.ok
          ? `sitemap locs=${locs.length}${hit ? ` hit=${hit}` : pid ? " pid_not_in_sample" : ""}`
          : `sitemap ${res.status}`,
        locCount: locs.length,
        hit: hit || null,
      };
    });
  }

  const pdp = await fetchDisneyPdp(session, pdpUrl, { tStep });

  return {
    ok: Boolean(pdp.ok || sitemap?.ok),
    steps,
    monitor: true,
    dryRun: true,
    checkoutStage: "monitor",
    finalUrl: pdpUrl,
    cookies: ctx.jar?.dump?.() ?? {},
    pid: pdp.pid || pid,
    title: pdp.title || null,
    purchaseAvailable: pdp.available,
    note: pdp.note || sitemap?.note || warm.note,
    warm,
    sitemap,
    pdp,
    hyperConfigured: hyperConfigured(),
    failedStep: pdp.ok ? null : pdp.denied ? "akamai_pdp" : "pdp_fetch",
  };
}

async function runAtcCheckout(task, ctx, session, tStep, steps) {
  const dryRun = task.placeOrder !== true;
  const warm = await warmDisneyAkamai(session, ctx, { tStep });
  if (!warm.ok && task.allowUnwarmed !== true) {
    return {
      ok: false,
      steps,
      dryRun,
      checkoutStage: "pre_cart",
      finalUrl: `${session.state.origin}/`,
      cookies: ctx.jar?.dump?.() ?? {},
      note: warm.note || "Akamai warm failed",
      failedStep: hyperConfigured() ? "akamai_warm" : "hyper_api_key",
      warm,
      merchantId: DISNEY_GE_MID,
    };
  }

  const pdpUrl = resolveDisneyPdpUrl(task);
  const pdp = await fetchDisneyPdp(session, pdpUrl, { tStep });
  const pid = resolveDisneyPid(task) || pdp.pid;
  if (!pid) {
    return {
      ok: false,
      steps,
      dryRun,
      checkoutStage: "pre_cart",
      finalUrl: pdpUrl,
      cookies: ctx.jar?.dump?.() ?? {},
      note: "pid / PDP required",
      failedStep: "resolve_pid",
      pdp,
      warm,
    };
  }

  const sitekey =
    task.recaptchaSitekey || pdp.recaptchaSitekey || DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY;
  let recaptchaToken = task.recaptchaToken || task.captchaToken || null;
  let recaptchaMeta = null;
  if (!recaptchaToken && task.skipRecaptcha !== true && capsolverKey()) {
    recaptchaMeta = await tStep("recaptcha_capsolver", async () => {
      const solved = await solveDisneyRecaptchaEnterprise({
        pageUrl: pdpUrl,
        sitekey,
        action: "AddToCart",
        proxyRaw: task.proxy || null,
        proxyless: task.capsolverProxyless === true,
      });
      return {
        ok: solved.ok,
        note: solved.ok
          ? `CapSolver ${solved.via} ${solved.elapsedMs}ms`
          : solved.error,
        token: solved.token || null,
        via: solved.via || null,
      };
    });
    if (recaptchaMeta.ok) recaptchaToken = recaptchaMeta.token;
  }

  const atc = await addDisneyToCart(session, ctx, {
    tStep,
    pid,
    quantity: Number(task.quantity || task.qty || 1),
    pdpUrl,
    addToCartUrl: pdp.addToCartUrl,
    recaptchaSitekey: sitekey,
    recaptchaToken,
    recaptchaEnterpriseUrl: pdp.recaptchaEnterpriseUrl,
    skipRecaptcha: task.skipRecaptcha === true,
    skipRecaptchaVerify: task.skipRecaptchaVerify === true,
    requireRecaptchaVerify: task.requireRecaptchaVerify === true,
    acceptAtcWithoutMini: task.acceptAtcWithoutMini === true,
  });

  let ge = null;
  const wantGe =
    atc.ok &&
    (task.disneyGe === true ||
      task.geHandoff === true ||
      task.disneyMode === "checkout" ||
      (!task.disneyMode && task.mode !== "atc"));

  if (wantGe) {
    ge = await runDisneyGeHandoff(session, ctx, {
      tStep,
      referer: `${session.state.origin}/bag`,
      customerEmail: task.email || task.profile?.email,
      placeOrder: task.placeOrder === true,
    });
  }

  const ok = Boolean(atc.ok);
  return {
    ok,
    steps,
    dryRun,
    placeOrder: task.placeOrder === true,
    checkoutStage: ge?.cartToken || ge?.gem?.cartToken ? "ge_checkout" : atc.ok ? "cart" : "pre_cart",
    finalUrl: pdpUrl,
    cookies: ctx.jar?.dump?.() ?? {},
    pid,
    title: pdp.title || null,
    note: ge?.note || atc.note,
    warm,
    pdp,
    atc,
    ge,
    recaptcha: recaptchaMeta,
    merchantId: DISNEY_GE_MID,
    needsRecaptcha: atc.needsRecaptcha || false,
    recaptchaSitekey: atc.recaptchaSitekey || DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
    capsolverConfigured: Boolean(capsolverKey()),
    stoppedBeforePay: true,
    failedStep: ok
      ? null
      : atc.needsRecaptcha
        ? "recaptcha_enterprise"
        : atc.atc?.denied
          ? "akamai_atc"
          : "cart_add_product",
  };
}

async function runGeOnly(task, ctx, session, tStep, steps) {
  const warm = await warmDisneyAkamai(session, ctx, { tStep });
  const ge = await runDisneyGeHandoff(session, ctx, {
    tStep,
    referer: `${session.state.origin}/bag`,
    customerEmail: task.email || task.profile?.email,
    placeOrder: false,
  });
  return {
    ok: ge.ok,
    steps,
    dryRun: true,
    checkoutStage: ge.checkoutStage,
    finalUrl: `${session.state.origin}/bag`,
    cookies: ctx.jar?.dump?.() ?? {},
    note: ge.note,
    warm,
    ge,
    merchantId: DISNEY_GE_MID,
    stoppedBeforePay: true,
    failedStep: ge.ok ? null : "ge_handoff",
  };
}

export const disneyAdapter = {
  id: "disney",
  matches(host) {
    const h = String(host || "").toLowerCase().replace(/^www\./, "");
    return (
      h === "disneystore.com.au" ||
      h === "shopdisney.com.au" ||
      h.endsWith(".disneystore.com.au")
    );
  },

  async run(task, ctx) {
    const steps = ctx.steps || (ctx.steps = []);
    const tStep = makeStep(steps, ctx);
    const mode = normalizeMode(task);

    // Normalize store URL so pickAdapter + labs work with bare host tasks.
    if (!task.storeUrl) {
      task.storeUrl = task.pdpUrl || DISNEY_ORIGIN;
    }

    const session = createDisneySession(ctx, {});
    steps.push({
      step: "disney_region",
      ok: true,
      note: `site=DisneyStoreAUNZ locale=en_AU geMid=${DISNEY_GE_MID} mode=${mode}`,
    });

    if (mode === "warm") {
      return runWarm(task, ctx, session, tStep, steps);
    }
    if (mode === "monitor") {
      return runMonitor(task, ctx, session, tStep, steps);
    }
    if (mode === "ge") {
      return runGeOnly(task, ctx, session, tStep, steps);
    }
    // atc + checkout (+ default)
    return runAtcCheckout(task, ctx, session, tStep, steps);
  },
};

export default disneyAdapter;
