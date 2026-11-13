# Stock list + offers: integration handoff

The front end is done and runs fully in the browser on mock data. What's left is the backend
(Cloudflare Worker), the eBay mirror, QuickBooks, and email. This doc is the contract.

## What's built

| File | Purpose |
| --- | --- |
| `stock.html` + `assets/stock/stock.js` | Public stock list: summary, category chips, search, sort, multi-select, offer form, invoice popup, WhatsApp hand-off |
| `admin.html` + `assets/stock/admin.js` | Offer review: tabs by status, accept / counter / deny, "end these on eBay" box for invoiced offers |
| `assets/stock/api.js` | **The only file that talks to a backend.** `CONFIG.MODE = 'mock'` today |
| `assets/stock/dom.js` | DOM builder; all text via `textContent` (no `innerHTML` anywhere) |
| `assets/stock/stock.css` | Styles, mobile layout, print-to-PDF for the invoice |
| `data/stock.sample.json` | Sample listings in the exact shape `GET /api/stock` must return |

Preview locally: `python -m http.server 8088` in the repo root, open `http://127.0.0.1:8088/stock.html`
and `/admin.html`. Mock offers live in `localStorage` (`smc-stock-mock-v1`); "Clear sample offers" on
the admin page resets them.

## Going live

1. Build the Worker endpoints below.
2. In `assets/stock/api.js`: set `MODE: 'live'` and `API_BASE` (empty string if the Worker is routed
   at `standardmobileco.com/api/*`, otherwise its full origin).
3. If `API_BASE` is a different origin, add it to `connect-src` in the CSP `<meta>` of both HTML files
   and return CORS headers for exactly `https://standardmobileco.com` with `Access-Control-Allow-Credentials: true`.
4. Add Turnstile (see Security) and pass the token where `stock.js` currently sends `turnstileToken: null`.
5. Add a "Stock" link to the nav in `index.html` / `insights.html` and `stock.html` to `sitemap.xml`.
   Never add `admin.html` to the sitemap.

## API contract

All JSON. Errors: non-2xx with `{ "error": "Human readable message" }` (the UI shows `error` verbatim).

### `GET /api/stock` (public)

```json
{
  "updatedAt": "2026-11-13T15:00:00Z",
  "source": "ebay-mirror",
  "store": { "name": "ludatronix", "url": "https://www.ebay.com/str/ludatronix" },
  "listings": [{
    "id": "296512345678",
    "title": "Apple iPad 10th Gen 64GB Wi-Fi Blue",
    "category": "iPads",
    "condition": "Used - Very Good",
    "quantity": 6,
    "ebayPrice": 239.00,
    "sitePrice": 227.05,
    "isLot": false,
    "status": "available",
    "image": "https://i.ebayimg.com/images/g/.../s-l500.jpg",
    "ebayUrl": "https://www.ebay.com/itm/296512345678"
  }]
}
```

- `id` = eBay item number. `status` is `available` or `pending` (pending = invoiced, waiting for payment /
  eBay removal; shown greyed out and not selectable).
- `sitePrice = round(ebayPrice * 0.95, 2)`, computed on the server.
- `source` other than `"sample"` hides the "Sample data" note.

### `POST /api/offers` (public, Turnstile + rate limited)

Request:

```json
{
  "listingIds": ["296512345678", "296598765432"],
  "offerAmount": 650.00,
  "customer": { "name": "", "company": "", "email": "", "phone": "" },
  "notes": "",
  "turnstileToken": "..."
}
```

Server must:

