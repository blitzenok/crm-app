# Crypto checkout (manual confirm)

Pending USDT orders on the CRM sidecar.

> **2026-09-28: payments are now verified on-chain automatically.** See [CRYPTO_VERIFY.md](CRYPTO_VERIFY.md) and the storefront contract in [CRYPTO_STOREFRONT_CONTRACT.md](CRYPTO_STOREFRONT_CONTRACT.md). Staff can no longer flip an order to paid by hand: `mark-paid` now takes a tx hash that the sidecar checks on-chain. Each order gets a unique exact amount (`payAmount` = total + 0.01–0.99 USDT) and is cancelled if unpaid after 60 minutes. The sections below describe v1; where they conflict, CRYPTO_VERIFY.md wins.

Card `/api/checkout/charge` is unchanged. Crypto works while `PAYMENTS_ENABLED` is off.

Storefront contract: [STOREFRONT_HOOK.md](./STOREFRONT_HOOK.md).

Legal: do not ship before the order is `crypto_paid`. Catalog stays RUO. Wallet private keys never go in git, chat, or API responses.

---

## Env (host only)

Set on `crm-umg.service` or the process environment. Do not commit values.

| Variable | Meaning |
|---|---|
| `CRYPTO_USDT_ERC` | USDT ERC-20 deposit address (`0x` + 40 hex). Returned to the storefront as `wallets.usdtErc20`. |
| `CRYPTO_USDT_TRC` | USDT TRC-20 deposit address (`T` + 33 base58). Returned as `wallets.usdtTrc20`. |
| `CRM_PUBLIC_URL` | Already used by the sidecar. Prefixes `statusUrl`. |

Anything that is not a deposit address (including a 32-byte hex key) is dropped. The API then returns `null` for that network and `walletsReady: false`. The shop must not invent an address.

`GET /api/psp/health` reports `cryptoWallets.erc20` and `cryptoWallets.trc20` as booleans only. It does not echo the addresses.

```ini
# Deposit addresses — set on the host, never in git.
# Environment=CRYPTO_USDT_ERC=
# Environment=CRYPTO_USDT_TRC=
```

---

## Staff

Live CRM page (drop-in, do not replace `store-orders.html`): `docs/live-crm/crypto-orders.html`.

Add one STORE nav row in live `crm.js` (already in this repo’s copy):

```js
{ key: 'crypto-orders', icon: '🪙', label: 'Crypto payments', m: 1 },
```

```bash
sudo cp /opt/crm-umg/docs/live-crm/crypto-orders.html /var/www/mastersol/html/CRM/crypto-orders.html
```

The Vite shell in this repo has the same queue under **Crypto payments**.

List: `GET /api/store-orders?paymentMethod=crypto&q=` (operator).  
Detail includes amount, order ref, customer, line items, created time, and who/when marked paid.

| Action | Effect |
|---|---|
| `POST /api/store-orders/:id/mark-paid` `{ "txHash": "required", "network": "trc20\|erc20", "note": "optional" }` | **Changed 2026-09-28.** The tx hash is attached as a staff hint and **checked on-chain** (right wallet, token, amount, confirmations, sanctions). `200 paymentConfirmed: true` only when verified; `409 not_verified_on_chain` (with `paymentStatus` and the tx it found, e.g. still confirming, short, wrong token) otherwise; `503 verification_disabled` / `chain_unavailable`. `amountReceived` is ignored (read from the chain). `analyticsEvent` is always `null` (GA4 purchase is sent server-side). Fulfillment becomes `ready_to_ship`. **Does not ship.** |
| `POST /api/store-orders/:id/ship` `{ "carrier": "USPS", "trackingNumber": "…", "trackingUrl": "https://…" }` | **409 `ship_blocked`** until the payment is verified on-chain (`crypto_paid` + `paymentStatus: paid` + sanctions clear) (card: until `approved`). After that, sets fulfillment `shipped` with who/when plus optional carrier / tracking number / https tracking URL. |
| `POST /api/store-orders/:id/tracking` `{ "carrier", "trackingNumber", "trackingUrl" }` | Set or correct tracking on an already shipped order (`409 not_shipped` otherwise). No customer email is sent (not built). |

Checkout body may carry `"test": true`; the order is stored with `test: true` so smoke orders can be found and removed.

`:id` may be the internal `BLR-…` id or the public `CR-…` order ref. Mark-paid on a card order returns **409 `not_crypto_order`**.

---

## Soft-QA

1. **Create pending** (quote mode, card charge still 503):

