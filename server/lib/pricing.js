/**
 * Server-side cart pricing for crypto and card checkout.
 *
 * Source of truth: products-api POST /msolpeptides-api/coupon-quote (127.0.0.1:4000, read-only), the same catalog +
 * pack-tier priceCheck notify-order runs (unit U per strength; 2+ bottles round(U*89/99), 3+ round(U*79/99)).
 *
 * infra 2026-09-29 honest-charge: the charged amount is `total_due` of ONE coupon-quote for the whole cart (coupon, volume
 * ladder, shipping all decided by products-api). No local ladder, no browser figure, no "single bottle" price: see
 * docs/HONEST_CHARGE.md.
 *
 * Storefront rules mirrored (checkout.html v3.00k8m4c):
 *  - total = sum of lines + shipping - discount; shipping $18.99 "express", $0 "ground".
 *  - The ship method is not sent, so express is inferred when client total − client item sum = $18.99
 *    (or body.shipMethod === "express").
 *  - The free research solvent (BAC gift, slug "research-solvent") is $0 and is not a catalog product.
 *  - A client line equal to the catalog pack-tier price is "pack_tier"; anything else (tampered / stale / old 1-bottle
 *    price at qty 2+) is "repriced" to the catalog price.
 */
export const DEFAULT_QUOTE_URL = "http://127.0.0.1:4000/msolpeptides-api/coupon-quote";
export const EXPRESS_SHIPPING = 18.99;
export const FREE_SLUGS = new Set(["research-solvent"]);

/**
 * 2026-09-29 FedEx 2-Day only (storefront 3.00k8m5f, PR #68). Behind SHIP_ENFORCE_FEDEX=true (or opts.enforceFedex) so the
 * old storefront (Ground free / Express $18.99 by choice) keeps working until the new one is live.
 *   base     = catalog merchandise (gift / research-solvent excluded) minus the ONE discount products-api coupon-quote applies
 *              (volume ladder or a winning coupon; they do not stack), shipping NOT in the base. Same base as checkout.html
 *              fedexShipRow() (getVolumePricing().discounted, which takes the winning coupon from coupon-quote too).
 *   shipping = base > $100.00 (strictly) ? $0 ("ground" row) : $18.99 ("express" row). Both rows are FedEx 2-Day (RAPID_SHIP_MAP).
 * The browser's shipMethod never lowers the price: "ground"/free sent for a base at or under $100 -> 400 shipping_mismatch
 * (charged:false, nothing created). "express" sent for a base over $100 -> priced free (the customer is never charged more
 * than the rule). No shipMethod -> the server row.
 */
export const FEDEX_FREE_OVER_CENTS = 10000;
export function fedexEnforced(opts = {}) {
  if (typeof opts.enforceFedex === "boolean") return opts.enforceFedex;
  return String(process.env.SHIP_ENFORCE_FEDEX || "").trim().toLowerCase() === "true";
}
/** baseCents = merchandise after discounts. -> { baseCents, shippingCents, shipMethod } */
export function fedexShipRowFromBase(baseCents) {
  const free = baseCents > FEDEX_FREE_OVER_CENTS;
  return { baseCents, shippingCents: free ? 0 : cents(EXPRESS_SHIPPING), shipMethod: free ? "ground" : "express" };
}
/** Volume ladder only (no coupon): merchCents -> row. */
export function fedexShipRow(merchCents) {
  return fedexShipRowFromBase(volumeDiscountedCents(merchCents).cents);
}
export const SHIPPING_MISMATCH_MESSAGE =
  "Shipping has been updated: FedEx 2-Day is $18.99, free on orders over $100 after discounts. You were not charged. Please refresh checkout and try again.";

