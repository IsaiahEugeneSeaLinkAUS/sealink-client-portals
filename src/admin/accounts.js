// Account administration inside the Worker.
//
// Password hashing needs WebCrypto, which the Worker already has, so there is
// no reason it has to happen on someone's laptop. tools/mkaccount.mjs still
// works and produces identical hashes; this is the same thing with a form in
// front of it, for anyone who cannot install Node.
//
// Bootstrap: while the accounts table is empty, /setup will create the first
// admin if the request carries the SETUP_TOKEN secret. The moment one account
// exists, /setup returns 404 for good. There is no way back in through it, so
// losing every admin password means adding a row through the D1 console.

import { page, esc } from '../brand.js';
import { CLIENTS } from '../clients.js';
import { hashPassword, logAuthEvent } from '../auth.js';

const MIN_PASSWORD = 12;

async function accountCount(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first();
  return r?.n ?? 0;
}

async function createAccount(env, { username, displayName, role, clientId, password, createdBy }) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(u)) {
    return 'Username must be 3 to 40 characters, lowercase letters, numbers, dot, dash or underscore.';
  }
  if (!String(displayName || '').trim()) return 'Enter the person\'s name.';
  if (role !== 'admin' && role !== 'client') return 'Choose a role.';
  if (role === 'client' && !CLIENTS[clientId]) return 'A client account needs a client.';
  if (String(password || '').length < MIN_PASSWORD) {
    return `Use a password of at least ${MIN_PASSWORD} characters.`;
  }

  const hash = await hashPassword(password, env.AUTH_PEPPER);
  try {
    await env.DB.prepare(
      `INSERT INTO accounts (username, display_name, role, client_id, password_hash,
        disabled, created_at, created_by) VALUES (?,?,?,?,?,0,?,?)`,
    ).bind(u, String(displayName).trim(), role, role === 'admin' ? null : clientId,
      hash, new Date().toISOString(), createdBy).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return `The username ${u} is already taken.`;
    throw e;
  }
  return null;
}

// ------------------------------------------------------------------ /setup

