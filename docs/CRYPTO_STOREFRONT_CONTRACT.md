# Crypto checkout — storefront contract (for Indian)

Updated 2026-09-28. Backend: CRM sidecar `crm-umg` (crm-app `crypto-onchain-verify`). Base URL: `https://crm.biolabsresearch.co`.
CORS is enabled for `https://biolabsresearch.co`, `https://www.biolabsresearch.co` (and blrcommerce.io) on every `/api/checkout/*` route.

What changed on the backend:
- Each order has a **unique exact amount**: the cart total plus a 0.01–0.99 USDT offset. That's how we match a blockchain transfer to an order, so **the memo line has to go** (USDT transfers have no memo).
- The server watches the blockchain itself. A payment counts only after enough confirmations (TRC20: 20, ERC20: 12) and a sanctions check on the sender.
- An unpaid order is cancelled **60 minutes** after checkout (+60 min grace if the customer presses "I've sent the payment"). The customer gets a cancellation email.
- GA4 `purchase` for crypto is sent **server-side**. The storefront must **not** fire a purchase event for crypto.

---

## 1. Create order — `POST /api/checkout/crypto`

Same endpoint and request body as today. One new optional field: `gaClientId`.

### Request

```json
{
  "idempotencyKey": "BLR-1727543000-ab12",
  "amount": "158.00",
  "currency": "USD",
  "network": "trc20",
  "customer": {
    "first_name": "Jane",
    "last_name": "Doe",
    "email": "jane@example.com",
    "phone": "+15555550100",
    "address": "1 Main St",
    "city": "Austin",
    "state": "TX",
    "zip": "78701",
    "country": "US"
  },
  "items": [{ "sku": "bpc-157-10mg", "name": "(as in cart)", "qty": 1, "amount": "158.00" }],
  "consent": { "checks": { "agreeTerms": true }, "pageVersion": "checkout-v4" },
  "gaClientId": "1234567890.1727543000"
}
```

Request fields:
- `network`: `"trc20"` or `"erc20"`. **Required in practice**, because the unique amount is reserved per network.
- `token` (added 2026-09-29): the asset the customer will send, `"USDT"` (default when omitted, unchanged behaviour) or `"USDC"`. Case-insensitive; `asset` / `payAsset` are accepted as aliases.
  - **USDC is ERC20 only.** Send `{"token":"USDC","network":"erc20"}`. `USDC` + `trc20` → `400 {error:"token_not_accepted"}`; `USDC` with no network → `400 {error:"network_required"}`; any other token → `400 {error:"invalid_asset"}`. No order is created on these errors.
  - A token that is not enabled on the server (`CRYPTO_ACCEPTED_TOKENS`) → `400 token_not_accepted`.
  - USDC is paid to the same ERC20 deposit address (`wallet` in the response). The response echoes `token` / `payAsset` = `"USDC"`, `network` = `"erc20"`.
  - Only offer USDC when the customer picked ERC20; the TRC20 option shows USDT only.
- `gaClientId` (optional, new): the `_ga` cookie client id (the `XXXXXXXXXX.YYYYYYYYYY` part after `GA1.1.`). It lets the server-side purchase join the browser session. Omit it if you can't read it.
- `idempotencyKey`: resending the same key returns the same order (`"reused": true`), with the same amount and the same `confirmToken`.

### Response `200` (real output from the build)

