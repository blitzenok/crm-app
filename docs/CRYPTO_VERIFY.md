# Crypto payment verification (on-chain)

2026-09-28. The sidecar verifies USDT payments on the blockchain itself. The chain access is read-only: public explorers and RPCs, no keys, and the system **never sends crypto**. Shipping, the Rapid push and the order confirmation email all wait until the payment is verified on-chain.

Storefront side: [CRYPTO_STOREFRONT_CONTRACT.md](CRYPTO_STOREFRONT_CONTRACT.md). v1 background: [CRYPTO_CHECKOUT.md](CRYPTO_CHECKOUT.md).

## Flow

1. **`POST /api/checkout/crypto`** creates the order.
   - It gets `cryptoPayment.payAmount` = server total + a random 0.01–0.99 USDT offset, unique among open orders on that network (open = awaiting / confirming / review, or cancelled within the late-watch window). Identical carts therefore always get distinct amounts.
   - `expiresAt` = created + `CRYPTO_PAYMENT_TIMEOUT_MIN` (60).
2. **Watcher.** Every `CRYPTO_VERIFY_POLL_MS` (90 s) the verifier lists incoming token transfers to each wallet since the last scanned point.
   - TRC20 via TronGrid `/v1/accounts/:addr/transactions/trc20`.
   - ERC20 via `eth_getLogs` Transfer(to = wallet) on the USDT/USDC contracts.
   - Each transfer is then matched to an order:
     1. a **tx hint** (customer confirm field or staff `add_tx`), re-read from the chain by hash; a hash on the other chain is detected as wrong network;
     2. **exact unique amount** on that network;
     3. if exactly one order on that network is open and the amount is at least 10% of it and at least 1 USDT, the single open order;
     4. otherwise the transfer is recorded as **unmatched** and an alert is raised.
   - Transfers under 1 USDT are ignored (address-poisoning dust).
   - The **tx ledger** (`store.crypto.ledger`) binds each tx hash to one order forever, so reusing a tx across orders is refused.
3. **Evaluation** (`evaluatePayment`):
   - only accepted tokens on the order's network count: USDT on TRC20 and ERC20, USDC on ERC20 only (`ACCEPTABLE_TOKENS`, owner decision 2026-09-28), narrowed by `CRYPTO_ACCEPTED_TOKENS` (default `USDT`). USDC on TRC20 is recognised but always → `payment_review` (`wrong_token`), except an order that was itself opened as USDC-TRC20 before the rule. Anything else → `payment_review` (`wrong_token` / `wrong_network`);
   - `success` must be true and confirmations must be ≥ 20 (TRC20) / 12 (ERC20), re-checked by tx hash (`finalChecked`) → otherwise `confirming`;
   - sum < payAmount → `payment_review` `partial_payment`; sum > payAmount → `payment_review` `overpaid`. The tolerance is 0.000001, so the amount must be exact;
   - payment after cancellation → `payment_review` `late_payment`. Watched for `CRYPTO_LATE_WATCH_HOURS` (72).
4. **Sanctions screening** of every sender address (below). A clear result → `paid`:
   - `status: crypto_paid`, `paymentConfirmed: true`, fulfillment `ready_to_ship`;
   - then the Rapid auto-push (if enabled), the confirmation email (order-emails), and the GA4 server purchase (if enabled).
5. **Timeout.** When `now > expiresAt` (+ `CRYPTO_CONFIRM_GRACE_MIN` = 60 if the customer pressed confirm) and a **successful** scan of that network has covered the deadline with nothing seen, the order becomes `cancelled` / `crypto_cancelled`.
   - The customer gets the `payment_cancelled` email (registered via `registerEmailType`, sent with `orderEmailer.send`, so it follows `ORDER_EMAILS_ENABLED`, the test-order skip and the email log).
   - If the chain API is down, nothing is cancelled.
   - An order that is `confirming` is never cancelled by the timer.

