import { escapeHtml, formatMoney } from './util.js';

async function send(env, message) {
  try {
    await env.EMAIL.send({ from: { email: env.FROM_EMAIL, name: 'Standard Mobile Company' }, ...message });
    return true;
  } catch (err) {
    console.error('email failed', err.code, err.message, message.subject);
    return false;
  }
}

function itemLines(items) {
  return items.map((i) => `- ${i.title} | eBay #${i.id} | ${formatMoney(i.price)} | ${i.ebayUrl}`).join('\n');
}

function itemRowsHtml(items) {
  return items.map((i) => `<tr><td>${escapeHtml(i.title)}</td><td><a href="${escapeHtml(i.ebayUrl)}">${escapeHtml(i.id)}</a></td><td align="right">${formatMoney(i.price)}</td></tr>`).join('');
}

function customerText(c) {
  return [c.name, c.company, c.email, c.phone].filter(Boolean).join(' | ');
}

export function notifyTeamInvoiced(env, offer, invoice, pdfBase64) {
  const ids = offer.items.map((i) => i.id).join(', ');
  const qboLine = invoice.qboError
    ? `QUICKBOOKS INVOICE FAILED: ${invoice.qboError}\nCreate the invoice manually. The customer was shown reference ${invoice.number}.`
    : `QuickBooks invoice ${invoice.number} created and emailed to the customer.`;
  const text = [
    `INVOICED ${formatMoney(invoice.total)}. End these eBay listings now: ${ids}`,
    '',
    qboLine,
    '',
    `Offer: ${offer.id}`,
    `Customer: ${customerText(offer.customer)}`,
    `Listed total: ${formatMoney(offer.askingTotal)}  Invoice total: ${formatMoney(invoice.total)}`,
    offer.notes ? `Notes: ${offer.notes}` : '',
    '',
    itemLines(offer.items),
  ].filter((l) => l !== null).join('\n');
  const html = `<p><strong>INVOICED ${formatMoney(invoice.total)}.</strong> End these eBay listings now: ${escapeHtml(ids)}</p>
<p${invoice.qboError ? ' style="color:#c0392b"' : ''}>${escapeHtml(qboLine).replace(/\n/g, '<br>')}</p>
<p>Offer ${escapeHtml(offer.id)}<br>${escapeHtml(customerText(offer.customer))}<br>Listed ${formatMoney(offer.askingTotal)}, invoice ${formatMoney(invoice.total)}</p>
${offer.notes ? `<p><em>${escapeHtml(offer.notes)}</em></p>` : ''}
<table cellpadding="6" border="1" style="border-collapse:collapse">${itemRowsHtml(offer.items)}</table>`;
  return send(env, {
    to: env.TEAM_EMAIL,
    replyTo: offer.customer.email,
    subject: `INVOICED ${invoice.number} ${formatMoney(invoice.total)}: end eBay ${ids}`.slice(0, 200),
    text,
    html,
    attachments: pdfBase64 ? [{ content: pdfBase64, filename: `invoice-${invoice.number}.pdf`, type: 'application/pdf', disposition: 'attachment' }] : undefined,
  });
}

export function notifyTeamOffer(env, offer) {
  const pct = Math.round((1 - offer.offerAmount / offer.askingTotal) * 100);
  const text = [
    `New offer to review: ${formatMoney(offer.offerAmount)} on ${formatMoney(offer.askingTotal)} listed (${pct}% below).`,
    `Review: ${env.SITE_ORIGIN}/admin.html`,
    '',
    `Offer: ${offer.id}`,
    `Customer: ${customerText(offer.customer)}`,
    offer.notes ? `Notes: ${offer.notes}` : '',
    '',
    itemLines(offer.items),
  ].join('\n');
  return send(env, {
    to: env.TEAM_EMAIL,
    replyTo: offer.customer.email,
    subject: `Offer ${formatMoney(offer.offerAmount)} (${pct}% below) from ${offer.customer.company || offer.customer.name}`.slice(0, 200),
    text,
  });
}

