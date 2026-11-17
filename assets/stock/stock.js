import { CONFIG, getStock, submitOffer, formatMoney, whatsappLink } from './api.js';
import { h, formatDate, formatDateTime } from './dom.js';

const state = { stock: null, category: 'All', query: '', sort: 'featured', selected: new Set() };
const $ = (id) => document.getElementById(id);

init();

async function init() {
  $('search').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); renderList(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
  $('sel-clear').addEventListener('click', () => { state.selected.clear(); renderList(); });
  $('sel-offer').addEventListener('click', openOfferModal);
  $('s-ebay').href = CONFIG.EBAY_STORE_URL;
  await loadStock();
}

async function loadStock() {
  try {
    state.stock = await getStock();
  } catch (err) {
    $('list').replaceChildren(h('li', { class: 'load-err' }, err.message || 'Could not load stock.'));
    return;
  }
  for (const id of [...state.selected]) {
    const l = byId(id);
    if (!l || l.status !== 'available') state.selected.delete(id);
  }
  renderSummary();
  renderChips();
  renderList();
}

function byId(id) {
  return state.stock.listings.find((l) => l.id === id);
}

function renderSummary() {
  const listings = state.stock.listings.filter((l) => l.status === 'available');
  $('s-listings').textContent = listings.length;
  $('s-cats').textContent = new Set(listings.map((l) => l.category)).size;
  $('s-lots').textContent = listings.filter((l) => l.isLot).length;
  $('updated').textContent = `Updated ${formatDateTime(state.stock.updatedAt)}.`;
}

