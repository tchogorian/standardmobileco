import { HttpError, encrypt, decrypt, getSetting, setSetting, deleteSetting, round2, randomId, timingSafeEqual } from './util.js';

// QuickBooks Online via plain fetch (the intuit-oauth Node SDK does not run on Workers).
// Endpoints: developer.intuit.com OAuth 2.0 + Accounting API v3.

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';
const ITEM_NAME = 'Wholesale stock';

const apiBase = (env) => (env.QBO_ENV === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');
const redirectUri = (env) => `${env.SITE_ORIGIN}/api/admin/qbo/callback`;

export class QboReauthError extends Error {}

// ---------- OAuth ----------

export async function buildConnectUrl(env) {
  if (!env.QBO_CLIENT_SECRET) throw new HttpError(503, 'QBO_CLIENT_SECRET is not set.');
  const state = randomId('', 32);
  await setSetting(env, 'qbo_state', JSON.stringify({ state, exp: Date.now() + 10 * 60_000 }));
  const q = new URLSearchParams({ client_id: env.QBO_CLIENT_ID, response_type: 'code', scope: SCOPE, redirect_uri: redirectUri(env), state });
  return `${AUTHORIZE_URL}?${q}`;
}

async function tokenRequest(env, params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`QuickBooks token error: ${data.error || res.status} (intuit_tid ${res.headers.get('intuit_tid') || 'n/a'})`);
    err.code = data.error;
    throw err;
  }
  return data;
}

async function saveTokens(env, realmId, t) {
  const now = Date.now();
  await setSetting(env, 'qbo_tokens', await encrypt(env, JSON.stringify({
    realmId,
    accessToken: t.access_token,
    accessExpiresAt: now + t.expires_in * 1000,
    refreshToken: t.refresh_token,
    refreshExpiresAt: now + t.x_refresh_token_expires_in * 1000,
  })));
}

async function loadTokens(env) {
  const raw = await getSetting(env, 'qbo_tokens');
  return raw ? JSON.parse(await decrypt(env, raw)) : null;
}

export async function handleCallback(env, url) {
  const saved = JSON.parse((await getSetting(env, 'qbo_state')) || 'null');
  await deleteSetting(env, 'qbo_state');
  const state = url.searchParams.get('state') || '';
  if (url.searchParams.get('error')) throw new HttpError(400, `QuickBooks returned: ${url.searchParams.get('error')}`);
  if (!saved || saved.exp < Date.now() || !timingSafeEqual(saved.state, state)) throw new HttpError(400, 'Connection request expired or did not match. Start again.');
  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  if (!code || !realmId) throw new HttpError(400, 'Missing code or company id.');
  const t = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(env) });
  await saveTokens(env, realmId, t);
  return realmId;
}

async function refresh(env, tokens) {
  try {
    const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    await saveTokens(env, tokens.realmId, t);
    return loadTokens(env);
  } catch (err) {
    if (err.code === 'invalid_grant') {
      await deleteSetting(env, 'qbo_tokens');
      throw new QboReauthError('QuickBooks needs to be reconnected from the admin page.');
    }
    throw err;
  }
}

async function validTokens(env, force = false) {
  let tokens = await loadTokens(env);
  if (!tokens) throw new QboReauthError('QuickBooks is not connected.');
  if (force || tokens.accessExpiresAt - Date.now() < 120_000) tokens = await refresh(env, tokens);
  return tokens;
}

export async function status(env) {
  const tokens = await loadTokens(env).catch(() => null);
  return {
    connected: !!tokens && tokens.refreshExpiresAt > Date.now(),
    environment: env.QBO_ENV,
    realmId: tokens ? tokens.realmId : null,
    refreshExpiresAt: tokens ? new Date(tokens.refreshExpiresAt).toISOString() : null,
  };
}

// ---------- API ----------

