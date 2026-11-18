# Stock list + offers: how it works

`stock.html` lists the ludatronix eBay store. Anyone can see what is in stock; only **approved buyer
accounts** see prices (3% below eBay, `DISCOUNT` in `worker/wrangler.jsonc`) and can send offers. At or
above asking the buyer gets a QuickBooks invoice on the spot (Zelle on the invoice, WhatsApp opens for
wire details). Below asking goes to `admin.html` for accept / counter / deny; buyers accept counters
from `account.html`. The team gets an email for every invoice, offer and new signup.

## Pieces

| Piece | Where | Notes |
| --- | --- | --- |
| Pages | `stock.html`, `account.html`, `admin.html`, `assets/stock/*` | Static, GitHub Pages. `api.js` is the only file that calls the backend. All DOM text via `textContent`. |
| Backend | `worker/` (Cloudflare Worker `smc-stock-api`) | Route `standardmobileco.com/api/*`, same origin as the site. D1 database `smc-stock`. |
| Buyer accounts | `worker/src/accounts.js` | Email + password (PBKDF2-SHA256, 100k iterations, the Workers max). Sessions: `__Host-smc_session` cookie (HttpOnly, Secure, SameSite=Lax, 30 days), stored as SHA-256 hashes. New accounts are `pending` until approved in admin > Buyers. |
| eBay stock (API) | `worker/src/ebay.js` | OAuth user consent as ludatronix, Trading API `GetSellerList` every 5 min (cron) and again before any invoice if the copy is over 60 s old. Fixed-price, active, in-stock listings only. Writes only changed rows. |
| eBay mirror (fallback) | `C:\Users\user\standardmobileco-sync\mirror.mjs` (copy in `worker/sync/`) | Headed Edge scrape every 2 h from the office PC. Ignored by the Worker once eBay API is connected; can then be disabled in Task Scheduler. |
| QuickBooks | `worker/src/qbo.js` | OAuth 2.0 + Accounting API v3 with fetch. Tokens AES-GCM encrypted in D1 `settings`. Connect from the admin page. |
| Email | `worker/src/email.js` | Cloudflare Email Service `send_email` binding, from `offers@standardmobileco.com`. |

`worker/` is stripped from the GitHub Pages deploy (`.github/workflows/deploy.yml`).

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/stock` | public | Active listings; `sitePrice`/`ebayPrice` only for approved buyers |
| POST | `/api/offers` | approved buyer session, 5/min/buyer | Submit offer; returns `invoiced` (with invoice) or `received` |
| POST | `/api/account/{signup,login,forgot}` | Turnstile + 10/min/IP | Signup creates a pending account; login locks 15 min after 8 wrong passwords |
| POST | `/api/account/{logout,password,reset}` | session / reset token | Reset links are emailed as `account.html#reset=TOKEN`, 1 hour, single use |
| GET/PUT | `/api/account/me` | session | Current buyer; update name/company/phone |
| GET | `/api/account/offers` | session | Buyer's own offers and invoices |
| POST | `/api/account/offers/{id}/accept` | approved buyer, own offer | Accept a counter; invoices at the counter amount |
| GET | `/api/invoices/{offerId}/pdf?exp&sig` | HMAC-signed link, 30 days | QuickBooks PDF |
| PUT | `/api/sync/stock` | `Authorization: Bearer SYNC_TOKEN` | Mirror upload. Refuses if count drops below 50% unless `?force=1` |
| GET | `/api/admin/offers`, `/api/admin/users` | Cloudflare Access JWT | Offer and buyer lists |
| POST | `/api/admin/offers/{id}/{accept,deny,counter,release}` | Access | `release` un-holds listings on an invoiced offer |
| POST | `/api/admin/users/{id}/{approve,reject,disable,enable}` | Access | Reject/disable also ends the buyer's sessions |
| GET | `/api/admin/{qbo,ebay}/{status,connect,callback}` | Access | QuickBooks / eBay connection |
| POST | `/api/admin/ebay/sync` | Access | Sync now (`?force=1` to accept a big drop) |

Rules the server enforces: prices come only from D1 (browser values ignored); at/above asking is
invoiced at the listed total; listing holds are atomic (`UPDATE ... WHERE held_by IS NULL`, all or
nothing); every non-GET request must carry our `Origin` (the bearer-token sync job is the only exception);
admin routes fail closed until Access is configured; eBay connect refuses any account other than `EBAY_SELLER`;
if eBay is connected but unreachable, nothing is invoiced. If QuickBooks fails, the buyer still gets an
on-page invoice with the offer ID as reference, and the team email and admin card say to create it by hand.

## Config

`worker/wrangler.jsonc` vars: `SITE_ORIGIN`, `TEAM_EMAIL`, `FROM_EMAIL`, `ZELLE_RECIPIENT`, `WHATSAPP_DISPLAY`,
`DISCOUNT`, `INVOICE_DUE_DAYS`, `QBO_ENV` (`sandbox`/`production`), `QBO_CLIENT_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
`EBAY_CLIENT_ID` (App ID), `EBAY_RUNAME`, `EBAY_SELLER`.

Secrets (`npx wrangler secret put NAME` in `worker/`): `TOKEN_KEY`, `LINK_SECRET`, `SYNC_TOKEN`,
`TURNSTILE_SECRET` (all set), `QBO_CLIENT_SECRET`, `EBAY_CLIENT_SECRET` (Cert ID) (not set yet). Changing
`TOKEN_KEY` disconnects QuickBooks and eBay; changing `SYNC_TOKEN` requires updating `standardmobileco-sync\.env`.

Turnstile widget "standardmobileco offers", site key in `assets/stock/api.js` (used on the account forms).

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
Tests: `standardmobileco-sync\test-accounts.mjs` (API), `test-accounts-ui.mjs` (Edge), `test-ebay-parse.mjs`.

Deploy: `npm run deploy` (schema changes: add a file in `worker/migrations/`, then `npm run migrate:remote`).
Logs: `npm run tail`.

## Still to do before going live

1. **Cloudflare Access** (Zero Trust > Access > Applications > Self-hosted): domain `standardmobileco.com`,
   paths `/admin.html` and `/api/admin/*`, allow the team's emails. Put the team domain
   (`<team>.cloudflareaccess.com`) and the application AUD tag in `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`, deploy.
   Until then nobody can approve buyers.
2. **Email Sending**: Cloudflare dashboard > Email Service > Email Sending > onboard `standardmobileco.com`.
   Until then emails (signup alerts, approvals, password resets) fail (logged, flows continue).
3. **QuickBooks**: Intuit app redirect URI `https://standardmobileco.com/api/admin/qbo/callback`;
   `npx wrangler secret put QBO_CLIENT_SECRET`; admin page > Connect QuickBooks. For real invoices switch to
   production keys, `QBO_ENV=production`, reconnect.
4. **eBay**: production keyset + RuName (accept URL `https://standardmobileco.com/api/admin/ebay/callback`);
   set `EBAY_CLIENT_ID`, `EBAY_RUNAME`; `npx wrangler secret put EBAY_CLIENT_SECRET`; deploy; admin > Connect eBay.
   Open decision: what to do on eBay when the site invoices a listing (today: team email says end it by hand).
5. Merge `stock-list` to `main`, add Stock link to the site nav and `stock.html` to `sitemap.xml`.