Statuses (`order.cryptoPayment.status`, mirrored to `order.paymentStatus`):
- `awaiting_payment`, `confirming`, `paid`;
- `payment_review`;
- `sanctions_review`;
- `screening_hold` (the screening service was unavailable);
- `cancelled`.

The customer only ever sees `payment_review` for any of the three review states.

## Customer confirmation

`POST /api/checkout/crypto/:ref/confirm {token, txHash?, pageVersion}`

- **Access:** public; rate limit 10 per 10 min per IP.
- **Token:** `token` = HMAC-SHA256(order id + ref), returned only in the create response.
  - The secret comes from `CRYPTO_CONFIRM_SECRET`, or is auto-generated at `<state dir>/crypto-confirm.key` (mode 600). Rotating it invalidates the tokens of open orders.
- **What it does:**
  - sets `customerConfirmedAt`, which the staff view shows as `customerConfirmed`, and extends the cancel deadline by the grace window;
  - stores the tx hash as a hint and triggers an immediate check;
  - appends a `crypto_payment_confirmed` record to the hash-chained consent log (`consent-log.jsonl`) with orderId, time, tx hint, pageVersion, IP and user agent. Like the existing consent entries, IP and UA are stored **unmasked**.
- **It never releases the order.**

## Sanctions (OFAC)

The sender (`from`) of every counted transfer is screened before release.

- **Primary:** Chainalysis free sanctions API (`CHAINALYSIS_API_KEY`, `CHAINALYSIS_API_URL` default `https://public.chainalysis.com/api/v1/address/`).
- **Fallback / second source:** a local OFAC SDN crypto-address list at `CRYPTO_OFAC_LIST_PATH` (default `/var/lib/crm-umg/ofac-crypto-addresses.txt`).
  - It is built from `github.com/0xB10C/ofac-sanctioned-digital-currency-addresses` (ETH, TRX, USDT, USDC lists, generated from the Treasury SDN XML).
  - Auto-refreshed daily (`CRYPTO_OFAC_AUTO_REFRESH`, default on). It counts as usable while younger than `CRYPTO_OFAC_LIST_MAX_AGE_DAYS` (14).
- **Match** on either source → `sanctions_review`: no ship, no automatic refund, internal alert. Staff cannot `release` it; escalate to compliance.
- **Neither source available** → `screening_hold` (fail-closed, `CRYPTO_SANCTIONS_FAIL_CLOSED=true`). With `false`, the order is released and recorded as `sanctions.status: skipped_fail_open`.

## Staff API (CRM session / operator token)

Under `/api/psp/crypto/` (this prefix is already proxied by nginx to :8787):

| Route | |
|---|---|
| `GET /api/psp/crypto/orders[?paymentStatus=]` | Staff view per order. Fields: payAmount, receivedAmount, amountDelta, confirmations/required, customerConfirmed(+At), txHints, transfers (explorer links, from, matchedBy), reviewReasons, sanctions, cancelAt, cancelEmail, refunds, staffActions, ga4, `actions`. Also returns verifier health. |
| `GET /api/psp/crypto/orders/:id-or-ref` | One order. |
| `POST /api/psp/crypto/orders/:id/action` | `{action, note, …}`. Actions are listed below. |
| `GET /api/psp/crypto/alerts`, `GET /api/psp/crypto/unmatched` | Internal alerts and unmatched deposits. |
| `POST /api/psp/crypto/verify-now` | Run one scan now. |
| `POST /api/store-orders/:id/mark-paid {txHash, network}` | Kept for the old UI. It is now "attach tx and verify": `200` only if verified on-chain, else `409 not_verified_on_chain`. |

