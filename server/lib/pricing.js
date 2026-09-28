/**
 * Server-side cart pricing for crypto checkout.
 *
 * Single source of truth: products-api POST /msolpeptides-api/coupon-quote (127.0.0.1:4000), which runs the same
 * priceCheck the order path (notify-order) runs: catalog strength prices + pack tiers. Nothing is written there.
 *
 * Storefront rules mirrored here (checkout.html v3.00k8m4c): total = catalog subtotal + shipping, shipping is
 * $18.99 for "express" and $0 for "ground"; no coupon/tier discount is deducted from what the customer pays.
 * The shop does not send the ship method on /api/checkout/crypto, so express is inferred when the client total
 * minus the client item sum is $18.99 (or when body.shipMethod === "express").
 */
export const DEFAULT_QUOTE_URL = "http://127.0.0.1:4000/msolpeptides-api/coupon-quote";
export const EXPRESS_SHIPPING = 18.99;

function cents(n) {
  return Math.round(Number(n) * 100);
}
function fmt(c) {
  return (c / 100).toFixed(2);
}

/** sku "bpc-157-10mg" -> slug + mg, as the storefront builds it. */
export function splitCartSku(sku) {
  const s = String(sku || "").trim();
  const m = s.match(/^(.+?)-(\d+(?:\.\d+)?(?:mg|mcg|g|iu|ml))$/i);
  if (m) return { slug: m[1].toLowerCase(), mg: m[2].toLowerCase() };
  return { slug: /^[a-z0-9-]{1,64}$/i.test(s) ? s.toLowerCase() : "", mg: "" };
}

/**
 * items: [{ sku, name, qty, amount }] where amount is the LINE total (crypto payload).
 * Returns { ok, amount, subtotal, shipping, clientAmount, mismatch, unknownItems } or { ok:false, error, status }.
 */
export async function priceCryptoCart(input, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const url = deps.url || process.env.CRYPTO_PRICING_URL || DEFAULT_QUOTE_URL;
  const items = Array.isArray(input.items) ? input.items : [];
  const lines = items.map((it) => {
    const qty = Math.max(1, parseInt(it.qty ?? it.quantity, 10) || 1);
    const { slug, mg } = splitCartSku(it.sku);
    const lineCents = cents(it.amount ?? 0);
    return { slug, mg, name: String(it.name || "").replace(/\s+\d+(?:\.\d+)?\s*(mg|mcg|g|iu|ml)$/i, "").slice(0, 120), qty, lineCents };
  });
  const clientItemsCents = lines.reduce((a, l) => a + (Number.isFinite(l.lineCents) ? l.lineCents : 0), 0);
  const clientAmountCents = cents(input.amount);
  const explicit = String(input.shipMethod || input.shippingMethod || "").toLowerCase();
  const express = explicit
    ? explicit === "express"
    : Math.abs(clientAmountCents - clientItemsCents - cents(EXPRESS_SHIPPING)) <= 1;
  const shippingCents = express ? cents(EXPRESS_SHIPPING) : 0;

  let quote;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coupon: "",
        items: lines.map((l) => ({ slug: l.slug, name: l.name, mg: l.mg, qty: l.qty, price: l.qty ? Math.max(0, l.lineCents) / 100 / l.qty : 0 })),
        shippingCost: fmt(shippingCents),
      }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
    quote = await res.json().catch(() => null);
    if (!res.ok || !quote || quote.ok !== true) return { ok: false, error: "pricing_unavailable", status: 503 };
  } catch {
    return { ok: false, error: "pricing_unavailable", status: 503 };
  }
  const unknownItems = Array.isArray(quote.unknown_items) ? quote.unknown_items.map(String) : [];
  // A line the catalog cannot price cannot be sold at a browser-chosen price.
  if (unknownItems.length) return { ok: false, error: "unknown_item", status: 400, unknownItems };
  const subtotalCents = cents(quote.subtotal);
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) return { ok: false, error: "pricing_unavailable", status: 503 };
  const amountCents = subtotalCents + shippingCents;
  return {
    ok: true,
    amount: fmt(amountCents),
    subtotal: fmt(subtotalCents),
    shipping: fmt(shippingCents),
    shipMethod: express ? "express" : "ground",
    clientAmount: Number.isFinite(clientAmountCents) ? fmt(clientAmountCents) : null,
    mismatch: !Number.isFinite(clientAmountCents) || Math.abs(clientAmountCents - amountCents) > 0,
    source: "products-api:coupon-quote",
    discountInfo: { pct: quote.discount_pct || 0, source: quote.discount_source || "none", note: "not deducted (storefront charges full total)" },
  };
}
