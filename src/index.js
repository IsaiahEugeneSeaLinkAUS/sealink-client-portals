// client.sealinkgladstone.com
//
// The gate sits on the path, not on each handler, so a route added later by
// someone who has not read STATUS.md is still gated. Anything that is not
// explicitly public requires a session, and scope comes from the session only.

import LOGO from './logo.png';
import FAVICON from './favicon.png';
import { page, esc } from './brand.js';
import { CLIENTS, isKnownClient } from './clients.js';
import {
  readSession, issueSession, sessionCookie, clearCookie,
  findAccount, verifyPassword, logAuthEvent, logView,
} from './auth.js';
import { refreshAll, loadScope, loadMeta } from './store.js';
import { renderDaily, todayBrisbane } from './trips/page.js';
import { renderUnattributed } from './admin/unmatched.js';
import { handleSetup, handleAccounts } from './admin/accounts.js';
import { handleRefresh } from './admin/refresh.js';
import { renderLogin } from './pages/login.js';
import { renderHome } from './pages/home.js';

const PUBLIC = new Set(['/login', '/healthz', '/setup']);

// Changing the file changes its length, so the tag changes and caches drop it.
const LOGO_ETAG = `W/"logo-${LOGO.byteLength}"`;
const FAVICON_ETAG = `W/"fav-${FAVICON.byteLength}"`;

function asset(request, bytes, etag) {
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return new Response(bytes, {
    headers: {
      'content-type': 'image/png',
      // A day, not a year. Long enough that a device fetches it once, short
      // enough that swapping the file does not need a cache-buster.
      'cache-control': 'public, max-age=86400',
      etag,
      'x-content-type-options': 'nosniff',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Reports WHICH bindings the running Worker can see, never their values.
    // Secrets bind at deploy time, so a secret added in the dashboard after
    // the last deployment is invisible here until a new one goes out.
    // Ungated on purpose: the sign-in page shows the logo before anyone has
    // signed in, and browsers ask for the favicon without a cookie. Gating
    // them only means every page load logs a redirect to the login. They are
    // static brand assets, not data.
    if (path === '/logo.png') return asset(request, LOGO, LOGO_ETAG);
    if (path === '/favicon.png' || path === '/favicon.ico') {
      return asset(request, FAVICON, FAVICON_ETAG);
    }

    if (path === '/healthz') {
      return Response.json({
        ok: true,
        deployedAt: new Date().toISOString(),
        bindings: {
          CLIENT_KV: !!env.CLIENT_KV,
          DB: !!env.DB,
          HELM_CSV_URL: !!env.HELM_CSV_URL,
          HELM_TRIPLOG_CONFIG_ID: !!env.HELM_TRIPLOG_CONFIG_ID,
          HELM_DISPATCH_CONFIG_ID: !!env.HELM_DISPATCH_CONFIG_ID,
          HELM_API_KEY: !!env.HELM_API_KEY,
          SESSION_SECRET: !!env.SESSION_SECRET,
          AUTH_PEPPER: !!env.AUTH_PEPPER,
          SETUP_TOKEN: !!env.SETUP_TOKEN,
        },
      });
    }

    if (path === '/setup') return handleSetup(request, env);
    if (path === '/login') return login(request, env, url);
    if (path === '/logout') {
      return new Response(null, { status: 302, headers: { Location: '/login', 'Set-Cookie': clearCookie } });
    }

    // ---- gate ----------------------------------------------------------
    const session = await readSession(env, request);
    if (!session && !PUBLIC.has(path)) {
      return Response.redirect(new URL('/login', url), 302);
    }

    // ---- admin ----------------------------------------------------------
    if (path.startsWith('/admin')) {
      if (session.role !== 'admin') return new Response('Not found', { status: 404 });
      if (path === '/admin/accounts') return handleAccounts(request, env, session);
      if (path === '/admin/unattributed') return renderUnattributed(env, session);
      if (path === '/admin/refresh') return handleRefresh(request, env, session);
      return new Response('Not found', { status: 404 });
    }

    // ---- client pages ---------------------------------------------------
    if (path === '/') return renderHome(env, session);

    if (path === '/daily') {
      const clientId = session.role === 'admin'
        ? (isKnownClient(url.searchParams.get('as')) ? url.searchParams.get('as') : null)
        : session.clientId;
      if (!clientId) return new Response('No client scope', { status: 403 });

      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '')
        ? url.searchParams.get('day') : todayBrisbane();

      const legs = await loadScope(env, clientId);
      const unattributed = await loadScope(env, 'unattributed');
      const meta = await loadMeta(env);

      ctx.waitUntil(logView(env, { username: session.username, clientId, path, day }));
      return renderDaily({ clientId, day, legs, unattributed, meta, session });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env));
  },
};

async function login(request, env, url) {
  if (request.method !== 'POST') return renderLogin({});

  const form = await request.formData();
  const username = String(form.get('username') || '').trim().toLowerCase();
  const password = String(form.get('password') || '');
  const ip = request.headers.get('CF-Connecting-IP');
  const ua = request.headers.get('User-Agent');

  const account = await findAccount(env, username);
  if (!account || account.disabled) {
    await logAuthEvent(env, { username, event: 'login_unknown_user', ip, ua });
    return renderLogin({ error: 'That username and password did not match.' });
  }
  if (!await verifyPassword(password, account.password_hash, env.AUTH_PEPPER)) {
    await logAuthEvent(env, { username, event: 'login_bad_password', ip, ua });
    return renderLogin({ error: 'That username and password did not match.' });
  }

  await logAuthEvent(env, { username, event: 'login_ok', ip, ua, detail: account.client_id });
  const token = await issueSession(env, account);
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': sessionCookie(token) },
  });
}

export { CLIENTS, esc, page };
