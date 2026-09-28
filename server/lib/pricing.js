/**
 * Server-side cart pricing for crypto and card checkout.
 *
 * Source of truth: products-api POST /msolpeptides-api/coupon-quote (127.0.0.1:4000, read-only), the same catalog +
 * pack-tier priceCheck notify-order runs (unit U per strength; 2+ bottles round(U*89/99), 3+ round(U*79/99)).
 *
 * Storefront rules mirrored (checkout.html v3.00k8m4c):
 *  - total = sum of lines + shipping; shipping $18.99 "express", $0 "ground"; no coupon/tier discount deducted.
 *  - The ship method is not sent, so express is inferred when client total − client item sum = $18.99
 *    (or body.shipMethod === "express").
 *  - The free research solvent (BAC gift, slug "research-solvent") is $0 and is not a catalog product.
 *  - Lines added through the pack picker carry pack-tier prices; a few older add paths keep the 1-bottle price at
 *    qty 2+. Both are real storefront prices, so a client line equal to either is honoured exactly; anything else
 *    (tampered / stale) is repriced to the catalog pack-tier price and the order is flagged.
 */
export const DEFAULT_QUOTE_URL = "http://127.0.0.1:4000/msolpeptides-api/coupon-quote";
export const EXPRESS_SHIPPING = 18.99;
export const FREE_SLUGS = new Set(["research-solvent"]);

function cents(n) {
  return Math.round(Number(n) * 100);
}
function fmt(c) {
  return (c / 100).toFixed(2);
}

/** sku "bpc-157-10mg" -> slug + mg, as the storefront builds it. */
export function splitCartSku(sku) {
  const s = String(sku || "").trim().replace(/\.html$/i, "");
  const m = s.match(/^(.+?)-(\d+(?:\.\d+)?(?:mg|mcg|g|iu|ml))$/i);
  if (m) return { slug: m[1].toLowerCase(), mg: m[2].toLowerCase() };
  return { slug: /^[a-z0-9-]{1,64}$/i.test(s) ? s.toLowerCase() : "", mg: "" };
}

async function quoteLine(fetchImpl, url, line, qty) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ coupon: "", items: [{ slug: line.slug, name: line.name, mg: line.mg, qty, price: 0 }], shippingCost: "0" }),
    signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
  });
  const q = await res.json().catch(() => null);
  if (!res.ok || !q || q.ok !== true) throw new Error("pricing_unavailable");
  if (Array.isArray(q.unknown_items) && q.unknown_items.length) return null;
  const c = cents(q.subtotal);
  return Number.isFinite(c) && c > 0 ? c : null;
}

/**
 * input: { amount, items:[{sku,name,qty,amount}], shipMethod? }
 * opts.itemAmount: "line" (crypto payload: amount = line total) | "unit" (card payload: amount = unit price)
 * Returns { ok, amount, subtotal, shipping, shipMethod, clientAmount, mismatch, lines } or { ok:false, error, status }.
 */
export async function priceCart(input, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const url = opts.url || process.env.CART_PRICING_URL || process.env.CRYPTO_PRICING_URL || DEFAULT_QUOTE_URL;
  const unitMode = opts.itemAmount === "unit";
  const items = Array.isArray(input?.items) ? input.items : [];
  if (!items.length) return { ok: false, error: "items_required", status: 400 };
  const lines = items.map((it) => {
    const qty = Math.max(1, parseInt(it.qty ?? it.quantity, 10) || 1);
    const { slug, mg } = splitCartSku(it.sku || it.slug);
    const raw = cents(it.amount ?? it.price ?? 0);
    const clientLineCents = Number.isFinite(raw) ? (unitMode ? raw * qty : raw) : NaN;
    return {
      sku: String(it.sku || ""),
      slug,
      mg,
      name: String(it.name || "").replace(/\s+\d+(?:\.\d+)?\s*(mg|mcg|g|iu|ml)$/i, "").slice(0, 120),
      qty,
      clientLineCents,
    };
  });
  const clientItemsCents = lines.reduce((a, l) => a + (Number.isFinite(l.clientLineCents) ? l.clientLineCents : 0), 0);
  const clientAmountCents = cents(input.amount);
  const explicit = String(input.shipMethod || input.shippingMethod || "").toLowerCase();
  const express = explicit
    ? explicit === "express"
    : Math.abs(clientAmountCents - clientItemsCents - cents(EXPRESS_SHIPPING)) <= 1;
  const shippingCents = express ? cents(EXPRESS_SHIPPING) : 0;

  let priced;
  try {
    priced = await Promise.all(
      lines.map(async (l) => {
        if (FREE_SLUGS.has(l.slug)) return { ...l, lineCents: 0, rule: "free_gift" };
        if (!l.slug) return { ...l, unknown: true };
        const [tier, unit] = await Promise.all([quoteLine(fetchImpl, url, l, l.qty), l.qty > 1 ? quoteLine(fetchImpl, url, l, 1) : null]);
        if (tier == null) return { ...l, unknown: true };
        const unitTotal = unit != null ? unit * l.qty : tier;
        if (l.clientLineCents === tier) return { ...l, lineCents: tier, rule: "pack_tier" };
        if (l.clientLineCents === unitTotal) return { ...l, lineCents: unitTotal, rule: "single_bottle" };
        return { ...l, lineCents: tier, rule: "repriced", catalogLineCents: tier };
      }),
    );
  } catch {
    return { ok: false, error: "pricing_unavailable", status: 503 };
  }
  const unknownItems = priced.filter((l) => l.unknown).map((l) => l.slug || l.sku || "?");
  if (unknownItems.length) return { ok: false, error: "unknown_item", status: 400, unknownItems };
  const subtotalCents = priced.reduce((a, l) => a + l.lineCents, 0);
  if (!(subtotalCents > 0)) return { ok: false, error: "pricing_unavailable", status: 503 };
  const amountCents = subtotalCents + shippingCents;
  return {
    ok: true,
    amount: fmt(amountCents),
    subtotal: fmt(subtotalCents),
    shipping: fmt(shippingCents),
    shipMethod: express ? "express" : "ground",
    clientAmount: Number.isFinite(clientAmountCents) ? fmt(clientAmountCents) : null,
    mismatch: !Number.isFinite(clientAmountCents) || clientAmountCents !== amountCents,
    source: "products-api:coupon-quote",
    lines: priced.map((l) => ({ sku: l.sku, slug: l.slug, mg: l.mg, qty: l.qty, line: fmt(l.lineCents), unit: fmt(Math.round(l.lineCents / l.qty)), rule: l.rule })),
  };
}

/** Crypto payload (line totals). Kept for the existing call sites. */
export function priceCryptoCart(input, deps = {}) {
  return priceCart(input, { ...deps, itemAmount: "line" });
}

/** Card payload (unit prices). */
export function priceCardCart(input, deps = {}) {
  return priceCart(input, { ...deps, itemAmount: "unit" });
}
