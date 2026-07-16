const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseKmartPdpHtml, inferStockFromHtml, extractSearchProducts } = require("./kmart-stock-probe.cjs");

describe("parseKmartPdpHtml", () => {
  it("extracts sku/title/stock from __NEXT_DATA__", () => {
    const html = `<html><head><title>Foo | Kmart</title>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          product: {
            name: "Pokemon ETB",
            sku: "43671588",
            inStock: true,
            price: { centAmount: 4999 },
          },
        },
      },
    })}</script></head><body><button>Add to cart</button></body></html>`;
    const r = parseKmartPdpHtml(
      html,
      "https://www.kmart.com.au/product/pokemon-etb-43671588/",
    );
    assert.equal(r.ok, true);
    assert.equal(r.sku, "43671588");
    assert.equal(r.title, "Pokemon ETB");
    assert.equal(r.inStock, true);
    assert.equal(r.price, 49.99);
  });

  it("infers OOS from HTML copy", () => {
    assert.equal(inferStockFromHtml("<p>Out of stock</p>"), false);
    assert.equal(inferStockFromHtml('<button data-testid="addToCart">Add to cart</button>'), true);
  });
});

describe("extractSearchProducts", () => {
  it("pulls product links", () => {
    const html = `
      <a href="https://www.kmart.com.au/product/foo-bar-12345678/">x</a>
      <a href="https://www.kmart.com.au/product/baz-87654321/">y</a>
    `;
    const products = extractSearchProducts(html);
    assert.equal(products.length, 2);
    assert.ok(products.some((p) => p.sku === "12345678"));
  });
});
