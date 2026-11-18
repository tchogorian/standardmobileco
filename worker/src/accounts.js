import { HttpError, json, readJson, str, randomId, nowIso, timingSafeEqual, verifyTurnstile, rateLimit, EMAIL_RE } from './util.js';
import { notifyTeamSignup, emailPasswordReset } from './email.js';

const COOKIE = '__Host-smc_session';
const SESSION_SECONDS = 30 * 86400;
const RESET_SECONDS = 3600;
// Cloudflare Workers cap PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;
const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

async function sha256(s) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return b64url(new Uint8Array(bits));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64url(salt)}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

// Compared against when the email is unknown, so a miss costs the same time as a wrong password.
const DUMMY_HASH = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

async function checkPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored).split('$');
  if (alg !== 'pbkdf2-sha256' || !salt || !hash) return false;
  return timingSafeEqual(await pbkdf2(password, fromB64url(salt), Number(iter)), hash);
}

function parsePassword(value) {
  if (typeof value !== 'string' || value.length < 10) throw new HttpError(400, 'Use a password with at least 10 characters.');
  if (value.length > 200) throw new HttpError(400, 'Password is too long.');
  return value;
}

function parseEmail(value) {
  const email = str(value, { min: 3, max: 200, name: 'Email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email.');
  return email;
}

function parseProfile(body) {
  const profile = {
    name: str(body.name, { min: 1, max: 120, name: 'Name' }),
    company: str(body.company, { min: 1, max: 120, name: 'Company' }),
    phone: str(body.phone, { min: 7, max: 40, name: 'Phone' }),
  };
  if (profile.phone.replace(/\D/g, '').length < 7) throw new HttpError(400, 'Enter a valid phone number.');
  return profile;
}

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, company: u.company, phone: u.phone, status: u.status, createdAt: u.created_at };
}

// ---------- sessions ----------

function readSessionCookie(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) {
      const token = v.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
    }
  }
  return null;
}

const sessionCookie = (token) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function createSession(env, userId) {
  const token = newToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, new Date(now).toISOString()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), userId, new Date(now).toISOString(), new Date(now + SESSION_SECONDS * 1000).toISOString()),
  ]);
  return sessionCookie(token);
}

// Returns the signed-in user row, or null. Rejected and disabled accounts have no usable session.
export async function currentUser(request, env) {
  const token = readSessionCookie(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  ).bind(await sha256(token)).first();
  if (!row || row.session_expires < nowIso() || row.status === 'disabled' || row.status === 'rejected') return null;
  return row;
}

export async function requireUser(request, env, { approved = false } = {}) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'Please log in.');
  if (approved && user.status !== 'approved') throw new HttpError(403, 'Your account is waiting for approval.');
  return user;
}

// ---------- endpoints ----------

export async function signup(request, env, ctx) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  await rateLimit(env.AUTH_LIMIT, ip, 'Too many attempts. Wait a minute and try again.');
  const body = await readJson(request);
  await verifyTurnstile(env, body.turnstileToken, ip);

  const email = parseEmail(body.email);
  const password = parsePassword(body.password);
  const profile = parseProfile(body);
  const about = str(body.about, { max: 1000, name: 'About your business' });

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new HttpError(409, 'An account with this email already exists. Log in or reset your password.');

  const user = {
    id: randomId('U-'), email, password_hash: await hashPassword(password), ...profile, about, status: 'pending', created_at: nowIso(),
  };
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, name, company, phone, about, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(user.id, user.email, user.password_hash, user.name, user.company, user.phone, user.about, user.status, user.created_at).run();

  ctx.waitUntil(notifyTeamSignup(env, user));
  return json({ user: publicUser(user) }, 201, { 'Set-Cookie': await createSession(env, user.id) });
}

export async function login(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  await rateLimit(env.AUTH_LIMIT, ip, 'Too many attempts. Wait a minute and try again.');
  const body = await readJson(request);
  await verifyTurnstile(env, body.turnstileToken, ip);

  const email = parseEmail(body.email);
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

  if (user?.locked_until && user.locked_until > nowIso()) {
    throw new HttpError(429, `Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes or reset your password.`);
  }
  const ok = await checkPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    if (user) {
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
      await env.DB.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
        .bind(lock ? 0 : failed, lock, user.id).run();
    }
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  if (user.status === 'disabled' || user.status === 'rejected') {
    throw new HttpError(403, 'This account is not active. Contact us if you think this is a mistake.');
  }
  await env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(user.id).run();
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': await createSession(env, user.id) });
}

export async function logout(request, env) {
  const token = readSessionCookie(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

export async function me(request, env) {
  const user = await currentUser(request, env);
  return json({ user: user ? publicUser(user) : null });
}

export async function updateProfile(request, env) {
  const user = await requireUser(request, env);
  const profile = parseProfile(await readJson(request));
  await env.DB.prepare('UPDATE users SET name = ?, company = ?, phone = ? WHERE id = ?')
    .bind(profile.name, profile.company, profile.phone, user.id).run();
  return json({ user: publicUser({ ...user, ...profile }) });
}

export async function changePassword(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  if (!(await checkPassword(String(body.currentPassword || '').slice(0, 200), user.password_hash))) {
    throw new HttpError(400, 'Your current password is incorrect.');
  }
  const password = parsePassword(body.newPassword);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': await createSession(env, user.id) });
}

export async function forgotPassword(request, env, ctx) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  await rateLimit(env.AUTH_LIMIT, ip, 'Too many attempts. Wait a minute and try again.');
  const body = await readJson(request);
  await verifyTurnstile(env, body.turnstileToken, ip);
  const email = parseEmail(body.email);

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (user && user.status !== 'disabled') {
    const token = newToken();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(user.id),
      env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(await sha256(token), user.id, new Date(Date.now() + RESET_SECONDS * 1000).toISOString()),
    ]);
    // The token rides in the URL fragment so it never reaches server logs or Referer headers.
    ctx.waitUntil(emailPasswordReset(env, user, `${env.SITE_ORIGIN}/account.html#reset=${token}`));
  }
  return json({ ok: true });
}

export async function resetPassword(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  await rateLimit(env.AUTH_LIMIT, ip, 'Too many attempts. Wait a minute and try again.');
  const body = await readJson(request);
  const token = typeof body.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.token) ? body.token : null;
  const password = parsePassword(body.password);
  const row = token
    ? await env.DB.prepare('SELECT * FROM password_resets WHERE token_hash = ?').bind(await sha256(token)).first()
    : null;
  if (!row || row.expires_at < nowIso()) throw new HttpError(400, 'This reset link has expired. Request a new one.');

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?')
      .bind(await hashPassword(password), row.user_id),
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(row.user_id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
  ]);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
  if (user.status === 'disabled' || user.status === 'rejected') return json({ user: null });
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': await createSession(env, user.id) });
}

export async function deleteUserSessions(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}