export async function handleSetup(request, env) {
  if (await accountCount(env) > 0) return new Response('Not found', { status: 404 });
  if (!env.SETUP_TOKEN) {
    return new Response(
      'SETUP_TOKEN is not readable by the running Worker.\n\n'
      + 'Secrets bind at deploy time, so one added in the dashboard after the last\n'
      + 'deployment will not be visible until a new deployment goes out. Open the\n'
      + 'Deployments tab and redeploy the latest version, then reload this page.\n\n'
      + 'Check /healthz to see which bindings this Worker can currently read.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

  const form = request.method === 'POST' ? await request.formData() : null;
  let error = null;

  if (form) {
    if (String(form.get('token') || '') !== env.SETUP_TOKEN) {
      error = 'That setup token is not correct.';
    } else {
      error = await createAccount(env, {
        username: form.get('username'),
        displayName: form.get('display_name'),
        role: 'admin',
        password: form.get('password'),
        createdBy: 'setup',
      });
      if (!error) {
        await logAuthEvent(env, { username: String(form.get('username')).toLowerCase(), event: 'account_created', detail: 'first admin via /setup' });
        return page({
          title: 'First-time setup',
          home: false,
          body: `<div class="notice calm"><strong>Done.</strong> <a href="/login">Sign in</a>, then add
          the rest of the accounts from the Accounts page. This setup page is now closed and
          will return "not found" from here on.</div>`,
        });
      }
    }
  }

  return page({
    title: 'First-time setup',
    home: false,
    body: `<form class="card" method="post" action="/setup" autocomplete="off">
  <h2 style="margin-top:0">Create the first administrator</h2>
  <p class="sub">This page works once, while no accounts exist. The setup token is the
  <code>SETUP_TOKEN</code> secret on this Worker.</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <label for="tk">Setup token</label>
  <input id="tk" name="token" type="password" required>
  <label for="u">Username</label>
  <input id="u" name="username" required autocapitalize="none" spellcheck="false">
  <label for="dn">Name</label>
  <input id="dn" name="display_name" required>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" required minlength="${MIN_PASSWORD}">
  <button class="primary" type="submit">Create administrator</button>
</form>`,
  });
}

// -------------------------------------------------------- /admin/accounts

export async function handleAccounts(request, env, session) {
  let error = null;
  let done = null;

  if (request.method === 'POST') {
    const form = await request.formData();
    const action = String(form.get('action') || '');

    if (action === 'create') {
      error = await createAccount(env, {
        username: form.get('username'),
        displayName: form.get('display_name'),
        role: form.get('role'),
        clientId: form.get('client_id'),
        password: form.get('password'),
        createdBy: session.username,
      });
      if (!error) {
        done = `Created ${String(form.get('username')).toLowerCase()}.`;
        await logAuthEvent(env, {
          username: String(form.get('username')).toLowerCase(),
          event: 'account_created', detail: `by ${session.username}`,
        });
      }
    }

    if (action === 'disable' || action === 'enable') {
      const u = String(form.get('username') || '').toLowerCase();
      if (u === session.username && action === 'disable') {
        error = 'You cannot disable your own account.';
      } else {
        await env.DB.prepare('UPDATE accounts SET disabled = ? WHERE username = ?')
          .bind(action === 'disable' ? 1 : 0, u).run();
        done = `${action === 'disable' ? 'Disabled' : 'Re-enabled'} ${u}.`;
        await logAuthEvent(env, { username: u, event: `account_${action}d`, detail: `by ${session.username}` });
      }
    }

    if (action === 'reset') {
      const u = String(form.get('username') || '').toLowerCase();
      const pw = String(form.get('password') || '');
      if (pw.length < MIN_PASSWORD) error = `Use a password of at least ${MIN_PASSWORD} characters.`;
      else {
        await env.DB.prepare('UPDATE accounts SET password_hash = ? WHERE username = ?')
          .bind(await hashPassword(pw, env.AUTH_PEPPER), u).run();
        done = `Set a new password for ${u}.`;
        await logAuthEvent(env, { username: u, event: 'password_reset', detail: `by ${session.username}` });
      }
    }
  }

  const { results = [] } = await env.DB.prepare(
    'SELECT username, display_name, role, client_id, disabled, created_at, created_by FROM accounts ORDER BY role, username',
  ).all();

  const clientName = (id) => (CLIENTS[id]?.name ?? '');

  return page({
    title: 'Accounts',
    session,
    current: '/admin/accounts',
    body: `
${error ? `<p class="error">${esc(error)}</p>` : ''}
${done ? `<p class="done">${esc(done)}</p>` : ''}

<h2>People with a login</h2>
<div class="scroll"><table>
<thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Sees</th>
<th>Added</th><th>Status</th><th></th></tr></thead>
<tbody>
${results.map((a) => `<tr>
  <td>${esc(a.username)}</td>
  <td>${esc(a.display_name)}</td>
  <td>${a.role === 'admin' ? 'Administrator' : 'Client'}</td>
  <td>${a.role === 'admin' ? 'Everything, and who viewed what' : esc(clientName(a.client_id))}</td>
  <td>${esc(String(a.created_at).slice(0, 10))} by ${esc(a.created_by)}</td>
  <td>${a.disabled ? '<span class="pill p-extra">Disabled</span>' : '<span class="pill p-scheduled">Active</span>'}</td>
  <td><form method="post" style="margin:0">
    <input type="hidden" name="action" value="${a.disabled ? 'enable' : 'disable'}">
    <input type="hidden" name="username" value="${esc(a.username)}">
    <button class="small">${a.disabled ? 'Re-enable' : 'Disable'}</button>
  </form></td>
</tr>`).join('')}
</tbody>
<caption>Disabling takes effect on the next request. It does not delete the account or the
record of what that person viewed.</caption>
</table></div>

<h2>Add someone</h2>
<form class="panel" method="post">
  <input type="hidden" name="action" value="create">
  <label for="nu">Username</label>
  <input id="nu" name="username" required autocapitalize="none" spellcheck="false"
    placeholder="b.wilson">
  <label for="nn">Name</label>
  <input id="nn" name="display_name" required placeholder="Bruce Wilson">
  <label for="nr">Role</label>
  <select id="nr" name="role">
    <option value="client">Client — sees one client's reports</option>
    <option value="admin">Administrator — sees everything and can add logins</option>
  </select>
  <label for="nc">Client (ignored for administrators)</label>
  <select id="nc" name="client_id">
    ${Object.values(CLIENTS).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
  </select>
  <label for="np">Password (at least ${MIN_PASSWORD} characters)</label>
  <input id="np" name="password" type="password" required minlength="${MIN_PASSWORD}">
  <button class="primary" type="submit">Create login</button>
  <p class="sub" style="margin-top:14px">Hand the password over in person or by phone. Nothing here emails it,
  and it cannot be read back afterwards.</p>
</form>

<h2>Set a new password</h2>
<form class="panel" method="post">
  <input type="hidden" name="action" value="reset">
  <label for="ru">Username</label>
  <input id="ru" name="username" required autocapitalize="none" spellcheck="false">
  <label for="rp">New password</label>
  <input id="rp" name="password" type="password" required minlength="${MIN_PASSWORD}">
  <button class="primary" type="submit">Set password</button>
</form>`,
  });
}