```json
{
  "ok": true,
  "orderId": "BLR-1001",
  "orderRef": "CR-SFBSPB2P",
  "status": "awaiting_crypto",
  "paymentStatus": "awaiting_payment",
  "amount": "158.00",
  "currency": "USD",
  "amountDue": "158.34",
  "payAmount": "158.34",
  "payAmountUnits": "158340000",
  "payDecimals": 6,
  "amountOffset": "0.34",
  "priceAdjusted": false,
  "payAsset": "USDT",
  "token": "USDT",
  "network": "trc20",
  "wallet": "TXfrivx3QHrYDwPcaj3ojEDQFvAzX8EdKv",
  "paymentConfirmed": false,
  "analyticsEvent": null,
  "fulfillment": "blocked",
  "shippable": false,
  "wallets": {
    "usdtErc20": "0x55C758a84BCC999C5386E5047A064E0364915DE9",
    "usdtTrc20": "TXfrivx3QHrYDwPcaj3ojEDQFvAzX8EdKv"
  },
  "walletsReady": true,
  "statusUrl": "/api/checkout/crypto/CR-SFBSPB2P",
  "confirmUrl": "/api/checkout/crypto/CR-SFBSPB2P/confirm",
  "confirmToken": "trX5uG4b2KB969gocG4YZ19K8Rb6tZ6jtmMxhQgshN0",
  "createdAt": "2026-09-28T17:56:45.304Z",
  "expiresAt": "2026-09-28T18:56:45.304Z",
  "cancelAt": "2026-09-28T18:56:45.304Z",
  "customerConfirmed": false,
  "customerConfirmedAt": null,
  "txSeen": false,
  "confirmations": 0,
  "requiredConfirmations": 20,
  "paidAt": null,
  "message": "Send the exact amount within 60 minutes. Unpaid orders are cancelled automatically. This is not a completed payment until it is confirmed on the blockchain.",
  "reused": false
}
```

Fields to use:

| Field | Use |
|---|---|
| `payAmount` | **The amount to show and copy.** A string with every decimal kept. Show it exactly as given (`"158.34"`). Don't round it, don't pass it through `toFixed`, and don't show `amount` as the amount to send. `amountDue` holds the same value (kept for the current page). |
| `amount` | The cart total in USD (server price). Show it only as "Order total" if you want. |
| `amountOffset` | The added cents. Optional small print, e.g. "includes 0.34 USDT order identifier". |
| `token`, `network` | "USDT" + "trc20" / "erc20", or "USDC" + "erc20" (echo of what the order was created with). |
| `wallet` | The deposit address for the chosen network. Use this instead of reading the address from page config. |
| `expiresAt` | 60 minutes after creation. Use it for the countdown. |
| `cancelAt` | When the order is actually cancelled. Equals `expiresAt`, or `expiresAt` + 60 min after the customer confirms. Stop polling after this time. |
| `confirmToken` | Keep it in memory or sessionStorage for this order. It's returned **only** by this call (and by an idempotent replay), never by GET. Needed for the button in section 2. |
| `confirmUrl`, `statusUrl` | Paths relative to `https://crm.biolabsresearch.co`. |

Errors: `400 {error: invalid_network | invalid_asset | token_not_accepted | network_required | email_required | items_required | …}`, `409 idempotency_conflict`, `429 rate_limited`. One new error: `503 pay_amount_unavailable` (all 99 offsets are taken on that network; practically never happens). Show a generic retry message for it.

### Page copy (payment step)

- Replace the memo line ("…include the order ref in the transfer memo…") with:
  **"Send the exact amount within 60 minutes. Unpaid orders are cancelled automatically."**
- Put this label next to or under the amount:
  **"Send this exact amount, including cents"**
- Keep the existing warning about sending the correct asset on the correct network.
- Add a copy button for `payAmount` that copies the exact string, and one for `wallet`.

---

## 2. "I've sent the payment" button — `POST /api/checkout/crypto/:orderRef/confirm`

Show the button on the payment step, with an **optional** "Transaction hash (optional)" text field under it.

### Request

```json
{ "token": "trX5uG4b2KB969gocG4YZ19K8Rb6tZ6jtmMxhQgshN0", "txHash": "0f3c…64 hex chars", "pageVersion": "checkout-v4" }
```

- `token` (required): the `confirmToken` from the create response.
- `txHash` (optional): leave it out or send `""` if the field is empty. Accepted formats:
  - TRC20: 64 hex characters, with or without `0x`;
  - ERC20: `0x` followed by 64 hex characters.

  You can check the format client-side before sending, but the server validates it too.
