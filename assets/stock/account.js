import {
  getMe, signup, login, logout, updateProfile, changePassword, forgotPassword, resetPassword,
  myOffers, acceptCounter, formatMoney, whatsappLink,
} from './api.js';
import { h, formatDate, formatDateTime } from './dom.js';
import { mountTurnstile } from './turnstile.js';

const view = document.getElementById('view');
let user = null;

window.addEventListener('hashchange', route);
start();

async function start() {
  const reset = location.hash.match(/^#reset=([A-Za-z0-9_-]{43})$/);
  if (reset) {
    history.replaceState(null, '', location.pathname);
    return showReset(reset[1]);
  }
  try {
    ({ user } = await getMe());
  } catch (err) {
    return view.replaceChildren(h('div', { class: 'load-err' }, err.message));
  }
  route();
}

function route() {
  if (user) return showDashboard();
  if (location.hash === '#signup') return showSignup();
  if (location.hash === '#forgot') return showForgot();
  return showLogin();
}

// ---------- form helpers ----------

function field(label, attrs) {
  return h('label', { class: 'fl' }, label, h(attrs.tag || 'input', { ...attrs, tag: null }));
}

function values(form) {
  return Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}

// Wires a form: disables the button while busy and shows server errors inline.
function onSubmit(form, button, err, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Please wait\u2026';
    try {
      await handler(values(form));
    } catch (ex) {
      err.textContent = ex.message || 'Something went wrong. Try again.';
    } finally {
      if (button.isConnected) { button.disabled = false; button.textContent = label; }
    }
  });
}

function authPage(title, sub, form, links) {
  view.replaceChildren(h('section', { class: 'auth' },
    h('span', { class: 'eyebrow' }, 'Buyer account'),
    h('h1', {}, title),
    sub ? h('p', { class: 'sub' }, sub) : null,
    form,
    links ? h('div', { class: 'auth-links' }, ...links) : null));
}

async function withTurnstile(form, err) {
  const slot = h('div', { class: 'turnstile-slot' });
  form.querySelector('.f-err').before(slot);
  try {
    return await mountTurnstile(slot);
  } catch (ex) {
    err.textContent = ex.message;
    return { token: null, reset() {} };
  }
}

function requireToken(captcha) {
  if (!captcha.token) throw new Error('Please wait for the verification check to finish.');
  return captcha.token;
}

// ---------- logged out ----------

async function showLogin() {
  const err = h('div', { class: 'f-err', role: 'alert' });
  const button = h('button', { class: 'btn', type: 'submit' }, 'Log in');
  const form = h('form', { class: 'offer', novalidate: true },
    field('Email', { name: 'email', type: 'email', required: true, maxlength: '200', autocomplete: 'email' }),
    field('Password', { name: 'password', type: 'password', required: true, maxlength: '200', autocomplete: 'current-password' }),
    err,
    h('div', { class: 'actions start' }, button));
  authPage('Log in.', 'See wholesale prices, send offers and track your invoices.', form, [
    h('a', { href: '#signup' }, 'Create a buyer account'),
    h('a', { href: '#forgot' }, 'Forgot your password?'),
  ]);
  const captcha = await withTurnstile(form, err);
  onSubmit(form, button, err, async (v) => {
    try {
      ({ user } = await login({ email: v.email, password: v.password, turnstileToken: requireToken(captcha) }));
    } catch (ex) {
      captcha.reset();
      throw ex;
    }
    if (new URLSearchParams(location.search).get('next') === 'stock') location.href = 'stock.html';
    else showDashboard();
  });
}

async function showSignup() {
  const err = h('div', { class: 'f-err', role: 'alert' });
  const button = h('button', { class: 'btn', type: 'submit' }, 'Create account');
  const form = h('form', { class: 'offer', novalidate: true },
    h('div', { class: 'f-row' },
      field('Your name *', { name: 'name', required: true, maxlength: '120', autocomplete: 'name' }),
      field('Company *', { name: 'company', required: true, maxlength: '120', autocomplete: 'organization' })),
    h('div', { class: 'f-row' },
      field('Email *', { name: 'email', type: 'email', required: true, maxlength: '200', autocomplete: 'email' }),
      field('Phone / WhatsApp *', { name: 'phone', type: 'tel', required: true, maxlength: '40', autocomplete: 'tel' })),
    field('About your business', {
      tag: 'textarea', name: 'about', maxlength: '1000',
      placeholder: 'What you buy, where you resell, typical order size. This helps us approve you faster.',
    }),
    h('div', { class: 'f-row' },
      field('Password * (10+ characters)', { name: 'password', type: 'password', required: true, minlength: '10', maxlength: '200', autocomplete: 'new-password' }),
      field('Confirm password *', { name: 'confirm', type: 'password', required: true, maxlength: '200', autocomplete: 'new-password' })),
    err,
    h('div', { class: 'actions start' }, button));
  authPage('Create a buyer account.', 'We approve wholesale buyers by hand, usually within one business day. Once approved you can see prices and send offers.', form, [
    h('a', { href: '#' }, 'Already have an account? Log in'),
  ]);
  const captcha = await withTurnstile(form, err);
  onSubmit(form, button, err, async (v) => {
    if (v.password.length < 10) throw new Error('Use a password with at least 10 characters.');
    if (v.password !== v.confirm) throw new Error('The passwords do not match.');
    try {
      ({ user } = await signup({
        name: v.name, company: v.company, email: v.email, phone: v.phone, about: v.about,
        password: v.password, turnstileToken: requireToken(captcha),
      }));
    } catch (ex) {
      captcha.reset();
      throw ex;
    }
    history.replaceState(null, '', location.pathname);
    showDashboard();
  });
}

