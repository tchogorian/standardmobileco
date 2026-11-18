import { HttpError, encrypt, decrypt, getSetting, setSetting, deleteSetting, randomId, timingSafeEqual, nowIso } from './util.js';
import { applyListings, describeTitle } from './stock.js';

// eBay via plain fetch: OAuth 2.0 user consent (developer.ebay.com/api-docs/static/oauth-authorization-code-grant.html)
// and the Trading API (GetUser, GetSellerList) authenticated with the OAuth user token.

const AUTHORIZE_URL = 'https://auth.ebay.com/oauth2/authorize';
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
];
const COMPAT_LEVEL = '1193';
const PAGE_SIZE = 200;
// Trading API error codes for an expired or revoked token.
const TOKEN_ERRORS = new Set(['931', '932', '16110', '21916984', '21917053']);

export class EbayReauthError extends Error {}

export const configured = (env) => !!(env.EBAY_CLIENT_ID && env.EBAY_RUNAME && env.EBAY_CLIENT_SECRET);

// ---------- OAuth ----------

export async function buildConnectUrl(env) {
  if (!configured(env)) throw new HttpError(503, 'eBay is not configured: set EBAY_CLIENT_ID, EBAY_RUNAME and the EBAY_CLIENT_SECRET secret.');
  const state = randomId('', 32);
  await setSetting(env, 'ebay_state', JSON.stringify({ state, exp: Date.now() + 10 * 60_000 }));
  const q = new URLSearchParams({ client_id: env.EBAY_CLIENT_ID, redirect_uri: env.EBAY_RUNAME, response_type: 'code', scope: SCOPES.join(' '), state });
  return `${AUTHORIZE_URL}?${q}`;
}

async function tokenRequest(env, params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`eBay token error: ${data.error || res.status} ${data.error_description || ''}`.trim());
    err.code = data.error;
    throw err;
  }
  return data;
}

async function saveTokens(env, t, previous = {}) {
  const now = Date.now();
  const tokens = {
    user: previous.user || null,
    accessToken: t.access_token,
    accessExpiresAt: now + t.expires_in * 1000,
    refreshToken: t.refresh_token || previous.refreshToken,
    refreshExpiresAt: t.refresh_token_expires_in ? now + t.refresh_token_expires_in * 1000 : previous.refreshExpiresAt,
  };
  await setSetting(env, 'ebay_tokens', await encrypt(env, JSON.stringify(tokens)));
  return tokens;
}

async function loadTokens(env) {
  const raw = await getSetting(env, 'ebay_tokens');
  return raw ? JSON.parse(await decrypt(env, raw)) : null;
}

export async function handleCallback(env, url) {
  const saved = JSON.parse((await getSetting(env, 'ebay_state')) || 'null');
  await deleteSetting(env, 'ebay_state');
  const state = url.searchParams.get('state') || '';
  if (!saved || saved.exp < Date.now() || !timingSafeEqual(saved.state, state)) throw new HttpError(400, 'Connection request expired or did not match. Start again.');
  const code = url.searchParams.get('code');
  if (!code) throw new HttpError(400, 'eBay did not return an authorization code.');

  let tokens = await saveTokens(env, await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: env.EBAY_RUNAME }));
  const user = await currentEbayUser(env);
  const seller = (env.EBAY_SELLER || '').toLowerCase();
  if (seller && user.toLowerCase() !== seller) {
    await deleteSetting(env, 'ebay_tokens');
    throw new HttpError(400, `You signed in to eBay as ${user}. Sign in as ${env.EBAY_SELLER} and connect again.`);
  }
  tokens = { ...tokens, user };
  await setSetting(env, 'ebay_tokens', await encrypt(env, JSON.stringify(tokens)));
  return user;
}

async function validTokens(env, force = false) {
  let tokens = await loadTokens(env);
  if (!tokens) throw new EbayReauthError('eBay is not connected.');
  if (force || tokens.accessExpiresAt - Date.now() < 120_000) {
    try {
      tokens = await saveTokens(env, await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, scope: SCOPES.join(' ') }), tokens);
    } catch (err) {
      if (err.code === 'invalid_grant') {
        await deleteSetting(env, 'ebay_tokens');
        throw new EbayReauthError('eBay needs to be reconnected from the admin page.');
      }
      throw err;
    }
  }
  return tokens;
}

// ---------- Trading API ----------

const decodeXml = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1].trim()) : null;
}

function blocks(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
}

async function trading(env, call, inner) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tokens = await validTokens(env, attempt > 0);
    const res = await fetch(TRADING_URL, {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': call,
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': COMPAT_LEVEL,
        'X-EBAY-API-IAF-TOKEN': tokens.accessToken,
        'Content-Type': 'text/xml',
      },
      body: `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">${inner}</${call}Request>`,
    });
    const xml = await res.text();
    const ack = tag(xml, 'Ack');
    if (res.ok && (ack === 'Success' || ack === 'Warning')) return xml;
    const errors = blocks(xml, 'Errors').filter((e) => tag(e, 'SeverityCode') === 'Error');
    const codes = errors.map((e) => tag(e, 'ErrorCode'));
    if (attempt === 0 && (res.status === 401 || codes.some((c) => TOKEN_ERRORS.has(c)))) continue;
    const msg = errors.map((e) => `${tag(e, 'ErrorCode')}: ${tag(e, 'LongMessage') || tag(e, 'ShortMessage')}`).join('; ');
    throw new Error(`eBay ${call} failed (${res.status}${ack ? ` ${ack}` : ''}): ${msg || xml.slice(0, 300)}`);
  }
}

