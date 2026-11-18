import { HttpError, json, readJson, money, str, nowIso } from './util.js';
import { rowToOffer, getOffer, saveOffer, lockListings, finalizeInvoice } from './offers.js';
import { emailCustomerCounter, emailCustomerDenied, emailUserApproved, emailUserRejected } from './email.js';
import { publicUser, deleteUserSessions } from './accounts.js';

const OPEN = new Set(['pending', 'countered']);

export async function listOffers(env) {
  const { results } = await env.DB.prepare('SELECT * FROM offers ORDER BY created_at DESC LIMIT 500').all();
  return json(results.map(rowToOffer));
}

export async function decideOffer(request, env, ctx, admin, offerId, action) {
  const body = await readJson(request).catch((err) => {
    if (err.status === 415) return {};
    throw err;
  });
  const offer = await getOffer(env, offerId);
  if (!offer) throw new HttpError(404, 'Offer not found.');
  const message = str(body.message, { max: 1000, name: 'Message' });
  const entry = { at: nowIso(), action, by: admin.email };

  if (action === 'accept') {
    if (!OPEN.has(offer.status)) throw new HttpError(409, `Offer is already ${offer.status}.`);
    const amount = offer.status === 'countered' ? offer.counterAmount : offer.offerAmount;
    await lockListings(env, offer.id, offer.items.map((i) => i.id));
    offer.status = 'accepted';
    offer.invoice = await finalizeInvoice(env, ctx, offer, amount);
    entry.amount = amount;
  } else if (action === 'counter') {
    if (!OPEN.has(offer.status)) throw new HttpError(409, `Offer is already ${offer.status}.`);
    offer.counterAmount = money(body.counterAmount, 'Counter');
    offer.status = 'countered';
    entry.counterAmount = offer.counterAmount;
    ctx.waitUntil(emailCustomerCounter(env, offer, message));
  } else if (action === 'deny') {
    if (!OPEN.has(offer.status)) throw new HttpError(409, `Offer is already ${offer.status}.`);
    offer.status = 'denied';
    ctx.waitUntil(emailCustomerDenied(env, offer, message));
  } else if (action === 'release') {
    if (offer.status !== 'accepted') throw new HttpError(409, 'Only invoiced offers can be released.');
    await env.DB.prepare('UPDATE listings SET held_by = NULL WHERE held_by = ?').bind(offer.id).run();
    offer.status = 'denied';
  } else {
    throw new HttpError(404, 'Unknown action.');
  }

  if (message) entry.message = message;
  offer.history.push(entry);
  await saveOffer(env, offer);
  return json(offer);
}

export async function listUsers(env) {
  const { results } = await env.DB.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM offers o WHERE o.user_id = u.id) AS offer_count
    FROM users u ORDER BY u.status = 'pending' DESC, u.created_at DESC LIMIT 1000`).all();
  return json(results.map((u) => ({
    ...publicUser(u), about: u.about, reviewedAt: u.reviewed_at, reviewedBy: u.reviewed_by, offerCount: u.offer_count,
  })));
}

const USER_TRANSITIONS = {
  approve: { from: ['pending', 'rejected'], to: 'approved' },
  reject: { from: ['pending'], to: 'rejected' },
  disable: { from: ['approved', 'pending'], to: 'disabled' },
  enable: { from: ['disabled'], to: 'approved' },
};

export async function decideUser(request, env, ctx, admin, userId, action) {
  const rule = USER_TRANSITIONS[action];
  if (!rule) throw new HttpError(404, 'Unknown action.');
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!user) throw new HttpError(404, 'Buyer not found.');
  if (!rule.from.includes(user.status)) throw new HttpError(409, `Buyer is ${user.status}.`);

  await env.DB.prepare('UPDATE users SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?')
    .bind(rule.to, nowIso(), admin.email, user.id).run();
  if (rule.to === 'disabled' || rule.to === 'rejected') await deleteUserSessions(env, user.id);
  if (action === 'approve') ctx.waitUntil(emailUserApproved(env, user));
  if (action === 'reject') ctx.waitUntil(emailUserRejected(env, user));
  return json({ ...publicUser({ ...user, status: rule.to }) });
}
