#!/usr/bin/env node
// Single-sticky probe: edge (+ Reese remint) → auth → tags → ATC → cart/data.
// Env: HYPER_API_KEY, PROXY=…, TRANSPORT=undici|tls-worker
import fs from "node:fs";
import { createJar, makeDispatcher, makeRemoteTlsDispatcher, UA } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { hyperConfigured } from "../antibot.js";
import { createPcSession } from "../adapters/pokemoncentre-session.js";
import {
  warmPokemonCentre,
  clearIncapsulaReese,
  postDataDomeTags,
  solveDatadomeCaptchaUrl,
  PC_REESE_SCRIPT_PATH,
} from "../adapters/pokemoncentre-edge.js";
import {
  getPublicToken,
  attemptGuestAtc,
  cartGuidFromCartData,
  cortexApiHeaders,
  PC_API_BASE,
  PC_CORTEX_SCOPE,
  parsePdpAvailability,
} from "../adapters/pokemoncentre-cortex.js";

const OUT = process.env.PC_CAPTURE_DIR || `/tmp/pc-probe-${Date.now()}`;
const PROXY = String(process.env.PROXY || "").trim();
const TRANSPORT = String(process.env.TRANSPORT || "undici").toLowerCase();
const PDP =
  process.env.PC_PDP ||
  "https://www.pokemoncenter.com/en-au/product/10-10320-101/pokemon-tcg-mewtwo-and-mew-dna-premium-zip-binder";
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
    const ip = await resolveEgressIp(ctx);
    push("egress", { ip, transport: TRANSPORT });

    let edge = await warmPokemonCentre(session, ctx);
    push("edge", { ok: edge.ok, note: edge.note, view: edge.datadome?.view });
    if (!edge.ok && /view=captcha/i.test(edge.note || "") && TRANSPORT === "undici") {
      push("hint", { note: "view=captcha on undici — retry this sticky with TRANSPORT=tls-worker" });
    }
    if (!edge.ok) {
      fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({ ok: false, log }, null, 2));
      return;
    }

    // Explicit Reese remint before BFF (belt + suspenders)
    const reese = await clearIncapsulaReese(session, ctx, {
      pageUrl: `${session.state.base}/`,
      html: "",
    });
    push("reese_pre_auth", { ok: reese.ok, hasToken: reese.hasToken, note: reese.note });

    let auth = await getPublicToken(session, ctx);
    push("auth", { ok: auth.ok, status: auth.status, note: auth.note, incap: auth.incapBlock });
    if (!auth.ok) {
      fs.writeFileSync(`${OUT}/auth.txt`, auth.note || "");
      fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({ ok: false, log }, null, 2));
      return;
    }

    const tags = await postDataDomeTags(session, ctx, { pageUrl: `${session.state.base}/` });
    push("tags", { ok: tags.ok, note: tags.note });

    const pdpRes = await session.get(PDP, { headers: { referer: `${session.state.base}/` } });
    const pdpHtml = await session.readText(pdpRes);
    fs.writeFileSync(`${OUT}/pdp.html`, pdpHtml.slice(0, 800_000));
    const avail = parsePdpAvailability(pdpHtml);
    push("pdp", {
      status: pdpRes.status,
      epId: avail.epItemId,
      availability: avail.product?.availability,
    });

    let atc = await attemptGuestAtc(session, {
      sku: "10-10320-101",
      qty: 1,
      product: avail.product,
      pageUrl: PDP,
    });
    fs.writeFileSync(`${OUT}/atc.json`, JSON.stringify(atc.json || { note: atc.note }, null, 2));
    push("atc", {
      ok: atc.ok,
      status: atc.status,
      dd: atc.datadomeChallenge,
      captchaT: atc.captchaUrl ? (atc.captchaUrl.match(/[?&]t=([^&]+)/) || [])[1] : null,
      note: atc.note,
    });

    if (atc.datadomeChallenge && atc.captchaUrl && !/[?&]t=bv\b/i.test(atc.captchaUrl)) {
      const solved = await solveDatadomeCaptchaUrl(session, ctx, atc.captchaUrl, { pageUrl: PDP });
      push("atc_captcha", { ok: solved.ok, note: solved.note });
      if (solved.ok) {
        atc = await attemptGuestAtc(session, {
          sku: "10-10320-101",
          qty: 1,
          product: avail.product,
          pageUrl: PDP,
        });
        push("atc_retry", { ok: atc.ok, status: atc.status, note: atc.note });
      }
    }

    if (atc.ok) {
      const apiH = cortexApiHeaders({
        accessToken: session.state.cortexAuth.accessToken,
        referer: `${session.state.base}/`,
        userAgent: UA,
      });
      const cartRes = await session.get(`${PC_API_BASE}/cart/data?type=full`, {
        api: true,
        headers: apiH,
      });
      const cartText = await session.readText(cartRes);
      fs.writeFileSync(`${OUT}/cart-full.json`, cartText.slice(0, 400_000));
      let cartJson = null;
      try {
        cartJson = JSON.parse(cartText);
      } catch {
        /* ignore */
      }
      const cartGuid = cartGuidFromCartData(cartJson);
      push("cart", {
        status: cartRes.status,
        cartGuid: Boolean(cartGuid),
        keys: cartJson ? Object.keys(cartJson).slice(0, 12) : null,
      });
    }

    fs.writeFileSync(
      `${OUT}/summary.json`,
      JSON.stringify(
        {
          ok: Boolean(atc.ok),
          transport: TRANSPORT,
          reesePath: PC_REESE_SCRIPT_PATH,
          scope: PC_CORTEX_SCOPE,
          cookies: Object.keys(jar.dump?.() || {}),
          log,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ out: OUT, ok: atc.ok, stage: log.at(-1)?.step }));
  } finally {
    await dispatcher.close?.();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
