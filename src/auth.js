// Named-account auth for client users.
//
// Deliberately NOT the internal model. The crew dashboard uses two shared
// passwords, which is defensible because it is internal, read-only and behind
// a door nobody outside the business has. A client site is none of those, and
// a commercial incident has to be answerable with who saw what and when.
//
// Accounts and auth events live in D1. Sessions are HMAC-signed cookies with a
// short idle window. Roles: 'client' (scoped to one client id), 'admin'
// (Isaiah and the operations scheduler; can administer logins, cannot be
// scoped to a client and so sees no client pages).

const enc = new TextEncoder();
const IDLE_MINUTES = 30;
const COOKIE = 'clientsess';

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s) => Uint8Array.from(
  atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------- passwords

// Workers caps PBKDF2 at 100,000 iterations per call, to stop a request
// burning unbounded CPU. Asking for more throws, which is not obvious from the
// error. OWASP wants considerably more than 100,000 for PBKDF2-SHA-256, so we
// run the derivation ROUNDS times, feeding each output in as the next input.
// That is ordinary key stretching: 3 x 100,000 is 300,000 iterations of work
// against an attacker, in three calls the runtime will accept.
//
// The larger protection is the pepper. It lives in Cloudflare as a secret and
// never touches D1, so a stolen copy of the accounts table cannot be attacked
// offline at all without it.
export const PBKDF2_ITERATIONS = 100000;   // the platform ceiling
export const PBKDF2_ROUNDS = 3;            // 300,000 effective

async function derive(password, pepper, salt) {
  let material = enc.encode(password + pepper);
  let bits;
  for (let i = 0; i < PBKDF2_ROUNDS; i++) {
    const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
    bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
    material = new Uint8Array(bits);
  }
  return bits;
}

export async function hashPassword(password, pepper, saltBytes) {
  const salt = saltBytes ?? crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, pepper, salt);
  return `pbkdf2r${PBKDF2_ROUNDS}$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(password, stored, pepper) {
  const [scheme, iters, salt, expect] = String(stored || '').split('$');
  const m = /^pbkdf2r(\d+)$/.exec(scheme || '');
  if (!m) return false;
  const rounds = Number(m[1]);
  const iterations = Number(iters);
  let material = enc.encode(password + pepper);
  let bits;
  for (let i = 0; i < rounds; i++) {
    const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
    bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(salt), iterations }, key, 256);
    material = new Uint8Array(bits);
  }
  return timingSafeEqual(b64url(bits), expect);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ----------------------------------------------------------------- sessions

async function signingKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueSession(env, account) {
  const payload = {
    u: account.username,
    r: account.role,
    c: account.client_id ?? null,
    exp: Date.now() + IDLE_MINUTES * 60_000,
  };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await crypto.subtle.sign('HMAC', await signingKey(env.SESSION_SECRET), enc.encode(body)));
  return `${body}.${sig}`;
}

export async function readSession(env, request) {
  const raw = (request.headers.get('Cookie') || '')
    .split(';').map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const token = raw.slice(COOKIE.length + 1);
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify(
    'HMAC', await signingKey(env.SESSION_SECRET), fromB64url(sig), enc.encode(body));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(fromB64url(body))); }
  catch { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return { username: payload.u, role: payload.r, clientId: payload.c };
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${IDLE_MINUTES * 60}`;
}

export const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

// ----------------------------------------------------------------- accounts

export async function findAccount(env, username) {
  return env.DB.prepare(
    'SELECT username, display_name, role, client_id, password_hash, disabled FROM accounts WHERE username = ?',
  ).bind(String(username || '').trim().toLowerCase()).first();
}

export async function logAuthEvent(env, { username, event, ip, ua, detail }) {
  await env.DB.prepare(
    'INSERT INTO auth_events (at, username, event, ip, user_agent, detail) VALUES (?,?,?,?,?,?)',
  ).bind(new Date().toISOString(), username ?? null, event, ip ?? null, ua ?? null, detail ?? null).run();
}

export async function logView(env, { username, clientId, path, day }) {
  await env.DB.prepare(
    'INSERT INTO view_events (at, username, client_id, path, day) VALUES (?,?,?,?,?)',
  ).bind(new Date().toISOString(), username, clientId, path, day ?? null).run();
}

/**
 * The gate. Returns a session or a Response. Callers must not proceed past a
 * Response. Scope comes from the session only: never from a path segment, a
 * query parameter or a header, because all three are attacker-supplied.
 */
export async function requireClient(env, request) {
  const s = await readSession(env, request);
  if (!s) return { redirect: Response.redirect(new URL('/login', request.url), 302) };
  if (s.role === 'admin') return { session: s, clientId: null, admin: true };
  if (!s.clientId) return { redirect: new Response('No client scope on this account', { status: 403 }) };
  return { session: s, clientId: s.clientId, admin: false };
}

export async function requireAdmin(env, request) {
  const s = await readSession(env, request);
  if (!s) return { redirect: Response.redirect(new URL('/login', request.url), 302) };
  if (s.role !== 'admin') return { redirect: new Response('Not found', { status: 404 }) };
  return { session: s };
}