async function api(env, method, path, { body, accept = 'application/json', contentType } = {}) {
  let tokens = await validTokens(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = new URL(`${apiBase(env)}/v3/company/${tokens.realmId}${path}`);
    url.searchParams.set('minorversion', MINOR_VERSION);
    const headers = { Authorization: `Bearer ${tokens.accessToken}`, Accept: accept };
    if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (res.status === 401 && attempt === 0) {
      tokens = await validTokens(env, true);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`QuickBooks ${method} ${path.split('?')[0]} failed ${res.status} (intuit_tid ${res.headers.get('intuit_tid') || 'n/a'}): ${detail.slice(0, 300)}`);
    }
    return accept === 'application/json' ? res.json() : res.arrayBuffer();
  }
}

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function query(env, sql) {
  const data = await api(env, 'GET', `/query?query=${encodeURIComponent(sql)}`);
  return data.QueryResponse || {};
}

async function ensureItem(env) {
  const { realmId } = await validTokens(env);
  const cacheKey = `qbo_item_${realmId}`;
  const cached = await getSetting(env, cacheKey);
  if (cached) return cached;

  let item = (await query(env, `select Id from Item where Name = '${q(ITEM_NAME)}'`)).Item?.[0];
  if (!item) {
    const account = (await query(env, "select Id from Account where AccountType = 'Income' maxresults 1")).Account?.[0];
    if (!account) throw new Error('No income account found in QuickBooks.');
    item = (await api(env, 'POST', '/item', { body: { Name: ITEM_NAME, Type: 'Service', IncomeAccountRef: { value: account.Id } } })).Item;
  }
  await setSetting(env, cacheKey, item.Id);
  return item.Id;
}

async function ensureCustomer(env, c) {
  const display = `${c.company || c.name} - ${c.email}`.replace(/[:\t\n\r]/g, ' ').slice(0, 100);
  const found = (await query(env, `select Id from Customer where DisplayName = '${q(display)}'`)).Customer?.[0];
  if (found) return found.Id;
  const body = {
    DisplayName: display,
    PrimaryEmailAddr: { Address: c.email },
    PrimaryPhone: { FreeFormNumber: c.phone.slice(0, 30) },
    Notes: 'Created from standardmobileco.com stock offers',
  };
  if (c.company) body.CompanyName = c.company.slice(0, 100);
  return (await api(env, 'POST', '/customer', { body })).Customer.Id;
}

// Spread the agreed total across lines in proportion to listed prices, so no QBO discount
// setting is needed; the last line absorbs rounding.
function allocate(items, total) {
  const listed = items.reduce((s, i) => s + i.price, 0);
  let left = round2(total);
  return items.map((it, idx) => {
    const amt = idx === items.length - 1 ? left : round2((it.price / listed) * total);
    left = round2(left - amt);
    return amt;
  });
}

export async function createInvoice(env, offer, total, dueDate) {
  const [itemId, customerId] = await Promise.all([ensureItem(env), ensureCustomer(env, offer.customer)]);
  const amounts = allocate(offer.items, total);
  const memo = `Pay by Zelle to ${env.ZELLE_RECIPIENT}. For wire transfer details, message sales on WhatsApp ${env.WHATSAPP_DISPLAY}. Include the invoice number with your payment.`;
  const invoice = (await api(env, 'POST', '/invoice', {
    body: {
      CustomerRef: { value: customerId },
      BillEmail: { Address: offer.customer.email },
      DueDate: dueDate.slice(0, 10),
      CustomerMemo: { value: memo.slice(0, 1000) },
      PrivateNote: `Website offer ${offer.id}. eBay items: ${offer.items.map((i) => i.id).join(', ')}. Listed total ${offer.askingTotal}.`.slice(0, 4000),
      Line: offer.items.map((it, idx) => ({
        DetailType: 'SalesItemLineDetail',
        Amount: amounts[idx],
        Description: `${it.title} (eBay #${it.id})`.slice(0, 4000),
        SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: amounts[idx] },
      })),
    },
  })).Invoice;

  await api(env, 'POST', `/invoice/${invoice.Id}/send?sendTo=${encodeURIComponent(offer.customer.email)}`, { body: '', contentType: 'application/octet-stream' });
  return { qboId: invoice.Id, number: invoice.DocNumber || invoice.Id };
}

export function invoicePdf(env, qboId) {
  return api(env, 'GET', `/invoice/${encodeURIComponent(qboId)}/pdf`, { accept: 'application/pdf' });
}
