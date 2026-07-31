// node --test desktop/bandai-product-image.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  absolutizeBandaiUrl,
  pickBandaiImageUrl,
} = require("./bandai-product-image.cjs");

test("absolutizeBandaiUrl prefixes relative file paths", () => {
  assert.equal(
    absolutizeBandaiUrl("files/seller-products/x/a.jpg"),
    "https://p-bandai.com/files/seller-products/x/a.jpg",
  );
  assert.equal(
    absolutizeBandaiUrl("https://cdn.example/a.jpg"),
    "https://cdn.example/a.jpg",
  );
});

test("pickBandaiImageUrl reads mediaSection and productImages", () => {
  assert.equal(
    pickBandaiImageUrl({
      mediaSection: {
        images: [{ fileUrl: "files/seller-products/NSP/a.jpg" }],
      },
    }),
    "https://p-bandai.com/files/seller-products/NSP/a.jpg",
  );
  assert.equal(
    pickBandaiImageUrl({
      productImages: [{ fileUrl: "https://p-bandai.com/files/b.jpg" }],
    }),
    "https://p-bandai.com/files/b.jpg",
  );
  assert.equal(pickBandaiImageUrl({}), "");
});
