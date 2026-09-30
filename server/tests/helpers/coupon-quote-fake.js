// infra 2026-09-29 honest-charge: fake of products-api POST /coupon-quote (catalog pack tiers + COUPONS + 5/10/15 ladder,
// coupon and ladder do not stack: larger percent wins, a tie goes to the coupon; shipping is never discounted).
// Mirrors discountFields() in products-api.cjs so tests exercise the same arithmetic the live endpoint does.
export const CATALOG = {
  "bpc-157": { "10mg": 88, "20mg": 105 },
  kpv: { "10mg": 79 },
  semax: { "10mg": 99, "30mg": 119 },
  "g1-s": { "5mg": 60 },
  "aod-9604": { "5mg": 42 },
  "g3-r": { "50mg": 300 },
};
export const COUPONS = { INSIDER25: 25 };

export function couponQuoteFake({ catalog = CATALOG, coupons = COUPONS, mutate } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    let sum = 0;
    const unknown = [];
    for (const it of body.items) {
      const p = catalog[it.slug];
      const u = p ? (p[it.mg] ?? Object.values(p)[0]) : undefined;
      if (u === undefined) { unknown.push(it.slug); continue; }
      const unit = it.qty >= 3 ? Math.round((u * 79) / 99) : it.qty >= 2 ? Math.round((u * 89) / 99) : u;
      sum += unit * it.qty;
    }
    const subC = Math.round(sum * 100);
    const shipC = Math.round(Number(body.shippingCost || 0) * 100);
    const code = String(body.coupon || "").trim().toUpperCase();
    const couponPct = Object.prototype.hasOwnProperty.call(coupons, code) ? coupons[code] : 0;
    let tierPct = 0, tierMin = 0;
    for (const [min, pct] of [[500, 15], [250, 10], [100, 5]]) if (subC >= min * 100) { tierMin = min; tierPct = pct; break; }
    let pct = 0, source = "none";
    if (subC > 0) {
      if (couponPct > 0 && couponPct >= tierPct) { pct = couponPct; source = `coupon:${code}`; }
      else if (tierPct > 0) { pct = tierPct; source = `tier:${tierMin}`; }
    }
    const discC = Math.round((subC * pct) / 100);
    let reply = {
      ok: true, coupon: code, recognized: Object.prototype.hasOwnProperty.call(coupons, code),
      subtotal: (subC / 100).toFixed(2), shipping: (shipC / 100).toFixed(2), discount: (discC / 100).toFixed(2),
      discount_pct: pct, discount_source: source, total_due: ((subC + shipC - discC) / 100).toFixed(2), price_mismatch: false,
      ...(unknown.length ? { unknown_items: unknown } : {}),
    };
    if (mutate) reply = mutate(reply, body, calls.length) || reply; // calls.length = 1-based call number
    return { ok: true, status: 200, json: async () => reply };
  };
  fn.calls = calls;
  return fn;
}