async function showForgot() {
  const err = h('div', { class: 'f-err', role: 'alert' });
  const button = h('button', { class: 'btn', type: 'submit' }, 'Email me a reset link');
  const form = h('form', { class: 'offer', novalidate: true },
    field('Email', { name: 'email', type: 'email', required: true, maxlength: '200', autocomplete: 'email' }),
    err,
    h('div', { class: 'actions start' }, button));
  authPage('Reset your password.', "Enter your account email and we'll send you a link to set a new password.", form, [
    h('a', { href: '#' }, 'Back to log in'),
  ]);
  const captcha = await withTurnstile(form, err);
  onSubmit(form, button, err, async (v) => {
    try {
      await forgotPassword({ email: v.email, turnstileToken: requireToken(captcha) });
    } catch (ex) {
      captcha.reset();
      throw ex;
    }
    authPage('Check your email.', `If ${v.email} has an account, a reset link is on its way. It expires in 1 hour.`, null, [
      h('a', { href: '#' }, 'Back to log in'),
    ]);
  });
}

function showReset(token) {
  const err = h('div', { class: 'f-err', role: 'alert' });
  const button = h('button', { class: 'btn', type: 'submit' }, 'Set new password');
  const form = h('form', { class: 'offer', novalidate: true },
    field('New password (10+ characters)', { name: 'password', type: 'password', required: true, minlength: '10', maxlength: '200', autocomplete: 'new-password' }),
    field('Confirm new password', { name: 'confirm', type: 'password', required: true, maxlength: '200', autocomplete: 'new-password' }),
    err,
    h('div', { class: 'actions start' }, button));
  authPage('Set a new password.', null, form, null);
  onSubmit(form, button, err, async (v) => {
    if (v.password.length < 10) throw new Error('Use a password with at least 10 characters.');
    if (v.password !== v.confirm) throw new Error('The passwords do not match.');
    ({ user } = await resetPassword({ token, password: v.password }));
    route();
  });
}

// ---------- logged in ----------

const STATUS_LABEL = { pending: 'Under review', countered: 'Counter offer', accepted: 'Invoiced', denied: 'Declined' };

async function showDashboard() {
  const approved = user.status === 'approved';
  const offersBox = h('div', {}, h('div', { class: 'loading' }, 'Loading your offers\u2026'));

  view.replaceChildren(
    h('header', { class: 'page-head' },
      h('span', { class: 'eyebrow' }, 'Buyer account'),
      h('h1', {}, `Hi, ${user.name.split(' ')[0]}.`),
      h('p', {}, `${user.company} \u00b7 ${user.email}`),
      approved
        ? h('div', { class: 'admin-note ok' }, 'Your account is approved. ', h('a', { class: 'btn sm', href: 'stock.html' }, 'Browse stock and prices'))
        : h('div', { class: 'admin-note' }, h('strong', {}, 'Waiting for approval. '),
          "We review new buyers within one business day and email you when you're approved. After that you'll see prices and can send offers.")),
    h('section', { class: 'acct-section' }, h('h2', {}, 'My offers'), offersBox),
    h('section', { class: 'acct-grid' }, profileCard(), passwordCard()),
    h('div', { class: 'actions start' },
      h('button', {
        class: 'btn ghost', type: 'button',
        onclick: async () => { await logout().catch(() => {}); user = null; location.hash = ''; showLogin(); },
      }, 'Log out')));

  try {
    const offers = await myOffers();
    offersBox.replaceChildren(...(offers.length
      ? offers.map(offerCard)
      : [h('div', { class: 'empty small' }, approved ? 'No offers yet. Pick listings on the stock page to send one.' : 'No offers yet.')]));
  } catch (err) {
    offersBox.replaceChildren(h('div', { class: 'load-err' }, err.message));
  }
}

