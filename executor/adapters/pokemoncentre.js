// Pokémon Centre (TPCI) adapter — Incapsula + DataDome + Cortex + Global-e.
// Completely separate from Kmart (Akamai) and Bandai (F5). Shared Hyper DD/Incapsula
// live in antibot.js; CapSolver hCaptcha is opt-in for drop windows.
//
// Modes (task.pcMode / pokemoncentreMode):
//   monitor   — edge warm → PDP / soft availability (default dry)
//   checkout  — warm → Cortex ATC (HAR-shaped) → /intl-checkout → optional GE pay
//   edge      — warm only (Incapsula + DD probe)
//   har_probe — warm + Cortex path probe (for HAR day)
//
// Transport: prefer tls-worker (chrome_131) for DataDome BFF trust; undici often
// escalates interstitial → view=captcha.
// GE Pay: HTTP ONLY (`pokemoncentre-ge-http.js`) — Bandai Fast playbook
// (GetCartToken→riskHydrate→handleaction→save→issuer). No Playwright pay /
// Safe cart-hold (PC carts do not hold). Browser = riskHydrate mint or HAR capture.
// Mid 1634 — never Bandai 1925.

import {
  warmPokemonCentre,
  fetchWithEdgeClear,
  clearDataDome,
  postDataDomeTags,
} from "./pokemoncentre-edge.js";
import {
  createPcSession,
  resolvePcLocale,
  resolveSku,
  parseProductUrl,
  localeUsesGlobalE,
  pcBaseFor,
  PC_ORIGIN,
} from "./pokemoncentre-session.js";
import {
  probeCortex,
  attemptGuestAtc,
  parsePdpAvailability,
  getPublicToken,
  getGlobaleM2mToken,
  cartGuidFromCartData,
  cortexApiHeaders,
  PC_API_BASE,
} from "./pokemoncentre-cortex.js";
import {
  extractHcaptchaSitekey,
  looksLikeHcaptcha,
  solveHcaptcha,
  capsolverKey,
} from "./pokemoncentre-hcaptcha.js";
import { runGlobalEPayHttp, PC_GLOBALE_MID } from "./pokemoncentre-ge-http.js";
import { looksLikeDataDomeBlock, hyperConfigured } from "../antibot.js";

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
  const raw = String(task.pcMode || task.pokemoncentreMode || task.mode || "checkout").toLowerCase();
  if (raw === "mon" || raw === "watch") return "monitor";
  if (raw === "warm" || raw === "edge_only") return "edge";
  if (raw === "probe" || raw === "har") return "har_probe";
  return raw;
}

async function maybeSolveHcaptcha(session, ctx, task, html, pageUrl, tStep) {
  if (!looksLikeHcaptcha(html) && !task.forceHcaptcha) return null;
  const sitekey = task.hcaptchaSitekey || extractHcaptchaSitekey(html);
  if (!sitekey) {
    return { ok: false, note: "hCaptcha detected but sitekey missing" };
  }
  if (!capsolverKey()) {
    return { ok: false, note: "hCaptcha needs CAPSOLVER_API_KEY (Settings)" };
  }
  return tStep("hcaptcha_capsolver", async () => {
    const solved = await solveHcaptcha({
      pageUrl,
      sitekey,
      proxyRaw: task.proxy || ctx.dispatcher?.proxy || null,
      userAgent: session.state.userAgent,
      rqdata: task.hcaptchaRqdata || null,
    });
    return {
      ok: solved.ok,
      note: solved.ok ? `hCaptcha token ${String(solved.token).slice(0, 16)}…` : solved.error,
      token: solved.token || null,
    };
  });
}

async function runEdge(task, ctx, session, tStep, steps) {
  const warm = await warmPokemonCentre(session, ctx, { tStep });
  return {
    ok: warm.ok,
    steps,
    dryRun: true,
    checkoutStage: "pre_cart",
    finalUrl: `${session.state.base}/`,
    cookies: ctx.jar?.dump?.() ?? {},
    note: warm.note,
    edge: warm,
    hyperConfigured: hyperConfigured(),
    locale: session.state.locale,
  };
}

