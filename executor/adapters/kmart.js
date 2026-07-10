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

import { request, UA, OXYLABS_ENABLED } from "../http.js";
import { resolveEgressIp } from "../ip-resolve.js";
import { hyperConfigured, solveAkamaiSensor, solveAkamaiPixel, solveAkamaiSbsd } from "../antibot.js";
import { randomUUID } from "node:crypto";

// Detects the SBSD script tag served inside Akamai SBSD challenge HTML
// (often returned with 403 or 429 status). Pattern per Hyper docs §3.4:
//   <script src="/path?v=<token>[&t=<token>]">
// `v` is an opaque token (NOT necessarily UUID-shaped), and the presence
// of `t=` distinguishes a HARD challenge (1 sensor submission, §3.3) from
// passive SBSD (2 submissions). The previous UUID-strict matcher missed
// all real Kmart challenges because their `v` value is not UUID-formatted.
const SBSD_RE = /src=["']([a-z\d\/\-_.]+)\?v=([^"'&]+)(?:&[^"']*?t=([^"'&]+))?["']/i;
function parseSbsd(html) {
  const m = SBSD_RE.exec(html);
  if (!m) return null;
  return { path: m[1], uuid: m[2], t: m[3] ?? "" };
}


import { parseAkamaiPath, isAkamaiCookieValid } from "hyper-sdk-js";

const ACCEPT_LANG = "en-AU,en;q=0.9";

// Human-pace jitter. Fixed delays are themselves a bot signature; always
// randomise within a range. Min/max in ms.
const sleep = (min, max) =>
  new Promise((r) => setTimeout(r, Math.floor(min + Math.random() * (max - min))));

// Realistic intermediate browsing pages — pick one at random to fetch
// between warm_home and pdp_get so the nav path is home → category → PDP
// instead of a straight home → PDP jump.
const CATEGORY_PATHS = [
  "/category/toys/D110000",
  "/category/home/D100000",
  "/category/kids-clothing/D170000",
  "/category/sale/D310000",
  "/category/kitchen-dining/D250000",
];

// Chrome 124 / macOS navigation header shape. Akamai scores requests on the
// presence + ordering of these client hints; a Chrome UA without matching
// sec-ch-ua + sec-fetch-* is an instant bot tag.
// Chrome 131 macOS client hints — basic (low entropy) + high entropy.
// Real Chrome sends the high-entropy hints (arch/bitness/full-version-list/
// model/platform-version) on navigation requests whenever the origin has
// previously responded with Accept-CH (Kmart does). Sending only the low-
// entropy trio is a classic headless-Chrome tell.
const CHROME_CH = {
  "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
  "sec-ch-ua-arch": '"x86"',
  "sec-ch-ua-bitness": '"64"',
  "sec-ch-ua-full-version": '"131.0.6778.265"',
  "sec-ch-ua-full-version-list":
    '"Not(A:Brand";v="99.0.0.0", "Google Chrome";v="131.0.6778.265", "Chromium";v="131.0.6778.265"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-model": '""',
  "sec-ch-ua-platform": '"macOS"',
  "sec-ch-ua-platform-version": '"14.6.1"',
};
// Real Chrome 133 link-click navigation header set. Notable absences:
//   - NO `cache-control` / `pragma` — those only appear on a hard reload
//     (CMD+SHIFT+R). Sending them on every nav is a strong bot signal.
//   - `priority: u=0, i` is sent on every top-level navigation.
function navHeaders({ referer, site }) {
  return {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": ACCEPT_LANG,
    "accept-encoding": "gzip, deflate, br, zstd",
    "upgrade-insecure-requests": "1",
    ...CHROME_CH,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": site,
    "sec-fetch-user": "?1",
    priority: "u=0, i",
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
        const detail = (() => {
          if (e?.code === "antibot_misconfigured") return "HYPER_API_KEY missing on executor";
          const parts = [e?.message ?? String(e)];
          if (e?.cause) parts.push(`cause=${e.cause?.message ?? JSON.stringify(e.cause)}`);
          if (e?.response) {
            try {
              parts.push(`resp=${JSON.stringify({ status: e.response.status, data: e.response.data })}`);
            } catch {}
          }
          if (e?.data) {
            try { parts.push(`data=${JSON.stringify(e.data)}`); } catch {}
          }
          return parts.join(" | ").slice(0, 800);
        })();
        steps.push({
          step: name,
          ok: false,
          status: null,
          ms: Date.now() - t0,
          note: detail,
        });
        throw e;
      }
    };

    // Oxylabs Web Unblocker handles Akamai for us — mark the session so http.js
    // pins the same residential IP across the flow, and skip our own solves.
    if (OXYLABS_ENABLED) {
      ctx.oxylabsSessionId = randomUUID();
      steps.push({
        step: "unblocker",
        ok: true,
        note: `oxylabs session=${ctx.oxylabsSessionId.slice(0, 8)} (skipping Akamai/SBSD/pixel solves)`,
      });
    } else if (!hyperConfigured()) {
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
      const warmHeaders = navHeaders({ site: "none" });
      steps.push({
        step: "warm_home:hdrs",
        ok: true,
        note: JSON.stringify({ url: origin + "/", headers: warmHeaders, cookieHeader: ctx.jar.header() }),
      });
      const res = await request(
        origin + "/",
        { method: "GET", headers: warmHeaders },
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

    // 2b. PROACTIVE SBSD SOLVE. Kmart runs passive SBSD on the whole site.
    //     Real Chrome fetches + solves the SBSD script on the homepage
    //     before any protected nav (category/PDP). Without it, `_abck`
    //     alone is not enough and category/PDP hard-403 with no in-body
    //     challenge (see `sbsd_missing` note on prior runs). Docs §3.5.
    const runSbsd = async (sourceHtml, pageUrl, label) => {
      const parsed = parseSbsd(sourceHtml);
      if (!parsed) {
        steps.push({ step: `${label}:none`, ok: true, note: "no SBSD script tag in HTML" });
        return false;
      }
      const sbsdPath = parsed.path.startsWith("/") ? parsed.path : "/" + parsed.path;
      const sbsdScriptUrl = origin + sbsdPath + `?v=${parsed.uuid}${parsed.t ? `&t=${parsed.t}` : ""}`;
      const sbsdPostUrl = origin + sbsdPath + (parsed.t ? `?t=${parsed.t}` : "");
      let sbsdBody = "";
      await tStep(`${label}:script_fetch`, async () => {
        const r = await request(
          sbsdScriptUrl,
          {
            method: "GET",
            headers: {
              "user-agent": UA,
              referer: pageUrl,
              "accept-language": ACCEPT_LANG,
              accept: "*/*",
              "sec-fetch-dest": "script",
              "sec-fetch-mode": "no-cors",
              "sec-fetch-site": "same-origin",
            },
          },
          ctx,
        );
        sbsdBody = await r.text();
        return { status: r.status, note: `uuid=${parsed.uuid.slice(0, 8)} ${sbsdBody.length}b t=${parsed.t || "-"}` };
      });
      const rounds = parsed.t ? 1 : 2; // hard = 1, passive = 2 (docs §3.3)
      for (let i = 0; i < rounds; i++) {
        await tStep(`${label}:round#${i}`, async () => {
          const payload = await solveAkamaiSbsd({
            jar: ctx.jar,
            pageUrl,
            scriptBody: sbsdBody,
            uuid: parsed.uuid,
            oCookie: ctx.jar.get("bm_so") ?? ctx.jar.get("sbsd_o") ?? "",
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
                referer: pageUrl,
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
              },
              body: JSON.stringify({ body: payload }),
            },
            ctx,
          );
          const sbsdKeys = Object.keys(ctx.jar.dump()).filter((k) => /sbsd|bm_s/.test(k)).join(",");
          return { status: res.status, ok: res.status < 400, note: `jarSbsd=${sbsdKeys} bm_sv=${ctx.jar.has("bm_sv")}` };
        }).catch(() => {});
      }
      return true;
    };
    try {
      await runSbsd(html, origin + "/", "sbsd_home");
    } catch (e) {
      steps.push({ step: "sbsd_home:error", ok: false, note: e?.message ?? String(e) });
    }

    // Human pause: glance at homepage before the browser pulls the sensor script.
    await sleep(800, 1500);

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
          version: "3",
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
        steps.push({ step: "abck_raw", ok: true, note: ctx.jar.get("_abck") ?? "(empty)" });
        steps.push({ step: "bmsz_raw", ok: true, note: ctx.jar.get("bm_sz") ?? "(empty)" });
        break;
      }
      // Sensors are JS-scheduled; back-to-back posts with zero gap are a tell.
      await sleep(200, 400);
    }

    if (!abckSolved(ctx.jar, 3)) {
      steps.push({ step: "akamai_unsolved", ok: false, note: "_abck never reached ~0~ after 3 rounds" });
      return { ok: false, steps, finalUrl: origin, cookies: ctx.jar.dump() };
    }


    // Recon helper: dump exact request headers + cookie-jar snapshot at the
    // moment of a request. Used to compare against a real browser when
    // Akamai 403s after a clean sensor solve.
    const dumpRequestState = (label, url, headers) => {
      const jarDump = ctx.jar.dump();
      // Minimal recon: URL, header order, cookie names + abck/bm_sz markers only.
      // Full cookie/header dump was bloating step notes and getting our
      // post-pdp steps cut off by upstream truncation. Trim aggressively.
      const abck = String(jarDump._abck ?? "");
      const bmsz = String(jarDump.bm_sz ?? "");
      const marker = (v) => {
        if (!v) return "(none)";
        const m = v.match(/~(-?\d+)~/);
        return `${v.length}b ind=${m?.[1] ?? "?"}`;
      };
      steps.push({
        step: label,
        ok: true,
        note: JSON.stringify({
          url,
          hdrs: Object.keys(headers).length,
          ck: Object.keys(jarDump),
          abck: marker(abck),
          bmsz: marker(bmsz),
        }),
      });
    };


    // 4b. Pre-PDP pixel solve. If warm_home embedded a pixel challenge, solve
    //     it now to upgrade the bot score BEFORE the gated navigation. Pixel
    //     posts arrive as a `bm_so` cookie that Akamai's risk engine reads on
    //     the next request. Non-fatal: most warm_home responses don't carry
    //     a pixel, in which case this is a no-op.
    try {
      const warmPixel = await solveAkamaiPixel({
        jar: ctx.jar,
        pageUrl: origin + "/",
        html,
        userAgent: UA,
        ip: egressIp,
        acceptLanguage: ACCEPT_LANG,
        ctx,
      });
      if (warmPixel) {
        await tStep("akamai_pixel_prepdp", async () => {
          const res = await request(
            warmPixel.postUrl,
            {
              method: "POST",
              headers: {
                "user-agent": UA,
                "content-type": "application/x-www-form-urlencoded",
                origin,
                referer: origin + "/",
                "accept-language": ACCEPT_LANG,
              },
              body: warmPixel.payload,
            },
            ctx,
          );
          return { status: res.status, note: `pixel posted, bm_so=${ctx.jar.has("bm_so")}` };
        });
      } else {
        steps.push({ step: "akamai_pixel_prepdp", ok: true, note: "no pixel on warm_home" });
      }
    } catch (e) {
      steps.push({ step: "akamai_pixel_prepdp", ok: false, note: e?.message ?? String(e) });
    }

    // 4c. Intermediate category browse. Real users don't teleport from the
    //     homepage to a deep PDP — they click into a category first. Hitting
    //     /category/* gives Akamai a same-origin nav with a sensible referer
    //     chain (none → home → category → pdp) and an extra 200 to learn from.
    const catPath = CATEGORY_PATHS[Math.floor(Math.random() * CATEGORY_PATHS.length)];
    const catUrl = origin + catPath;
    let categoryStatus = 0;
    let categoryHtml = "";
    let categoryOk = false;
    await sleep(700, 1400); // brief glance at homepage before the click
    await tStep("category_browse", async () => {
      const res = await request(
        catUrl,
        { method: "GET", headers: navHeaders({ referer: origin + "/", site: "same-origin" }) },
        ctx,
      );
      categoryStatus = res.status;
      categoryHtml = await res.text();
      categoryOk = res.status < 400;
      const hasSbsd = Boolean(parseSbsd(categoryHtml));
      return { status: res.status, ok: categoryOk, note: `${catPath} ${categoryHtml.length}b sbsd=${hasSbsd}` };
    });

    // If the category hop is the first route to expose the SBSD block, solve it
    // there and retry the category before moving on. A real browser cannot click
    // from a 403 category page into the PDP, so keeping that failed hop in the
    // journey makes the next request look impossible.
    if (!categoryOk && categoryHtml) {
      try {
        const solvedCategorySbsd = await runSbsd(categoryHtml, catUrl, "sbsd_category");
        if (solvedCategorySbsd) {
          await sleep(350, 850);
          await tStep("category_browse#2", async () => {
            const res = await request(
              catUrl,
              { method: "GET", headers: navHeaders({ referer: origin + "/", site: "same-origin" }) },
              ctx,
            );
            categoryStatus = res.status;
            categoryHtml = await res.text();
            categoryOk = res.status < 400;
            const snippet = categoryHtml.replace(/\s+/g, " ").trim().slice(0, 180);
            return { status: res.status, ok: categoryOk, note: `${catPath} ${categoryHtml.length}b | ${snippet}` };
          });
        }
      } catch (e) {
        steps.push({ step: "sbsd_category:error", ok: false, note: e?.message ?? String(e) });
      }
    }
    // Human dwell on the category page before clicking through to the PDP.
    // 1.5–3s is the critical gap — Akamai's risk model is sensitive to the
    // home→PDP interval being unrealistically short.
    await sleep(1500, 3000);

    // 5. Hit the PDP — this is the gated request and the real success signal.
    let pdpStatus = 0;
    let pdpHtml = "";
    {
      const pdpReferer = categoryOk ? catUrl : origin + "/";
      const pdpHeaders = navHeaders({ referer: pdpReferer, site: "same-origin" });
      dumpRequestState("pdp_get:recon", pdpUrl, pdpHeaders);
      steps.push({
        step: "pdp_get:hdrs",
        ok: true,
        note: JSON.stringify({ url: pdpUrl, headers: pdpHeaders, cookieHeader: ctx.jar.header() }),
      });
      await tStep("pdp_get", async () => {
        const res = await request(pdpUrl, { method: "GET", headers: pdpHeaders }, ctx);
        pdpStatus = res.status;
        pdpHtml = await res.text();
        const snippet = pdpHtml.replace(/\s+/g, " ").trim().slice(0, 300);
        const hasRefScript = /<script[^>]+src=["'][^"']*\?v=/i.test(pdpHtml);
        const hasRefMarker = /Reference\s*#|Access\s+Denied/i.test(pdpHtml);
        return {
          status: res.status,
          ok: res.status < 400,
          note: `${pdpHtml.length}b srv=${res.headers.get("server") ?? "-"} ct=${res.headers.get("content-type") ?? "-"} refMk=${hasRefMarker} refScr=${hasRefScript} | ${snippet}`,
        };
      });
      if (pdpHtml && pdpHtml.length < 10000) {
        steps.push({ step: "pdp_body_full", ok: true, note: pdpHtml });
      }
    }

    // Verify the proxy session held the same egress IP from warm_home through
    // pdp_get. If the IP drifted, Akamai will hard-block because `_abck` was
    // solved on a different IP than the one making the PDP request.
    await tStep("verify_ip", async () => {
      const ipNow = await resolveEgressIp(ctx, { force: true });
      const same = ipNow && egressIp && ipNow === egressIp;
      return { ok: Boolean(same), note: `start=${egressIp ?? "?"} now=${ipNow ?? "?"} same=${Boolean(same)}` };
    });



    // 5b. SBSD challenge — the PDP response (200 OR 403/429) carries a
    //     `<script src="/path?v=<token>[&t=<token>]">` tag. Hyper docs §3.4:
    //     fetch the script, POST to /sbsd, then POST the payload to
    //     `/path?t=<t>`. Hard challenge (t present) = 1 round; passive = 2.
    if (parseSbsd(pdpHtml)) {
      await runSbsd(pdpHtml, pdpUrl, "sbsd_pdp");
      await sleep(450, 950);
      const pdp2Headers = navHeaders({ referer: categoryOk ? catUrl : origin + "/", site: "same-origin" });
      dumpRequestState("pdp_get#2:recon", pdpUrl, pdp2Headers);
      await tStep("pdp_get#2", async () => {
        const res = await request(pdpUrl, { method: "GET", headers: pdp2Headers }, ctx);
        pdpStatus = res.status;
        pdpHtml = await res.text();
        const snippet = pdpHtml.length < 1500 ? pdpHtml.replace(/\s+/g, " ").trim().slice(0, 1200) : `ok ${pdpHtml.length}b`;
        const respHeaders = {
          server: res.headers.get("server"),
          "akamai-grn": res.headers.get("akamai-grn"),
          "set-cookie-count": (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []).length,
        };
        return { status: res.status, ok: res.status < 400, note: `resp=${JSON.stringify(respHeaders)} | ${snippet}` };
      });
    } else if (pdpStatus >= 400) {
      steps.push({ step: "sbsd_missing", ok: false, note: `pdp ${pdpStatus} body had no SBSD script tag` });
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
      // 7a. Solve Akamai for api.kmart.com.au — separate _abck scope.
      //     Cookie jar is name-keyed (not domain-keyed), so the api-host
      //     sensor responses will overwrite the www host's _abck. That's
      //     fine: we're done with www after pdp_get#2.
      let apiSeedHtml = "";
      let apiScriptPath = null;
      await tStep("api_warm", async () => {
        const res = await request(
          apiOrigin + "/",
          {
            method: "GET",
            headers: {
              "user-agent": UA,
              accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
        apiSeedHtml = await res.text();
        apiScriptPath = findAkamaiScriptPath(apiSeedHtml);
        return {
          status: res.status,
          ok: Boolean(apiScriptPath),
          note: `${apiSeedHtml.length}b script=${apiScriptPath ?? "(none)"}`,
        };
      });
      steps.push({ step: "api_warm_body_full", ok: true, note: apiSeedHtml.slice(0, 5000) });

      if (apiScriptPath) {
        const apiScriptUrl = apiOrigin + apiScriptPath;
        let apiScriptBody = "";
        await tStep("api_script_fetch", async () => {
          const r = await request(
            apiScriptUrl,
            { method: "GET", headers: { "user-agent": UA, referer: apiOrigin + "/", "accept-language": ACCEPT_LANG } },
            ctx,
          );
          apiScriptBody = await r.text();
          return { status: r.status, note: `${apiScriptBody.length}b` };
        });

        let apiPrev = null;
        let apiSolved = false;
        for (let i = 0; i < 3; i++) {
          await tStep(`api_sensor#${i + 1}`, async () => {
            const r = await solveAkamaiSensor({
              jar: ctx.jar,
              pageUrl: apiOrigin + "/",
              userAgent: UA,
              ip: egressIp,
              acceptLanguage: ACCEPT_LANG,
              scriptUrl: apiScriptUrl,
              scriptBody: apiScriptBody,
              prevContext: apiPrev,
            });
            apiPrev = r.context;
            const res = await request(
              r.postUrl,
              {
                method: "POST",
                headers: {
                  "user-agent": UA,
                  "content-type": "text/plain;charset=UTF-8",
                  accept: "*/*",
                  "accept-language": ACCEPT_LANG,
                  origin: apiOrigin,
                  referer: apiOrigin + "/",
                },
                body: JSON.stringify({ sensor_data: r.payload }),
              },
              ctx,
            );
            return { status: res.status, note: `abck=${(ctx.jar.get("_abck") ?? "").slice(0, 40)}…` };
          });
          if (abckSolved(ctx.jar, i + 1)) {
            apiSolved = true;
            steps.push({ step: "api_akamai_solved", ok: true, note: `rounds=${i + 1}` });
            break;
          }
        }
        if (!apiSolved) {
          steps.push({ step: "api_akamai_unsolved", ok: false, note: "_abck not ~0~ after 3 rounds on api host" });
        }

        // SBSD on the api host, if present.
        const apiSbsd = parseSbsd(apiSeedHtml);
        if (apiSbsd) {
          const sbsdScriptUrl =
            apiOrigin + (apiSbsd.path.startsWith("/") ? apiSbsd.path : "/" + apiSbsd.path) +
            `?v=${apiSbsd.uuid}${apiSbsd.t ? `&t=${apiSbsd.t}` : ""}`;
          const sbsdPostUrl =
            apiOrigin + (apiSbsd.path.startsWith("/") ? apiSbsd.path : "/" + apiSbsd.path) +
            (apiSbsd.t ? `?t=${apiSbsd.t}` : "");
          let apiSbsdBody = "";
          await tStep("api_sbsd_script_fetch", async () => {
            const r = await request(
              sbsdScriptUrl,
              { method: "GET", headers: { "user-agent": UA, referer: apiOrigin + "/", "accept-language": ACCEPT_LANG } },
              ctx,
            );
            apiSbsdBody = await r.text();
            return { status: r.status, note: `uuid=${apiSbsd.uuid.slice(0, 8)} ${apiSbsdBody.length}b t=${apiSbsd.t || "-"}` };
          });
          const apiRounds = apiSbsd.t ? 1 : 2;
          for (let i = 0; i < apiRounds; i++) {
            await tStep(`api_sbsd_round#${i}`, async () => {
              const payload = await solveAkamaiSbsd({
                jar: ctx.jar,
                pageUrl: apiOrigin + "/",
                scriptBody: apiSbsdBody,
                uuid: apiSbsd.uuid,
                oCookie: ctx.jar.get("bm_so") ?? ctx.jar.get("sbsd_o") ?? "",
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
                    origin: apiOrigin,
                    referer: apiOrigin + "/",
                  },
                  body: JSON.stringify({ body: payload }),
                },
                ctx,
              );
              const bodyTxt = (await res.text()).slice(0, 160).replace(/\s+/g, " ");
              return { status: res.status, note: `body="${bodyTxt}"` };
            });
          }
        }
      }


      // 7b. getActiveBag — me.activeCart may be null on first run.
      let cartId = null;
      let cartVersion = null;
      steps.push({
        step: "cart_get:hdrs",
        ok: true,
        note: JSON.stringify({ url: gqlUrl, headers: gqlHeaders, cookieHeader: ctx.jar.header() }),
      });
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
        steps.push({ step: "cart_get_body_full", ok: true, note: `srv=${res.headers.get("server") ?? "-"} ct=${res.headers.get("content-type") ?? "-"} | ${txt.slice(0, 4500)}` });
        return {
          status: res.status,
          ok: res.status < 400,
          note: `${txt.length}b activeCart=${cartId ? `${cartId.slice(0, 8)} v${cartVersion}` : "null"}`,
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

      // ===================================================================
      // 8. CHECKOUT FLOW
      //    Address → billing → Paydock card vault → create3DSToken.
      //    Stops short of placeOrder until task.placeOrder === true AND we
      //    have the final mutation captured.
      // ===================================================================
      const wantCheckout = task.checkout !== false && cartId && sku;
      if (wantCheckout) {
        // 8a. Warm the checkout pages — establishes the referer chain that
        //     later GraphQL calls expect (some ops are referer-gated).
        let checkoutHtml = "";
        await tStep("checkout_warm", async () => {
          const r1 = await request(
            origin + "/checkout/bag",
            { method: "GET", headers: navHeaders({ referer: pdpUrl, site: "same-origin" }) },
            ctx,
          );
          const b1 = await r1.text();
          const r2 = await request(
            origin + "/checkout/delivery",
            { method: "GET", headers: navHeaders({ referer: origin + "/checkout/bag", site: "same-origin" }) },
            ctx,
          );
          const b2 = await r2.text();
          const r3 = await request(
            origin + "/checkout/payment",
            { method: "GET", headers: navHeaders({ referer: origin + "/checkout/delivery", site: "same-origin" }) },
            ctx,
          );
          checkoutHtml = await r3.text();
          return {
            status: r3.status,
            ok: r3.status < 400,
            note: `bag=${r1.status}/${b1.length}b delivery=${r2.status}/${b2.length}b payment=${r3.status}/${checkoutHtml.length}b`,
          };
        });

        // Identity (hardcoded for now — wire to task.identity in a later batch).
        const identity = {
          firstName: task.firstName ?? "morgan",
          lastName: task.lastName ?? "edwards",
          email: task.email ?? "flowgdesigns@gmail.com",
          phone: task.phone ?? "0429444444",
        };
        const cncStoreId = "1124";

        // 8b. setShippingAddress (contact) + addItemShippingAddress (C&C store).
        const updateNoStockQuery = `mutation updateMyBagWithoutBagStockAvailability($id: String!, $version: Long!, $actions: [MyCartUpdateAction!]!) {
  updateMyCart(id: $id, version: $version, actions: $actions) {
    id version
    totalPrice { centAmount __typename }
    shippingAddress { firstName lastName email phone country __typename }
    billingAddress { firstName lastName email phone country __typename }
    itemShippingAddresses { key country __typename }
    __typename
  }
}`;

        const contactAddress = {
          firstName: identity.firstName,
          lastName: identity.lastName,
          email: identity.email,
          phone: identity.phone,
          country: "AU",
        };
        // C&C store address — uses key=storeId so commercetools can tie line
        // items to a pickup destination via shippingDetails.
        const storeAddress = {
          key: cncStoreId,
          firstName: "Kmart",
          lastName: cncStoreId,
          country: "AU",
        };

        await tStep("checkout_set_address", async () => {
          const res = await gqlPost({
            operationName: "updateMyBagWithoutBagStockAvailability",
            variables: {
              id: cartId,
              version: cartVersion,
              actions: [
                { setShippingAddress: { address: contactAddress } },
                { addItemShippingAddress: { address: storeAddress } },
              ],
            },
            query: updateNoStockQuery,
          });
          const txt = await res.text();
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.updateMyCart;
            if (c?.version) cartVersion = c.version;
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400,
            note: `v=${cartVersion} : ${txt.slice(0, 350)}`,
          };
        });

        // 8c. setShippingAddress + setBillingAddress.
        await tStep("checkout_set_billing", async () => {
          const res = await gqlPost({
            operationName: "updateMyBagWithoutBagStockAvailability",
            variables: {
              id: cartId,
              version: cartVersion,
              actions: [
                { setShippingAddress: { address: contactAddress } },
                { setBillingAddress: { address: contactAddress } },
              ],
            },
            query: updateNoStockQuery,
          });
          const txt = await res.text();
          let hasBilling = false;
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.updateMyCart;
            if (c?.version) cartVersion = c.version;
            hasBilling = Boolean(c?.billingAddress?.email);
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400 && hasBilling,
            note: `v=${cartVersion} hasBilling=${hasBilling} : ${txt.slice(0, 350)}`,
          };
        });

        // 8d. Refresh — snapshot version + totals before payment.
        await tStep("checkout_refresh", async () => {
          const res = await gqlPost({
            operationName: "getMyActiveBag",
            variables: {},
            query:
              "query getMyActiveBag { me { activeCart { id version totalPrice { centAmount __typename } lineItems { id quantity variant { sku __typename } __typename } billingAddress { email __typename } shippingAddress { email __typename } __typename } __typename } }",
          });
          const txt = await res.text();
          try {
            const j = JSON.parse(txt);
            const c = j?.data?.me?.activeCart;
            if (c?.version) cartVersion = c.version;
          } catch {}
          return {
            status: res.status,
            ok: res.status < 400,
            note: `v=${cartVersion} : ${txt.slice(0, 300)}`,
          };
        });

        // 8e. Paydock card vault. Tokenizes the PAN → returns a UUID we feed
        //     into create3DSToken. Public key is scraped from the checkout
        //     page bundle (Paydock client SDK embeds it).
        // Prefer per-request card (sent by the control plane) over Fly env.
        // This keeps the PAN out of the executor's secret store and matches
        // the future profiles-sourced flow.
        const reqCard = task.card ?? {};
        const cardNumber = String(reqCard.number ?? process.env.KMART_CARD_NUMBER ?? "");
        const cardCcv = String(reqCard.cvv ?? process.env.KMART_CARD_CVV ?? "");
        const cardMonth = String(reqCard.expMonth ?? process.env.KMART_CARD_EXPIRY_MONTH ?? "");
        const cardYear = String(reqCard.expYear ?? process.env.KMART_CARD_EXPIRY_YEAR ?? "");
        const cardHolder = String(reqCard.holder ?? process.env.KMART_CARD_HOLDER ?? `${identity.firstName} ${identity.lastName}`);
        const paydockPublicKey =
          process.env.PAYDOCK_PUBLIC_KEY ||
          checkoutHtml.match(/"(?:publicKey|public_key|paydockPublicKey)"\s*:\s*"([^"]+)"/i)?.[1] ||
          checkoutHtml.match(/public[-_]?key["']?\s*[:=]\s*["']([a-zA-Z0-9._-]{20,})/)?.[1] ||
          "";

        // Derive Paydock gateway type from card BIN.
        const firstDigit = cardNumber.charAt(0);
        const first2 = cardNumber.slice(0, 2);
        let gatewayType = "Visa";
        if (firstDigit === "5" || (first2 >= "22" && first2 <= "27")) gatewayType = "MasterCard";
        else if (first2 === "34" || first2 === "37") gatewayType = "Amex";

        let oneTimeToken = null;
        if (!cardNumber || !cardCcv) {
          steps.push({
            step: "paydock_tokenize",
            ok: false,
            note: "skipped: KMART_CARD_NUMBER / KMART_CARD_CVV not set",
          });
        } else {
          await tStep("paydock_tokenize", async () => {
            const headers = {
              "user-agent": UA,
              "content-type": "application/json",
              accept: "application/json",
              "accept-language": ACCEPT_LANG,
              origin,
              referer: origin + "/checkout/payment",
              ...CHROME_CH,
              "sec-fetch-site": "cross-site",
              "sec-fetch-mode": "cors",
              "sec-fetch-dest": "empty",
            };
            if (paydockPublicKey) headers["x-user-public-key"] = paydockPublicKey;
            const res = await request(
              "https://api.paydock.com/v1/payment_sources/tokens",
              {
                method: "POST",
                headers,
                body: JSON.stringify({
                  type: "card",
                  card_name: cardHolder,
                  card_number: cardNumber,
                  expire_month: cardMonth,
                  expire_year: cardYear,
                  card_ccv: cardCcv,
                  gateway_id: "",
                  store_ccv: true,
                  meta: {},
                }),
              },
              ctx,
            );
            const txt = await res.text();
            try {
              const j = JSON.parse(txt);
              oneTimeToken = j?.resource?.data ?? null;
            } catch {}
            return {
              status: res.status,
              ok: res.status < 400 && Boolean(oneTimeToken),
              note: `gateway=${gatewayType} pk=${paydockPublicKey ? paydockPublicKey.slice(0, 12) + "…" : "(none)"} token=${oneTimeToken ? oneTimeToken.slice(0, 12) + "…" : "null"} : ${txt.slice(0, 250)}`,
            };
          });
        }

        // 8f. create3DSToken — hands the Paydock UUID to Kmart's payment
        //     orchestrator. Returns a payment token or a 3DS challenge URL.
        let paymentToken = null;
        let threeDSStatus = null;
        let acsUrl = null;
        let sessionData = null;
        if (oneTimeToken) {
          await tStep("create_3ds_token", async () => {
            const res = await gqlPost({
              operationName: "create3DSToken",
              variables: {
                oneTimeToken,
                gatewayType,
                saveCardOption: false,
                useSavedCard: false,
              },
              query:
                "mutation create3DSToken($oneTimeToken: String!, $gatewayType: String!, $saveCardOption: Boolean!, $useSavedCard: Boolean!) { create3DSToken(oneTimeToken: $oneTimeToken, gatewayType: $gatewayType, saveCardOption: $saveCardOption, useSavedCard: $useSavedCard) { token acsUrl sessionData status __typename } }",
            });
            const txt = await res.text();
            try {
              const j = JSON.parse(txt);
              const c = j?.data?.create3DSToken;
              if (c) {
                paymentToken = c.token ?? null;
                threeDSStatus = c.status ?? null;
                acsUrl = c.acsUrl ?? null;
                sessionData = c.sessionData ?? null;
              }
            } catch {}
            return {
              status: res.status,
              ok: res.status < 400 && Boolean(paymentToken || acsUrl),
              note: `status=${threeDSStatus} token=${paymentToken ? paymentToken.slice(0, 10) + "…" : "null"} acs=${acsUrl ? "yes" : "no"} : ${txt.slice(0, 300)}`,
            };
          });
        } else {
          steps.push({
            step: "create_3ds_token",
            ok: false,
            note: "skipped: no oneTimeToken from Paydock",
          });
        }

        // 8f.2. handle_3ds — branch on the 3DS status.
        //   • not_required / authenticated / succeeded → frictionless, proceed.
        //   • challenge / pending / requires_challenge → issuer step-up
        //     (form POST to acsUrl with PaReq + browser redirect back). Not
        //     achievable in a pure HTTP chain; log + stop so the timeline
        //     surfaces the exact case.
        if (paymentToken || threeDSStatus) {
          const frictionless =
            !threeDSStatus ||
            /not[_-]?required|authenticated|succeeded|completed|frictionless/i.test(String(threeDSStatus));
          if (frictionless && paymentToken) {
            steps.push({ step: "handle_3ds", ok: true, note: `frictionless status=${threeDSStatus ?? "(none)"}` });
          } else {
            steps.push({
              step: "handle_3ds",
              ok: false,
              note: `challenge required status=${threeDSStatus} acs=${acsUrl ?? "(none)"} sessionData=${sessionData ? "yes" : "no"} — issuer step-up not supported in HTTP chain`,
            });
          }
        }

        // 8g. bundle_recon — scan checkout bundle JS for order-mutation op
        //     names so we can wire the real placeOrder without a HAR. Runs
        //     only when the caller opts into a real submit and no explicit
        //     mutation was supplied.
        if (task.placeOrder === true && !task.placeOrderMutation) {
          await tStep("bundle_recon", async () => {
            const hits = new Set();
            const scanText = (txt) => {
              let m;
              const reMut = /mutation\s+([A-Za-z_][A-Za-z0-9_]*)/g;
              while ((m = reMut.exec(txt)) !== null) {
                if (/order|submit|place|checkout/i.test(m[1])) hits.add(m[1]);
              }
              const reOp = /operationName["']?\s*[:=]\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g;
              while ((m = reOp.exec(txt)) !== null) {
                if (/order|submit|place|checkout/i.test(m[1])) hits.add(m[1]);
              }
            };
            scanText(checkoutHtml);
            const scriptSrcs = Array.from(
              checkoutHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi),
              (mm) => mm[1],
            )
              .filter((s) => /_next|main|checkout|payment|bundle/i.test(s))
              .slice(0, 3);
            for (const src of scriptSrcs) {
              try {
                const abs = src.startsWith("http") ? src : origin + (src.startsWith("/") ? src : `/${src}`);
                const r = await request(
                  abs,
                  { method: "GET", headers: { referer: origin + "/checkout/payment", "user-agent": UA } },
                  ctx,
                );
                const t = await r.text();
                scanText(t);
              } catch {}
            }
            return {
              ok: hits.size > 0,
              note: hits.size > 0 ? `candidates: ${Array.from(hits).slice(0, 20).join(", ")}` : "no order-mutation op names found",
            };
          });
        }

        // 8h. placeOrder — real submit. Requires:
        //   - task.placeOrder === true
        //   - task.placeOrderMutation = { operationName, query, extraVars? }
        //   - paymentToken from create3DSToken (frictionless 3DS)
        // The mutation signature varies per commercetools tenant; we send
        // { paymentToken, cartId, cartVersion, gatewayType, ...extraVars }
        // and let the caller supply the exact query captured from live
        // traffic (via bundle_recon output or a real HAR).
        let orderNumber = null;
        let orderId = null;
        let paymentStatus = null;
        if (task.placeOrder === true) {
          const mut = task.placeOrderMutation;
          if (!mut?.operationName || !mut?.query) {
            steps.push({
              step: "place_order",
              ok: false,
              note: "skipped: task.placeOrderMutation { operationName, query } not supplied — check bundle_recon candidates",
            });
          } else if (!paymentToken) {
            steps.push({
              step: "place_order",
              ok: false,
              note: "skipped: no paymentToken from create3DSToken",
            });
          } else {
            await tStep("place_order", async () => {
              const res = await gqlPost({
                operationName: mut.operationName,
                variables: {
                  paymentToken,
                  cartId,
                  cartVersion,
                  gatewayType,
                  ...(mut.extraVars ?? {}),
                },
                query: mut.query,
              });
              const txt = await res.text();
              try {
                const j = JSON.parse(txt);
                const walk = (o) => {
                  if (!o || typeof o !== "object") return;
                  for (const [k, v] of Object.entries(o)) {
                    if (typeof v === "string") {
                      if (/^orderNumber$/i.test(k) && !orderNumber) orderNumber = v;
                      if (/paymentStatus|orderState/i.test(k) && !paymentStatus) paymentStatus = v;
                    } else if (v && typeof v === "object") {
                      if (typeof v.orderNumber === "string" && !orderNumber) orderNumber = v.orderNumber;
                      if (typeof v.id === "string" && !orderId && /order/i.test(k)) orderId = v.id;
                      walk(v);
                    }
                  }
                };
                walk(j?.data ?? {});
              } catch {}
              return {
                status: res.status,
                ok: res.status < 400 && Boolean(orderNumber || orderId),
                note: `order=${orderNumber ?? orderId ?? "null"} paymentStatus=${paymentStatus ?? "null"} : ${txt.slice(0, 400)}`,
              };
            });
          }
        } else {
          steps.push({
            step: "place_order",
            ok: true,
            note: "skipped: task.placeOrder !== true (dry-run stop)",
          });
        }

        ctx.__kmart_order = { orderNumber, orderId, paymentStatus };
      }
    }

    const orderInfo = ctx.__kmart_order ?? {};
    return {
      ok: pdpStatus > 0 && pdpStatus < 400,
      steps,
      finalUrl: pdpUrl,
      cookies: ctx.jar.dump(),
      dryRun: task.placeOrder !== true,
      orderNumber: orderInfo.orderNumber ?? null,
      orderId: orderInfo.orderId ?? null,
      paymentStatus: orderInfo.paymentStatus ?? null,
    };
  },
};
