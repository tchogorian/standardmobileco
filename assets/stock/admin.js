import { listOffers, decideOffer, qboStatus, listUsers, decideUser, ebayStatus, ebaySync, formatMoney } from './api.js';
import { h, formatDateTime } from './dom.js';

const TABS = [
  ['pending', 'Needs review'],
  ['countered', 'Countered'],
  ['accepted', 'Invoiced'],
  ['denied', 'Denied'],
  ['all', 'All'],
];
const BUYER_TABS = [
  ['pending', 'Waiting for approval'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['disabled', 'Disabled'],
  ['all', 'All'],
];
const INTRO = {
  offers: ['Offers.', 'Review offers below asking price. Accept to send an invoice, deny, or send a counter (the customer gets an email either way). Invoiced listings show eBay links so you can end them.'],
  buyers: ['Buyers.', 'New buyer accounts wait here until you approve them. Only approved buyers see prices and can send offers. Disabling a buyer logs them out right away.'],
};
const state = { offers: [], tab: 'pending', users: [], buyerTab: 'pending' };
const $ = (id) => document.getElementById(id);

window.addEventListener('hashchange', showSection);
showSection();
load();
loadUsers();
loadQbo();
loadEbay();

async function loadEbay() {
  const note = $('ebay-note');
  let s;
  try {
    s = await ebayStatus();
  } catch {
    return;
  }
  note.hidden = false;
  const last = s.lastSync;
  const healthy = s.connected && last && last.ok;
  note.classList.toggle('ok', !!healthy);
  if (!s.configured) {
    note.replaceChildren('eBay API is not set up yet. Stock still comes from the office PC copy every 2 hours.');
    return;
  }
  const err = h('span', { class: 'f-err' });
  const sync = h('button', {
    class: 'btn ghost sm', type: 'button',
    onclick: async () => {
      sync.disabled = true;
      err.textContent = '';
      try {
        await ebaySync();
      } catch (ex) {
        if (!/Refusing to replace/.test(ex.message) || !confirm(`${ex.message}\n\nApply it anyway?`)) err.textContent = ex.message;
        else await ebaySync(true).catch((e2) => { err.textContent = e2.message; });
      }
      loadEbay();
    },
  }, 'Sync now');
  const connect = h('a', { class: 'btn ghost sm', href: '/api/admin/ebay/connect' }, s.connected ? 'Reconnect' : 'Connect eBay');
  if (!s.connected) {
    note.replaceChildren('eBay is not connected. Click Connect eBay and sign in as ludatronix. ', connect);
    return;
  }
  const lastText = !last ? 'No sync yet.'
    : last.ok ? `Last sync ${formatDateTime(last.at)}: ${last.active} listings, ${last.changed} changed, ${last.deactivated} removed.`
      : `Last sync FAILED ${formatDateTime(last.at)}: ${last.error}`;
  note.replaceChildren(`eBay connected as ${s.user}. Stock syncs every 5 minutes and is re-checked before every invoice. ${lastText} `, sync, connect, err);
}

function showSection() {
  const section = location.hash === '#buyers' ? 'buyers' : 'offers';
  $('offers-panel').hidden = section !== 'offers';
  $('buyers-panel').hidden = section !== 'buyers';
  $('sec-offers').classList.toggle('active', section === 'offers');
  $('sec-buyers').classList.toggle('active', section === 'buyers');
  [$('admin-title').textContent, $('admin-intro').textContent] = INTRO[section];
}

async function loadUsers() {
  try {
    state.users = await listUsers();
  } catch (err) {
    $('buyers').replaceChildren(h('div', { class: 'load-err' }, err.message || 'Could not load buyers.'));
    return;
  }
  renderUsers();
}

function renderUsers() {
  const count = (k) => (k === 'all' ? state.users.length : state.users.filter((u) => u.status === k).length);
  $('buyers-pending').textContent = count('pending') || '';
  $('buyer-tabs').replaceChildren(...BUYER_TABS.map(([key, label]) => h('button', {
    class: `chip${state.buyerTab === key ? ' active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': state.buyerTab === key ? 'true' : 'false',
    onclick: () => { state.buyerTab = key; renderUsers(); },
  }, label, h('span', { class: 'c' }, count(key)))));
  const rows = state.buyerTab === 'all' ? state.users : state.users.filter((u) => u.status === state.buyerTab);
  $('buyers').replaceChildren(...(rows.length ? rows.map(renderUser) : [h('div', { class: 'empty' }, 'Nothing here.')]));
}

function renderUser(u) {
  const err = h('span', { class: 'f-err', role: 'alert' });
  const act = async (action, question) => {
    if (question && !confirm(question)) return;
    err.textContent = '';
    card.querySelectorAll('button').forEach((el) => { el.disabled = true; });
    try {
      await decideUser(u.id, action);
      await loadUsers();
    } catch (ex) {
      err.textContent = ex.message || 'Action failed.';
      card.querySelectorAll('button').forEach((el) => { el.disabled = false; });
    }
  };
  const btn = (label, action, cls = 'btn sm', question) =>
    h('button', { class: cls, type: 'button', onclick: () => act(action, question) }, label);

  const card = h('article', { class: 'offer-card' },
    h('div', { class: 'oc-top' },
      h('div', {},
        h('div', { class: 'oc-who' }, u.company, ` \u00b7 ${u.name}`,
          h('span', { class: 'c' }, `${u.email} \u00b7 ${u.phone} \u00b7 signed up ${formatDateTime(u.createdAt)} \u00b7 ${u.offerCount} offer${u.offerCount === 1 ? '' : 's'}`)),
        h('span', { class: `status ${u.status}` }, u.status)),
      u.reviewedBy ? h('div', { class: 'oc-who' }, h('span', { class: 'c' }, `${u.status} by ${u.reviewedBy}, ${formatDateTime(u.reviewedAt)}`)) : null),
    u.about ? h('div', { class: 'buyer-about' }, u.about) : null,
    h('div', { class: 'oc-actions' },
      u.status === 'pending' ? btn('Approve', 'approve') : null,
      u.status === 'pending' ? btn('Reject', 'reject', 'btn danger sm', `Reject ${u.company}? They get an email and cannot log in.`) : null,
      u.status === 'rejected' ? btn('Approve anyway', 'approve') : null,
      u.status === 'approved' || u.status === 'pending'
        ? btn('Disable', 'disable', 'btn ghost sm', `Disable ${u.company}? They are logged out and cannot log in.`) : null,
      u.status === 'disabled' ? btn('Re-enable', 'enable') : null,
      err));
  return card;
}

async function loadQbo() {
  const note = $('admin-note');
  let s;
  try {
    s = await qboStatus();
  } catch {
    return;
  }
  note.hidden = false;
  note.classList.toggle('ok', s.connected);
  const connect = h('a', { class: 'btn ghost sm', href: '/api/admin/qbo/connect' }, s.connected ? 'Reconnect' : 'Connect QuickBooks');
  note.replaceChildren(s.connected
    ? `QuickBooks connected (${s.environment}, company ${s.realmId}). Invoices are created and emailed automatically. `
    : `QuickBooks is not connected (${s.environment}). Customers still see an invoice, but you must create it in QuickBooks by hand. `,
  connect);
}

async function load() {
  try {
    state.offers = await listOffers();
  } catch (err) {
    $('offers').replaceChildren(h('div', { class: 'load-err' }, err.message || 'Could not load offers.'));
    return;
  }
  render();
}

function render() {
  const counts = Object.fromEntries(TABS.map(([k]) => [k, k === 'all' ? state.offers.length : state.offers.filter((o) => o.status === k).length]));
  $('tabs').replaceChildren(...TABS.map(([key, label]) => h('button', {
    class: `chip${state.tab === key ? ' active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': state.tab === key ? 'true' : 'false',
    onclick: () => { state.tab = key; render(); },
  }, label, h('span', { class: 'c' }, counts[key]))));

  const rows = state.tab === 'all' ? state.offers : state.offers.filter((o) => o.status === state.tab);
  $('offers').replaceChildren(...(rows.length
    ? rows.map(renderOffer)
    : [h('div', { class: 'empty' }, 'Nothing here.')]));
}

function renderOffer(o) {
  const below = o.offerAmount < o.askingTotal;
  const pct = Math.round((1 - o.offerAmount / o.askingTotal) * 100);
  const err = h('span', { class: 'f-err', role: 'alert' });

  const act = async (action, extra) => {
    err.textContent = '';
    card.querySelectorAll('button,input').forEach((el) => { el.disabled = true; });
    try {
      await decideOffer(o.id, action, extra);
      await load();
    } catch (ex) {
      err.textContent = ex.message || 'Action failed.';
      card.querySelectorAll('button,input').forEach((el) => { el.disabled = false; });
    }
  };

  const counterInput = h('input', { type: 'number', min: '1', step: '0.01', placeholder: 'Counter $', 'aria-label': 'Counter amount', inputmode: 'decimal' });
  const open = o.status === 'pending' || o.status === 'countered';

  const card = h('article', { class: 'offer-card' },
    h('div', { class: 'oc-top' },
      h('div', {},
        h('div', { class: 'oc-who' },
          o.customer.name, o.customer.company ? ` \u00b7 ${o.customer.company}` : '',
          h('span', { class: 'c' }, `${o.customer.email} \u00b7 ${o.customer.phone} \u00b7 ${formatDateTime(o.createdAt)} \u00b7 ${o.id}`)),
        h('span', { class: `status ${o.status}` }, o.status === 'accepted' ? 'invoiced' : o.status)),
      h('div', { class: 'oc-nums' },
        h('div', {}, h('div', { class: 'l' }, 'Asking'), h('div', { class: 'v' }, formatMoney(o.askingTotal))),
        h('div', {}, h('div', { class: 'l' }, below ? `Offer (\u2212${pct}%)` : 'Offer'),
          h('div', { class: `v${below ? ' below' : ''}` }, formatMoney(o.offerAmount))),
        o.counterAmount ? h('div', {}, h('div', { class: 'l' }, 'Counter'), h('div', { class: 'v' }, formatMoney(o.counterAmount))) : null)),
    h('ul', { class: 'oc-items' }, ...o.items.map((i) => h('li', {},
      h('span', {}, `${i.title} `, h('a', { href: i.ebayUrl, target: '_blank', rel: 'noopener noreferrer' }, `${i.id} \u2197`)),
      h('span', {}, formatMoney(i.price))))),
    o.notes ? h('div', { class: 'oc-notes' }, `\u201c${o.notes}\u201d`) : null,
    o.status === 'accepted' && o.invoice && o.invoice.qboError
      ? h('div', { class: 'qbo-error' }, `QuickBooks invoice failed, create it by hand for ${formatMoney(o.invoice.total)} (reference ${o.invoice.number}). ${o.invoice.qboError}`)
      : null,
    o.status === 'accepted' && o.invoice
      ? h('div', { class: 'remove-ebay' }, `Invoice ${o.invoice.number} for ${formatMoney(o.invoice.total)}. End these listings on eBay using the links above.`)
      : null,
    o.status === 'accepted' ? h('div', { class: 'oc-actions' },
      h('button', {
        class: 'btn ghost sm', type: 'button',
        onclick: () => { if (confirm('Release these listings back to the stock page? Void the QuickBooks invoice separately.')) act('release'); },
      }, 'Customer backed out: release listings'),
      err) : null,
    open ? h('div', { class: 'oc-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => act('accept') },
        o.status === 'countered' ? `Accept at ${formatMoney(o.counterAmount)}` : 'Accept & invoice'),
      counterInput,
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => act('counter', { counterAmount: Number(counterInput.value) }) }, 'Send counter'),
      h('button', { class: 'btn danger sm', type: 'button', onclick: () => { if (confirm('Deny this offer?')) act('deny'); } }, 'Deny'),
      err) : null);

  return card;
}
