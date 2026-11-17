// Every network call the stock and admin pages make goes through this file.
// The backend (worker/) owns prices, invoices and listing holds; the pages only display them.

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

export const CONFIG = {
  CURRENCY: 'USD',
  EBAY_STORE_URL: 'https://www.ebay.com/str/ludatronix',
  WHATSAPP_NUMBER: '17866135141',
  COMPANY_NAME: 'Standard Mobile Company',
  // Cloudflare's always-pass test key locally; the real widget key in production.
  TURNSTILE_SITE_KEY: LOCAL ? '1x00000000000000000000AA' : '0x4AAAAAAGFp5W7irQSfO3QB',
};

export function formatMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: CONFIG.CURRENCY }).format(n);
}

export function whatsappLink(message) {
  return `https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

// { updatedAt, source, store, listings:[{ id, title, category, condition, quantity, ebayPrice,
//   sitePrice, isLot, status:'available'|'pending', image, ebayUrl }] }
export function getStock() {
  return request('GET', '/api/stock');
}

// input: { listingIds, offerAmount, customer:{ name, company, email, phone }, notes, turnstileToken }
// -> { result:'invoiced', offerId, invoice } | { result:'received', offerId, askingTotal }
export function submitOffer(input) {
  return request('POST', '/api/offers', input);
}

export function listOffers() {
  return request('GET', '/api/admin/offers');
}

// action: 'accept' | 'deny' | 'counter' | 'release'
export function decideOffer(offerId, action, { counterAmount, message } = {}) {
  return request('POST', `/api/admin/offers/${encodeURIComponent(offerId)}/${action}`, { counterAmount, message });
}

export function qboStatus() {
  return request('GET', '/api/admin/qbo/status');
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
  return data;
}
