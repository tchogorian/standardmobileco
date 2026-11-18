# Stock list + offers: how it works

Public page `stock.html` mirrors the ludatronix eBay store at 3% below eBay (`DISCOUNT` in `worker/wrangler.jsonc`). Customers select
listings and send an offer. At or above asking they get a QuickBooks invoice on the spot (Zelle on
the invoice, WhatsApp opens for wire details). Below asking goes to `admin.html` for
accept / counter / deny. The team gets an email for every invoice and every offer.

## Pieces

| Piece | Where | Notes |
| --- | --- | --- |
| Pages | `stock.html`, `admin.html`, `assets/stock/*` | Static, GitHub Pages. `api.js` is the only file that calls the backend. All DOM text via `textContent`. |
| Backend | `worker/` (Cloudflare Worker `smc-stock-api`) | Route `standardmobileco.com/api/*`, same origin as the site. D1 database `smc-stock`. |
| eBay mirror | `C:\Users\user\standardmobileco-sync\mirror.mjs` (copy in `worker/sync/`) | Headed Edge via playwright-core (eBay blocks headless/plain HTTP). Task Scheduler "Standard Mobile eBay mirror", every 2 h. Log: `standardmobileco-sync\logs\mirror.log`. |
| QuickBooks | `worker/src/qbo.js` | OAuth 2.0 + Accounting API v3 with fetch. Tokens AES-GCM encrypted in D1 `settings`. Connect from the admin page. |
| Email | `worker/src/email.js` | Cloudflare Email Service `send_email` binding, from `offers@standardmobileco.com`. |

`worker/` is stripped from the GitHub Pages deploy (`.github/workflows/deploy.yml`).

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/stock` | public | Active listings with server-computed `sitePrice`, `status` available/pending |
| POST | `/api/offers` | Turnstile + rate limit (5/min/IP) | Submit offer; returns `invoiced` (with invoice) or `received` |
| GET | `/api/invoices/{offerId}/pdf?exp&sig` | HMAC-signed link, 30 days | QuickBooks PDF |
| PUT | `/api/sync/stock` | `Authorization: Bearer SYNC_TOKEN` | Mirror upload. Refuses if count drops below 50% unless `?force=1` |
| GET | `/api/admin/offers` | Cloudflare Access JWT | Offer list |
| POST | `/api/admin/offers/{id}/{accept,deny,counter,release}` | Access | `release` un-holds listings on an invoiced offer |
| GET | `/api/admin/qbo/{status,connect,callback}` | Access | QuickBooks connection |

Rules the server enforces: prices come only from D1 (browser values ignored); at/above asking is
invoiced at the listed total; listing holds are atomic (`UPDATE ... WHERE held_by IS NULL`, all or
nothing); POSTs with a foreign `Origin` are rejected; admin routes fail closed until Access is configured.
If QuickBooks fails, the customer still gets an on-page invoice with the offer ID as reference, and the
team email and admin card say to create it by hand.

## Config

`worker/wrangler.jsonc` vars: `SITE_ORIGIN`, `TEAM_EMAIL`, `FROM_EMAIL`, `ZELLE_RECIPIENT`, `WHATSAPP_DISPLAY`,
`DISCOUNT`, `INVOICE_DUE_DAYS`, `QBO_ENV` (`sandbox`/`production`), `QBO_CLIENT_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`.

Secrets (`npx wrangler secret put NAME` in `worker/`): `TOKEN_KEY`, `LINK_SECRET`, `SYNC_TOKEN`,
`TURNSTILE_SECRET` (all set), `QBO_CLIENT_SECRET` (not set yet). Changing `TOKEN_KEY` disconnects QuickBooks;
changing `SYNC_TOKEN` requires updating `standardmobileco-sync\.env`.

Turnstile widget "standardmobileco offers", site key in `assets/stock/api.js`.

## Local development

```
cd worker
npm install
npm run migrate:local
npm run dev                  # Worker on :8787, uses .dev.vars
node dev-server.mjs          # site + /api proxy on http://127.0.0.1:8088
```

`.dev.vars` (not committed): `TOKEN_KEY`, `LINK_SECRET`, `SYNC_TOKEN=dev-sync-token`,
`TURNSTILE_SECRET=1x0000000000000000000000000000000AA` (Cloudflare test key), `DEV_ADMIN_BYPASS=1`,
`QBO_CLIENT_SECRET=`. Load local stock: point `standardmobileco-sync\.env` `SYNC_URL` at
`http://127.0.0.1:8787/api/sync/stock` with the dev token and run `node mirror.mjs`.

Deploy: `npm run deploy` (schema changes: add a file in `worker/migrations/`, then `npm run migrate:remote`).
Logs: `npm run tail`.

## Still to do before going live

1. **Cloudflare Access** (Zero Trust > Access > Applications > Self-hosted): domain `standardmobileco.com`,
   paths `/admin.html` and `/api/admin/*`, allow the team's emails. Put the team domain
   (`<team>.cloudflareaccess.com`) and the application AUD tag in `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`, deploy.
2. **Email Sending**: Cloudflare dashboard > Email Service > Email Sending > onboard `standardmobileco.com`
   (the API token used here was not allowed to). Until then emails fail (logged, flows continue).
3. **QuickBooks**: in the Intuit app (sandbox keys) add redirect URI
   `https://standardmobileco.com/api/admin/qbo/callback`; `npx wrangler secret put QBO_CLIENT_SECRET`;
   admin page > Connect QuickBooks. For real invoices switch to production keys, `QBO_ENV=production`, reconnect.
4. Merge `stock-list` to `main`, add a Stock link to the site nav and `stock.html` to `sitemap.xml`.

Open questions: footer WhatsApp is `17865359684`, sales flow uses `17866135141`; invoice terms are 3 days.
