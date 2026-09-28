# Transactional customer order emails

Three emails, sent from `"BioLabs Research" <support@biolabsresearch.co>` (no Reply-To, so replies go to support@):

| Type | When | Subject |
|---|---|---|
| `confirmation` | the order is paid (card approved, Cleffo paid, or crypto marked paid) | `Order BLR-1234 received – BioLabs Research` |
| `shipping` | paid + fulfillment `shipped` + tracking number (Rapid poller, ship/tracking endpoints, `POST /api/fulfillment/:id/tracking`) | `Order BLR-1234 has shipped` |
| `followup` | 7 days after `shippedAt` (`ORDER_EMAILS_FOLLOWUP_DAYS`) | `Did your order arrive complete and intact?` |

## Header logo
All email types show the official BioLabs logo (blue helix + black "BIO LABS", transparent PNG, 400x167 shown at 200px, alt "BioLabs Research") in a white header above the gold rule. The image is loaded from `https://biolabsresearch.co/media/email/biolabs-logo-email.png`, which must be hosted there before sending is enabled. `ORDER_EMAIL_LOGO_URL` can override this, but only with an https URL. Previews may pass `renderEmail(type, order, { logoUrl: "data:image/png;base64,..." })`. The plain-text part is unchanged.

## Content rules (Marketing + Legal)
- Products are shown only by catalog name (`server/config/rapid-sku-map.draft.json`: stealth names such as G3-R, otherwise the RC-nn id), with `Strength: 10mg`. INN/compound names are never shown.
- The gift line (research solvent) is never shown in items or totals. The totals always equal the checkout total to the cent: subtotal − volume discount (5/10/15%) + shipping = amount charged. If the stored figures don't reconcile, per-line prices are hidden and only shipping + total are shown.
- The follow-up is a service email only: no review ask, no coupon.
- Every email ends with the RUO footer, verbatim: `For research use only. Not for human or veterinary use. Not a drug, food, or cosmetic.`
- No use, mixing, dosing or storage-for-use instructions.
- **Guard:** every rendered email (subject + text, with the customer address and card descriptor redacted) is scanned for INN/street names (`COMPOUND_TERMS` + the names in the SKU map) plus `EMAIL_EXTRA_TERMS` (dose, inject, reconstitute, bac water, lot COA, gift, ...). Any match means the send is blocked, `blocked_guard` is logged, and an alert goes to admin@.

## Delivery
- nodemailer SMTP. Google Workspace: `smtp.gmail.com:465` with an app password.
- Up to 3 retries with 2s / 10s / 30s backoff. After that the status is `failed` and an alert goes from noreply@ to `ORDER_EMAILS_ALERT_TO`.
- Sending is fire-and-forget: checkout and order endpoints never wait for SMTP.
- **Idempotent per (order, type):** state is stored in `order.emails[type]` and survives restarts. A `sending` state older than 15 minutes (interrupted by a restart) becomes `failed_unknown` plus an alert. It is never resent automatically.
- **Test/dry-run orders** (`test:true`, `DRY-` keys, STUB descriptor) never get an email unless a QA call passes `qa:true`.
- **Sweeper:** runs every `ORDER_EMAILS_SWEEP_MS` (30s). It only considers orders created on or after `ORDER_EMAILS_SINCE`, or after process start when that is unset, so there is never a backlog blast.
- **Log:** `email-log.jsonl`, stored next to the store (mode 600), one line per attempt. Fields: `{at, type, orderId, orderRef, to, status, attempt, messageId, via, error?, blocked?}`.
- **Statuses:** `sent`, `retrying`, `failed`, `failed_unknown`, `blocked_guard`, `skipped_disabled`, `no_recipient`.

## Env (`/etc/crm-umg/mail.env` via the `order-emails.conf` drop-in)
```
ORDER_EMAILS_ENABLED=false            # true = actually send (also needs SUPPORT_SMTP_PASS)
ORDER_EMAILS_SINCE=<ISO time>         # sweeper ignores older orders
ORDER_EMAILS_ALERT_TO=admin@biolabsresearch.co
SUPPORT_SMTP_HOST=smtp.gmail.com  SUPPORT_SMTP_PORT=465  SUPPORT_SMTP_USER=support@biolabsresearch.co  SUPPORT_SMTP_PASS=<app password>
NOREPLY_SMTP_HOST=smtp.gmail.com  NOREPLY_SMTP_PORT=465  NOREPLY_SMTP_USER=noreply@biolabsresearch.co  NOREPLY_SMTP_PASS=<app password>
```
While disabled (or while the password is empty), every email is still rendered, guard-checked and logged as `skipped_disabled`, and the order is marked accordingly. Those orders are not emailed later when sending is turned on.

## Staff endpoints (`X-Marketing-Key` or CRM session)
- `GET /api/emails/status`: whether sending is enabled, whether passwords are set (booleans only), the since time, and the registered types.
- `GET /api/emails/log?orderId=&type=&limit=`: recipients are masked unless `full=1`.
- `POST /api/emails/preview/:type {orderId?, data?}`: returns subject, html, text and guard. Uses a sample order when `orderId` is omitted.
- `POST /api/emails/resend/:orderId/:type {qa?}`: forced resend, logged with `via: resend:<actor>`.
- `POST /api/emails/process {orderId?, qa?, forceFollowup?}`: runs the sweeper step now (QA hook).
- `POST /api/fulfillment/:orderId/tracking {carrier, trackingNumber}`: marks any paid order as shipped with tracking, which triggers the shipping email.

## Adding a new customer email type (reusable helper)
```js
import { registerEmailType } from "./lib/order-emails.js";
import { h } from "./lib/email-templates.js";

registerEmailType("payment_cancelled", {
  subject: (order, ctx) => `Order ${order.id} cancelled – payment not received`,
  preheader: (order, ctx) => "No payment was received for this order.",   // optional
  blocks: (order, ctx) => [
    h.heading("Your order was cancelled"),
    h.p(`We did not receive payment for order ${order.id} within ${ctx.data.hours} hours, so the order was cancelled.`),
    h.p("If you already sent payment, reply to this email with the transaction hash."),
  ],
});

// anywhere with access to the handler's emailer (index.js: `orderEmailer`, or handler.orderEmailer):
await orderEmailer.send(order.id, "payment_cancelled", { data: { hours: 24 } });
```
- Blocks come from `h.*`: `heading, p, strong, kv([[k,v]]), section, lines([...]), button(label, url), rule, items(orderTotals(order))`.
- Every registered type automatically gets the layout, the exact RUO footer, the guard, the SMTP password gate, retries, the log, the admin alert on failure, and idempotency per (order, type). Pass `{force:true}` to resend.
- `send()` resolves to `{ok, status, attempt?, messageId?, blocked?}` and never throws.