/**
 * Storefront volume tier, mirrored from cart-vial.js "Footer v4" (volumePct / updateTotals, v3.00k8m4d):
 *   merch = sum(price * qty) over non-gift lines (gift / research-solvent excluded), before shipping
 *   pct   = merch >= 500 ? 15 : merch >= 250 ? 10 : merch >= 100 ? 5 : 0      (thresholds inclusive, undiscounted merch)
 *   now   = Math.round(merch * (1 - pct / 100) * 100) / 100                     (rounded to the cent, JS Math.round)
 * Shipping is not discounted and no coupon is applied (the checkout coupon note never changes the total).
 * infra 2026-09-29 honest-charge: NOT used for the charged amount any more (products-api coupon-quote owns the ladder and
 * its coupon rule). Kept exported only because tests reference it.
 */
export function volumePct(merchDollars) {
  if (merchDollars >= 500) return 15;
  if (merchDollars >= 250) return 10;
  if (merchDollars >= 100) return 5;
  return 0;
}
export function volumeDiscountedCents(merchCents) {
  const merch = merchCents / 100;
  const pct = volumePct(merch);
  if (!pct) return { pct: 0, cents: merchCents };
  return { pct, cents: Math.round(merch * (1 - pct / 100) * 100) };
}

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

const COUPON_CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COUPON_NOTE_RE = /(?:^|[\s;,|])coupon:([A-Za-z0-9_-]{1,40})/;
/** infra 2026-09-29 honest-charge: coupon from body.coupon, else "coupon:CODE" in notes (what the page sends today). "" = none. */
export function couponFromInput(input) {
  const direct = typeof input?.coupon === "string" ? input.coupon.trim() : "";
  if (COUPON_CODE_RE.test(direct)) return direct.toUpperCase();
  const m = COUPON_NOTE_RE.exec(String(input?.notes || ""));
  return m ? m[1].toUpperCase() : "";
}

/** One coupon-quote for the whole cart. Returns the reply, { unknown } or throws pricing_unavailable. */
async function quoteCart(fetchImpl, url, { coupon, lines, shippingCents }) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      coupon,
      items: lines.map((l) => ({ slug: l.slug, name: l.name, mg: l.mg, qty: l.qty, price: fmt(Math.round(l.lineCents / l.qty)) })),
      shippingCost: fmt(shippingCents),
    }),
    signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
  });
  const q = await res.json().catch(() => null);
  if (!res.ok || !q || q.ok !== true) throw new Error("pricing_unavailable");
  return q;
}

