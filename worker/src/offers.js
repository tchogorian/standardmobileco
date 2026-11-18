import { HttpError, json, readJson, str, money, round2, randomId, nowIso, sitePrice, signLink, rateLimit } from './util.js';
import { loadListings } from './stock.js';
import { createInvoice, invoicePdf } from './qbo.js';
import { notifyTeamInvoiced, notifyTeamOffer, emailCustomerInvoiceFallback } from './email.js';
import { requireUser } from './accounts.js';
import { ensureFresh } from './ebay.js';

// Marks every listing as held by this offer, or none of them. Re-checks eBay first when it is connected.
export async function lockListings(env, offerId, ids) {
  await ensureFresh(env);
  const placeholders = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `UPDATE listings SET held_by = ? WHERE active = 1 AND held_by IS NULL AND id IN (${placeholders})`,
  ).bind(offerId, ...ids).run();
  if (res.meta.changes !== ids.length) {
    await env.DB.prepare('UPDATE listings SET held_by = NULL WHERE held_by = ?').bind(offerId).run();
    throw new HttpError(409, 'One or more of these listings was just taken. Refresh and try again.');
  }
}

function addDays(days) {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

// Creates the QuickBooks invoice (or a fallback reference if QuickBooks fails), notifies everyone,
// and returns the invoice record stored on the offer.
export async function finalizeInvoice(env, ctx, offer, total) {
  const date = nowIso();
  const dueDate = addDays(Number(env.INVOICE_DUE_DAYS) || 3);
  const invoice = {
    number: offer.id,
    date,
    dueDate,
    items: offer.items.map(({ id, title, price }) => ({ id, title, price })),
    subtotal: offer.askingTotal,
    total: round2(total),
    customer: offer.customer,
    payment: { zelle: env.ZELLE_RECIPIENT },
    qboId: null,
    qboError: null,
  };
  try {
    const created = await createInvoice(env, offer, invoice.total, dueDate);
    invoice.qboId = created.qboId;
    invoice.number = created.number;
  } catch (err) {
    console.error('qbo invoice failed', offer.id, err.message);
    invoice.qboError = err.message.slice(0, 500);
  }

  ctx.waitUntil((async () => {
    let pdf = null;
    if (invoice.qboId) {
      try {
        const bytes = new Uint8Array(await invoicePdf(env, invoice.qboId));
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        pdf = btoa(s);
      } catch (err) {
        console.error('qbo pdf failed', err.message);
      }
    } else {
      await emailCustomerInvoiceFallback(env, offer, invoice);
    }
    await notifyTeamInvoiced(env, offer, invoice, pdf);
  })());

  return invoice;
}

export async function publicInvoice(env, offerId, invoice) {
  const { qboId, qboError, ...rest } = invoice;
  let pdfUrl = null;
  if (qboId) {
    const { exp, sig } = await signLink(env, offerId, 30 * 86400);
    pdfUrl = `/api/invoices/${encodeURIComponent(offerId)}/pdf?exp=${exp}&sig=${sig}`;
  }
  return { ...rest, pdfUrl };
}

export async function submitOffer(request, env, ctx) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const user = await requireUser(request, env, { approved: true });
  await rateLimit(env.OFFER_LIMIT, user.id, 'Too many offers. Wait a minute and try again.');

  const body = await readJson(request);
  const ids = Array.isArray(body.listingIds) ? [...new Set(body.listingIds.map(String))] : [];
  if (!ids.length || ids.length > 50 || ids.some((id) => !/^\d{6,15}$/.test(id))) throw new HttpError(400, 'Select between 1 and 50 listings.');
  const customer = { name: user.name, company: user.company, email: user.email, phone: user.phone };
  const notes = str(body.notes, { max: 1000, name: 'Notes' });
  const offerAmount = money(body.offerAmount, 'Offer');

  await ensureFresh(env);
  const rows = await loadListings(env, ids);
  if (rows.length !== ids.length) throw new HttpError(409, 'One or more listings are no longer available. Refresh and try again.');
  if (rows.some((r) => r.held_by)) throw new HttpError(409, 'One or more listings are already on hold. Refresh and try again.');

  const items = ids.map((id) => {
    const r = rows.find((x) => x.id === id);
    return { id, title: r.title, price: sitePrice(env, r.ebay_price), ebayUrl: r.ebay_url };
  });
  const askingTotal = round2(items.reduce((s, i) => s + i.price, 0));
  const offer = {
    id: randomId('OF-'),
    userId: user.id,
    createdAt: nowIso(),
    status: 'pending',
    customer,
    notes,
    items,
    askingTotal,
    offerAmount,
    counterAmount: null,
    invoice: null,
    history: [{ at: nowIso(), action: 'submitted', by: 'customer' }],
  };

  if (offerAmount >= askingTotal) {
    await lockListings(env, offer.id, ids);
    offer.status = 'accepted';
    offer.invoice = await finalizeInvoice(env, ctx, offer, askingTotal);
    offer.history.push({ at: nowIso(), action: 'invoiced', by: 'auto' });
    await saveOffer(env, offer, ip, true);
    return json({ result: 'invoiced', offerId: offer.id, invoice: await publicInvoice(env, offer.id, offer.invoice) });
  }

  await saveOffer(env, offer, ip, true);
  ctx.waitUntil(notifyTeamOffer(env, offer));
  return json({ result: 'received', offerId: offer.id, askingTotal });
}

