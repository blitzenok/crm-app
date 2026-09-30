# Cleffo daily cap (2026-09-29)

Cleffo is the **first** card processor (`CLEFFO_ENABLED=true`, `CLEFFO_SPLIT_PCT=100`). `CLEFFO_DAILY_CAP_USD` limits how
much goes to Cleffo per calendar day. Once the day's Cleffo total is used up, **UMG takes the card** (reason `cap`).

| Env | Default | Meaning |
|---|---|---|
| `CLEFFO_DAILY_CAP_USD` | empty = no cap | e.g. `2000`. 0, empty or not a number = no cap |
| `CLEFFO_CAP_PENDING_MIN` | = `CLEFFO_LINK_TTL_MIN` (60) | open Cleffo links younger than this count toward the cap |
| `CLEFFO_CAP_TZ` | Asia/Jerusalem | whose calendar day ("today") |

## The rule (`capDecision()` in `server/lib/routing.js`)

```
used today = Cleffo attempts with status PAID, paid (finishedAt) on today's Asia/Jerusalem date
           + open Cleffo links (LINK_CREATED / LINK_UNKNOWN, no outcome, not abandoned) created in the last `CLEFFO_CAP_PENDING_MIN` (60) min
             (the buyer's own order, same idempotency key, is not counted twice)
capped     = used + this order's server total > cap   OR   used >= cap
```

- Only PAID money counts for the day; pending links count only while they are young (`CLEFFO_CAP_PENDING_MIN`, 60 min = the link lifetime), so a burst of checkouts
  cannot overshoot the cap while buyers are still on the Cleffo page. Declined / expired / abandoned links never count.
- The cap applies only to an attempt that would open a **new** Cleffo payment: the first attempt (`bucket`) and the
  one-time soft-decline switch UMG -> Cleffo (`retry_switch_soft`). Retries of an existing Cleffo payment
  (`retry_same_hard` / `retry_same_pending`) are not moved: a link that may still be paid is never paid again on UMG.
- Never moves a buyer to UMG while a Cleffo link of theirs is still open (`LINK_CREATED` / `LINK_UNKNOWN`, abandoned or not,
  counted attempt or not; matched by e-mail or cart session, `CLEFFO_SWEEP_HOURS` back): the payment may still arrive and a UMG
  charge on top would be a double payment. Log: `[routing] cap: skipped open_cleffo_link <order> attempt=<n> status=... -> stays cleffo`.
- Not applied with `CLEFFO_ONLY=true` (there is no UMG path then).
- `/api/checkout/charge` uses the server-side cart total. `/api/checkout/route` has no total (the storefront sends only
  the email), so it answers `umg` when nothing is left (`used >= cap`) or when this buyer was already capped.
- A capped buyer (email / cart session) stays on UMG for `CLEFFO_CAP_PENDING_MIN` (60 by default, never less than 30), so `/route` and `/charge` agree.
- Capped and the page sent no card (it showed the Cleffo step): `400 card_required`, `charged:false`. The storefront
  already handles this (shows the card fields, re-asks `/route`, which now says `umg`).
- Unchanged: a Cleffo link that cannot be created still falls back to UMG (card on hand / `retry_switch_link_error`);
  a failed Cleffo *payment* stays on Cleffo (hard, never switched), as before.

## Logs

```
[routing] cap: cleffo day=2026-09-29 paid=1900.00 pending=0.00 order=169.09 cap=2000.00 was=bucket -> umg reason=cap
[routing] BLR-1234 attempt=1 processor=umg reason=cap outcome=approved retryClass=none basis=approved
```
The order's routing log holds `reason: "cap"`. Staff `/api/psp/cleffo` shows `dailyCap.today` (paid / pending / used).
No email or card data in the cap line.

## Turn off
- Cap only: remove `CLEFFO_DAILY_CAP_USD` (drop-in `cleffo-zz-cap.conf`), `systemctl daemon-reload && systemctl restart crm-umg`
  (or `/root/rollback-crm-umg.sh cleffo-cap-off`). Cleffo stays first, uncapped.
- Cleffo off (UMG only): `/root/rollback-crm-umg.sh cleffo-disable`.

Tests: `server/tests/cleffo-daily-cap.test.js`.
