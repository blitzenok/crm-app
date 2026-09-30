# Cleffo guard (infra, 2026-09-29, money part 4)

Cleffo = the customer enters the card on Cleffo's hosted page, not on ours. The owner decided: **Cleffo is the main card
processor, UMG is the fallback** (`CLEFFO_ONLY=false`). These rules keep the money correct on that path. Please keep
them when you edit `index.js`, `lib/cleffo-checkout.js`, `lib/routing.js`, `lib/store.js`, `lib/sanitize.js`.

## What the server guarantees
- **Email is required** whenever `CLEFFO_ENABLED=true`: `/api/checkout/charge` without email → 400 `email_required`.
  (Without it, card-testing bots without email went straight to UMG.)
- **One live link per order.** A repeat `/charge` with the same key returns the same link (`reused:true`) for
  `CLEFFO_LINK_TTL_MIN` (60). Requests for one key run one at a time (double click = one attempt, one link).
  The same customer with the same cart under a NEW key also gets that live link (`reused:true`), no new order — only if
  EVERYTHING matches: email, name, phone digits, full address, cart, amount, ship method, coupon (a fixed typo in the
  address gets a new link with the new data; nobody gets another person's link by knowing the email).
  Orders in `approved`, `review` or `pending` never get a new link.
- **The sweep looks at every open link** (`LINK_CREATED`, abandoned or not, any order status) for `CLEFFO_SWEEP_HOURS`
  (72), and at `failed` links while they are younger than the link TTL (a late payment → `CLEFFO_LATE_PAID`). A payment on an old link is recorded. A second payment on a paid order keeps the order `approved`, does not
  touch `winningTxnId`, does not call `onPaid` again and raises `CLEFFO_DOUBLE_PAID` (refund by hand).
- **Amount and currency live in the attempt**; the settle check compares with them. A paid amount that differs from
  the attempt or the current order total → `review`, never `approved`.
- **USD only** (Cleffo and UMG, `cascade.js`): another currency → 400 `currency_unsupported` before any charge.
- **No server price → no link** (503 `pricing_unavailable`); the browser amount is never charged.
- **Fallback to UMG** (`CLEFFO_ONLY=false`): a link that cannot be created → 503 `processor_unavailable`, not charged;
  the next `/route` of the same customer answers `umg` (`retry_switch_link_error`); `/charge` on that step without a card
  → 400 `card_required`. A failed Cleffo *payment* stays on Cleffo (hard). With `CLEFFO_ONLY=true` there is no UMG path.
  No fallback while the customer has ANY open Cleffo link (any order): the card must not pay a cart the link can still pay.
  A timeout / cut connection while creating a link is `LINK_UNKNOWN` (Cleffo may have created it): 503, no fallback;
  the callback also matches such an attempt by `merchant_order_id`, but writes the ref only when Cleffo's status API
  confirms the same `merchant_order_id`, and never replaces a ref the attempt already has. If the status API does not
  answer, nothing is written: 503 + `CLEFFO_CALLBACK_UNVERIFIED`.
- **Return page by Origin** of the `/charge` request (biolabsresearch.co / blrcommerce.io, with or without www),
  stored in the attempt; `/cleffo/return` reads it from the attempt, never from the return request.
- **Logs cannot be forged**: text from the request goes through `logSafe()` (control characters and the literal
  `[pay-alert]` are neutralised).
- **store.json is written atomically**: temp file + fsync + rename, previous good copy `store.json.prev`. Unreadable
  store → the broken file is renamed `store.json.corrupt-<ts>`, `.prev` is loaded (`STORE_FROM_PREV`); the file mode is kept; both unreadable → `STORE_UNREADABLE` and exit (never start empty: the order
  counter would restart and BLR numbers would repeat).

## Daily cap (owner's agents, 2026-09-29)
`CLEFFO_DAILY_CAP_USD` (docs/CLEFFO_DAILY_CAP.md) moves new buyers to UMG once the day's Cleffo total is used — but never a
buyer who still has an open Cleffo link (`LINK_CREATED` / `LINK_UNKNOWN`, any order, 72 h): a slightly exceeded cap is
better than a second payment. Log: `[routing] cap: skipped open_cleffo_link`.

## Alerts (`[pay-alert] ` lines, sent to Telegram by ops-watch)
`CLEFFO_REVIEW`, `CLEFFO_LINK_ERROR` (≤ 1 per 10 min), `CLEFFO_STUCK_SUMMARY` (once a day: customers came back from
Cleffo and the payment is still pending after 24 h; abandoned links are only a log line),
`CLEFFO_DOUBLE_PAID`, `CLEFFO_LATE_PAID`, `CLEFFO_SAME_BUYER_PAID` (another approved order of the same email with the
same cart and amount created within one link lifetime of this one), `CLEFFO_CALLBACK_UNVERIFIED`, `STORE_FROM_PREV`, `STORE_UNREADABLE`. No card data or email in them.

## Tests
`tests/cleffo-part4.test.js`, `tests/store-atomic.test.js` (plus `tests/honest-charge.test.js` from part 2).
Source of truth: `services/honest-charge/` in the infra repo (biofirst-hosting).
