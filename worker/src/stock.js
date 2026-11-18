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

// PUT /api/sync/stock, called by the mirror job on the office PC with a bearer token.
export async function syncStock(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.SYNC_TOKEN || !timingSafeEqual(auth, `Bearer ${env.SYNC_TOKEN}`)) throw new HttpError(401, 'Unauthorized.');

  const body = await readJson(request, 2_000_000);
  if (!Array.isArray(body.listings)) throw new HttpError(400, 'listings must be an array.');
  const listings = body.listings.map(clean).filter(Boolean);
  if (listings.length > 5000) throw new HttpError(400, 'Too many listings.');

  const force = new URL(request.url).searchParams.get('force') === '1';
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM listings WHERE active = 1').first();
  if (!force && (listings.length === 0 || listings.length < n * 0.5)) {
    throw new HttpError(409, `Refusing to replace ${n} listings with ${listings.length}; looks like a failed scrape. Retry with ?force=1 if this is real.`);
  }

  const seen = nowIso();
  const upsert = env.DB.prepare(`
    INSERT INTO listings (id, title, category, condition, quantity, ebay_price, is_lot, image, ebay_url, active, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, category = excluded.category, condition = excluded.condition,
      quantity = excluded.quantity, ebay_price = excluded.ebay_price, is_lot = excluded.is_lot, image = excluded.image,
      ebay_url = excluded.ebay_url, active = 1, seen_at = excluded.seen_at`);
  const stmts = listings.map((l) => upsert.bind(l.id, l.title, l.category, l.condition, l.quantity, l.ebayPrice, l.isLot, l.image, l.ebayUrl, seen));
  stmts.push(env.DB.prepare('UPDATE listings SET active = 0 WHERE seen_at < ?').bind(seen));
  await env.DB.batch(stmts);
  await setSetting(env, 'stock_updated_at', seen);

  return json({ ok: true, active: listings.length, deactivated: Math.max(0, n - listings.length) });
}