async function runMonitor(task, ctx, session, tStep, steps) {
  const warm = await warmPokemonCentre(session, ctx, { tStep });
  if (!warm.ok) {
    return {
      ok: false,
      steps,
      monitor: true,
      dryRun: true,
      checkoutStage: "pre_cart",
      finalUrl: `${session.state.base}/`,
      cookies: ctx.jar?.dump?.() ?? {},
      note: warm.note || "edge warm failed",
      failedStep: warm.datadome?.isIpBanned ? "datadome_ip_ban" : "edge_warm",
    };
  }

  const sku = resolveSku(task);
  const parsed = parseProductUrl(task.pdpUrl || task.storeUrl || "");
  const productUrl =
    parsed?.productUrl ||
    (sku ? `${session.state.base}/product/${sku}` : null) ||
    `${session.state.base}/`;

  if (!sku && !parsed?.sku) {
    // Keyword-only monitor: just confirm edge + home title.
    return {
      ok: true,
      steps,
      monitor: true,
      dryRun: true,
      checkoutStage: "monitor",
      finalUrl: productUrl,
      cookies: ctx.jar?.dump?.() ?? {},
      note: `edge clear locale=${session.state.locale} — provide PDP URL/SKU for stock parse`,
      locale: session.state.locale,
    };
  }

  const pdp = await tStep("pdp_fetch", async () => {
    const got = await fetchWithEdgeClear(session, ctx, productUrl, { tStep });
    if (got.isIpBanned) {
      return { ok: false, note: got.note, isIpBanned: true, status: got.status };
    }
    const avail = parsePdpAvailability(got.html);
    const hc = await maybeSolveHcaptcha(session, ctx, task, got.html, productUrl, tStep);
    return {
      ok: got.ok,
      status: got.status,
      note: got.ok
        ? `${avail.note} title=${avail.title || "?"} avail=${avail.available}`
        : got.stillBlocked
          ? "pdp still blocked after edge clear"
          : `pdp ${got.status}`,
      avail,
      hcaptcha: hc,
      htmlBytes: got.html?.length || 0,
    };
  });

  return {
    ok: pdp.ok,
    steps,
    monitor: true,
    dryRun: true,
    checkoutStage: "monitor",
    finalUrl: productUrl,
    cookies: ctx.jar?.dump?.() ?? {},
    sku: sku || parsed?.sku,
    title: pdp.avail?.title || null,
    purchaseAvailable: pdp.avail?.available,
    note: pdp.note,
    locale: session.state.locale,
  };
}

async function runHarProbe(task, ctx, session, tStep, steps) {
  const warm = await warmPokemonCentre(session, ctx, { tStep });
  const sku = resolveSku(task);
  const auth = warm.ok
    ? await tStep("cortex_auth", () => getPublicToken(session, ctx, { locale: session.state.locale }))
    : { ok: false, note: "skipped — edge not clear" };
  const probes = await tStep("cortex_probe", async () => {
    const rows = await probeCortex(session, { sku, task });
    const anyOk = rows.some((r) => r.ok);
    return {
      ok: warm.ok && auth.ok && anyOk,
      note: rows.map((r) => `${r.name}:${r.status || "?"}`).join(" "),
      rows,
    };
  });
  return {
    ok: Boolean(warm.ok && auth.ok),
    steps,
    dryRun: true,
    checkoutStage: "pre_cart",
    finalUrl: `${session.state.base}/`,
    cookies: ctx.jar?.dump?.() ?? {},
    cortexAuth: auth.ok,
    cortexProbe: probes.rows,
    note: `warm=${warm.ok} auth=${auth.ok} ${probes.note}`,
    locale: session.state.locale,
    needsHar: false,
  };
}