/**
 * input: { amount, items:[{sku,name,qty,amount}], shipMethod?, coupon?, notes? }
 * opts.itemAmount: "line" (crypto payload: amount = line total) | "unit" (card payload: amount = unit price)
 * Returns { ok, amount, subtotal, shipping, shipMethod, clientAmount, mismatch, lines, discount, coupon, volumeDiscount }
 * or { ok:false, error, status }.
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
  const explicit = String(input.shipMethod || input.shippingMethod || "").trim().toLowerCase();
  const enforce = fedexEnforced(opts);
  let express = explicit
    ? explicit === "express"
    : Math.abs(clientAmountCents - clientItemsCents - cents(EXPRESS_SHIPPING)) <= 1;
  let shippingCents = express ? cents(EXPRESS_SHIPPING) : 0;
  let shipRule = null;

  const coupon = couponFromInput(input);
  let priced;
  let quote;
  try {
    // Per-line quotes only give the catalog price of each line (order emails and store-forward read lines[]).
    priced = await Promise.all(
      lines.map(async (l) => {
        if (FREE_SLUGS.has(l.slug)) return { ...l, lineCents: 0, rule: "free_gift" };
        if (!l.slug) return { ...l, unknown: true };
        const tier = await quoteLine(fetchImpl, url, l, l.qty);
        if (tier == null) return { ...l, unknown: true };
        return { ...l, lineCents: tier, rule: l.clientLineCents === tier ? "pack_tier" : "repriced" };
      }),
    );
    if (enforce && !priced.some((l) => l.unknown) && priced.some((l) => l.lineCents > 0)) {
      // One quote without shipping gives the discount (ladder or winning coupon); shipping is never discounted, so
      // total_due with shipping = this total_due + shipping. The second quote below re-checks that arithmetic.
      const q0 = await quoteCart(fetchImpl, url, { coupon, lines: priced.filter((l) => !FREE_SLUGS.has(l.slug)), shippingCents: 0 });
      const merchC = priced.reduce((a, l) => a + (FREE_SLUGS.has(l.slug) ? 0 : l.lineCents), 0);
      const d0 = cents(q0.discount ?? "0");
      if (!Number.isFinite(d0) || d0 < 0 || cents(q0.subtotal) !== merchC) throw new Error("pricing_unavailable");
      const row = fedexShipRowFromBase(merchC - d0);
      // "ground" (or any non-express value) = the browser asked for free shipping. Refused when the rule says $18.99.
      if (row.shippingCents > 0 && explicit && explicit !== "express") {
        return { ok: false, error: "shipping_mismatch", status: 400, charged: false, message: SHIPPING_MISMATCH_MESSAGE,
          shipping: fmt(row.shippingCents), shipMethod: row.shipMethod, base: fmt(row.baseCents), clientShipMethod: explicit };
      }
      express = row.shipMethod === "express";
      shippingCents = row.shippingCents;
      shipRule = { rule: "fedex_2day_free_over_100", base: fmt(row.baseCents), clientShipMethod: explicit || null, overridden: Boolean(explicit) && explicit !== row.shipMethod };
    }
    if (!priced.some((l) => l.unknown) && priced.some((l) => l.lineCents > 0)) {
      quote = await quoteCart(fetchImpl, url, { coupon, lines: priced.filter((l) => !FREE_SLUGS.has(l.slug)), shippingCents });
    }
  } catch {
    return { ok: false, error: "pricing_unavailable", status: 503 };
  }
  const unknownItems = priced.filter((l) => l.unknown).map((l) => l.slug || l.sku || "?");
  if (unknownItems.length) return { ok: false, error: "unknown_item", status: 400, unknownItems };
  const subtotalCents = priced.reduce((a, l) => a + l.lineCents, 0);
  if (!(subtotalCents > 0) || !quote) return { ok: false, error: "pricing_unavailable", status: 503 };
  if (Array.isArray(quote.unknown_items) && quote.unknown_items.length) {
    return { ok: false, error: "unknown_item", status: 400, unknownItems: quote.unknown_items.map(String) };
  }
  // infra 2026-09-29 honest-charge: the whole-cart quote must agree with the per-line catalog prices and with its own arithmetic; otherwise the catalog
  // moved between the calls or the reply is malformed, and we do not charge a number we cannot explain.
  const quoteSubC = cents(quote.subtotal);
  const discC = cents(quote.discount ?? "0");
  const dueC = cents(quote.total_due);
  if (quoteSubC !== subtotalCents || !Number.isFinite(discC) || discC < 0 || !Number.isFinite(dueC) || dueC <= 0 || dueC !== subtotalCents + shippingCents - discC) {
    return { ok: false, error: "pricing_unavailable", status: 503 };
  }
  const source = String(quote.discount_source || "none");
  const pct = discC > 0 ? Number(quote.discount_pct) || 0 : 0;
  return {
    ok: true,
    amount: fmt(dueC),
    subtotal: fmt(subtotalCents),
    shipping: fmt(shippingCents),
    shipMethod: express ? "express" : "ground",
    ...(shipRule ? { shipService: "fedex_2day", shipRule } : {}),
    clientAmount: Number.isFinite(clientAmountCents) ? fmt(clientAmountCents) : null,
    mismatch: !Number.isFinite(clientAmountCents) || clientAmountCents !== dueC,
    coupon,
    discount: { pct, source, amount: fmt(discC) },
    volumeDiscount: discC > 0 && source.startsWith("tier:") ? { pct, merch: fmt(subtotalCents), discount: fmt(discC), merchAfter: fmt(subtotalCents - discC) } : null,
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