Actions for `POST /api/psp/crypto/orders/:id/action`:
- `mark_reviewed`
- `add_tx` `{txHash, network?}`
- `record_refund` `{refundTxHash, amount, network?}`: bookkeeping only; staff send the refund themselves.
- `cancel`
- `release`: requires a `note`. Only allowed from `payment_review` / `screening_hold`. It re-reads the chain (at least one successful, fully confirmed accepted-token transfer is required) and re-screens. It is refused for `sanctions_review`.

Every action is logged with actor and time in `cryptoPayment.staffActions`. The CRM page `docs/live-crm/crypto-orders.html` uses these routes.

Internal alerts (unmatched deposit, review, sanctions match, screening hold, late payment, verifier errors) go to the service log as `[crypto] ALERT …` and to the CRM alert list (`store.crypto.alerts`). No admin email hook exists yet.

## GA4 server-side purchase

- **When:** on verification, a Measurement Protocol `purchase` is sent to `GA4_MEASUREMENT_ID` (default `G-KCMPHP783M`, property 552249403).
- **Payload:** `transaction_id` = orderRef, `value` = the USD order total, `currency` USD, and `items` with `item_id` = the catalog code from the SKU map only (e.g. `RC05-10`). No item names or product names are sent. `client_id` = `gaClientId` from checkout, else a pseudo id.
- **Gated by** `GA4_SERVER_PURCHASE_ENABLED` (default `false`) and requires `GA4_API_SECRET` (GA Admin → Data streams → Measurement Protocol API secrets). Test orders are skipped.
- **Result** is stored in `cryptoPayment.ga4`.

## Configuration

| Env | Default | |
|---|---|---|
| `CRYPTO_VERIFY_ENABLED` | on (unless `false`) | Watcher and verification. With it off, nothing can become paid. |
| `CRYPTO_VERIFY_POLL_MS` | 90000 (min 30000) | |
| `CRYPTO_PAYMENT_TIMEOUT_MIN` / `CRYPTO_CONFIRM_GRACE_MIN` | 60 / 60 | |
| `CRYPTO_LATE_WATCH_HOURS` | 72 | |
| `CRYPTO_CONFIRMATIONS_TRC20` / `_ERC20` | 20 / 12 | |
| `CRYPTO_AMOUNT_TOLERANCE` / `CRYPTO_OVERPAY_TOLERANCE` | 0.000001 | |
| `CRYPTO_ACCEPTED_TOKENS` | USDT | Narrows the per-network list (it cannot widen it). `USDT,USDC` enables USDC on ERC20 only; USDC on TRC20 always goes to review. |
| `CRYPTO_TRONGRID_URL`, `TRONGRID_API_KEY` | api.trongrid.io, none | A key is optional (raises rate limits). |
| `CRYPTO_ETH_RPC_URL` | publicnode, drpc | Comma list; falls through on errors or null receipts. |
| `CRYPTO_API_MIN_GAP_MS` | 400 | Pacing between explorer calls. |
| `CRYPTO_CONFIRM_SECRET` | auto file | |
| `CHAINALYSIS_API_KEY` | — | **Needed** for the primary screen. |
| `CRYPTO_OFAC_LIST_PATH`, `CRYPTO_OFAC_AUTO_REFRESH`, `CRYPTO_OFAC_LIST_MAX_AGE_DAYS` | see above | |
| `CRYPTO_SANCTIONS_FAIL_CLOSED` | true | |
| `GA4_SERVER_PURCHASE_ENABLED`, `GA4_API_SECRET`, `GA4_MEASUREMENT_ID` | false, —, G-KCMPHP783M | |

Health: `GET /api/psp/health` → `cryptoVerify`, which includes:
- enabled, confirmations;
- chainalysisKey (whether a key is set), ofacList size/freshness, sanctionsFailClosed;
- ga4ServerPurchase, ga4ApiSecret.

## Rollback

`/root/rollback-crm-umg.sh crypto` restores the pre-crypto-verify code backup and removes `crypto-verify.conf`. The store keeps the added `cryptoPayment` / `crypto` data; older code ignores it.
