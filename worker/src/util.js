export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-store',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}

export async function readJson(request, maxBytes = 16384) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

export const round2 = (n) => Math.round(n * 100) / 100;

export function sitePrice(env, ebayPrice) {
  return round2(ebayPrice * (1 - Number(env.DISCOUNT)));
}

export function str(value, { max, min = 0, name }) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < min) throw new HttpError(400, `${name} is required.`);
  if (s.length > max) throw new HttpError(400, `${name} is too long.`);
  return s;
}

export function money(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) throw new HttpError(400, `${name} must be a positive amount.`);
  return round2(n);
}

const B32 = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export function randomId(prefix, len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return prefix + [...bytes].map((b) => B32[b % B32.length]).join('');
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------- crypto ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function aesKey(env) {
  if (!env.TOKEN_KEY) throw new Error('TOKEN_KEY secret is not set.');
  const raw = b64ToBytes(env.TOKEN_KEY);
  if (raw.length !== 32) throw new Error('TOKEN_KEY must be 32 bytes, base64.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(env, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(plaintext)));
  return `${bytesToB64(iv)}.${bytesToB64(ct)}`;
}

export async function decrypt(env, payload) {
  const [iv, ct] = payload.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv) }, await aesKey(env), b64ToBytes(ct));
  return dec.decode(pt);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function signLink(env, subject, ttlSeconds) {
  if (!env.LINK_SECRET) throw new Error('LINK_SECRET secret is not set.');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { exp, sig: await hmacHex(env.LINK_SECRET, `${subject}.${exp}`) };
}

export async function verifyLink(env, subject, exp, sig) {
  if (!env.LINK_SECRET || !/^\d+$/.test(exp || '') || Number(exp) < Date.now() / 1000) return false;
  return timingSafeEqual(await hmacHex(env.LINK_SECRET, `${subject}.${exp}`), sig || '');
}

// ---------- settings table ----------

export async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value).run();
}

export async function deleteSetting(env, key) {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}
