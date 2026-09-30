# Server map (droplet 134.199.235.122)

Which folder of this repo is which path on the live server. The server is the source of truth: changes made
on the server are copied back here as a PR; nothing in this repo is deployed over the server automatically.

| Repo folder | Live path | Runs as | Serves |
|---|---|---|---|
| `server/`, `src/`, `index.html` | `/opt/crm-umg` | systemd `crm-umg`, `:8787` | card / Cleffo / crypto checkout, inventory, order emails |
| `crm-api/` | `/opt/crm-api` | PM2 `blitz-api`, `127.0.0.1:3001` | CRM login, users, leads, marketing, Customer.io, customer timeline |
| `crm-web/` | `/var/www/mastersol/html/CRM` | nginx static | CRM pages at `crm.biolabsresearch.co/crm/` |
| `products-api/` | `/var/www/mastersol/html/MSOLPEPTIDES/*.cjs` | PM2 `products-api`, `127.0.0.1:4000` | catalog, orders, coupon-quote, shop events; Telegram alerts |

Not in this repo, on purpose:

- secrets: `/opt/crm-api/.env` (read by `crm-api` and `products-api`), `/opt/crm-umg` env files;
- data: `/opt/crm-api/data/`, `MSOLPEPTIDES/*.json` (catalog, orders, customers, outbox), `/opt/crm-umg/server/data/`;
- the storefront: its own repo `biolabsresearch-co` (live copy `/var/www/biofirst`).

Server-side git: `/opt/crm-api` and `/var/www/mastersol` are local git repos without a remote (they track data files,
so they are not pushed). Every change there is committed on the server and mirrored here by a PR.
