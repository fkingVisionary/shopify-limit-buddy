import assert from "node:assert/strict";
import {
  normalizePcLocale,
  resolvePcLocale,
  pcBaseFor,
  localeUsesGlobalE,
  parseProductUrl,
  resolveSku,
  PC_LOCALES,
} from "./pokemoncentre-session.js";
import {
  extractReeseScriptPath,
  looksLikeIncapsulaChallenge,
  parseDataDomeObject,
  looksLikeDataDomeBlock,
} from "../antibot.js";
import { extractHcaptchaSitekey, looksLikeHcaptcha } from "./pokemoncentre-hcaptcha.js";
import { parsePdpAvailability } from "./pokemoncentre-cortex.js";

assert.equal(normalizePcLocale("AU"), "en-au");
assert.equal(normalizePcLocale("en_NZ"), "en-nz");
assert.equal(normalizePcLocale("uk"), "en-gb");
assert.equal(normalizePcLocale("jp"), null);
assert.ok(PC_LOCALES.includes("en-au"));

assert.equal(resolvePcLocale({ pdpUrl: "https://www.pokemoncenter.com/en-gb/product/x/y" }), "en-gb");
assert.equal(resolvePcLocale({ pcLocale: "NZ" }), "en-nz");
assert.equal(resolvePcLocale({}), "en-au");
assert.equal(pcBaseFor("en-au"), "https://www.pokemoncenter.com/en-au");
assert.equal(localeUsesGlobalE("en-au"), true);
assert.equal(localeUsesGlobalE("en-us"), false);

const p = parseProductUrl(
  "https://www.pokemoncenter.com/en-au/product/10-10186-109/pokemon-tcg-elite-trainer-box",
);
assert.equal(p.locale, "en-au");
assert.equal(p.sku, "10-10186-109");
assert.ok(p.slug.includes("elite-trainer"));

assert.equal(
  resolveSku({ pdpUrl: "https://www.pokemoncenter.com/en-au/product/99-1/foo" }),
  "99-1",
);
assert.equal(resolveSku({ sku: "ABC" }), "ABC");

// Incapsula challenge shell (live DC shape)
const incapHtml = `<html><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"><script src="/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C" async></script></head><body><iframe id="main-iframe" src="/_Incapsula_Resource?SWUDNSAI=31"></iframe></body></html>`;
assert.equal(looksLikeIncapsulaChallenge(incapHtml, 200), true);
assert.equal(
  extractReeseScriptPath(incapHtml),
  "/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C",
);

const ddHtml = `<html><body><script>var dd={'rt':'c','cid':'ABC','hsh':'HASH','t':'bv','s':9817,'e':'ee','host':'geo.captcha-delivery.com','cookie':'ddcookie'}</script></body></html>`;
assert.equal(looksLikeDataDomeBlock(ddHtml, 403, { get: () => "protected" }), true);
const dd = parseDataDomeObject(ddHtml);
assert.ok(dd);
assert.equal(dd.t, "bv");
assert.equal(dd.rt, "c");

const hcHtml2 = `<div class="h-captcha" data-sitekey="10000000-aaaa-bbbb-cccc-000000000001"></div>`;
assert.equal(extractHcaptchaSitekey(hcHtml2), "10000000-aaaa-bbbb-cccc-000000000001");
assert.equal(looksLikeHcaptcha(hcHtml2), true);

const avail = parsePdpAvailability(
  `<html><h1>Pokémon TCG ETB</h1><button>Add to Cart</button></html>`,
);
assert.equal(avail.available, true);
assert.equal(avail.title, "Pokémon TCG ETB");

// Adapter host match — JP online must NOT match
import { pokemoncentreAdapter } from "./pokemoncentre.js";
assert.equal(pokemoncentreAdapter.matches("www.pokemoncenter.com"), true);
assert.equal(pokemoncentreAdapter.matches("pokemoncenter.com"), true);
assert.equal(pokemoncentreAdapter.matches("www.pokemoncenter-online.com"), false);
assert.equal(pokemoncentreAdapter.matches("p-bandai.com"), false);

console.log("pokemoncentre-locale.test.mjs ok");