function offerCard(o) {
  const err = h('span', { class: 'f-err', role: 'alert' });
  const card = h('article', { class: 'offer-card' },
    h('div', { class: 'oc-top' },
      h('div', {},
        h('div', { class: 'oc-who' }, `Offer ${o.id}`, h('span', { class: 'c' }, formatDateTime(o.createdAt))),
        h('span', { class: `status ${o.status}` }, STATUS_LABEL[o.status] || o.status)),
      h('div', { class: 'oc-nums' },
        h('div', {}, h('div', { class: 'l' }, 'Asking'), h('div', { class: 'v' }, formatMoney(o.askingTotal))),
        h('div', {}, h('div', { class: 'l' }, 'Your offer'), h('div', { class: 'v' }, formatMoney(o.offerAmount))),
        o.counterAmount ? h('div', {}, h('div', { class: 'l' }, 'Our counter'), h('div', { class: 'v' }, formatMoney(o.counterAmount))) : null)),
    h('ul', { class: 'oc-items' }, ...o.items.map((i) => h('li', {}, h('span', {}, i.title), h('span', {}, formatMoney(i.price))))),
    o.message ? h('div', { class: 'oc-notes' }, `\u201c${o.message}\u201d`) : null,
    o.status === 'countered' ? h('div', { class: 'oc-actions' },
      h('button', {
        class: 'btn sm', type: 'button',
        onclick: async (e) => {
          if (!confirm(`Accept ${formatMoney(o.counterAmount)} and get your invoice now?`)) return;
          e.target.disabled = true;
          err.textContent = '';
          try {
            card.replaceWith(offerCard(await acceptCounter(o.id)));
          } catch (ex) {
            err.textContent = ex.message;
            e.target.disabled = false;
          }
        },
      }, `Accept ${formatMoney(o.counterAmount)}`),
      err) : null,
    o.status === 'accepted' && o.invoice ? invoiceBox(o.invoice) : null);
  return card;
}

function invoiceBox(inv) {
  const ids = inv.items.map((i) => i.id).join(', ');
  const wa = whatsappLink(`Hi Standard Mobile, I have invoice ${inv.number} for ${formatMoney(inv.total)} (listings ${ids}). Please send wire transfer details.`);
  return h('div', { class: 'remove-ebay' },
    h('strong', {}, `Invoice ${inv.number}: ${formatMoney(inv.total)}, due ${formatDate(inv.dueDate)}. `),
    `Pay by Zelle to ${inv.payment.zelle}, or message us on WhatsApp for wire details. Include ${inv.number} with your payment.`,
    h('div', { class: 'oc-actions' },
      inv.pdfUrl ? h('a', { class: 'btn sm', href: inv.pdfUrl, target: '_blank', rel: 'noopener' }, 'Download PDF') : null,
      h('a', { class: 'btn wa sm', href: wa, target: '_blank', rel: 'noopener' }, 'WhatsApp for wire details')));
}

function profileCard() {
  const err = h('div', { class: 'f-err', role: 'alert' });
  const ok = h('div', { class: 'hint ok' });
  const button = h('button', { class: 'btn sm', type: 'submit' }, 'Save details');
  const form = h('form', { class: 'offer', novalidate: true },
    field('Your name', { name: 'name', required: true, maxlength: '120', autocomplete: 'name', value: user.name }),
    field('Company', { name: 'company', required: true, maxlength: '120', autocomplete: 'organization', value: user.company }),
    field('Phone / WhatsApp', { name: 'phone', type: 'tel', required: true, maxlength: '40', autocomplete: 'tel', value: user.phone }),
    h('p', { class: 'hint' }, `Email: ${user.email}. To change it, contact us.`),
    err, ok,
    h('div', { class: 'actions start' }, button));
  onSubmit(form, button, err, async (v) => {
    ok.textContent = '';
    ({ user } = await updateProfile({ name: v.name, company: v.company, phone: v.phone }));
    ok.textContent = 'Saved. New invoices use these details.';
  });
  return h('div', { class: 'acct-card' }, h('h2', {}, 'Your details'), form);
}

function passwordCard() {
  const err = h('div', { class: 'f-err', role: 'alert' });
  const ok = h('div', { class: 'hint ok' });
  const button = h('button', { class: 'btn sm', type: 'submit' }, 'Change password');
  const form = h('form', { class: 'offer', novalidate: true },
    field('Current password', { name: 'current', type: 'password', required: true, maxlength: '200', autocomplete: 'current-password' }),
    field('New password (10+ characters)', { name: 'password', type: 'password', required: true, minlength: '10', maxlength: '200', autocomplete: 'new-password' }),
    field('Confirm new password', { name: 'confirm', type: 'password', required: true, maxlength: '200', autocomplete: 'new-password' }),
    err, ok,
    h('div', { class: 'actions start' }, button));
  onSubmit(form, button, err, async (v) => {
    ok.textContent = '';
    if (v.password.length < 10) throw new Error('Use a password with at least 10 characters.');
    if (v.password !== v.confirm) throw new Error('The new passwords do not match.');
    await changePassword({ currentPassword: v.current, newPassword: v.password });
    form.reset();
    ok.textContent = 'Password changed. Other devices were logged out.';
  });
  return h('div', { class: 'acct-card' }, h('h2', {}, 'Password'), form);
}
