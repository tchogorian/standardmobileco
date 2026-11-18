import { HttpError, json, readJson, sitePrice, getSetting, setSetting, nowIso, timingSafeEqual } from './util.js';
import { currentUser } from './accounts.js';

function toPublic(env, r, showPrices) {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    condition: r.condition,
    quantity: r.quantity,
    ebayPrice: showPrices ? r.ebay_price : null,
    sitePrice: showPrices ? sitePrice(env, r.ebay_price) : null,
    isLot: !!r.is_lot,
    status: r.held_by ? 'pending' : 'available',
    image: r.image,
    ebayUrl: r.ebay_url,
  };
}

// Prices are only sent to approved buyers; everyone else sees what is in stock.
export async function getStock(request, env) {
  const user = await currentUser(request, env);
  const showPrices = user?.status === 'approved';
  const { results } = await env.DB.prepare(
    'SELECT * FROM listings WHERE active = 1 ORDER BY held_by IS NOT NULL, seen_at DESC, rowid',
  ).all();
  return json({
    updatedAt: (await getSetting(env, 'stock_updated_at')) || nowIso(),
    viewer: user ? { name: user.name, status: user.status } : null,
    pricesVisible: showPrices,
    store: { name: 'ludatronix', url: 'https://www.ebay.com/str/ludatronix' },
    listings: results.map((r) => toPublic(env, r, showPrices)),
  });
}

export async function loadListings(env, ids) {
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT * FROM listings WHERE active = 1 AND id IN (${placeholders})`).bind(...ids).all();
  return results;
}

const IMG = /^https:\/\/i\.ebayimg\.com\//;
const ITEM_URL = /^https:\/\/www\.ebay\.com\/itm\/\d+$/;

function clean(l) {
  const id = String(l.id || '');
  const price = Number(l.ebayPrice);
  if (!/^\d{6,15}$/.test(id) || !Number.isFinite(price) || price <= 0 || price > 1_000_000) return null;
  const title = String(l.title || '').trim().slice(0, 200);
  if (!title) return null;
  const qty = Number.isInteger(l.quantity) && l.quantity > 0 ? l.quantity : null;
  return {
    id,
    title,
    category: String(l.category || 'Other').slice(0, 40),
    condition: String(l.condition || '').slice(0, 60),
    quantity: qty,
    ebayPrice: Math.round(price * 100) / 100,
    isLot: l.isLot ? 1 : 0,
    image: IMG.test(l.image || '') ? String(l.image).slice(0, 500) : null,
    ebayUrl: ITEM_URL.test(l.ebayUrl || '') ? l.ebayUrl : `https://www.ebay.com/itm/${id}`,
  };
}

const CATEGORIES = [
  [/\bipads?\b/i, 'iPads'],
  [/\biphones?\b/i, 'iPhones'],
  [/\bgalaxy tab\b|\bsamsung tab\b/i, 'Samsung Tablets'],
  [/\bssd\b|\bnvme\b|\bhdd\b|\bheatsink\b|\bddr\d\b|\bram\b|\bpower supply\b|\bgpu\b|\bgraphics card\b|\bmotherboard\b/i, 'PC Parts'],
  [/\bgalaxy\b|\bpixel\b|\bmotorola\b/i, 'Android Phones'],
  [/\bmacbook\b|\blaptop\b|\bchromebook\b|\bthinkpad\b/i, 'Laptops'],
  [/\bapple watch\b|\bwatch\b/i, 'Watches'],
  [/\bcamera|gopro|canon|nikon|kodak|fujifilm|polaroid/i, 'Cameras'],
  [/\bswitch\b|\bplaystation\b|\bps[345]\b|\bxbox\b|\bnintendo\b|\bgame|\brog ally\b|\bsteam deck\b/i, 'Games & Consoles'],
  [/\bairpods?\b|\bheadphones?\b|\bbeats\b/i, 'Audio'],
];

export function describeTitle(title) {
  const lot = title.match(/\b(?:bulk\s+)?lot\s+of\s+(\d+)/i);
  const category = (CATEGORIES.find(([re]) => re.test(title)) || [null, 'Other'])[1];
  return { category, isLot: !!lot, quantity: lot ? Number(lot[1]) : null };
}

const sameRow = (r, l) => r.active === 1 && r.title === l.title && r.category === l.category && r.condition === l.condition &&
  r.quantity === l.quantity && r.ebay_price === l.ebayPrice && r.is_lot === l.isLot && r.image === l.image && r.ebay_url === l.ebayUrl;

// Replaces the active stock with `input`, writing only rows that changed. Holds (held_by) are never touched.
export async function applyListings(env, input, { force = false } = {}) {
  const listings = input.map(clean).filter(Boolean);
  if (listings.length > 5000) throw new HttpError(400, 'Too many listings.');
  const { results: current } = await env.DB.prepare('SELECT * FROM listings').all();
  const activeCount = current.filter((r) => r.active === 1).length;
  if (!force && (listings.length === 0 || listings.length < activeCount * 0.5)) {
    throw new HttpError(409, `Refusing to replace ${activeCount} listings with ${listings.length}; looks like a failed read. Retry with force if this is real.`);
  }

  const seen = nowIso();
  const byId = new Map(current.map((r) => [r.id, r]));
  const upsert = env.DB.prepare(`
    INSERT INTO listings (id, title, category, condition, quantity, ebay_price, is_lot, image, ebay_url, active, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, category = excluded.category, condition = excluded.condition,
      quantity = excluded.quantity, ebay_price = excluded.ebay_price, is_lot = excluded.is_lot, image = excluded.image,
      ebay_url = excluded.ebay_url, active = 1, seen_at = excluded.seen_at`);
  const stmts = listings
    .filter((l) => !byId.has(l.id) || !sameRow(byId.get(l.id), l))
    .map((l) => upsert.bind(l.id, l.title, l.category, l.condition, l.quantity, l.ebayPrice, l.isLot, l.image, l.ebayUrl, seen));
  const changed = stmts.length;

  const incoming = new Set(listings.map((l) => l.id));
  const gone = current.filter((r) => r.active === 1 && !incoming.has(r.id)).map((r) => r.id);
  // D1 allows at most 100 bound parameters per statement.
  for (let i = 0; i < gone.length; i += 90) {
    const ids = gone.slice(i, i + 90);
    stmts.push(env.DB.prepare(`UPDATE listings SET active = 0 WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await setSetting(env, 'stock_updated_at', seen);
  return { active: listings.length, changed, deactivated: gone.length };
}

// PUT /api/sync/stock, called by the mirror job on the office PC with a bearer token.
// Ignored once the eBay API is connected, so the two sources never fight.
export async function syncStock(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.SYNC_TOKEN || !timingSafeEqual(auth, `Bearer ${env.SYNC_TOKEN}`)) throw new HttpError(401, 'Unauthorized.');
  if (await getSetting(env, 'ebay_tokens')) return json({ ok: true, skipped: 'eBay API is connected; mirror updates are ignored.' });

  const body = await readJson(request, 2_000_000);
  if (!Array.isArray(body.listings)) throw new HttpError(400, 'listings must be an array.');
  const force = new URL(request.url).searchParams.get('force') === '1';
  return json({ ok: true, ...(await applyListings(env, body.listings, { force })) });
}
