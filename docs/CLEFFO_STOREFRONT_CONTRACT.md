# Cleffo + UMG card checkout — storefront contract (for Indian)

CRM sidecar `crm-umg` (crm-app patch 0008). **Status: shipped DISABLED (code default `CLEFFO_ENABLED` off); ENABLED on prod since 2026-09-29**
(`CLEFFO_ENABLED=true`, `CLEFFO_SPLIT_PCT=100`, see CLEFFO_DAILY_CAP.md). While the flag is off, `/api/checkout/charge` behaves exactly as today (UMG only). The only change you'll see is some extra
fields in the JSON (`processor`, `attempt`, `statementDescriptor`, `statementDescriptorConfirmed`), which you can
ignore. Build against this contract now and ship it behind your own switch. Customers see no change until Yehuda
gives the final OK and the flag is turned on.

Base URL: `https://crm.biolabsresearch.co`. CORS is unchanged: only the storefront origins get an answer, and
there is no `*`. Don't touch or proxy any other path.

## 1. Routing rules (server side, for context)

- **First attempt:** each customer is split by email between UMG and Cleffo. The server hashes the normalised email
  (sha256 of trim + lowercase) into a bucket, so the same customer always gets the same first processor.
  `CLEFFO_SPLIT_PCT` sets the split (default 50).
- **After a decline, the next attempt by the same customer** (same email, cart session or cart key):
  - A **soft** decline (insufficient funds, activity limit / 203, issuer unavailable, timeout / processor down)
    moves the next attempt to the **other** processor. This happens **once** per checkout.
  - A **hard** decline stays on the **same** processor and is **never** moved to the other one. Hard means: lost,
    stolen or pick-up card, fraud / security, do-not-honor, "do not retry", Mastercard MAC 03 / 21, closed or
    invalid account, and any code the server does not recognise (it fails closed). On UMG, the same card is
    refused outright after a hard decline.
  - Cleffo's status API gives no decline reason, so **a failed Cleffo payment always counts as hard**. The retry
    stays on Cleffo.
- **Cap:** at most 3 attempts per checkout (`CLEFFO_MAX_ATTEMPTS`). An approval starts a new checkout.
- **Price:** the amount is always the server-side catalog total (volume discount + shipping), never the browser's.

## 2. Ask which processor comes next (optional, recommended)

`POST /api/checkout/route` has no side effects. Call it once you have the email, and again after any decline. It
tells you whether to render card fields (UMG) or a "Continue to secure payment" button (Cleffo).

Request:
```json
{ "customer": { "email": "a@b.com" }, "session_id": "<cart session>", "idempotencyKey": "<cart key>" }
```
Response 200:
```json
{ "ok": true, "processor": "umg" | "cleffo" | null, "cleffoEnabled": true, "attempt": 1,
  "reason": "bucket" | "retry_switch_soft" | "retry_same_hard" | "retry_same_switch_used" | "cleffo_disabled",
  "statementDescriptor": "PEPTIDESS SHOP" | null, "statementDescriptorConfirmed": true | false,
  "blocked": true, "...": "blocked only present when processor is null (attempts_exhausted / hard_decline_same_card)" }
```

## 3. Charge: `POST /api/checkout/charge`

The request body is the same as today (`idempotencyKey`, `session_id`, `customer`, `items`, `amount`,
`shipMethod`, `card`, `consent`), with two differences:

- `consent` is **required** for a Cleffo attempt:
  `{ "checks": { "ck-terms": true, "ck-ruo": true, ... }, "acceptedAt": "<ISO time of ticking>", "pageVersion": "<checkout version>" }`.
  Every check must be `true` and `acceptedAt` must be present. The server writes the consent record and reads it
  back (hash verified) **before** it creates the payment link. If consent is missing or invalid, there is **no**
  redirect. For UMG, consent is still recorded but never blocks (unchanged).
- `card` is **ignored** on a Cleffo attempt (it is never stored or sent anywhere). If `/route` says `cleffo`, don't
  collect the card at all. One exception: if Cleffo can't even create a link (outage, no charge attempted) and a
  card is present, the server charges that attempt on UMG instead, and you get a normal UMG answer.

### Responses

**A. Cleffo: redirect** (HTTP 200)
```json
{ "ok": true, "processor": "cleffo", "redirectUrl": "https://app.cleffo.com/pay/api-checkout-session/<ref>",
  "orderId": "BLR-1234", "attempt": 1, "amount": "169.09", "currency": "USD", "chargedAmount": "169.09",
  "priceAdjusted": false, "statementDescriptor": null, "statementDescriptorConfirmed": false, "charged": false }
```
Then:
1. Keep `orderId` and `attempt` in `sessionStorage`.
2. Do a **top-level** redirect: `window.location.assign(redirectUrl)`. Not an iframe or popup.

A repeated call for the same key (double click, reload) returns the same link with `"reused": true` for as long as the link lives: `CLEFFO_LINK_TTL_MIN`, 60 minutes
(a new key from the same buyer with the same cart and address gets the live link too). After that a new link is made.

**B. UMG approved** (HTTP 200): as today, plus `"processor": "umg"`, `"attempt": n`,
`"statementDescriptor": "PEPTIDESS SHOP"`, `"statementDescriptorConfirmed": true`.

