import { HttpError } from './util.js';

// Verifies the Cloudflare Access JWT that Access adds to every request it lets through.
// Routing alone is not trusted: if Access is misconfigured, admin routes fail closed.

let certCache = { url: null, keys: null, fetchedAt: 0 };

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodePart(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function getKeys(teamUrl, force = false) {
  const url = `${teamUrl}/cdn-cgi/access/certs`;
  if (!force && certCache.url === url && Date.now() - certCache.fetchedAt < 3600_000) return certCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(503, 'Could not load Access keys.');
  const { keys } = await res.json();
  certCache = { url, keys, fetchedAt: Date.now() };
  return keys;
}

export async function requireAdmin(request, env) {
  // DEV_ADMIN_BYPASS lives only in .dev.vars for `wrangler dev`; it is ignored once Access is configured.
  if (env.DEV_ADMIN_BYPASS === '1' && !env.ACCESS_AUD) return { email: 'dev@localhost' };

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(503, 'Admin access is not configured.');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'Not signed in.');

  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Invalid session.');
  let header, payload;
  try {
    header = decodePart(parts[0]);
    payload = decodePart(parts[1]);
  } catch {
    throw new HttpError(401, 'Invalid session.');
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'Invalid session.');

  const teamUrl = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let jwk = (await getKeys(teamUrl)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(teamUrl, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, 'Invalid session.');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new HttpError(401, 'Invalid session.');

  const now = Date.now() / 1000;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD) || payload.iss !== teamUrl || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60)) {
    throw new HttpError(401, 'Invalid session.');
  }
  return { email: payload.email || payload.common_name || 'service' };
}