export function emailCustomerCounter(env, offer, message) {
  const text = [
    `Hi ${offer.customer.name},`,
    '',
    `Thanks for your offer of ${formatMoney(offer.offerAmount)}. We can do ${formatMoney(offer.counterAmount)} for:`,
    '',
    offer.items.map((i) => `- ${i.title}`).join('\n'),
    '',
    message || '',
    `To accept, log in at ${env.SITE_ORIGIN}/account.html and click Accept. Your invoice is created right away.`,
    `Questions? Reply to this email or message us on WhatsApp at ${env.WHATSAPP_DISPLAY}.`,
    '',
    'Standard Mobile Company',
  ].join('\n');
  return send(env, { to: offer.customer.email, replyTo: env.TEAM_EMAIL, subject: `Counter offer ${offer.id}: ${formatMoney(offer.counterAmount)}`, text });
}

export function emailCustomerDenied(env, offer, message) {
  const text = [
    `Hi ${offer.customer.name},`,
    '',
    `Thanks for your offer of ${formatMoney(offer.offerAmount)}. We can't accept it at this price.`,
    message || '',
    `Our current stock and prices are at ${env.SITE_ORIGIN}/stock.html. Feel free to send another offer.`,
    '',
    'Standard Mobile Company',
  ].join('\n');
  return send(env, { to: offer.customer.email, replyTo: env.TEAM_EMAIL, subject: `Your offer ${offer.id}`, text });
}

export function notifyTeamSignup(env, user) {
  const text = [
    `New buyer account waiting for approval: ${user.company} (${user.name}).`,
    `Approve or reject: ${env.SITE_ORIGIN}/admin.html#buyers`,
    '',
    `Email: ${user.email}`,
    `Phone: ${user.phone}`,
    user.about ? `About: ${user.about}` : '',
  ].join('\n');
  return send(env, { to: env.TEAM_EMAIL, replyTo: user.email, subject: `New buyer to approve: ${user.company}`.slice(0, 200), text });
}

export function emailUserApproved(env, user) {
  const text = [
    `Hi ${user.name},`,
    '',
    'Your Standard Mobile Company buyer account is approved. You can now see wholesale prices and send offers:',
    `${env.SITE_ORIGIN}/stock.html`,
    '',
    'Standard Mobile Company',
  ].join('\n');
  return send(env, { to: user.email, replyTo: env.TEAM_EMAIL, subject: 'Your buyer account is approved', text });
}

export function emailUserRejected(env, user) {
  const text = [
    `Hi ${user.name},`,
    '',
    "Thanks for applying for a Standard Mobile Company buyer account. We weren't able to approve it right now.",
    `If you think this is a mistake, reply to this email or message us on WhatsApp at ${env.WHATSAPP_DISPLAY}.`,
    '',
    'Standard Mobile Company',
  ].join('\n');
  return send(env, { to: user.email, replyTo: env.TEAM_EMAIL, subject: 'Your buyer account application', text });
}

export function emailPasswordReset(env, user, link) {
  const text = [
    `Hi ${user.name},`,
    '',
    'Use this link to set a new password. It works once and expires in 1 hour:',
    link,
    '',
    "If you didn't ask for this, ignore this email. Your password stays the same.",
    '',
    'Standard Mobile Company',
  ].join('\n');
  return send(env, { to: user.email, subject: 'Reset your Standard Mobile Company password', text });
}

export function emailCustomerInvoiceFallback(env, offer, invoice) {
  const text = [
    `Hi ${offer.customer.name},`,
    '',
    `Here is your invoice ${invoice.number} for ${formatMoney(invoice.total)}, due ${invoice.dueDate.slice(0, 10)}.`,
    '',
    offer.items.map((i) => `- ${i.title} (eBay #${i.id}) ${formatMoney(i.price)}`).join('\n'),
    '',
    `Pay by Zelle to ${env.ZELLE_RECIPIENT}, or message ${env.WHATSAPP_DISPLAY} on WhatsApp for wire details.`,
    `Include ${invoice.number} with your payment.`,
    '',
    'Standard Mobile Company',
  ].join('\n');
  return send(env, { to: offer.customer.email, replyTo: env.TEAM_EMAIL, subject: `Invoice ${invoice.number} from Standard Mobile Company`, text });
}
