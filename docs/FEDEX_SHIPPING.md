# FedEx 2-Day shipping, priced server-side (2026-09-29, storefront 3.00k8m5f / PR #68)

Switch: `SHIP_ENFORCE_FEDEX=true` (drop-in `/etc/systemd/system/crm-umg.service.d/ship-enforce.conf`). Off = browser picks ground/express (old rule).

On:
- base = catalog merchandise (gift / `research-solvent` excluded) minus the ONE discount products-api coupon-quote applies
  (volume ladder 5/10/15 % or a winning coupon; they do not stack). Shipping is not in the base.
- shipping = base > $100.00 (strictly) ? $0 (`shipMethod: "ground"`) : $18.99 (`"express"`). Both rows ship FedEx 2-Day (RAPID_SHIP_MAP).
- Applies to `/api/checkout/charge` (Cleffo link, UMG card, cascade: all price through `priceCardCart`) and `/api/checkout/crypto` (`priceCryptoCart`).
- Browser sends `ground` (or any non-`express` value) while the rule says $18.99 -> 400 `shipping_mismatch`, `charged:false`, message
  "Shipping has been updated: FedEx 2-Day is $18.99, free on orders over $100 after discounts. You were not charged. Please refresh checkout and try again."
  Nothing is created or charged. Browser sends `express` while the base is over $100 -> priced free (never more than the rule).
- Stored: `priceCheck.shipping`, `priceCheck.shipMethod`, `shipService: "fedex_2day"`, `shipRule { base, clientShipMethod, overridden }`.

Examples: $99.00 -> $18.99 (117.99). $100.00 -> 95.00 after 5 % -> $18.99. $101 -> 95.95 -> $18.99. $105.26 -> 100.00 -> $18.99.
$105.27 -> 100.01 -> free. $130 -> 123.50 -> free. Tests: `server/tests/fedex-ship-enforce.test.js`.
