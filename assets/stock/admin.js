import { CONFIG, listOffers, decideOffer, formatMoney, resetMockData } from './api.js';
import { h, formatDateTime } from './dom.js';

const TABS = [
  ['pending', 'Needs review'],
  ['countered', 'Countered'],
  ['accepted', 'Invoiced'],
  ['denied', 'Denied'],
  ['all', 'All'],
];
const state = { offers: [], tab: 'pending' };
const $ = (id) => document.getElementById(id);

if (CONFIG.MODE === 'mock') {
  const note = $('admin-note');
  note.hidden = false;
  note.append(
    'Preview mode: offers come from this browser only. In production this page must sit behind Cloudflare Access. ',
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { resetMockData(); load(); } }, 'Clear sample offers'));
}

load();

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
    o.status === 'accepted' && o.invoice
      ? h('div', { class: 'remove-ebay' }, `Invoice ${o.invoice.number} sent for ${formatMoney(o.invoice.total)}. End these listings on eBay using the links above.`)
      : null,
    open ? h('div', { class: 'oc-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => act('accept') },
        o.status === 'countered' ? `Accept at ${formatMoney(o.counterAmount)}` : 'Accept & invoice'),
      counterInput,
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => act('counter', { counterAmount: Number(counterInput.value) }) }, 'Send counter'),
      h('button', { class: 'btn danger sm', type: 'button', onclick: () => { if (confirm('Deny this offer?')) act('deny'); } }, 'Deny'),
      err) : null);

  return card;
}
