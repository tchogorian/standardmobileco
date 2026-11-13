// Integration adapter for the stock list and admin pages.
// Every network call the pages make goes through this file. The pages never compute
// authoritative prices or create invoices themselves; the backend must.
//
// MODE 'mock' runs entirely in the browser (sample stock + localStorage) so the layout
// and flow can be demoed. Set MODE to 'live' and API_BASE to the backend origin to
// switch to real endpoints. See STOCK-INTEGRATION.md for the request/response contract.

export const CONFIG = {
  MODE: 'mock',
  API_BASE: '',
  SAMPLE_STOCK_URL: 'data/stock.sample.json',
  DISCOUNT: 0.05,
  CURRENCY: 'USD',
  EBAY_STORE_URL: 'https://www.ebay.com/str/ludatronix',
  WHATSAPP_NUMBER: '17866135141',
  ZELLE_RECIPIENT: 'alex@standardmobilecompany.com',
  COMPANY_NAME: 'Standard Mobile Company',
};

export function sitePrice(ebayPrice) {
  return Math.round(ebayPrice * (1 - CONFIG.DISCOUNT) * 100) / 100;
}

export function formatMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: CONFIG.CURRENCY }).format(n);
}

export function whatsappLink(message) {
  return `https://wa.me/${CONFIG.WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

// ---------- public: stock ----------

// Returns { updatedAt, store:{name,url}, listings:[{id,title,category,condition,quantity,
// ebayPrice,sitePrice,isLot,status,image,ebayUrl}] }
export async function getStock() {
  if (CONFIG.MODE === 'live') return request('GET', '/api/stock');
  const res = await fetch(CONFIG.SAMPLE_STOCK_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load stock.');
  const data = await res.json();
  const pending = new Set(mockDb().pendingIds);
  data.listings = data.listings.map((l) => ({
    ...l,
    sitePrice: sitePrice(l.ebayPrice),
    status: pending.has(l.id) ? 'pending' : l.status,
  }));
  return data;
}

// ---------- public: offers ----------

// input: { listingIds:[], offerAmount, customer:{name,company,email,phone}, notes, turnstileToken }
// returns one of:
//   { result:'invoiced', offerId, invoice:{ number, date, dueDate, items:[{id,title,price}],
//       total, customer, payment:{ zelle }, pdfUrl } }
//   { result:'received', offerId, askingTotal }
export async function submitOffer(input) {
  if (CONFIG.MODE === 'live') return request('POST', '/api/offers', input);

  const stock = await getStock();
  const items = stock.listings.filter((l) => input.listingIds.includes(l.id));
  if (items.length !== input.listingIds.length) throw new Error('One or more listings are no longer available.');
  if (items.some((l) => l.status !== 'available')) throw new Error('One or more listings are already pending.');
  const askingTotal = round2(items.reduce((s, l) => s + l.sitePrice, 0));

  const db = mockDb();
  const offerId = `OF-${Date.now().toString(36).toUpperCase()}`;
  const offer = {
    id: offerId,
    createdAt: new Date().toISOString(),
    customer: input.customer,
    notes: input.notes || '',
    items: items.map((l) => ({ id: l.id, title: l.title, price: l.sitePrice, ebayUrl: l.ebayUrl })),
    askingTotal,
    offerAmount: input.offerAmount,
    status: 'pending',
    history: [],
  };

  if (input.offerAmount >= askingTotal) {
    offer.status = 'accepted';
    offer.invoice = mockInvoice(offer, input.offerAmount);
    db.pendingIds.push(...offer.items.map((i) => i.id));
  }
  db.offers.unshift(offer);
  saveMockDb(db);

  return offer.invoice
    ? { result: 'invoiced', offerId, invoice: offer.invoice }
    : { result: 'received', offerId, askingTotal };
}

// ---------- admin ----------

// returns [{ id, createdAt, customer, notes, items:[{id,title,price,ebayUrl}], askingTotal,
//   offerAmount, status:'pending'|'countered'|'accepted'|'denied', counterAmount?, invoice?, history }]
export async function listOffers() {
  if (CONFIG.MODE === 'live') return request('GET', '/api/admin/offers');
  return mockDb().offers;
}

// action: 'accept' | 'deny' | 'counter'; counterAmount required for 'counter'.
// Accept must create the invoice (QuickBooks) and email it; counter must email the customer.
export async function decideOffer(offerId, action, { counterAmount, message } = {}) {
  if (CONFIG.MODE === 'live') {
    return request('POST', `/api/admin/offers/${encodeURIComponent(offerId)}/${action}`, { counterAmount, message });
  }
  const db = mockDb();
  const offer = db.offers.find((o) => o.id === offerId);
  if (!offer) throw new Error('Offer not found.');
  const at = new Date().toISOString();
  if (action === 'accept') {
    const amount = offer.status === 'countered' ? offer.counterAmount : offer.offerAmount;
    offer.status = 'accepted';
    offer.invoice = mockInvoice(offer, amount);
    db.pendingIds.push(...offer.items.map((i) => i.id));
  } else if (action === 'deny') {
    offer.status = 'denied';
  } else if (action === 'counter') {
    if (!(counterAmount > 0)) throw new Error('Enter a counter amount.');
    offer.status = 'countered';
    offer.counterAmount = round2(counterAmount);
  } else {
    throw new Error('Unknown action.');
  }
  offer.history.push({ at, action, counterAmount: offer.counterAmount, message: message || '' });
  saveMockDb(db);
  return offer;
}

// ---------- internals ----------

async function request(method, path, body) {
  const res = await fetch(`${CONFIG.API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
  return data;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function mockInvoice(offer, amount) {
  const now = new Date();
  const due = new Date(now.getTime() + 3 * 86400000);
  return {
    number: `SMC-${now.getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
    date: now.toISOString(),
    dueDate: due.toISOString(),
    items: offer.items.map((i) => ({ id: i.id, title: i.title, price: i.price })),
    subtotal: offer.askingTotal,
    total: round2(amount),
    customer: offer.customer,
    payment: { zelle: CONFIG.ZELLE_RECIPIENT },
    pdfUrl: null,
  };
}

const MOCK_KEY = 'smc-stock-mock-v1';

function mockDb() {
  try {
    const db = JSON.parse(localStorage.getItem(MOCK_KEY));
    if (db && Array.isArray(db.offers)) return db;
  } catch { /* reset below */ }
  return { offers: [], pendingIds: [] };
}

function saveMockDb(db) {
  localStorage.setItem(MOCK_KEY, JSON.stringify(db));
}

export function resetMockData() {
  localStorage.removeItem(MOCK_KEY);
}
