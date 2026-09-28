# Cleffo payment links (UMG + Cleffo split). Shipped DISABLED

- Adapter: `server/lib/cleffo.js` (create link, status, HMAC-SHA256 x-signature over the exact body, redirect token,
  timeouts, env-driven base URL and keys).
- Routing: `server/lib/routing.js` + `server/lib/retry-class.js`.
  - First processor: sticky sha256(email) bucket vs `CLEFFO_SPLIT_PCT`.
  - Soft decline switches to the other processor once. Hard or unknown declines stay on the same processor
    (fail closed). Cap is `CLEFFO_MAX_ATTEMPTS`.
- Glue: `server/lib/cleffo-checkout.js`.
  - Consent gate: record, then read back and verify the hash, before the link is created.
  - Server-side confirmation. The idempotent settle checks amount, currency and merchant_order_id. A mismatch goes
    to `review`.
  - A sweep polls open links for 24 h.
- Routes:
  - `POST /api/checkout/charge` (routing). Cleffo bucket returns `{processor:"cleffo", redirectUrl}`.
  - `POST /api/checkout/route`.
  - `GET /api/checkout/cleffo/return`.
  - `GET /api/checkout/cleffo/status`.
  - `POST /api/checkout/cleffo/callback`.
  - Staff: `GET /api/psp/cleffo`. `/api/psp/settings` also includes `cleffo`.
- Orders carry `routing.attempts[] {n, processor, reason, outcome, retryClass, retryBasis, retryCode}`,
  `paymentProcessor` and `attemptNumber`. Log lines start with `[routing]`.
- Product data sent to Cleffo: one neutral line, "BioLabs Research order BLR-xxxx", qty 1 × server total. This
  matches the UMG path, which sends the vendor, amount and order id and no product names.
- Keys: `/etc/crm-umg/cleffo.env` (mode 600) holds `CLEFFO_SANDBOX_*` and `CLEFFO_LIVE_*`. `CLEFFO_ENV` selects
  the set. A sandbox config pointing at production is refused.
- Sandbox E2E: `CLEFFO_ENV_PATH=... node server/scripts/cleffo-sandbox-e2e.mjs [--completed-ref REF]`. Never live.
- Storefront contract: [CLEFFO_STOREFRONT_CONTRACT.md](CLEFFO_STOREFRONT_CONTRACT.md).
- Open item: `CLEFFO_DESCRIPTOR` = UNKNOWN until Cleffo confirms the statement descriptor.
