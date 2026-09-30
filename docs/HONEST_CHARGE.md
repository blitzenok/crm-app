# Honest charge (infra, 2026-09-29)

This module charges real cards. The owner asked for three guarantees; the code carries `// infra 2026-09-29 honest-charge:`
markers where they live. Please keep them when you edit these files.

## 1. The amount is the server's `total_due`
- `lib/pricing.js` `priceCart()` sends ONE whole-cart request to products-api `POST /msolpeptides-api/coupon-quote`
  (`{coupon, items, shippingCost}`) and charges its `total_due`. Coupon, the 5/10/15 % volume ladder and the
  "larger percent wins, tie goes to the coupon" rule all live in products-api, not here.
- Coupon code: body field `coupon`, otherwise `coupon:CODE` inside `notes` (what the page sends). Empty = none.
- Per-line quotes only give catalog line prices for `lines[]` (emails, store-forward). Their sum must equal the
  whole-cart `subtotal`, and `total_due` must equal `subtotal + shipping - discount`; otherwise 503
  `pricing_unavailable` and nothing is charged.
- The browser's `amount` is only compared (`mismatch`). The old "single bottle price is accepted" rule and the local
  ladder (`VOLUME_DISCOUNT_ENABLED`) no longer touch the amount.
- The order stores `priceCheck.coupon` / `priceCheck.discount`; store-forward sends `orderData.coupon` so products-api
  computes the same `total_due_server` as the charge; the order emails show `Coupon CODE (N%)`.

## 2. A timeout is not a decline
- If the UMG create call ends with no clear answer (timeout, network, 5xx, 408, 429, empty body, 2xx without status),
  `processors/umg.js` asks UMG `GET /transactions/find-by-ext-id/{our key}` (2 s pause first).
  - found -> that transaction is the result: approved/PAID, DECLINED/CANCELED are decisions, any other status
    (PENDING, 3DS, "PROCESSING - PENDING VERIFICATION", new ones) keeps waiting with its txn id;
    txn ids already on the order are ignored (an older declined try under the same key);
  - HTTP 200 + `[]` -> not charged (soft, next processor, `noChargeConfirmed`) ONLY if the request cannot have reached UMG
    (ECONNREFUSED / ENOTFOUND / EAI_AGAIN, or UMG's own JSON 429 / 503); after a timeout, reset, 502/504 or other 5xx it is UNKNOWN;
  - anything else (404, 5xx, network, not an array, rows that are not ours) -> `UNKNOWN`, `cascadeAction: "wait"`,
    `reason: "unknown_outcome"`: the order is `pending`, no other processor is tried, `retryClass: none`.
- The browser gets `ok:true, pending:true, charged:"unknown"`; the page must keep its idempotency key.
- `lib/poller.js` re-asks UMG for such attempts every cycle: found -> applied; `[]` -> `declined` /
  `not_charged_verified` only once the attempt is 30 min old; otherwise stays pending and, after 30 min, logs one
  `[pay-alert] UNKNOWN_OUTCOME <order> <key> since <iso>` line per order per process; `NOT_CHARGED_VERIFIED <order> <key>` is logged when it decides.
  At service start, orders left `inFlight` (restart mid-charge) become such unknown attempts (`RECOVERED_INFLIGHT <order>`).

## 3. Repeat under a new key -> 409
Same buyer email (any case), same server `amount`, same set of `sku:qty` lines, an approved / pending / in-flight card
order under a DIFFERENT key created in the last 15 min -> `409 duplicate_recent_order`, `charged:false`,
`existingOrder:<id>`. The same key is still a normal replay (`reused`).

## Do not
- Do not take the amount from the browser or add a local price / discount rule to the sum.
- Do not turn a timeout / 5xx into `declined` without the find-by-ext-id answer; never treat 404 or an unreadable
  answer as "not charged".
- Do not remove the 409 guard, and do not log card data (the find URL carries the API authorization: never log it).

Tests: `cd sidecar && node --test tests/*.test.js`; the new ones are `tests/honest-charge.test.js` and the fake
products-api in `tests/helpers/coupon-quote-fake.js`.