```bash
curl -sS -X POST http://127.0.0.1:8787/api/checkout/crypto \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"BL-CRYPTO-QA-1","amount":"158.00","currency":"USD","customer":{"first_name":"QA","last_name":"Probe","email":"qa+crypto@biolabsresearch.co"},"items":[{"sku":"BL-PEP-001","name":"Research peptide A","qty":1,"amount":"158.00"}]}'
```

Expect `status: "awaiting_crypto"`, an `orderRef` like `CR-XXXXXXXX`, `paymentConfirmed: false`, `analyticsEvent: null`, `fulfillment: "blocked"`. The body must not say payment successful.

2. **Ship blocked** (operator cookie or `X-Marketing-Key`):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:8787/api/store-orders/CR-XXXXXXXX/ship \
  -H "X-Marketing-Key: $MARKETING_DIGEST_KEY"
```

Expect `409` and `error: "ship_blocked"`.

3. **Mark paid** (still not shipped):

```bash
curl -sS -X POST http://127.0.0.1:8787/api/store-orders/CR-XXXXXXXX/mark-paid \
  -H "X-Marketing-Key: $MARKETING_DIGEST_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"txHash":""}'
```

(v1 text, superseded: mark-paid now only succeeds for a real confirmed on-chain transfer.) Expect `paymentConfirmed: true`, `analyticsEvent: null`, `fulfillment: "ready_to_ship"`, and `shippedAt: null`. `GET /api/checkout/crypto/CR-XXXXXXXX` is the storefront poll. Do not fire a client-side GA purchase for crypto; the sidecar sends it via Measurement Protocol after on-chain verification (flag `GA4_SERVER_PURCHASE_ENABLED`).

4. **Ship after paid** returns `fulfillment: "shipped"`. A second ship is `409 already_shipped`.

5. **Card path:** `POST /api/checkout/charge` with `PAYMENTS_ENABLED` unset still returns `503 payments_disabled` and does not write an order.

---

## Card orders -> CRM Store Orders (2026-09-28)

`server/lib/store-forward.js`. After an **approved** card charge the sidecar answers the shop first, then POSTs the order to
`http://127.0.0.1:4000/msolpeptides-api/notify-order` (products-api) with `paymentMethod: "card-umg"`, `ref` = sidecar id
(`BLR-…`), customer, shipping address, items (`slug`/`mg` split from the storefront sku) and totals. notify-order recomputes
`subtotal_server` / `price_mismatch` from the catalog and sends the existing Customer.io transactional manager + customer emails.

- **DEAD PATH, do not enable (audit 2026-10-02):** products-api `notify-order` answers 400 `ref prefix reserved` to every `BLR-` ref from this sender, so with the flag on each approved order only produces failed attempts in the log. Card orders reach the CRM through card-import (since 28.09), letters through order-letters. Delete-or-bypass is an open owner decision.
- Host env: `STORE_FORWARD_ENABLED=true`, `STORE_FORWARD_SINCE=<ISO>` (sweep ignores older orders). Off by default, so tests never post to the live service.
- Once per order: `order.storeForward.sentAt`; notify-order is also idempotent by `ref`.
- Failures never touch the charge response; they are logged (`[store-forward]`) and retried by a 60 s sweep with backoff (max 20 tries). The sweep also catches approvals that arrive via webhook/poll.
- Dry-run / test orders (`dryRun`, `test`, `DRY-` keys, `*-STUB` descriptors) are never auto-forwarded. Staff override: `POST /api/store-orders/:id/forward` (operator).
- Backfill of pre-existing approved orders: `server/scripts/backfill-store-forward-20260928.mjs` writes straight into `orders.json` (no notify-order, so no emails / no CIO events) and flags `backfill: true`.

---

## Server-side crypto amount (2026-09-28, storefront v3.00k8m4c)

`server/lib/pricing.js`, on when `CRYPTO_SERVER_PRICING=true` (host drop-in `crypto-pricing.conf`).
`POST /api/checkout/crypto` prices the cart through products-api `POST /msolpeptides-api/coupon-quote` (127.0.0.1:4000, read-only;
the same catalog + pack-tier `priceCheck` notify-order uses). Amount = catalog subtotal + shipping ($18.99 express, $0 ground;
express inferred from client total − client items = 18.99, or `shipMethod: "express"`). No coupon/tier discount is deducted,
matching what the storefront charges. The server amount is stored as `amount`/`amountDue` and returned; the browser's figure
is kept in `priceCheck.clientAmount` with `priceMismatch` and public `priceAdjusted: true` when they differ.
Unknown catalog items → `400 unknown_item`; catalog/products-api down → `503 pricing_unavailable` (fail closed).

