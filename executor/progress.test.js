import test from "node:test";
import assert from "node:assert/strict";
import { stageForStep } from "./progress.js";

test("shipping_ensure stays on login (before Adding to cart)", () => {
  assert.equal(stageForStep("shipping_ensure"), "login");
});

test("addToCart / cart_detail map to cart (Adding to cart)", () => {
  assert.equal(stageForStep("addToCart"), "cart");
  assert.equal(stageForStep("addToCart_bridge"), "cart");
  assert.equal(stageForStep("cart_hold"), "cart");
  assert.equal(stageForStep("cart_detail"), "cart");
});

test("pay-from-cart verify maps to details (not Adding to cart)", () => {
  assert.equal(stageForStep("held_cart_verify"), "details");
  assert.equal(stageForStep("held_cart_ok"), "details");
});

test("cart_checkout maps to details (Checking out)", () => {
  assert.equal(stageForStep("cart_checkout"), "details");
  assert.equal(stageForStep("cart_checkout_bridge"), "details");
});

test("login → cart → checkout stage order is preserved", () => {
  const path = ["login", "shipping_ensure", "product_get", "addToCart", "cart_detail", "cart_checkout"];
  assert.deepEqual(
    path.map(stageForStep),
    ["login", "login", "product", "cart", "cart", "details"],
  );
});
