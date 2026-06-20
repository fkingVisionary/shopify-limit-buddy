// Kmart AU adapter.
//
// Scope (this batch): dry-run only. Goal is to prove that Hyper-generated
// Akamai sensors clear the `_abck` challenge on kmart.com.au so the homepage
// → PDP path resolves to 200 with a valid `~0~` cookie. Cart and checkout
// endpoints get reverse-engineered after the sensor pipeline is verified.
//
// Why a custom adapter: Kmart AU runs Akamai Bot Manager (sensor + pixel,
// no SBSD as of writing). Their frontend is a custom SPA, not Shopify, so
// none of the generic Shopify cart endpoints apply.

import { request, UA } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { hyperConfigured, solveAkamaiSensor, solveAkamaiPixel, solveAkamaiSbsd } from "../antibot.js";

// Detects the SBSD script tag served inside Akamai 403 challenge HTML.
// Pattern (per Hyper docs §3.4): /<path>?v=<uuid>[&t=<token>]
const SBSD_RE = /src=["']([a-z0-9\/\-_.]+)\?v=([0-9a-f-]+)(?:&[^"']*?t=([^"'&]+))?["']/i;
function parseSbsd(html) {
  const m = SBSD_RE.exec(html);
  if (!m) return null;
  return { path: m[1], uuid: m[2], t: m[3] ?? "" };
}
import { parseAkamaiPath, isAkamaiCookieValid } from "hyper-sdk-js";

const ACCEPT_LANG = "en-AU,en;q=0.9";

// Chrome 124 / macOS navigation header shape. Akamai scores requests on the
// presence + ordering of these client hints; a Chrome UA without matching
// sec-ch-ua + sec-fetch-* is an instant bot tag.
const CHROME_CH = {
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};
function navHeaders({ referer, site }) {
  return {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": ACCEPT_LANG,
    "accept-encoding": "gzip, deflate, br, zstd",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "upgrade-insecure-requests": "1",
    ...CHROME_CH,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": site,
    "sec-fetch-user": "?1",
    ...(referer ? { referer } : {}),
  };
}

// Use the SDK's parseAkamaiPath — Kmart's path doesn't contain "/akam/" and
// rotates per page load, so our old `/akam/` regex always missed.
function findAkamaiScriptPath(html) {
  return parseAkamaiPath(html);
}

// Solved when _abck contains the `~0~` indicator AND survives the SDK's
// internal validation (count of completed sensor rounds matters).
function abckSolved(jar, roundCount) {
  const v = jar.get("_abck") ?? "";
  return isAkamaiCookieValid(v, roundCount);
}


export const kmartAdapter = {
  id: "kmart",
  matches(host) {
    return host === "kmart.com.au" || host.endsWith(".kmart.com.au");
  },

  async run(task, ctx) {
    const steps = ctx.steps ?? (ctx.steps = []);
    const tStep = async (name, fn) => {
      const t0 = Date.now();
      try {
        const out = await fn();
        steps.push({ step: name, ok: out.ok !== false, status: out.status ?? null, ms: Date.now() - t0, note: out.note });
        return out;
      } catch (e) {
        steps.push({
          step: name,
          ok: false,
          status: null,
          ms: Date.now() - t0,
          note: e?.code === "antibot_misconfigured" ? "HYPER_API_KEY missing on executor" : e?.message ?? String(e),
        });
        throw e;
      }
    };

    if (!hyperConfigured()) {
      steps.push({ step: "antibot_misconfigured", ok: false, note: "HYPER_API_KEY missing on executor" });
      return { ok: false, steps, finalUrl: task.storeUrl, cookies: ctx.jar.dump() };
    }

    const origin = "https://www.kmart.com.au";
    const pdpUrl = task.storeUrl;
    let scriptPath = null;
    let scriptBody = null;
    let html = "";
    let prevContext = null;

    // 1. Resolve egress IP for fingerprint consistency.
    const ip = await tStep("resolve_ip", async () => {
      const v = await resolveEgressIp(ctx);
      return { note: v ?? "(no ip)", ok: Boolean(v) };
    }).then(() => ctx._ip ?? null).catch(() => null);
    // resolveEgressIp doesn't stash on ctx; re-read from cache via helper.
    const egressIp = await resolveEgressIp(ctx);

    // 2. Warm homepage → ingests _abck/bm_sz seeds + lets us discover the
    //    Akamai script path.
    await tStep("warm_home", async () => {
      const res = await request(
        origin + "/",
        { method: "GET", headers: navHeaders({ site: "none" }) },
        ctx,
      );
      html = await res.text();
      scriptPath = findAkamaiScriptPath(html);
      return { status: res.status, note: `${html.length}b, abck=${ctx.jar.has("_abck")} bmsz=${ctx.jar.has("bm_sz")} script=${scriptPath ?? "(none)"}` };
    });

    if (!scriptPath) {
      // Without the script path we can't generate a sensor. Fail fast.
      steps.push({ step: "akamai_script_missing", ok: false, note: "no /akam/ path on homepage; recon needed" });
      return { ok: false, steps, finalUrl: origin, cookies: ctx.jar.dump() };
    }
    const scriptUrl = origin + scriptPath;

    // 3. Fetch the Akamai sensor script (first sensor needs the script body).
    await tStep("akamai_script_fetch", async () => {
      const res = await request(scriptUrl, { method: "GET", headers: { "user-agent": UA, referer: origin + "/", "accept-language": ACCEPT_LANG } }, ctx);
      scriptBody = await res.text();
      return { status: res.status, note: `${scriptBody.length}b` };
    });

    // 4. Sensor loop. Akamai rotates `_abck` on response; we need `~0~` in
    //    the cookie before we're allowed past the bot wall. Cap at 3 rounds.
    for (let i = 0; i < 3; i++) {
      const { payload, postUrl, context } = await tStep(`akamai_sensor#${i + 1}`, async () => {
        const r = await solveAkamaiSensor({
          jar: ctx.jar,
          pageUrl: origin + "/",
          userAgent: UA,
          ip: egressIp,
          acceptLanguage: ACCEPT_LANG,
          scriptUrl,
          scriptBody,
          prevContext,
        });
        // Post the sensor payload back to the script URL — Akamai answers
        // with refreshed `_abck`/`bm_sz` cookies via Set-Cookie.
        const res = await request(
          r.postUrl,
          {
            method: "POST",
            headers: {
              "user-agent": UA,
              "content-type": "text/plain;charset=UTF-8",
              accept: "*/*",
              "accept-language": ACCEPT_LANG,
              origin,
              referer: origin + "/",
            },
            body: JSON.stringify({ sensor_data: r.payload }),
          },
          ctx,
        );
        return { status: res.status, note: `abck=${(ctx.jar.get("_abck") ?? "").slice(0, 40)}…`, _ctx: r.context };
      }).then((s) => ({ payload: null, postUrl: null, context: s._ctx }));
      prevContext = context;
      if (abckSolved(ctx.jar, i + 1)) {
        steps.push({ step: "akamai_solved", ok: true, note: `rounds=${i + 1}` });
        break;
      }
    }

    if (!abckSolved(ctx.jar, 3)) {
      steps.push({ step: "akamai_unsolved", ok: false, note: "_abck never reached ~0~ after 3 rounds" });
      return { ok: false, steps, finalUrl: origin, cookies: ctx.jar.dump() };
    }


    // 5. Hit the PDP — this is the gated request and the real success signal.
    let pdpStatus = 0;
    let pdpHtml = "";
    await tStep("pdp_get", async () => {
      const res = await request(
        pdpUrl,
        { method: "GET", headers: navHeaders({ referer: origin + "/", site: "same-origin" }) },
        ctx,
      );
      pdpStatus = res.status;
      pdpHtml = await res.text();
      const snippet = pdpHtml.replace(/\s+/g, " ").trim().slice(0, 1200);
      const srv = res.headers.get("server");
      const aka = res.headers.get("x-akamai-transformed") ?? res.headers.get("akamai-grn") ?? "";
      return { status: res.status, ok: res.status < 400, note: `${pdpHtml.length}b: ${snippet} | server=${srv} ${aka}` };

    });

    // 5b. SBSD challenge — fires on ANY response carrying the `?v=<uuid>`
    //     script tag (Kmart serves it inline on 200s too, not just 403s).
    //     Solve two SBSD rounds (index 0, 1) per Hyper docs §3.3, then retry PDP.
    const sbsdDetected = /sec-if-cpt-container|sbsd_o|\?v=[0-9a-f-]{8,}[^"']*?(?:&t=|["'])/i.test(pdpHtml) && parseSbsd(pdpHtml);
    if (pdpStatus === 403 || sbsdDetected) {
      const sbsd = parseSbsd(pdpHtml);
      if (sbsd) {
        const sbsdScriptUrl = origin + (sbsd.path.startsWith("/") ? sbsd.path : "/" + sbsd.path) + `?v=${sbsd.uuid}${sbsd.t ? `&t=${sbsd.t}` : ""}`;
        const sbsdPostUrl = origin + (sbsd.path.startsWith("/") ? sbsd.path : "/" + sbsd.path) + (sbsd.t ? `?t=${sbsd.t}` : "");
        let sbsdScriptBody = "";
        await tStep("sbsd_script_fetch", async () => {
          const r = await request(sbsdScriptUrl, { method: "GET", headers: { "user-agent": UA, referer: pdpUrl, "accept-language": ACCEPT_LANG } }, ctx);
          sbsdScriptBody = await r.text();
          return { status: r.status, note: `uuid=${sbsd.uuid.slice(0, 8)} ${sbsdScriptBody.length}b t=${sbsd.t || "-"}` };
        });
        const rounds = sbsd.t ? 1 : 2; // hard challenge = 1 round, passive = 2
        for (let i = 0; i < rounds; i++) {
          await tStep(`sbsd_round#${i}`, async () => {
            const payload = await solveAkamaiSbsd({
              jar: ctx.jar,
              pageUrl: pdpUrl,
              scriptBody: sbsdScriptBody,
              uuid: sbsd.uuid,
              oCookie: ctx.jar.get("sbsd_o") ?? ctx.jar.get("bm_so") ?? "",
              index: i,
              userAgent: UA,
              ip: egressIp,
              acceptLanguage: ACCEPT_LANG,
            });
            const res = await request(
              sbsdPostUrl,
              {
                method: "POST",
                headers: {
                  "user-agent": UA,
                  "content-type": "application/json",
                  accept: "*/*",
                  "accept-language": ACCEPT_LANG,
                  origin,
                  referer: pdpUrl,
                },
                body: JSON.stringify({ body: payload }),
              },
              ctx,
            );
            const bodyTxt = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
            const setCk = res.headers.get("set-cookie") ?? "";
            const sbsdKeys = Object.keys(ctx.jar.dump()).filter((k) => /sbsd|bm_s/.test(k)).join(",");
            return { status: res.status, note: `body="${bodyTxt}" setCk=${setCk.slice(0, 120)} jarSbsd=${sbsdKeys}` };
          });
        }

        await tStep("pdp_get#2", async () => {
          const res = await request(
            pdpUrl,
            { method: "GET", headers: navHeaders({ referer: origin + "/", site: "same-origin" }) },
            ctx,
          );
          pdpStatus = res.status;
          pdpHtml = await res.text();
          const snippet = pdpHtml.length < 1500 ? pdpHtml.replace(/\s+/g, " ").trim().slice(0, 1200) : `ok ${pdpHtml.length}b`;
          return { status: res.status, ok: res.status < 400, note: snippet };
        });
      } else {
        steps.push({ step: "sbsd_missing", ok: false, note: "403 body had no ?v=<uuid> script tag" });
      }
    }


    // 6. Opportunistic pixel solve if the PDP carries one. Non-fatal.
    try {
      const pixel = await solveAkamaiPixel({
        jar: ctx.jar,
        pageUrl: pdpUrl,
        html: pdpHtml,
        userAgent: UA,
        ip: egressIp,
        acceptLanguage: ACCEPT_LANG,
        ctx,
      });
      if (pixel) {
        await tStep("akamai_pixel", async () => {
          const res = await request(
            pixel.postUrl,
            {
              method: "POST",
              headers: {
                "user-agent": UA,
                "content-type": "application/x-www-form-urlencoded",
                origin,
                referer: pdpUrl,
                "accept-language": ACCEPT_LANG,
              },
              body: pixel.payload,
            },
            ctx,
          );
          return { status: res.status, note: "pixel posted" };
        });
      } else {
        steps.push({ step: "akamai_pixel", ok: true, note: "no pixel challenge" });
      }
    } catch (e) {
      steps.push({ step: "akamai_pixel", ok: false, note: e?.message ?? String(e) });
    }

    // 7. Cart steps — commercetools-style GraphQL on api.kmart.com.au.
    //    Auth is cookie-only (Akamai session from kmart.com.au). Real ops
    //    captured from DevTools: getActiveBag / createMyBag / updateMyBag.
    const gqlUrl = "https://api.kmart.com.au/gateway/graphql";
    const apiOrigin = "https://api.kmart.com.au";
    const keycodeMatch = pdpUrl.match(/-(\d{6,9})\/?(?:\?|$)/);
    const urlKeycode = task.keycode ?? keycodeMatch?.[1] ?? null;

    // SKU != URL keycode. Scrape the variant sku from the PDP HTML (Next.js
    // embeds it inside __NEXT_DATA__ / Apollo preloaded state).
    let sku = null;
    let skuSource = "none";
    if (pdpHtml) {
      const nextBlock = pdpHtml.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      const blob = nextBlock?.[1] ?? pdpHtml;
      const m1 = nextBlock && /"sku":"(\d{6,9})"/.exec(nextBlock[1]);
      const m2 = !m1 && /"sku":"(\d{6,9})"/.exec(pdpHtml);
      if (m1) { sku = m1[1]; skuSource = "__NEXT_DATA__"; }
      else if (m2) { sku = m2[1]; skuSource = "html"; }
    }
    if (!sku && urlKeycode) { sku = urlKeycode; skuSource = "url-fallback"; }
    steps.push({ step: "sku_extract", ok: Boolean(sku), note: `sku=${sku ?? "(none)"} source=${skuSource}` });

    const gqlHeaders = {
      "user-agent": UA,
      "content-type": "application/json",
      accept: "*/*",
      "accept-language": ACCEPT_LANG,
      origin,
      referer: pdpUrl,
      ...CHROME_CH,
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    const gqlPost = async (body) =>
      request(gqlUrl, { method: "POST", headers: gqlHeaders, body: JSON.stringify(body) }, ctx);

    if (pdpStatus > 0 && pdpStatus < 400) {
      // 7a. Warm api.kmart.com.au — seeds any per-host cookies the API
      //     edge sets. If this 403s with a vendor challenge body we'll
      //     need an Incapsula/Akamai solver on the API host next batch.
      await tStep("api_warm", async () => {
        const res = await request(
          apiOrigin + "/",
          {
            method: "GET",
            headers: {
              "user-agent": UA,
              accept: "*/*",
              "accept-language": ACCEPT_LANG,
              referer: pdpUrl,
              ...CHROME_CH,
              "sec-fetch-site": "same-site",
              "sec-fetch-mode": "cors",
              "sec-fetch-dest": "empty",
            },
          },
          ctx,
        );
        const txt = (await res.text()).slice(0, 160).replace(/\s+/g, " ");
        return { status: res.status, ok: res.status < 500, note: `${txt}` };
      });

      // 7b. getActiveBag — me.activeCart may be null on first run.
      let cartId = null;
      let cartVersion = null;
      await tStep("cart_get", async () => {
        const res = await gqlPost({
          operationName: "getActiveBag",
          variables: {},
          query:
            "query getActiveBag { me { activeCart { id version lineItems { quantity __typename } __typename } __typename } }",
        });
        const txt = await res.text();
        try {
          const j = JSON.parse(txt);
          const ac = j?.data?.me?.activeCart;
          if (ac) { cartId = ac.id; cartVersion = ac.version; }
        } catch {}
        return {
          status: res.status,
          ok: res.status < 400,
          note: `${txt.length}b activeCart=${cartId ? `${cartId.slice(0, 8)} v${cartVersion}` : "null"} : ${txt.slice(0, 300)}`,
        };
      });

      // 7c. createMyBag — only if no active cart.
      if (!cartId) {
        await tStep("cart_create", async () => {
          const res = await gqlPost({
            operationName: "createMyBag",
            variables: {
              draft: {
                currency: "AUD",
                country: "AU",
                shippingAddress: { country: "AU" },
                postcodeSelector:
                  '{"city":"BRISBANE","postalCode":"4001","state":"QLD","country":"AU"}',
                selectedCncStoreId: "1124",
              },
            },
            query:
              "mutation createMyBag($draft: MyCartDraft!) { createMyCart(draft: $draft) { id version postcodeSelector { postalCode __typename } __typename } }",
          });
          const txt = await res.text();
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.createMyCart;
            if (c) { cartId = c.id; cartVersion = c.version; }
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400 && Boolean(cartId),
            note: `id=${cartId ?? "null"} v=${cartVersion ?? "?"} : ${txt.slice(0, 400)}`,
          };
        });
      }

      // 7d. updateMyBag — addLineItem(sku) + setCustomField(selectedCncStoreId).
      if (cartId && sku) {
        const updateQuery = `mutation updateMyBag($id: String!, $version: Long!, $actions: [MyCartUpdateAction!]!) {
  updateMyCart(id: $id, version: $version, actions: $actions) {
    ...BasicBagFields
    lineItems { ...LineItemFields __typename }
    __typename
  }
}
fragment BasicBagFields on Cart {
  id version
  postcodeSelector { postalCode state city country __typename }
  totalPrice { centAmount __typename }
  shippingDiscount { FreeShippingThreshold __typename }
  __typename
}
fragment LineItemFields on LineItem {
  id name(locale: "en") quantity
  price { value { centAmount __typename } __typename }
  totalPrice { centAmount __typename }
  variant { id sku image(input: {preset: thumbnail}) imageKey attributes { name value __typename } __typename }
  custom { fields { offerId __typename } __typename }
  __typename
}`;
        await tStep("cart_atc", async () => {
          const res = await gqlPost({
            operationName: "updateMyBag",
            variables: {
              id: cartId,
              version: cartVersion,
              actions: [
                { addLineItem: { sku, quantity: task.qty ?? 1, addToCartSource: "PDP" } },
                { setCustomField: { name: "selectedCncStoreId", value: "1124" } },
              ],
            },
            query: updateQuery,
          });
          const txt = await res.text();
          let lineCount = 0;
          let total = null;
          let hasSku = false;
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.updateMyCart;
            if (c) {
              cartVersion = c.version ?? cartVersion;
              lineCount = c.lineItems?.length ?? 0;
              total = c.totalPrice?.centAmount ?? null;
              hasSku = (c.lineItems ?? []).some((li) => li.variant?.sku === sku);
            }
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400 && hasSku,
            note: `sku=${sku} lines=${lineCount} total=${total} hasSku=${hasSku} : ${txt.slice(0, 500)}`,
          };
        });

        // 7e. Verify with the rich getMyActiveCart query.
        await tStep("cart_verify", async () => {
          const verifyQuery = `query getMyActiveCart {
  me {
    activeCart {
      id version
      totalPrice { centAmount __typename }
      lineItems {
        id quantity
        totalPrice { centAmount __typename }
        variant { sku __typename }
        __typename
      }
      __typename
    }
    __typename
  }
}`;
          const res = await gqlPost({
            operationName: "getMyActiveCart",
            variables: {},
            query: verifyQuery,
          });
          const txt = await res.text();
          let hasSku = false;
          let lineCount = 0;
          try {
            const j = JSON.parse(txt);
            const lis = j?.data?.me?.activeCart?.lineItems ?? [];
            lineCount = lis.length;
            hasSku = lis.some((li) => li.variant?.sku === sku);
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400 && hasSku,
            note: `lines=${lineCount} hasSku=${hasSku} : ${txt.slice(0, 400)}`,
          };
        });
      } else {
        steps.push({
          step: "cart_atc",
          ok: false,
          note: `skipped: cartId=${cartId ?? "null"} sku=${sku ?? "null"}`,
        });
      }
    }

    return {
      ok: pdpStatus > 0 && pdpStatus < 400,
      steps,
      finalUrl: pdpUrl,
      cookies: ctx.jar.dump(),

      dryRun: true,
    };
  },
};