export async function saveOffer(env, o, ip, insert = false) {
  const vals = [o.status, JSON.stringify(o.customer), o.notes, JSON.stringify(o.items), o.askingTotal, o.offerAmount,
    o.counterAmount, o.invoice ? JSON.stringify(o.invoice) : null, JSON.stringify(o.history)];
  if (insert) {
    await env.DB.prepare(`INSERT INTO offers (status, customer, notes, items, asking_total, offer_amount, counter_amount, invoice, history, id, created_at, ip, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...vals, o.id, o.createdAt, ip || null, o.userId || null).run();
  } else {
    await env.DB.prepare(`UPDATE offers SET status = ?, customer = ?, notes = ?, items = ?, asking_total = ?, offer_amount = ?,
      counter_amount = ?, invoice = ?, history = ? WHERE id = ?`).bind(...vals, o.id).run();
  }
}

export function rowToOffer(r) {
  return {
    id: r.id,
    userId: r.user_id || null,
    createdAt: r.created_at,
    status: r.status,
    customer: JSON.parse(r.customer),
    notes: r.notes,
    items: JSON.parse(r.items),
    askingTotal: r.asking_total,
    offerAmount: r.offer_amount,
    counterAmount: r.counter_amount,
    invoice: r.invoice ? JSON.parse(r.invoice) : null,
    history: JSON.parse(r.history),
  };
}

export async function getOffer(env, id) {
  const r = await env.DB.prepare('SELECT * FROM offers WHERE id = ?').bind(id).first();
  return r ? rowToOffer(r) : null;
}

async function buyerView(env, o) {
  const lastMessage = [...o.history].reverse().find((h) => h.message && h.by !== 'customer');
  return {
    id: o.id,
    createdAt: o.createdAt,
    status: o.status,
    items: o.items.map(({ id, title, price }) => ({ id, title, price })),
    askingTotal: o.askingTotal,
    offerAmount: o.offerAmount,
    counterAmount: o.counterAmount,
    message: lastMessage ? lastMessage.message : null,
    invoice: o.invoice ? await publicInvoice(env, o.id, o.invoice) : null,
  };
}

export async function myOffers(request, env) {
  const user = await requireUser(request, env);
  const { results } = await env.DB.prepare('SELECT * FROM offers WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').bind(user.id).all();
  return json(await Promise.all(results.map((r) => buyerView(env, rowToOffer(r)))));
}

export async function acceptCounter(request, env, ctx, offerId) {
  const user = await requireUser(request, env, { approved: true });
  const offer = await getOffer(env, offerId);
  if (!offer || offer.userId !== user.id) throw new HttpError(404, 'Offer not found.');
  if (offer.status !== 'countered') throw new HttpError(409, 'This offer has no open counter.');

  await lockListings(env, offer.id, offer.items.map((i) => i.id));
  offer.status = 'accepted';
  offer.invoice = await finalizeInvoice(env, ctx, offer, offer.counterAmount);
  offer.history.push({ at: nowIso(), action: 'accepted counter', by: 'customer', amount: offer.counterAmount });
  await saveOffer(env, offer);
  return json(await buyerView(env, offer));
}
