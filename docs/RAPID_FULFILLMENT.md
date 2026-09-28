# Rapid Fulfillment (3PL) integration — phase 1 (test server only)

Code: `server/lib/rapid.js` (SOAP client), `server/lib/rapid-orders.js` (mapping, push, pollers, stock), routes in `server/index.js`.

## Config (systemd drop-in `crm-umg.service.d/rapid.conf` + `EnvironmentFile=/etc/crm-umg/rapid.env`, mode 600)
| var | default | phase 1 |
|---|---|---|
| `RAPID_ENABLED` | false | true (client + scheduler + staff routes) |
| `RAPID_ENV` | test | test |
| `RAPID_AUTO_PUSH` | false | **false** |
| `RAPID_ALLOW_REAL_ORDERS` | false | **false** — without it no non-synthetic order is ever pushed, auto-push or not |
| `RAPID_LIVE_CONFIRM` | — | unset; the client refuses `RAPID_ENV=live` unless it is `yes-live` |
| `RAPID_TEST_API_USER` / `RAPID_TEST_API_PASS` | — | in rapid.env only (live creds are not on the server) |
| `RAPID_TEST_TLS_INSECURE` | false | true — honoured only when `RAPID_ENV=test` |
| `RAPID_ORDER_PREFIX` / `RAPID_TEST_ORDER_PREFIX` | 100 / 990 | order_id_prefix for store orders / synthetic QA orders |
| `RAPID_SKU_MAP_PATH` | /etc/crm-umg/rapid-sku-map.json | not installed yet (draft only) |
| `RAPID_SHIP_MAP` | `{"express":"usps_rrd_priority","ground":"usps_evs_parcelgrnd"}` | draft, Rapid to confirm |
| `RAPID_TIMEOUT_MS` / `RAPID_RETRIES` | 20000 / 2 | |
| `RAPID_GIFT_MODE` | omit | omit (BAC gift off the slip, flagged `rapid.manualPack`) |

## Client
rpc/encoded envelopes built from the WSDL types (no deps), `urn:WF`, SOAPAction `urn:WF_Api_Soap_HandlerAction`.
Lazy `login`, cached session, one re-login on fault 3; network/timeout/HTTP 5xx/fault 5 retried (500 ms, 1 s).
Faults -> `RapidError{code,kind}` (0 unknown, 1 access_denied, 2 invalid_path, 3 session_expired, 4 missing_parameter,
5 internal_error, 6 not_found, 7 already_exists, 10 client_error, 100 custom_error). `orders_new` fault 7 = success
(`alreadyExists`). Search / list methods return `[]` for fault 6 (Rapid's answer to an empty result).

## Orders
Eligible: card `approved` or crypto `crypto_paid` + `paymentConfirmed`; never `test` / `dryRun`; never already shipped;
real orders only with `RAPID_ALLOW_REAL_ORDERS=true`. `order_id` = numeric part of `BLR-n`, prefix `RAPID_ORDER_PREFIX`,
`custom_data orig_order_id` = CR-ref (crypto) or BLR-id (card), source `biolabsresearch.co`, order_date US Pacific,
address fields cut to the XML-schema lengths, country -> ISO2, products via the SKU map (product_id <= 16), prices from
`priceCheck.lines`, totals from the order, USD. Result on `order.rapid` (`pushed` / `exists` / `error`), so pushes are idempotent.

## Pollers (in-process, only when RAPID_ENABLED)
Minute tick, state in `/var/lib/crm-umg/rapid-state.json`:
- 07:15 Asia/Jerusalem daily (= after 21:00 Pacific): `orders_search ship_date=<Pacific date>, prefix` -> tracking,
  ship date, `fulfillment.status=shipped` (shippedBy `rapid`); plus `orders_rejected` / `returns_list` for that date.
  Retry every 15 min on failure (max 4), then give up for the day.
- 07:30 daily: `products_stock` -> inventory SKU `rapid_stock {product_id, stock, allocated, syncedAt}` (stock_qty untouched).
- Hourly: `orders_search` per pushed, non-final order.
`rejected` / `returned` / `addrcorrect` set `order.rapidAlert {type, reason, at, acknowledged:false}` and log `[rapid] ALERT`.

## Staff routes (operator auth: X-Marketing-Key or CRM session)
`GET /api/rapid/health` (login test) · `GET /api/rapid/couriers` · `GET /api/rapid/stock` · `GET /api/rapid/alerts` ·
`POST /api/rapid/test-order` (synthetic QA Test / qa-test+rapid@biolabsresearch.co / tprod, prefix 990; 403 on live) ·
`GET|DELETE /api/rapid/test-order/:orderId` (read back / cancel, test prefix only; 403 on live) ·
`POST /api/rapid/poll-now {job: all|status|shipped|stock, date?}`.

## Packing-slip compliance (legal, 2026-09-28)
- Everything Rapid can print — `product_id`, product `name`, `extra`, `message`, `custom_data` — carries only internal ids
  and neutral names: `RC-nn <strength> vial` (ids `RCnn-<mg>`), and the site's stealth code names for G1-S / G2-T / G3-R.
  Names come **only** from the SKU map; storefront item names and order notes are never sent.
- `assertNoCompoundNames` runs on every payload (store + synthetic) before `orders_new`: a static INN / compound list
  (`COMPOUND_TERMS`) plus every non-stealth storefront slug from the SKU map keys. Any hit -> `compound_name_blocked`,
  nothing is sent, `order.rapid.status=error`.
- The free research-solvent (BAC) gift is never printed. Default `RAPID_GIFT_MODE=omit`: the line is left out of
  `products` and the order gets `rapid.manualPack=[{sku, qty, reason}]` for manual packing. Alternative
  `RAPID_GIFT_MODE=neutral` sends `INS-01 / Accessory insert` (needs that SKU set up at Rapid).
- Draft map: `server/config/rapid-sku-map.draft.json` (not installed; install as `/etc/crm-umg/rapid-sku-map.json` once
  Rapid has the SKUs). Keys are storefront SKUs (internal), values `{product_id, name, internal_id, inventory_code?, stealth?}`
  or `{gift:true}`.
