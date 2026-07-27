import test from "node:test";
import assert from "node:assert/strict";
import { findCartLine, findCartLineAny, listCartLines } from "./bandai-cart.js";

const sample = {
  subCarts: [
    {
      cartSn: "c1",
      cartId: "id1",
      combinedShippings: [
        {
          lineItems: [
            {
              cartLineItemSn: "line-gundam",
              product: {
                areaItemNo: "NAI0859145AU",
                productCode: "N2890904001",
                qty: 1,
              },
            },
          ],
        },
      ],
    },
  ],
};

test("findCartLine matches productCode as well as areaItemNo", () => {
  assert.equal(findCartLine(sample, "NAI0859145AU")?.cartItemSn, "line-gundam");
  assert.equal(findCartLine(sample, "N2890904001")?.cartItemSn, "line-gundam");
});

test("findCartLineAny tries NAI then frontend N", () => {
  const hit = findCartLineAny(sample, ["N2890904001", "NAI0859145AU"]);
  assert.equal(hit?.cartItemSn, "line-gundam");
  assert.deepEqual(listCartLines(sample).map((l) => l.areaItemNo), ["NAI0859145AU"]);
});
