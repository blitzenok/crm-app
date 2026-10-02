# CRM docs

Read-only inventory from the 2026-09-22 audit. The inventory files do not change runtime, config, or deploy.

Operational contracts:

- [Crypto checkout](CRYPTO_CHECKOUT.md) — pending USDT order, staff mark-paid, ship gate, deposit-address env.
- [Cleffo payment links](CLEFFO.md) — UMG/Cleffo split, retry rules, consent gate, storefront contract (code default off; ENABLED on prod since 2026-09-29).
- [Storefront hook (Indian)](STOREFRONT_HOOK.md) — JSON the shop calls. CRM only; do not edit the storefront in that change.

- [CRM & Retention inventory](CRM_RETENTION_INVENTORY_20260922.md) — full live read of CRM, retention features, data stores, and blockers as of 2026-09-22, including the Indian Soft-QA storefront appendix.
- [Legal extract](CRM_RETENTION_INVENTORY_LEGAL_EXTRACT_20260922.md) — consent, email, constraints, and unsubscribe paths from the same audit.
- [Storefront Soft-QA (Indian)](CRM_RETENTION_INVENTORY_STOREFRONT_INDIAN_20260922.md) — live storefront retention inventory for biolabsresearch.co (quote checkout, abandon, insider, and missing account/stock flows).
