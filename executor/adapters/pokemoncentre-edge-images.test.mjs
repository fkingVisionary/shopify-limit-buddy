import assert from "node:assert/strict";
import { extractDdSliderImages } from "./pokemoncentre-edge.js";

const escaped =
  'x https:\\/\\/dd.prod.captcha-delivery.com\\/image\\/p1.jpg y https:\\/\\/dd.prod.captcha-delivery.com\\/image\\/p1.frag.png z';
const r = extractDdSliderImages(escaped);
assert.equal(r.puzzleUrl, "https://dd.prod.captcha-delivery.com/image/p1.jpg");
assert.equal(r.pieceUrl, "https://dd.prod.captcha-delivery.com/image/p1.frag.png");
assert.equal(r.needsHcaptcha, false);

const plain = extractDdSliderImages(
  'https://dd.prod.captcha-delivery.com/image/abc.jpg https://dd.prod.captcha-delivery.com/image/abc.frag.png',
);
assert.ok(plain.puzzleUrl?.endsWith(".jpg"));
assert.ok(plain.pieceUrl?.endsWith(".frag.png"));

const hc = extractDdSliderImages(
  '<div class="h-captcha" data-sitekey="aaaaaaaaaaaaaaaaaa"></div>',
);
assert.equal(hc.puzzleUrl, null);
assert.equal(hc.needsHcaptcha, true);

console.log("pokemoncentre-edge-images.test.mjs ok");
