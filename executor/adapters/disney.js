/**
 * Disney Store AU adapter — SFCC + Akamai (Hyper) + reCAPTCHA Enterprise + Global-e 1696.
 *
 * Modes (task.disneyMode / mode):
 *   warm | edge     — Akamai cookie/sensor warm + minicart probe
 *   monitor         — sitemap / PDP availability
 *   atc | checkout  — warm → CSRF → ATC (needs recaptchaToken) → minibag → optional GE
 *   ge              — warm → GE handoff only (expects existing bag)
 *   pay | fake_decline — ATC → GE Checkout/v2 → issuer with fake PAN (decline lab)
 *
 * Constraints: do not touch kmart.js. GE mid 1696 parameterized (not Bandai 1925).
 * Fake-card decline is the pay pass signal — never default a live PAN.
 */

import {
  createDisneySession,
  resolveDisneyPid,
  resolveDisneyPdpUrl,
  DISNEY_GE_MID,
  DISNEY_ORIGIN,
  DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
} from "./disney-session.js";
import { warmDisneyAkamai, refreshDisneyAkamai } from "./disney-akamai.js";
import {
  fetchDisneyPdp,
  fetchDisneyMiniCart,
  generateDisneyCsrf,
  addDisneyToCart,
} from "./disney-cart.js";
import { runDisneyGeHandoff, fetchDisneyGeScriptLoader } from "./disney-ge.js";
import {
  DISNEY_FAKE_DECLINE_CARD,
  runDisneyGeHttpPay,
} from "./disney-ge-http.js";
import {
  capsolverKey,
  solveDisneyRecaptchaEnterprise,
} from "./disney-recaptcha.js";
import { hyperConfigured } from "../antibot.js";
import { resolveEgressIp } from "../ip-resolve.js";

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
      // Do not abort the whole Disney run on a single flaky proxy fetch.
      return { ok: false, note: row.note };
    }
  };
}

function normalizeMode(task) {
  const raw = String(task.disneyMode || task.mode || "checkout").toLowerCase();
  if (raw === "mon" || raw === "watch") return "monitor";
  if (raw === "warm" || raw === "edge" || raw === "edge_only") return "warm";
  if (raw === "atc" || raw === "cart") return "atc";
  if (raw === "ge" || raw === "globale" || raw === "ge_handoff") return "ge";
  if (raw === "pay" || raw === "ge_pay" || raw === "fake_decline") return "pay";
  return raw;
}

function wantsDisneyGePay(task, mode) {
  return (
    mode === "pay" ||
    task.disneyGePay === true ||
    task.fakeDecline === true ||
    (task.placeOrder === true && task.disneySkipPay !== true)
  );
}

function resolveDisneyPayCard(task) {
  const provided = task.card || task.paymentCard || null;
  const pan = String(provided?.number || "").replace(/\s+/g, "");
  // Live PAN only when placeOrder=true and a number was supplied.
  if (task.placeOrder === true && pan.length >= 12) return provided;
  return {
    ...DISNEY_FAKE_DECLINE_CARD,
    expMonth: provided?.expMonth || DISNEY_FAKE_DECLINE_CARD.expMonth,
    expYear: provided?.expYear || DISNEY_FAKE_DECLINE_CARD.expYear,
    cvv: provided?.cvv || DISNEY_FAKE_DECLINE_CARD.cvv,
    name: provided?.name || DISNEY_FAKE_DECLINE_CARD.name,
  };
}

/** Sticky ISP lines in resi.proxies use exit IP as host — prefer that over a
 * pre-warm ipify CONNECT (tls-client often 403s the next Disney CONNECT). */
function guessEgressFromProxy(proxy) {
  const host = String(proxy || "")
    .replace(/^https?:\/\//i, "")
    .split("@")
    .pop()
    ?.split(":")[0];
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host || "") ? host : null;
}

async function ensureDisneyEgressIp(task, ctx, tStep) {
  if (ctx.egressIp) return ctx.egressIp;
  const guessed = guessEgressFromProxy(task.proxy);
  if (guessed) {
    ctx.egressIp = guessed;
    await tStep("resolve_ip", async () => ({
      ok: true,
      note: `egress=${guessed} (proxy host — skip ipify preflight for TLS)`,
    }));
    return guessed;
  }
  await tStep("resolve_ip", async () => {
    const ip = await resolveEgressIp(ctx);
    ctx.egressIp = ip;
    return { ok: Boolean(ip), note: ip ? `egress=${ip}` : "egress unresolved" };
  });
  return ctx.egressIp;
}