async function currentEbayUser(env) {
  const xml = await trading(env, 'GetUser', '');
  const user = tag(xml, 'UserID');
  if (!user) throw new Error('eBay GetUser returned no UserID.');
  return user;
}

const OUTPUT = [
  'ItemArray.Item.ItemID', 'ItemArray.Item.Title', 'ItemArray.Item.Quantity', 'ItemArray.Item.ListingType',
  'ItemArray.Item.SellingStatus', 'ItemArray.Item.PictureDetails', 'ItemArray.Item.ConditionDisplayName',
  'PaginationResult', 'HasMoreItems',
].map((s) => `<OutputSelector>${s}</OutputSelector>`).join('');

function toListing(itemXml) {
  const id = tag(itemXml, 'ItemID');
  // Auctions have no fixed price to discount from.
  if (!['FixedPriceItem', 'StoresFixedPrice'].includes(tag(itemXml, 'ListingType'))) return null;
  const status = itemXml.match(/<SellingStatus>([\s\S]*?)<\/SellingStatus>/)?.[1] || '';
  if (tag(status, 'ListingStatus') !== 'Active') return null;
  const available = Number(tag(itemXml, 'Quantity') || 0) - Number(tag(status, 'QuantitySold') || 0);
  if (available <= 0) return null;
  const title = tag(itemXml, 'Title') || '';
  const pictures = itemXml.match(/<PictureDetails>([\s\S]*?)<\/PictureDetails>/)?.[1] || '';
  const image = (tag(pictures, 'PictureURL') || tag(pictures, 'GalleryURL') || '').replace(/^http:/, 'https:');
  return {
    id,
    title,
    ebayPrice: Number(tag(status, 'CurrentPrice')),
    condition: tag(itemXml, 'ConditionDisplayName') || '',
    image,
    ebayUrl: `https://www.ebay.com/itm/${id}`,
    ...describeTitle(title),
  };
}

export const parseItems = (xml) => blocks(xml, 'Item').map(toListing).filter(Boolean);

export async function fetchActiveListings(env) {
  const now = Date.now();
  const from = new Date(now).toISOString();
  // GetSellerList accepts an end-time window of at most 120 days; good-'til-cancelled listings renew within 30.
  const to = new Date(now + 119 * 86400_000).toISOString();
  const listings = [];
  for (let page = 1; page <= 50; page++) {
    const xml = await trading(env, 'GetSellerList',
      `<EndTimeFrom>${from}</EndTimeFrom><EndTimeTo>${to}</EndTimeTo><DetailLevel>ReturnAll</DetailLevel>` +
      `<Pagination><EntriesPerPage>${PAGE_SIZE}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>${OUTPUT}`);
    listings.push(...parseItems(xml));
    const pages = Number(tag(tag(xml, 'PaginationResult') || '', 'TotalNumberOfPages') || 1);
    if (tag(xml, 'HasMoreItems') !== 'true' && page >= pages) break;
  }
  return listings;
}

// ---------- sync ----------

export async function syncFromEbay(env, { force = false } = {}) {
  try {
    const listings = await fetchActiveListings(env);
    const result = await applyListings(env, listings, { force });
    await setSetting(env, 'ebay_last_sync', JSON.stringify({ at: nowIso(), ok: true, ...result }));
    return result;
  } catch (err) {
    await setSetting(env, 'ebay_last_sync', JSON.stringify({ at: nowIso(), ok: false, error: String(err.message).slice(0, 500) }));
    throw err;
  }
}

// Called before any invoice: re-reads eBay if our copy is older than maxAgeMs, so nothing sold on eBay
// in the meantime can be invoiced. Without an eBay connection (mirror mode) this is a no-op.
export async function ensureFresh(env, maxAgeMs = 60_000) {
  if (!configured(env) || !(await getSetting(env, 'ebay_tokens'))) return;
  const last = JSON.parse((await getSetting(env, 'ebay_last_sync')) || 'null');
  if (last?.ok && Date.now() - Date.parse(last.at) < maxAgeMs) return;
  try {
    await syncFromEbay(env);
  } catch (err) {
    console.error('ebay fresh check failed', err.message);
    throw new HttpError(503, "We couldn't confirm availability with eBay just now. Please try again in a few minutes.");
  }
}

export async function status(env) {
  const tokens = await loadTokens(env).catch(() => null);
  return {
    configured: configured(env),
    connected: !!tokens && (!tokens.refreshExpiresAt || tokens.refreshExpiresAt > Date.now()),
    user: tokens ? tokens.user : null,
    refreshExpiresAt: tokens?.refreshExpiresAt ? new Date(tokens.refreshExpiresAt).toISOString() : null,
    lastSync: JSON.parse((await getSetting(env, 'ebay_last_sync')) || 'null'),
  };
}

export async function scheduledSync(env) {
  if (!configured(env) || !(await getSetting(env, 'ebay_tokens'))) return;
  try {
    const r = await syncFromEbay(env);
    console.log('ebay sync', JSON.stringify(r));
  } catch (err) {
    console.error('ebay sync failed', err.message);
  }
}
