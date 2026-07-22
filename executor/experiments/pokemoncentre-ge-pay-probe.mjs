#!/usr/bin/env node
// Full path: tls-worker edge → ATC → cartGuid → GE m2m → Playwright GE Pay (decline card).
// Env: HYPER_API_KEY, PROXY=…, TRANSPORT=tls-worker (default)
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
import { runGlobalEPay, PC_GLOBALE_MID } from "../adapters/pokemoncentre-ge.js";

const OUT = process.env.PC_CAPTURE_DIR || `/tmp/pc-gepay-${Date.now()}`;
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

    // Persist cookies for GE browser handoff
    const cookies = jar.dump();
    fs.writeFileSync(`${OUT}/cookies.json`, JSON.stringify(cookies, null, 2));

    const pay = await runGlobalEPay({
      checkoutUrl: `${session.state.base}/intl-checkout`,
      cartUrl: `${session.state.base}/cart`,
      card: {
        number: "4000000000000002",
        expMonth: "12",
        expYear: "30",
        cvv: "999",
        holder: "DECLINE TEST",
      },
      proxyRaw: PROXY,
      cookies,
      userAgent: UA,
      globaleMid: PC_GLOBALE_MID,
      placeOrder: process.env.PLACE_ORDER === "1",
      headless: true,
      debugDir: OUT,
      onProgress: (n, note) => push("ge_pay_progress", { n, note }),
    });
    fs.writeFileSync(`${OUT}/ge-pay.json`, JSON.stringify(pay, null, 2));
    push("ge_pay", {
      ok: pay.ok,
      stage: pay.checkoutStage,
      mid: pay.globaleMid,
      note: pay.note || pay.error,
      reached3ds: pay.reached3ds,
    });

    fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({ log, pay, cartGuid }, null, 2));
    console.log(JSON.stringify({ out: OUT, cartGuid, gePay: pay.ok, stage: pay.checkoutStage, note: pay.note || pay.error }));
  } finally {
    await dispatcher.close?.();
  }
}

main().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${OUT}/error.txt`, String(e?.stack || e));
  process.exit(1);
});