Staff cleanup (operator auth):
- `DELETE /api/store-orders/:id|:orderRef` — only orders with `test: true` (`409 not_test_order` otherwise).
- `DELETE /api/checkout/abandon/:session_id` — only records with a QA/test email (`qa-…`, `qa+…`, `…+test@`, `dry-run@`, `probe…`) or `test: true`.

---

## Server-side card amount (2026-09-28)

`CARD_SERVER_PRICING=true` (host drop-in `card-pricing.conf`; rollback `/root/rollback-card-pricing.sh`).
Before any processor call, `/api/checkout/charge` prices the cart with `priceCardCart` (card items carry the **unit** price;
crypto items carry the line total). The charged amount (sent to UMG) is the server amount; `clientAmount`, `priceMismatch`
and `priceCheck` (per-line rule) are stored on the order. Response adds `chargedAmount` and `priceAdjusted`.
`400 unknown_item` / `503 pricing_unavailable` return `charged: false` and create no order. Replays of an approved,
pending or in-flight order are answered from the stored order (no re-pricing, no second charge).
Dry-run can exercise it with `"serverPricing": true`.

Line rule (both card and crypto): each line is priced per line through coupon-quote at its qty (pack tier) and at qty 1.
A client line equal to the pack-tier total or to the single-bottle total (older add paths keep the 1-bottle price at 2+) is
honoured exactly; anything else is repriced to the pack-tier total and flagged. The free research solvent
(`research-solvent`, BAC gift) is $0 and is not sent to the catalog (it used to come back `unknown_item`).
The card forward to notify-order uses the stored server line prices, subtotal, shipping and the charged amount.

---

## Storefront volume tier (2026-09-28) — built, OFF by default

`server/lib/pricing.js` `volumePct` / `volumeDiscountedCents`, mirrored from storefront `cart-vial.js` "Footer v4" `updateTotals`:
merch = Σ price×qty over non-gift lines (BAC / research-solvent excluded), before shipping; 5% at ≥ $100, 10% at ≥ $250,
15% at ≥ $500 (inclusive, on the undiscounted merch); discounted merch = `Math.round(merch × (1 − pct/100) × 100) / 100`;
shipping ($18.99 express / $0 ground) added after, never discounted; no coupon.

Switch: `VOLUME_DISCOUNT_ENABLED=true` (drop-in `volume-discount.conf`). Left **off** because, as of storefront v3.00k8m4d,
only the cart drawer shows the tiered total; the checkout page total, the crypto modal step 1 and the amount sent to
`/api/checkout/charge` and `/api/checkout/crypto` are undiscounted. Turn it on in the same release that makes checkout
show the tiered total. With it on, a client that sends either the undiscounted or the discounted total is not flagged;
tampered lines are still repriced to the catalog pack tier and flagged. Order `priceCheck.volumeDiscount` records pct/discount.

---

## Checkout consent log (2026-09-28)

`POST /api/checkout/charge` and `POST /api/checkout/crypto` accept an optional
`consent: { checks: { <checkboxId>: boolean }, acceptedAt: ISO, pageVersion: string }`
(checkout ids today: `agreeTerms`, `agreeRuo`; entry gate: `tcCheck1..3`). Sanitised: ≤ 20 checks, ids `[A-Za-z0-9_.:-]{1,64}`,
booleans only, pageVersion ≤ 64 chars, acceptedAt normalised to ISO. Missing/invalid consent never blocks an order; it is
recorded as `consent: null, missing: true`. Prices and charging are unaffected.

For every order a route creates (card approved or declined, crypto; not idempotent replays) one line is appended to
`CONSENT_LOG_PATH` (default: `consent-log.jsonl` next to `STORE_PATH`, i.e. `/var/lib/crm-umg/consent-log.jsonl`),
O_APPEND + fsync, mode 600: schema, channel, server receivedAt (UTC), orderId / orderRef / idempotencyKey, email, amount,
currency, shipMethod, orderStatus, ip (existing X-Forwarded-For rule), xRealIp (nginx `$remote_addr`), userAgent (≤ 400),
consent, missing, prevHash, hash = sha256 of the canonical JSON (sorted keys) of the record without `hash`.
The order gets `consent` (recorded, missing, allChecked, checks, pageVersion, acceptedAt, receivedAt, ip, hash).
Staff read: `GET /api/consent?ref=<BLR-id|CR-ref|idempotencyKey>` or `?email=` (operator auth), each record with `hashOk`.
Keep the file 7+ years; include it in backups; never edit it (deleting a test order leaves its consent line).
