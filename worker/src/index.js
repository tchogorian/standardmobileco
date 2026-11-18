import { HttpError, json, verifyLink } from './util.js';
import { requireAdmin } from './access.js';
import { getStock, syncStock } from './stock.js';
import { submitOffer, getOffer, myOffers, acceptCounter } from './offers.js';
import { listOffers, decideOffer, listUsers, decideUser } from './admin.js';
import * as accounts from './accounts.js';
import * as qbo from './qbo.js';

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

function isSiteOrigin(origin, env) {
  if (origin === env.SITE_ORIGIN) return true;
  return env.DEV_ADMIN_BYPASS === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  // Writes must come from our own pages. Browsers always send Origin on cross-site writes, so a
  // missing header is only tolerated for the bearer-token sync job, which carries no cookie.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin ? !isSiteOrigin(origin, env) : path !== '/api/sync/stock') throw new HttpError(403, 'Forbidden.');
  }

  if (path === '/api/stock' && method === 'GET') return getStock(request, env);
  if (path === '/api/offers' && method === 'POST') return submitOffer(request, env, ctx);
  if (path === '/api/sync/stock' && method === 'PUT') return syncStock(request, env);

  if (path === '/api/account/signup' && method === 'POST') return accounts.signup(request, env, ctx);
  if (path === '/api/account/login' && method === 'POST') return accounts.login(request, env);
  if (path === '/api/account/logout' && method === 'POST') return accounts.logout(request, env);
  if (path === '/api/account/me' && method === 'GET') return accounts.me(request, env);
  if (path === '/api/account/me' && method === 'PUT') return accounts.updateProfile(request, env);
  if (path === '/api/account/password' && method === 'POST') return accounts.changePassword(request, env);
  if (path === '/api/account/forgot' && method === 'POST') return accounts.forgotPassword(request, env, ctx);
  if (path === '/api/account/reset' && method === 'POST') return accounts.resetPassword(request, env);
  if (path === '/api/account/offers' && method === 'GET') return myOffers(request, env);

  let m = path.match(/^\/api\/account\/offers\/(OF-[A-Z0-9]{10})\/accept$/);
  if (m && method === 'POST') return acceptCounter(request, env, ctx, m[1]);

  m = path.match(/^\/api\/invoices\/(OF-[A-Z0-9]{10})\/pdf$/);
  if (m && method === 'GET') {
    if (!(await verifyLink(env, m[1], url.searchParams.get('exp'), url.searchParams.get('sig')))) throw new HttpError(403, 'This link has expired.');
    const offer = await getOffer(env, m[1]);
    if (!offer?.invoice?.qboId) throw new HttpError(404, 'Invoice not found.');
    const pdf = await qbo.invoicePdf(env, offer.invoice.qboId);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="invoice-${offer.invoice.number}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (path.startsWith('/api/admin/')) {
    const admin = await requireAdmin(request, env);

    if (path === '/api/admin/offers' && method === 'GET') return listOffers(env);
    m = path.match(/^\/api\/admin\/offers\/(OF-[A-Z0-9]{10})\/(accept|deny|counter|release)$/);
    if (m && method === 'POST') return decideOffer(request, env, ctx, admin, m[1], m[2]);

    if (path === '/api/admin/users' && method === 'GET') return listUsers(env);
    m = path.match(/^\/api\/admin\/users\/(U-[A-Z0-9]{10})\/(approve|reject|disable|enable)$/);
    if (m && method === 'POST') return decideUser(request, env, ctx, admin, m[1], m[2]);

    if (path === '/api/admin/qbo/status' && method === 'GET') return json(await qbo.status(env));
    if (path === '/api/admin/qbo/connect' && method === 'GET') return redirect(await qbo.buildConnectUrl(env));
    if (path === '/api/admin/qbo/callback' && method === 'GET') {
      await qbo.handleCallback(env, url);
      return redirect('/admin.html?qbo=connected');
    }
  }

  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof qbo.QboReauthError) return json({ error: err.message }, 503);
      console.error('unhandled', err.stack || err.message);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },
};
