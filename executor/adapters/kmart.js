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
      const snippet = pdpHtml.length < 1500 ? pdpHtml.replace(/\s+/g, " ").trim().slice(0, 1200) : `${pdpHtml.length}b`;
      const srv = res.headers.get("server");
      const aka = res.headers.get("x-akamai-transformed") ?? res.headers.get("akamai-grn") ?? "";
      return { status: res.status, ok: res.status < 400, note: `${snippet} | server=${srv} ${aka}` };
    });

    // 5b. PDP 403 = SBSD challenge (script src has `?v=<uuid>`). Solve two
    //     SBSD rounds (index 0, 1) per Hyper docs §3.3, then retry PDP.
    if (pdpStatus === 403) {
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

    return {
      ok: pdpStatus > 0 && pdpStatus < 400,
      steps,
      finalUrl: pdpUrl,
      cookies: ctx.jar.dump(),
      dryRun: true,
    };
  },
};