1. Verify Turnstile, validate every field (lengths match the form's `maxlength`), reject unknown IDs.
2. Load listings from **its own** stock data, reject any not `available`, compute `askingTotal` itself.
   Never use a price from the browser.
3. If `offerAmount >= askingTotal`: atomically mark listings `pending` (fail with 409 if another offer
   got there first), create the QuickBooks invoice, email the team, return:

```json
{
  "result": "invoiced",
  "offerId": "OF-...",
  "invoice": {
    "number": "1042",
    "date": "2026-11-13T15:00:00Z",
    "dueDate": "2026-11-16T15:00:00Z",
    "items": [{ "id": "296512345678", "title": "...", "price": 227.05 }],
    "subtotal": 721.05,
    "total": 721.05,
    "customer": { "name": "", "company": "", "email": "", "phone": "" },
    "payment": { "zelle": "alex@standardmobilecompany.com" },
    "pdfUrl": "/api/invoices/OF-.../pdf?t=<signed token>"
  }
}
```

   `pdfUrl` is optional. If null, "Download PDF" prints the on-page invoice (`window.print()`, print CSS
   shows only the invoice). If set, it must be unguessable (signed, expiring) since it has customer data.
4. Otherwise store the offer as `pending` and return `{ "result": "received", "offerId": "OF-...", "askingTotal": 721.05 }`.
   Email the team that an offer needs review.

When `result` is `invoiced` the page also opens WhatsApp to +1 786-613-5141 with the invoice number
and listing IDs prefilled; that's where the team sends wire details. Wire details are never on the page.

### `GET /api/admin/offers` (Cloudflare Access only)

Array, newest first:

```json
[{
  "id": "OF-...",
  "createdAt": "...",
  "customer": { "name": "", "company": "", "email": "", "phone": "" },
  "notes": "",
  "items": [{ "id": "", "title": "", "price": 0, "ebayUrl": "" }],
  "askingTotal": 0,
  "offerAmount": 0,
  "status": "pending | countered | accepted | denied",
  "counterAmount": 0,
  "invoice": { "number": "", "total": 0 },
  "history": [{ "at": "", "action": "", "counterAmount": 0, "message": "" }]
}]
```

### `POST /api/admin/offers/{id}/{accept|deny|counter}` (Cloudflare Access only)

Body: `{ "counterAmount": 690.00, "message": "" }` (`counterAmount` only for counter).

- **accept**: amount = `counterAmount` if status is `countered`, else `offerAmount`. Same as the
  at-asking path: lock listings, create + send the QBO invoice, email the team. Status becomes `accepted`.
- **counter**: store `counterAmount`, email the customer. Status `countered`.
- **deny**: status `denied`, optionally email the customer.

Returns the updated offer.

## Pieces to build

### eBay mirror (no API keys)

eBay returns 403 to plain HTTP and headless browsers; a normal headed Edge window works.
`C:\Users\user\standardmobileco-sync\probe.mjs` (playwright-core, `channel: 'msedge'`, `headless: false`)
loads the store page and finds the `/itm/` links. Turn that into a scheduled job on the always-on PC:

1. Open `https://www.ebay.com/str/ludatronix` (and pagination) at a normal pace, collect item number,
   title, price, quantity, condition, image URL, item URL.
2. Map to the `listings` shape above (category from title keywords, `isLot` from "Lot of").
3. POST to a Worker endpoint like `PUT /api/admin/stock` authenticated with a Cloudflare Access
   **service token** (stored only on the PC). Worker stores it in D1/KV; items already `pending` stay pending.
4. Run every 1-4 hours. Listings that vanish from eBay should drop out of `/api/stock`.

### QuickBooks invoice

The sandbox OAuth app at `C:\Users\user\qbo-sandbox-app` already handles the authorization_code flow,
encrypted token storage and refresh rotation. For the Worker, keep the refresh token in KV (encrypted)
and `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` as Worker secrets. Per invoice:

1. Find or create the Customer (query by email).
2. Create the Invoice: one line per listing (`Description` = title + eBay item number, `Amount` = price;
   use one generic service Item like "Wholesale stock"). If the final amount differs from the listed total,
   add a discount line so the total matches.
3. Send it: `POST /v3/company/{realmId}/invoice/{id}/send?sendTo={email}`.
4. PDF: `GET /v3/company/{realmId}/invoice/{id}/pdf` (stream through the Worker for `pdfUrl`).
5. Put the Zelle address and "wire details via WhatsApp +1 786-613-5141" in the invoice memo.

Move from sandbox to production keys only after the flow works end to end.

### Team email

To `smcom1000@gmail.com` on every invoice and every below-asking offer. Include offer ID, customer
contact, eBay item numbers with links, amounts, invoice number, and attach or link the PDF. Subject
like `INVOICED 1042: end eBay items 2965..., 2965...` so it's obvious which listings to remove.

## Security checklist

- [ ] Prices and totals computed only on the server; browser values ignored.
- [ ] Turnstile verified server-side on `POST /api/offers`; Cloudflare rate-limit rule on `/api/offers`.
- [ ] Honeypot: `stock.js` silently drops submissions with the hidden `website` field filled; also check server-side if you add it to the payload.
- [ ] `admin.html` and `/api/admin/*` behind **Cloudflare Access** (email allowlist). The static page has no
      secrets, but serve it from the Worker behind Access too, or at least never link to it.
- [ ] Worker verifies the `Cf-Access-Jwt-Assertion` header on admin routes, not just relying on routing.
- [ ] Listing lock is atomic (D1 transaction / conditional update) so two buyers can't invoice the same item.
- [ ] All secrets (QBO, email, Access service token) in `wrangler secret`, never in the repo.
- [ ] Validate and length-limit every input; never build HTML from user input in emails without escaping.
- [ ] CSP `<meta>` in both pages stays strict; only add origins you actually use.
- [ ] Rotate the QBO client secret that was shared in a screenshot.

## Open items

- The site footer's WhatsApp link is `wa.me/17865359684`; the sales number for this flow is
  `17866135141` (`CONFIG.WHATSAPP_NUMBER`). Confirm which the footer should use.
- Invoice due date in the mock is 3 days; set the real terms.
