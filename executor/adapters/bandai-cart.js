// Premium Bandai AU — cart JSON helpers (shared by HTTP + browser paths).

/** Walk Bandai cart.detail — lines live under subCarts[].combinedShippings[].lineItems[]. */
export function findCartLine(cartJson, areaItemNo) {
  const want = areaItemNo != null && String(areaItemNo).trim() ? String(areaItemNo).trim() : null;
  const subs = Array.isArray(cartJson?.subCarts) ? cartJson.subCarts : [];
  for (const sc of subs) {
    const nested = [];
    for (const ship of sc.combinedShippings || []) {
      for (const it of ship.lineItems || []) nested.push(it);
    }
    for (const it of [
      ...nested,
      ...(sc.items || []),
      ...(sc.cartItems || []),
      ...(sc.lineItems || []),
    ]) {
      const prod = it.product || it;
      const ids = [
        prod.areaItemNo,
        it.areaItemNo,
        prod.productCode,
        prod.productSn,
        prod.code,
        it.productCode,
      ]
        .filter(Boolean)
        .map(String);
      if (want && !ids.some((id) => id === want)) continue;
      if (!want && !ids.length) continue;
      return {
        cartSn: sc.cartSn,
        cartId: sc.cartId,
        cartItemSn: it.cartLineItemSn || it.cartItemSn || prod.cartItemSn || null,
        cartType: sc.cartType,
        qty: prod.qty || it.qty || 1,
        areaItemNo: prod.areaItemNo || it.areaItemNo || ids[0] || null,
        matchedIds: ids,
        line: it,
        sub: sc,
      };
    }
  }
  return null;
}

/** Match any of several codes (NAI backend + frontend N… + productSn). */
export function findCartLineAny(cartJson, ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || "").trim()).filter(Boolean);
  for (const id of list) {
    const hit = findCartLine(cartJson, id);
    if (hit?.cartItemSn) return hit;
  }
  return null;
}

export function listCartLines(cartJson) {
  const out = [];
  for (const sc of cartJson?.subCarts || []) {
    for (const ship of sc.combinedShippings || []) {
      for (const it of ship.lineItems || []) {
        out.push({
          cartSn: sc.cartSn,
          cartId: sc.cartId,
          cartItemSn: it.cartLineItemSn || it.product?.cartItemSn,
          areaItemNo: it.product?.areaItemNo,
          productCode: it.product?.productCode || it.product?.code || null,
          qty: it.product?.qty,
        });
      }
    }
  }
  return out;
}

export default { findCartLine, findCartLineAny, listCartLines };