async function runCheckout(task, ctx, session, tStep, steps) {
  const dryRun = task.placeOrder !== true;
  const sku = resolveSku(task);
  if (!sku) {
    return {
      ok: false,
      steps,
      dryRun,
      checkoutStage: "pre_cart",
      failedStep: "sku_missing",
      note: "Pokémon Centre needs PDP URL or sku (…/product/{sku}/…)",
      finalUrl: `${session.state.base}/`,
      cookies: ctx.jar?.dump?.() ?? {},
    };
  }

  const warm = await warmPokemonCentre(session, ctx, { tStep });
  if (!warm.ok) {
    return {
      ok: false,
      steps,
      dryRun,
      checkoutStage: "pre_cart",
      failedStep: warm.datadome?.isIpBanned ? "datadome_ip_ban" : "edge_warm",
      note: warm.note,
      finalUrl: `${session.state.base}/`,
      cookies: ctx.jar?.dump?.() ?? {},
    };
  }

  const productUrl =
    parseProductUrl(task.pdpUrl || "")?.productUrl ||
    `${session.state.base}/product/${sku}`;

  // Auth before tags — tags can rotate datadome; keep token mint close to interstitial clear.
  const auth = await tStep("cortex_auth", () =>
    getPublicToken(session, ctx, { locale: session.state.locale }),
  );
  if (!auth.ok) {
    return {
      ok: false,
      steps,
      dryRun,
      checkoutStage: "pre_cart",
      failedStep: "cortex_auth",
      note: auth.note,
      finalUrl: productUrl,
      cookies: ctx.jar?.dump?.() ?? {},
    };
  }

  await tStep("datadome_tags", async () => {
    try {
      return await postDataDomeTags(session, ctx, { pageUrl: `${session.state.base}/` });
    } catch (e) {
      return { ok: false, note: e?.message || String(e) };
    }
  });

  const pdp = await tStep("pdp_fetch", async () => {
    const got = await fetchWithEdgeClear(session, ctx, productUrl, { tStep });
    if (got.isIpBanned) return { ok: false, note: got.note, status: got.status };
    const avail = parsePdpAvailability(got.html);
    if (looksLikeDataDomeBlock(got.html, got.status)) {
      await clearDataDome(session, ctx, { pageUrl: productUrl, html: got.html });
    }
    const hc = await maybeSolveHcaptcha(session, ctx, task, got.html, productUrl, tStep);
    return {
      ok: got.ok || Boolean(avail.title || avail.product),
      status: got.status,
      note: avail.note,
      avail,
      product: avail.product || null,
      cart: avail.cart || null,
      hcaptchaToken: hc?.token || null,
    };
  });

  let atc = await tStep("cortex_atc", async () => {
    try {
      return await attemptGuestAtc(session, {
        sku,
        qty: task.qty || 1,
        task,
        product: pdp.product,
        pageUrl: productUrl,
      });
    } catch (e) {
      return { ok: false, note: e?.message || String(e) };
    }
  });
  // BFF ATC can still escalate to DD captcha JSON — refresh tags once and retry.
  if (atc.datadomeChallenge) {
    await tStep("datadome_tags_retry", () =>
      postDataDomeTags(session, ctx, { pageUrl: productUrl }),
    );
    atc = await tStep("cortex_atc_retry", async () => {
      try {
        return await attemptGuestAtc(session, {
          sku,
          qty: task.qty || 1,
          task,
          product: pdp.product,
          pageUrl: productUrl,
        });
      } catch (e) {
        return { ok: false, note: e?.message || String(e) };
      }
    });
  }

  const usesGe = localeUsesGlobalE(session.state.locale);
  let geResult = null;
  let geM2m = null;
  let checkoutStage = atc.ok ? "cart" : "pre_cart";

  let cartGuid = pdp.cart?.cartGuid || task.cartGuid || null;
  if (atc.ok && usesGe) {
    // Prefer BFF /cart/data?type=full → cart-guid (wire-proven 2026-07-22).
    if (!cartGuid) {
      const cartData = await tStep("cart_data", async () => {
        try {
          const apiH = cortexApiHeaders({
            accessToken: session.state.cortexAuth?.accessToken,
            locale: session.state.locale,
            referer: `${session.state.base}/`,
            userAgent: session.state.userAgent,
          });
          const res = await session.get(`${PC_API_BASE}/cart/data?type=full`, {
            api: true,
            headers: apiH,
          });
          const text = await session.readText(res);
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* ignore */
          }
          const guid = cartGuidFromCartData(json);
          return {
            ok: Boolean(guid),
            cartGuid: guid,
            status: res.status,
            note: guid ? `cart-guid ${guid}` : `cart/data ${res.status} no cart-guid`,
          };
        } catch (e) {
          return { ok: false, note: e?.message || String(e) };
        }
      });
      cartGuid = cartData?.cartGuid || null;
    }
    if (!cartGuid) {
      const home = await fetchWithEdgeClear(session, ctx, `${session.state.base}/`, { tStep });
      cartGuid = parsePdpAvailability(home.html)?.cart?.cartGuid || null;
    }
    if (cartGuid) {
      geM2m = await tStep("ge_m2m", () => getGlobaleM2mToken(session, { cartGuid }));
      checkoutStage = geM2m?.ok ? "tokenize" : "cart";
    }
  }

  // Handoff URL — real SPA boot preferred over raw order id (Bandai lesson).
  // Note: bare GET /intl-checkout may 302 → /cart; GE iframe boots client-side with mid 1634.
  const intlUrl =
    task.intlCheckoutUrl ||
    (usesGe ? `${session.state.base}/intl-checkout` : `${session.state.base}/checkout`);

  if (atc.ok && (task.placeOrder === true || task.pcHttpCheckout === true)) {
    // Product path: HTTP GE only (Bandai Fast playbook). No Playwright Pay.
    checkoutStage = "tokenize";
    geResult = await tStep("ge_pay_http", async () => {
      const mid =
        task.globaleMid ||
        task.geMerchantId ||
        process.env.PC_GLOBALE_MID ||
        PC_GLOBALE_MID;
      const card =
        task.card ||
        (process.env.PC_CARD_NUMBER
          ? {
              number: process.env.PC_CARD_NUMBER,
              expMonth: process.env.PC_CARD_EXP_MONTH || process.env.KMART_CARD_EXP_MONTH,
              expYear: process.env.PC_CARD_EXP_YEAR || process.env.KMART_CARD_EXP_YEAR,
              cvv: process.env.PC_CARD_CVV || process.env.KMART_CARD_CVV,
              holder: process.env.PC_CARD_HOLDER || "TEST USER",
            }
          : null);
      return runGlobalEPayHttp({
        session,
        ctx,
        cartGuid,
        geM2m,
        card,
        email: task.email || task.profile?.email,
        phone: task.phone || task.profile?.phone,
        address1: task.address1 || task.profile?.address1,
        city: task.city || task.profile?.city,
        zip: task.zip || task.profile?.zip,
        globaleMid: mid,
        placeOrder: task.placeOrder === true,
        riskHydrate: task.riskHydrate !== false && task.pcNoPage !== true,
        noPage: task.pcNoPage === true || task.noPage === true,
        proxyRaw: task.proxy || null,
        page: task.page || null,
        stopBeforeIssuer: task.stopBeforeIssuer === true,
        forceIssuer: task.forceIssuer === true,
        debugDir: task.debugDir || task.pcCaptureDir || null,
        onProgress: (n, note) => ctx.onProgress?.(n, note),
      });
    });
    checkoutStage = geResult.checkoutStage || checkoutStage;
  } else if (atc.ok && task.pcBrowserCheckout === true) {
    // HAR / wire capture only — never product pay.
    const { runGlobalEPay } = await import("./pokemoncentre-ge.js");
    checkoutStage = "tokenize";
    geResult = await tStep("ge_pay_browser_capture", async () => {
      return runGlobalEPay({
        checkoutUrl: task.geCheckoutUrl || intlUrl,
        cartUrl: `${session.state.base}/cart`,
        card: task.card || null,
        email: task.email || task.profile?.email,
        phone: task.phone || task.profile?.phone,
        proxyRaw: task.proxy || null,
        cookies: ctx.jar?.dump?.() ?? {},
        userAgent: session.state.userAgent,
        globaleMid: task.globaleMid || PC_GLOBALE_MID,
        placeOrder: false,
        debugDir: task.debugDir || task.pcCaptureDir || null,
        onProgress: (n, note) => ctx.onProgress?.(n, note),
      });
    });
    checkoutStage = geResult.checkoutStage || checkoutStage;
  } else if (atc.ok && dryRun) {
    steps.push({
      step: "intl_checkout_stub",
      ok: true,
      note: usesGe
        ? `would HTTP GE pay mid=${PC_GLOBALE_MID} (placeOrder); riskHydrate inline; no Playwright pay`
        : "domestic checkout locale — GE skipped",
      cartGuid,
      geM2m: geM2m?.ok || false,
      globaleMid: PC_GLOBALE_MID,
    });
  }

  const ok = Boolean(atc.ok) && (!geResult || geResult.ok || geResult.dryRun);
  return {
    ok,
    steps,
    dryRun: dryRun || Boolean(geResult?.dryRun),
    checkoutStage,
    finalUrl: productUrl,
    cookies: ctx.jar?.dump?.() ?? {},
    sku,
    title: pdp.avail?.title || pdp.product?.name || null,
    epItemId: atc.epItemId || pdp.product?.epItemId || null,
    cartUri: atc.cartUri || null,
    locale: session.state.locale,
    geM2m: geM2m?.ok ? true : geM2m?.note || null,
    globaleMid: geResult?.globaleMid || task.globaleMid || null,
    orderNumber: geResult?.orderNumber || null,
    reached3ds: geResult?.reached3ds || null,
    threeDsUrl: geResult?.threeDsUrl || null,
    paymentStatus: geResult?.paymentStatus || null,
    possibleFraudDetected: geResult?.possibleFraudDetected ?? null,
    transactionId: geResult?.transactionId || null,
    transactionStatusType: geResult?.transactionStatusType || null,
    chargeReqCount: geResult?.chargeReqCount ?? null,
    note: geResult?.note || atc.note || pdp.note,
    failedStep: ok
      ? null
      : atc.ok
        ? geResult?.failedStep || "ge_pay"
        : atc.datadomeChallenge
          ? "datadome_atc"
          : "cortex_atc",
  };
}

export const pokemoncentreAdapter = {
  id: "pokemoncentre",
  matches(host) {
    const h = String(host || "").toLowerCase();
    // TPCI only — never match JP pokemoncenter-online.com
    return h === "pokemoncenter.com" || h === "www.pokemoncenter.com";
  },

  async run(task, ctx) {
    const steps = ctx.steps || (ctx.steps = []);
    const tStep = makeStep(steps, ctx);
    const mode = normalizeMode(task);
    const locale = resolvePcLocale(task);
    task.pcLocale = locale;

    const session = createPcSession(ctx, { locale });
    steps.push({
      step: "pc_region",
      ok: true,
      note: `locale=${locale} base=${pcBaseFor(locale)} ge=${localeUsesGlobalE(locale)} (not JP online)`,
    });

    if (mode === "edge") {
      return runEdge(task, ctx, session, tStep, steps);
    }
    if (mode === "monitor") {
      return runMonitor(task, ctx, session, tStep, steps);
    }
    if (mode === "har_probe") {
      return runHarProbe(task, ctx, session, tStep, steps);
    }
    return runCheckout(task, ctx, session, tStep, steps);
  },
};

export default pokemoncentreAdapter;