**C. UMG declined** (HTTP 402): as today (`ok:false`, `order`, `hardDecline` / `exhausted`), plus
`processor`, `attempt`, and when Cleffo is on:
```json
"next": { "attemptsUsed": 1, "attemptsLeft": 2, "nextProcessor": "cleffo" | "umg" | null,
          "nextReason": "retry_switch_soft" | "retry_same_hard" | "...",
          "statementDescriptor": null, "statementDescriptorConfirmed": false }
```
If `nextProcessor` is `cleffo`, swap the card form for the "Continue to secure payment" button. If it is `umg`
after a hard decline, ask for a **different** card.

**D. Refusals.** None of these charge the customer or return a redirect.

| HTTP | error | Show |
|---|---|---|
| 400 | `consent_missing` / `consent_invalid` | "Please confirm the checkout acknowledgements before continuing to payment." (highlight the boxes) |
| 503 | `consent_not_confirmed` | "We could not record your checkout acknowledgement. You were not charged. Please try again." |
| 503 | `processor_unavailable` | "Payment is temporarily unavailable. You were not charged. Please try again in a minute." |
| 429 | `attempts_exhausted` | server `message` (contact support / crypto / request a quote) |
| 429 | `hard_decline_same_card` | server `message` (use a different card) |
| 400/503 | `unknown_item` / `pricing_unavailable` | unchanged from today |

## 4. Return from Cleffo

The payment page sends the customer to the CRM
(`/api/checkout/cleffo/return?o=<order>&a=<attempt>&t=<token>`). The CRM checks its own HMAC token, confirms the
status with Cleffo's status API server-side (it never trusts the redirect alone), and then sends a **302** to:

```
https://biolabsresearch.co/checkout?cleffo=1&order=BLR-1234&a=1&t=<token>&status=paid|declined|pending|review
```
(`CLEFFO_STOREFRONT_RETURN_URL` sets this, default `https://biolabsresearch.co/checkout`.)

When checkout loads with `cleffo=1`, call:

`GET /api/checkout/cleffo/status?o=<order>&a=<a>&t=<t>`, which returns 200:
```json
{ "ok": true, "orderId": "BLR-1234", "processor": "cleffo", "attempt": 1,
  "status": "paid" | "declined" | "pending" | "review", "amount": "169.09", "currency": "USD",
  "statementDescriptor": null, "statementDescriptorConfirmed": false,
  "next": { "...": "same as 3C, only when declined" } }
```
A bad token returns 403 `invalid_token`. Treat the JSON as the truth, not the `status` query param.

| status | Storefront action |
|---|---|
| `paid` | Order-confirmed screen, same as a UMG approval. Clear the cart. Fire the analytics purchase event **once** (key it on orderId). |
| `pending` | "Confirming your payment…" spinner. Poll the status every 3 s for up to 60 s. If it's still pending: "We're still confirming your payment. You'll get an email once it's confirmed. Please don't pay again." Keep the cart. |
| `declined` | "Your payment wasn't completed. You were not charged." Keep the cart, then follow `next` (usually `cleffo` again, because Cleffo failures are hard). |
| `review` | "We received your payment and are reviewing it. We'll email you shortly." Don't offer a retry. |

## 5. Customer-visible text and step changes (only once the flag is on)

- **UMG customers:** no change. Card fields plus "Your card statement will show: PEPTIDESS SHOP".
- **Cleffo customers:**
  - Hide the card fields. Show a button **"Continue to secure payment"** with the note: "You'll be taken to our
    secure payment partner to enter your card, then brought back here."
  - Show the checkbox acknowledgements **before** the button, as today. They must be ticked or the server refuses.
  - The statement line comes from the API. Show **"Your card statement will show: {statementDescriptor}"** only
    when `statementDescriptorConfirmed` is `true`. Otherwise show no descriptor line (don't guess).
    ⚠ `CLEFFO_DESCRIPTOR` is currently **UNKNOWN**. It's a placeholder until Cleffo confirms the descriptor in
    writing.
- The order-confirmation email for a Cleffo order says `card-cleffo`. It only includes a statement line once the
  descriptor is confirmed.
- **Retry after a decline:** re-call `/route` (or read `next`), then render whichever step it names. Don't
  hard-code "try the other processor".
- The payment page is Cleffo's hosted page. Its branding and descriptor are not ours to change.

## 6. Flags (server) and current state

| Flag | Code default (prod value: CLEFFO_DAILY_CAP.md) | Meaning |
|---|---|---|
| `CLEFFO_ENABLED` | false (**true on prod since 2026-09-29**) | Master switch. Off = UMG only. |
| `CLEFFO_ENV` | sandbox | sandbox or live key set |
| `CLEFFO_SPLIT_PCT` | 50 | % of customers whose first processor is Cleffo |
| `CLEFFO_MAX_ATTEMPTS` | 3 | per checkout |
| `CLEFFO_DESCRIPTOR` | UNKNOWN | placeholder until Cleffo confirms |
| `CLEFFO_STOREFRONT_RETURN_URL` | https://biolabsresearch.co/checkout | where the customer lands |
| `CLEFFO_REQUIRED_CONSENT_CHECKS` | (empty) | optional list of check ids that must be present |

QA: Cleffo testing is **sandbox only**. Never test live with our own card (Cleffo warned this can shut the
account down).
