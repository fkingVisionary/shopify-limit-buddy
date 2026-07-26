// Premium Bandai AU — cart JSON helpers (shared by HTTP + browser paths).

/** Walk Bandai cart.detail — lines live under subCarts[].combinedShippings[].lineItems[]. */
export function findCartLine(cartJson, areaItemNo) {
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
      const aino = prod.areaItemNo || it.areaItemNo;
      if (areaItemNo && String(aino || "") !== String(areaItemNo)) continue;
      if (!areaItemNo && !aino) continue;
      return {
        cartSn: sc.cartSn,
        cartId: sc.cartId,
        cartItemSn: it.cartLineItemSn || it.cartItemSn || prod.cartItemSn || null,
        cartType: sc.cartType,
        qty: prod.qty || it.qty || 1,
        areaItemNo: aino,
        line: it,
        sub: sc,
      };
    }
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
          qty: it.product?.qty,
        });
      }
    }
  }
  return out;
}

export default { findCartLine, listCartLines };