- `pageVersion`: the same page version string you send in `consent.pageVersion`. It's stored in the consent log.

### Response `200`

The same object as the GET status (section 3), plus `"txHintReceived": true|false`. Example after the click:

```json
{
  "ok": true,
  "orderRef": "CR-TNU9J7VF",
  "paymentStatus": "awaiting_payment",
  "payAmount": "158.47",
  "network": "trc20",
  "expiresAt": "2026-09-28T18:56:50.623Z",
  "cancelAt": "2026-09-28T19:56:50.623Z",
  "customerConfirmed": true,
  "customerConfirmedAt": "2026-09-28T17:56:50.641Z",
  "txSeen": false,
  "confirmations": 0,
  "requiredConfirmations": 20,
  "paymentConfirmed": false,
  "message": "Thanks. We're checking the blockchain and will email you once your payment is confirmed.",
  "txHintReceived": true
}
```

(Shortened. All the fields from section 3 are present.)

Errors:
- `403 {"ok":false,"error":"invalid_token"}`: wrong or missing token, or unknown ref.
- `400 {"error":"invalid_tx_hash"}`: tell the customer "That doesn't look like a transaction hash. Check it or leave the field empty."
- `429 rate_limited`: 10 per 10 min per IP.

The button **never** marks the order paid. It records that the customer says they paid, extends the cancel deadline by 60 min, and triggers an immediate chain check.

**After the click**, replace the button area with:
**"Thanks. We're checking the blockchain and will email you once your payment is confirmed."**
Then keep polling (section 3). Pressing it again is harmless.

---

## 3. Status polling — `GET /api/checkout/crypto/:orderRef`

Poll every **15 s** (10–30 s is fine) until one of these:
- `paymentStatus` is `paid`, `cancelled` or `payment_review`;
- the current time is past `cancelAt` + 5 min;
- the customer leaves.

Replace the current fixed 45-min timer with `cancelAt`.

The response is the same shape as the create response **without** `confirmToken` and `reused`.

| `paymentStatus` | Meaning / what to show |
|---|---|
| `awaiting_payment` | Nothing seen on-chain yet. Show amount, wallet, countdown to `expiresAt`, and the button. |
| `confirming` | Transfer seen (`txSeen: true`), waiting for confirmations. Show "Payment detected. Waiting for blockchain confirmations (`confirmations`/`requiredConfirmations`)…" |
| `paid` | Verified (`paymentConfirmed: true`). Show `message` ("Payment confirmed on the blockchain. Your order is being prepared. Shipping is a separate step."). **Do not fire a GA purchase** (the server sends it). |
| `payment_review` | Something needs a manual check (wrong amount, token or network, late payment…). Show `message`. Stop polling. |
| `cancelled` | Not paid in time. Show `message` ("Payment was not received within the payment window, so this order was cancelled. If you already paid, reply to our email with the transaction hash."). Stop polling. |

Always display the server's `message` string rather than hard-coding text per status (except the button copy above).

---

## 4. Other storefront changes

1. **Legacy `/msolpeptides-api/notify-order` call.** Send `od.total = view.payAmount`, i.e. the exact amount including the offset. Better: send `payAmount` as the crypto amount and keep `amount` as the order total.
2. **GA.** No client-side `purchase` for crypto, not on create and not on `paid` (`analyticsEvent` is always `null`). The server sends the GA4 Measurement Protocol purchase to G-KCMPHP783M after on-chain verification. Only the transaction id, the value and catalog codes are sent (no product names). It's flag-gated and currently **off** until the API secret is added. `begin_checkout` / `add_payment_info` client events are fine as today.
3. **Don't compute the amount in the browser.** Always show `payAmount` from the response.
4. **Refunds.** Nothing is automatic. Support handles them manually.
