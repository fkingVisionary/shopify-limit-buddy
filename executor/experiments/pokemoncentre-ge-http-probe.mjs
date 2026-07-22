#!/usr/bin/env node
// HTTP-first PC GE probe: tls-worker edge → ATC → m2m → runGlobalEPayHttp.
// Env: HYPER_API_KEY, PROXY=…, TRANSPORT=tls-worker
// Optional placeOrder=1 requires gePayForm wire (or expect needs_wire).
// Browser capture (separate): PC_BROWSER=1 PLACE_ORDER=1 → ge-wire-posts.json
import fs from "node:fs";
import { createJar, makeDispatcher, makeRemoteTlsDispatcher, UA } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { hyperConfigured } from "../antibot.js";
import { createPcSession } from "../adapters/pokemoncentre-session.js";
import {
  warmPokemonCentre,
  clearIncapsulaReese,
  postDataDomeTags,
} from "../adapters/pokemoncentre-edge.js";
import {
  getPublicToken,
  attemptGuestAtc,
  getGlobaleM2mToken,
  cartGuidFromCartData,
  cortexApiHeaders,
  PC_API_BASE,
  parsePdpAvailability,
} from "../adapters/pokemoncentre-cortex.js";
import { runGlobalEPayHttp, PC_GLOBALE_MID } from "../adapters/pokemoncentre-ge-http.js";

const OUT = process.env.PC_CAPTURE_DIR || `/tmp/pc-ge-http-${Date.now()}`;
const PROXY = String(process.env.PROXY || "").trim();
const TRANSPORT = String(process.env.TRANSPORT || "tls-worker").toLowerCase();
const PDP =
  "https://www.pokemoncenter.com/en-au/product/10-10320-101/pokemon-tcg-mewtwo-and-mew-dna-premium-zip-binder";
const FALLBACK_EP = "qgqvhlbrgawtcmbtgiyc2mjqge=";
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  if (!hyperConfigured()) throw new Error("HYPER_API_KEY missing");
  if (!PROXY) throw new Error("PROXY required");
  const dispatcher =
    TRANSPORT === "tls-worker"
      ? await makeRemoteTlsDispatcher(PROXY)
      : makeDispatcher(PROXY, { forceUndici: true });
  const jar = createJar();
  const ctx = { jar, dispatcher };
  const session = createPcSession(ctx, { locale: "en-au", userAgent: UA });
  const log = [];
  const push = (step, extra = {}) => {
    log.push({ step, ...extra });
    console.log(JSON.stringify({ step, ...extra }));
  };

  try {
    push("egress", { ip: await resolveEgressIp(ctx), transport: TRANSPORT, mid: PC_GLOBALE_MID });
    const edge = await warmPokemonCentre(session, ctx);
    push("edge", { ok: edge.ok, note: edge.note });
    if (!edge.ok) throw new Error(edge.note || "edge fail");
    await clearIncapsulaReese(session, ctx, { pageUrl: `${session.state.base}/`, html: "" });
    const auth = await getPublicToken(session, ctx);
    push("auth", { ok: auth.ok, note: auth.note });
    if (!auth.ok) throw new Error(auth.note);
    await postDataDomeTags(session, ctx, { pageUrl: `${session.state.base}/` });

    const pdpRes = await session.get(PDP, { headers: { referer: `${session.state.base}/` } });
    const pdpHtml = await session.readText(pdpRes);
    const avail = parsePdpAvailability(pdpHtml);
    const product = avail.product || { code: "10-10320-101", epItemId: FALLBACK_EP };
    if (!product.epItemId) product.epItemId = FALLBACK_EP;

    const atc = await attemptGuestAtc(session, {
      sku: "10-10320-101",
      qty: 1,
      product,
      pageUrl: PDP,
    });
    push("atc", { ok: atc.ok, status: atc.status, note: atc.note });
    if (!atc.ok) throw new Error(atc.note);

    const apiH = cortexApiHeaders({
      accessToken: session.state.cortexAuth.accessToken,
      referer: `${session.state.base}/`,
      userAgent: UA,
    });
    const cartRes = await session.get(`${PC_API_BASE}/cart/data?type=full`, {
      api: true,
      headers: apiH,
    });
    const cartJson = JSON.parse(await session.readText(cartRes));
    const cartGuid = cartGuidFromCartData(cartJson);
    push("cart", { cartGuid, qty: cartJson["total-quantity"] });
    if (!cartGuid) throw new Error("no cartGuid");

    const ge = await getGlobaleM2mToken(session, { cartGuid });
    fs.writeFileSync(`${OUT}/ge-m2m.json`, JSON.stringify(ge.json, null, 2));
    push("ge_m2m", { ok: ge.ok, token: ge.json?.["access-token"]?.slice?.(0, 12) });

    if (process.env.PC_BROWSER === "1") {
      const { runGlobalEPay } = await import("../adapters/pokemoncentre-ge.js");
      const card = {
        number: process.env.PC_CARD_NUMBER || "4000000000000002",
        expMonth: process.env.PC_CARD_EXP_MONTH || "12",
        expYear: process.env.PC_CARD_EXP_YEAR || "30",
        cvv: process.env.PC_CARD_CVV || "999",
        holder: "TEST USER",
      };
      push("card", { last4: String(card.number).slice(-4), engine: "browser_capture" });
      const pay = await runGlobalEPay({
        checkoutUrl: `${session.state.base}/intl-checkout`,
        cartUrl: `${session.state.base}/cart`,
        card,
        email: process.env.PC_CHECKOUT_EMAIL || "decline.test@example.com",
        phone: process.env.PC_CHECKOUT_PHONE || "0412345678",
        proxyRaw: PROXY,
        cookies: jar.dump(),
        userAgent: UA,
        globaleMid: PC_GLOBALE_MID,
        placeOrder: process.env.PLACE_ORDER === "1",
        debugDir: OUT,
        onProgress: (n, note) => push("ge_pay_progress", { n, note }),
      });
      fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({ log, pay, cartGuid }, null, 2));
      console.log(
        JSON.stringify({
          out: OUT,
          engine: "browser_capture",
          paymentStatus: pay.paymentStatus,
          wirePosts: fs.existsSync(`${OUT}/ge-wire-posts.json`),
        }),
      );
      return;
    }

    const pay = await runGlobalEPayHttp({
      session,
      ctx,
      cartGuid,
      geM2m: ge,
      card: {
        number: process.env.PC_CARD_NUMBER,
        expMonth: process.env.PC_CARD_EXP_MONTH,
        expYear: process.env.PC_CARD_EXP_YEAR,
        cvv: process.env.PC_CARD_CVV,
      },
      placeOrder: process.env.PLACE_ORDER === "1",
      gePayForm: process.env.PC_GE_PAY_FORM
        ? JSON.parse(fs.readFileSync(process.env.PC_GE_PAY_FORM, "utf8"))
        : null,
      onProgress: (n, note) => push("ge_http_progress", { n, note }),
    });
    fs.writeFileSync(`${OUT}/ge-http.json`, JSON.stringify(pay, null, 2));
    fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({ log, pay, cartGuid }, null, 2));
    console.log(
      JSON.stringify({
        out: OUT,
        engine: pay.engine || "http",
        paymentStatus: pay.paymentStatus,
        note: pay.note || pay.error,
      }),
    );
  } finally {
    await dispatcher.close?.();
  }
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${OUT}/error.txt`, String(e?.stack || e));
  process.exit(1);
});