async function runWarm(task, ctx, session, tStep, steps) {
  await ensureDisneyEgressIp(task, ctx, tStep);
  const warm = await warmDisneyAkamai(session, ctx, { tStep, egressIp: ctx.egressIp });
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
  await ensureDisneyEgressIp(task, ctx, tStep);
  const warm = await warmDisneyAkamai(session, ctx, { tStep, egressIp: ctx.egressIp });
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

async function runAtcCheckout(task, ctx, session, tStep, steps, mode = "checkout") {
  const wantPay = wantsDisneyGePay(task, mode);
  const dryRun = task.placeOrder !== true;
  await ensureDisneyEgressIp(task, ctx, tStep);

  const pdpUrl = resolveDisneyPdpUrl(task);
  const sitekeyEarly = task.recaptchaSitekey || DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY;
  // Overlap CapSolver with Akamai warm + PDP — biggest free speed win (~8s).
  const captchaPromise =
    !task.recaptchaToken &&
    !task.captchaToken &&
    task.skipRecaptcha !== true &&
    capsolverKey()
      ? solveDisneyRecaptchaEnterprise({
          pageUrl: pdpUrl,
          sitekey: sitekeyEarly,
          action: "AddToCart",
          proxyRaw: task.proxy || null,
          proxyless: task.capsolverProxyless !== false,
        })
      : null;

  const warm = await warmDisneyAkamai(session, ctx, { tStep, egressIp: ctx.egressIp });
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

  let pdp = await fetchDisneyPdp(session, pdpUrl, { tStep });
  if (!pdp.ok) {
    // Proxy flake after sensor — one more try before giving up on parse.
    pdp = await fetchDisneyPdp(session, pdpUrl, { tStep });
  }
  const pid = resolveDisneyPid(task) || pdp.pid || "050368983992";

  // PDP sensor refresh: skip when warm already solved (default). Opt-in via disneyPdpRefresh:true.
  const wantPdpRefresh =
    task.disneyPdpRefresh === true ||
    (task.disneyPdpRefresh !== false && warm.abckValid !== true);
  if (wantPdpRefresh) {
    await refreshDisneyAkamai(session, ctx, {
      tStep,
      pageUrl: pdpUrl,
      maxRounds: Number(task.disneyPdpSensorRounds ?? 1),
      egressIp: ctx.egressIp,
      label: "akamai_pdp",
    });
  } else {
    steps.push({
      step: "akamai_pdp",
      ok: true,
      note: "skipped — _abck already valid after warm (speed)",
    });
  }

  const sitekey =
    task.recaptchaSitekey || pdp.recaptchaSitekey || DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY;
  let recaptchaToken = task.recaptchaToken || task.captchaToken || null;
  let recaptchaMeta = null;
  if (captchaPromise) {
    recaptchaMeta = await tStep("recaptcha_capsolver", async () => {
      const solved = await captchaPromise;
      return {
        ok: solved.ok,
        note: solved.ok
          ? `CapSolver ${solved.via} ${solved.elapsedMs}ms (overlapped warm/pdp)`
          : solved.error,
        token: solved.token || null,
        via: solved.via || null,
      };
    });
    if (recaptchaMeta.ok) recaptchaToken = recaptchaMeta.token;
  }

  const atcOpts = {
    tStep,
    pid,
    quantity: Number(task.quantity || task.qty || 1),
    pdpUrl,
    addToCartUrl: pdp.addToCartUrl,
    recaptchaSitekey: sitekey,
    recaptchaToken,
    recaptchaEnterpriseUrl: pdp.recaptchaEnterpriseUrl,
    skipRecaptcha: task.skipRecaptcha === true,
    // SFCC currently returns result:false even for native tokens — don't hard-gate.
    skipRecaptchaVerify: task.skipRecaptchaVerify !== false,
    requireRecaptchaVerify: task.requireRecaptchaVerify === true,
    // Pay path: trust ATC HTTP + skip mini RTT unless caller wants bag proof.
    acceptAtcWithoutMini: task.acceptAtcWithoutMini === true || wantPay,
    alwaysCheckMini: task.alwaysCheckMini === true ? true : wantPay ? false : undefined,
  };

  let atc = await addDisneyToCart(session, ctx, atcOpts);

  // Fail-path only: one sensor refresh + ATC retry on Akamai deny (keeps win path fast).
  if (!atc.ok && atc.atc?.denied && task.atcRetry !== false) {
    await refreshDisneyAkamai(session, ctx, {
      tStep,
      pageUrl: pdpUrl,
      maxRounds: 1,
      egressIp: ctx.egressIp,
      label: "akamai_atc_retry",
    });
    atc = await addDisneyToCart(session, ctx, {
      ...atcOpts,
      csrf: atc.csrf || undefined,
    });
    steps.push({
      step: "atc_retry",
      ok: Boolean(atc.ok),
      note: atc.ok ? "ATC ok after sensor refresh retry" : `ATC retry still fail: ${atc.note}`,
    });
  }

  let ge = null;
  const wantGe =
    atc.ok &&
    (wantPay ||
      task.disneyGe === true ||
      task.geHandoff === true ||
      task.disneyMode === "checkout" ||
      mode === "checkout" ||
      (!task.disneyMode && task.mode !== "atc"));

  if (wantGe) {
    ge = await runDisneyGeHandoff(session, ctx, {
      tStep,
      referer: `${session.state.origin}/bag`,
      customerEmail: task.email || task.profile?.email,
      placeOrder: false, // pay is a separate HTTP issuer step
      // Pay: skip loader + Checkout/v2 here — single v2 fetch inside GE pay.
      skipLoader: wantPay && task.disneyGeLoader !== true,
      skipCheckoutV2: wantPay,
      includeHtml: false,
    });
  }

  let pay = null;
  if (wantPay && ge?.checkoutGuid) {
    const card = resolveDisneyPayCard(task);
    // iovation is slow — opt-in via riskHydrate:true, or auto for live placeOrder.
    const riskHydrate =
      task.noPage === true || process.env.DISNEY_NO_PAGE === "1"
        ? false
        : task.riskHydrate === true ||
          (task.placeOrder === true && task.riskHydrate !== false);
    pay = await runDisneyGeHttpPay({
      ctx,
      tStep,
      steps,
      checkoutGuid: ge.checkoutGuid,
      cartToken: ge.checkoutGuid,
      card,
      guest: task.guest || task.profile || {
        email: task.email || "disney.decline.test@example.com",
      },
      proxyRaw: task.proxy,
      referer: `${session.state.origin}/bag`,
      userAgent: session.state.userAgent,
      allowDirectCheckout: task.allowDirectCheckout !== false,
      riskHydrate,
      noPage: !riskHydrate,
      forceIssuer: task.forceIssuer !== false,
      stopBeforeIssuer: task.stopBeforeIssuer === true,
      createTransaction: task.createTransaction !== false,
      issuerTimeoutMs: Number(task.issuerTimeoutMs) || 180_000,
    });
  }

  const declineOk = Boolean(pay?.decline || /decline|fraud_refused/i.test(String(pay?.paymentStatus || "")));
  const ok = wantPay
    ? Boolean(atc.ok && ge?.ok && pay?.ok && (declineOk || task.placeOrder === true))
    : Boolean(atc.ok && (!wantGe || ge?.ok || task.acceptAtcWithoutGe === true));

  return {
    ok,
    steps,
    dryRun,
    placeOrder: task.placeOrder === true,
    checkoutStage: pay?.checkoutStage || (ge?.ok ? "ge_checkout" : atc.ok ? "cart" : "pre_cart"),
    finalUrl: pay?.checkoutV2Url || ge?.checkoutV2Url || pdpUrl,
    cookies: ctx.jar?.dump?.() ?? {},
    pid,
    title: pdp.title || null,
    note: pay?.note || ge?.note || atc.note,
    warm,
    pdp,
    atc,
    ge,
    pay,
    paymentStatus: pay?.paymentStatus || null,
    decline: declineOk,
    transactionId: pay?.transactionId || null,
    cartToken: pay?.cartToken || ge?.checkoutGuid || null,
    fakeCard: pay?.fakeCard ?? null,
    fraudFlags: pay?.fraudFlags || null,
    possibleFraudDetected: pay?.possibleFraudDetected ?? null,
    isSameCartToken: pay?.isSameCartToken ?? null,
    recaptcha: recaptchaMeta,
    merchantId: DISNEY_GE_MID,
    encodedMerchantId: pay?.encodedMerchantId || ge?.encodedMerchantId || null,
    needsRecaptcha: atc.needsRecaptcha || false,
    recaptchaSitekey: atc.recaptchaSitekey || DISNEY_RECAPTCHA_ENTERPRISE_SITEKEY,
    capsolverConfigured: Boolean(capsolverKey()),
    stoppedBeforePay: !wantPay || Boolean(pay?.stoppedBeforePay),
    failedStep: atc.ok
      ? !ge?.ok && wantGe
        ? "ge_handoff"
        : wantPay && !pay?.ok
          ? pay?.failedStep || "ge_issuer"
          : wantPay && pay?.ok && !declineOk && task.placeOrder !== true
            ? "awaiting_decline_signal"
            : null
      : atc.needsRecaptcha
        ? "recaptcha_enterprise"
        : atc.atc?.denied
          ? "akamai_atc"
          : "cart_add_product",
  };
}

async function runGeOnly(task, ctx, session, tStep, steps) {
  await ensureDisneyEgressIp(task, ctx, tStep);
  const warm = await warmDisneyAkamai(session, ctx, { tStep, egressIp: ctx.egressIp });
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
      note: `site=DisneyStoreAUNZ locale=en_AU geMid=${DISNEY_GE_MID} mode=${mode} transport=${ctx.dispatcher?.transport || "?"}`,
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
    // atc + checkout + pay/fake_decline (+ default)
    return runAtcCheckout(task, ctx, session, tStep, steps, mode);
  },
};

export default disneyAdapter;