function renderChips() {
  const byCount = new Map();
  for (const l of state.stock.listings) byCount.set(l.category, (byCount.get(l.category) || 0) + 1);
  const sorted = [...byCount].sort((a, b) => (a[0] === 'Other') - (b[0] === 'Other') || b[1] - a[1]);
  const counts = new Map([['All', state.stock.listings.length], ...sorted]);
  $('chips').replaceChildren(...[...counts].map(([name, n]) => h('button', {
    class: `chip${state.category === name ? ' active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': state.category === name ? 'true' : 'false',
    onclick: () => { state.category = name; renderChips(); renderList(); },
  }, name, h('span', { class: 'c' }, n))));
}

function visibleListings() {
  let rows = state.stock.listings.filter((l) =>
    (state.category === 'All' || l.category === state.category) &&
    (!state.query || `${l.title} ${l.category} ${l.condition}`.toLowerCase().includes(state.query)));
  const sorters = {
    'price-asc': (a, b) => a.sitePrice - b.sitePrice,
    'price-desc': (a, b) => b.sitePrice - a.sitePrice,
    'title': (a, b) => a.title.localeCompare(b.title),
  };
  if (sorters[state.sort]) rows = [...rows].sort(sorters[state.sort]);
  return rows.sort((a, b) => (a.status === 'pending') - (b.status === 'pending'));
}

function renderList() {
  const rows = visibleListings();
  if (!rows.length) {
    $('list').replaceChildren(h('li', { class: 'empty' }, 'No listings match.'));
  } else {
    $('list').replaceChildren(...rows.map(renderRow));
  }
  renderSelbar();
}

function renderRow(l) {
  const pending = l.status !== 'available';
  const checked = state.selected.has(l.id);
  const toggle = () => {
    if (pending) return;
    if (state.selected.has(l.id)) state.selected.delete(l.id); else state.selected.add(l.id);
    renderList();
  };
  const thumb = l.image
    ? h('div', { class: 'thumb' }, h('img', { src: l.image, alt: '', loading: 'lazy' }))
    : h('div', { class: 'thumb' }, l.category.split(' ')[0]);

  return h('li', { class: `row${checked ? ' selected' : ''}${pending ? ' pending' : ''}`, onclick: toggle },
    h('input', {
      type: 'checkbox', checked, disabled: pending, 'aria-label': `Select ${l.title}`,
      onclick: (e) => e.stopPropagation(), onchange: toggle,
    }),
    thumb,
    h('div', {},
      h('div', { class: 'r-title' }, l.title),
      h('div', { class: 'r-meta' },
        l.isLot ? h('span', { class: 'tag lot' }, 'Lot') : null,
        pending ? h('span', { class: 'tag pending' }, 'Pending') : null,
        h('span', {}, l.condition),
        l.quantity ? h('span', {}, `${l.quantity} units`) : null,
        h('span', {}, l.category))),
    h('a', {
      class: 'r-ebay', href: l.ebayUrl, target: '_blank', rel: 'noopener',
      onclick: (e) => e.stopPropagation(),
    }, 'eBay \u2197'),
    h('div', { class: 'r-price' },
      h('div', { class: 'p' }, formatMoney(l.sitePrice)),
      h('div', { class: 'was' }, formatMoney(l.ebayPrice))));
}

function selectedItems() {
  return [...state.selected].map(byId).filter(Boolean);
}

function askingTotal(items) {
  return Math.round(items.reduce((s, l) => s + l.sitePrice, 0) * 100) / 100;
}

function renderSelbar() {
  const items = selectedItems();
  $('selbar').hidden = items.length === 0;
  $('sel-count').textContent = items.length;
  $('sel-total').textContent = formatMoney(askingTotal(items));
}

// ---------- modal ----------

function openModal(content) {
  closeModal();
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: closeModal }, '\u00d7'),
    ...content);
  const modal = h('div', { class: 'modal', id: 'modal', onclick: (e) => { if (e.target === modal) closeModal(); } }, sheet);
  document.body.append(modal);
  document.addEventListener('keydown', escClose);
  return sheet;
}

function closeModal() {
  const m = $('modal');
  if (m) m.remove();
  document.removeEventListener('keydown', escClose);
}

function escClose(e) {
  if (e.key === 'Escape') closeModal();
}

function openOfferModal() {
  const items = selectedItems();
  if (!items.length) return;
  const asking = askingTotal(items);

  const offerInput = h('input', { name: 'offer', type: 'number', min: '1', step: '0.01', required: true, value: asking.toFixed(2), inputmode: 'decimal' });
  const hint = h('div', { class: 'hint ok' });
  const updateHint = () => {
    const v = Number(offerInput.value);
    if (!(v > 0)) { hint.className = 'hint'; hint.textContent = ''; return; }
    if (v >= asking) {
      hint.className = 'hint ok';
      hint.textContent = v > asking
        ? 'Above asking: you get an invoice for the listed price right away.'
        : 'At asking price: you get an invoice right away.';
    } else {
      hint.className = 'hint warn';
      hint.textContent = `${Math.round((1 - v / asking) * 100)}% below asking: our team reviews it and replies by email.`;
    }
  };
  offerInput.addEventListener('input', updateHint);
  updateHint();

  const err = h('div', { class: 'f-err', role: 'alert' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Submit offer');
  const form = h('form', { class: 'offer', novalidate: true },
    h('div', { class: 'f-row' },
      h('label', { class: 'fl' }, 'Name *', h('input', { name: 'name', required: true, maxlength: '120', autocomplete: 'name' })),
      h('label', { class: 'fl' }, 'Company', h('input', { name: 'company', maxlength: '120', autocomplete: 'organization' }))),
    h('div', { class: 'f-row' },
      h('label', { class: 'fl' }, 'Email *', h('input', { name: 'email', type: 'email', required: true, maxlength: '200', autocomplete: 'email' })),
      h('label', { class: 'fl' }, 'Phone / WhatsApp *', h('input', { name: 'phone', type: 'tel', required: true, maxlength: '40', autocomplete: 'tel' }))),
    h('label', { class: 'fl' }, `Your offer (asking ${formatMoney(asking)}) *`, offerInput),
    hint,
    h('label', { class: 'fl' }, 'Notes', h('textarea', { name: 'notes', maxlength: '1000', placeholder: 'Shipping destination, payment timing, questions' })),
    h('div', { class: 'hp', 'aria-hidden': 'true' }, h('input', { name: 'website', tabindex: '-1', autocomplete: 'off' })),
    h('div', { class: 'turnstile-slot', id: 'turnstile-slot' }),
    err,
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
      submit));

  form.addEventListener('submit', (e) => onSubmitOffer(e, form, items, asking, submit, err));

  openModal([
    h('h2', {}, 'Submit an offer'),
    h('p', { class: 'sub' }, `${items.length} listing${items.length > 1 ? 's' : ''} selected.`),
    h('ul', { class: 'picked' },
      ...items.map((l) => h('li', {}, h('span', {}, l.title), h('span', {}, formatMoney(l.sitePrice)))),
      h('li', { class: 'tot' }, h('span', {}, 'Asking total'), h('span', {}, formatMoney(asking)))),
    form,
  ]);
  renderTurnstile($('turnstile-slot')).catch(() => {
    err.textContent = 'Could not load the verification check. Refresh and try again.';
  });
}

// ---------- Turnstile ----------

let turnstileLoad = null;
const captcha = { widgetId: null, token: null };

function loadTurnstile() {
  turnstileLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { turnstileLoad = null; reject(new Error('turnstile')); };
    document.head.append(s);
  });
  return turnstileLoad;
}

async function renderTurnstile(slot) {
  const turnstile = await loadTurnstile();
  if (!slot.isConnected) return;
  captcha.token = null;
  captcha.widgetId = turnstile.render(slot, {
    sitekey: CONFIG.TURNSTILE_SITE_KEY,
    callback: (t) => { captcha.token = t; },
    'expired-callback': () => { captcha.token = null; },
    'error-callback': () => { captcha.token = null; },
  });
}

function resetTurnstile() {
  captcha.token = null;
  if (window.turnstile && captcha.widgetId != null) window.turnstile.reset(captcha.widgetId);
}

async function onSubmitOffer(e, form, items, asking, submit, err) {
  e.preventDefault();
  err.textContent = '';
  const f = new FormData(form);
  const customer = {
    name: String(f.get('name') || '').trim(),
    company: String(f.get('company') || '').trim(),
    email: String(f.get('email') || '').trim(),
    phone: String(f.get('phone') || '').trim(),
  };
  const offerAmount = Math.round(Number(f.get('offer')) * 100) / 100;

  if (String(f.get('website') || '')) return;
  if (!customer.name) return void (err.textContent = 'Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) return void (err.textContent = 'Enter a valid email.');
  if (customer.phone.replace(/\D/g, '').length < 7) return void (err.textContent = 'Enter a phone or WhatsApp number.');
  if (!(offerAmount > 0)) return void (err.textContent = 'Enter your offer.');
  if (!captcha.token) return void (err.textContent = 'Please wait for the verification check to finish.');

  // Browsers only allow pop-ups during the click itself, so reserve the WhatsApp tab now.
  const waTab = offerAmount >= asking ? window.open('', '_blank') : null;
  if (waTab) waTab.opener = null;

  submit.disabled = true;
  submit.textContent = 'Sending\u2026';
  try {
    const res = await submitOffer({
      listingIds: items.map((l) => l.id),
      offerAmount,
      customer,
      notes: String(f.get('notes') || '').trim(),
      turnstileToken: captcha.token,
    });
    state.selected.clear();
    if (res.result === 'invoiced') {
      const link = whatsappLink(waMessage(res.invoice));
      if (waTab) waTab.location.href = link;
      showInvoice(res.invoice, link);
    } else {
      if (waTab) waTab.close();
      showReceived(res, customer);
    }
    loadStock();
  } catch (ex) {
    if (waTab) waTab.close();
    resetTurnstile();
    err.textContent = ex.message || 'Something went wrong. Try again.';
    submit.disabled = false;
    submit.textContent = 'Submit offer';
  }
}

function waMessage(inv) {
  const ids = inv.items.map((i) => i.id).join(', ');
  return `Hi Standard Mobile, I just requested invoice ${inv.number} for ${formatMoney(inv.total)} (listings ${ids}). Please send wire transfer details.`;
}

function showReceived(res, customer) {
  openModal([
    h('div', { class: 'done' },
      h('div', { class: 'ck' }, '\u2713'),
      h('h2', {}, 'Offer received'),
      h('p', { class: 'sub' }, `Reference ${res.offerId}. Our team reviews offers below asking and replies to ${customer.email}, usually within one business day.`),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Done'))),
  ]);
}

function showInvoice(inv, waLink) {
  const c = inv.customer;
  const invoice = h('div', { class: 'invoice' },
    h('div', { class: 'inv-head' },
      h('img', { src: 'assets/logo.png?v=3', alt: CONFIG.COMPANY_NAME }),
      h('div', { class: 'meta' },
        h('strong', {}, `Invoice ${inv.number}`),
        `Issued ${formatDate(inv.date)}`, h('br'),
        `Due ${formatDate(inv.dueDate)}`)),
    h('div', { class: 'inv-to' },
      h('div', { class: 'l' }, 'Bill to'),
      c.name, c.company ? ` \u00b7 ${c.company}` : '', h('br'), c.email, h('br'), c.phone),
    h('table', { class: 'inv' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Listing'), h('th', { class: 'num' }, 'Price'))),
      h('tbody', {}, ...inv.items.map((i) => h('tr', {},
        h('td', {}, i.title), h('td', {}, i.id), h('td', { class: 'num' }, formatMoney(i.price))))),
      h('tfoot', {},
        inv.total !== inv.subtotal ? h('tr', {}, h('td', { colspan: '2' }, 'Listed total'), h('td', { class: 'num' }, formatMoney(inv.subtotal))) : null,
        h('tr', { class: 'total' }, h('td', { colspan: '2' }, 'Total due'), h('td', { class: 'num' }, formatMoney(inv.total))))),
    h('div', { class: 'pay' },
      h('h4', {}, 'Payment'),
      h('p', {}, h('strong', {}, 'Zelle: '), inv.payment.zelle),
      h('p', {}, 'Wire transfer: message our sales team on WhatsApp for bank details.'),
      h('p', {}, `Reference ${inv.number} with your payment.`)));

  const download = () => {
    if (inv.pdfUrl) { window.open(inv.pdfUrl, '_blank', 'noopener'); return; }
    document.body.classList.add('printing');
    window.addEventListener('afterprint', () => document.body.classList.remove('printing'), { once: true });
    window.print();
  };

  openModal([
    h('h2', {}, 'Your invoice'),
    h('p', { class: 'sub' }, `We emailed a copy to ${c.email}. These listings are now held for you.`),
    invoice,
    h('div', { class: 'actions' },
      h('a', { class: 'btn wa', href: waLink, target: '_blank', rel: 'noopener' }, 'WhatsApp sales for wire details'),
      h('button', { class: 'btn', type: 'button', onclick: download }, 'Download PDF')),
  ]);
}
