import { page, esc } from '../brand.js';
import { CLIENTS } from '../clients.js';
import { loadMeta } from '../store.js';
import { todayBrisbane } from '../trips/page.js';
import { refreshForm } from '../admin/refresh.js';

const STALE_AFTER_MS = 3 * 3600_000;

export async function renderHome(env, session) {
  const meta = await loadMeta(env);
  const day = todayBrisbane();
  const stamp = meta?.checked
    ? `Data to ${meta.checked.replace('T', ' ').slice(0, 16)}`
    : 'No data loaded';

  if (session.role !== 'admin') {
    const c = CLIENTS[session.clientId];
    return page({
      title: c.name,
      session,
      current: '/',
      home: false,
      stamp,
      body: `<h2>Reports</h2>
<ul><li><a href="/daily?day=${day}">Daily trip log</a></li></ul>
<p class="sub">Ferry services delivered for ${esc(c.name)} by SeaLink Gladstone.</p>`,
    });
  }

  // ---- administrator ----
  const never = !meta?.checked;
  const stale = meta?.checked && (Date.now() - Date.parse(meta.checked)) > STALE_AFTER_MS;
  const failing = !!meta?.lastError;

  // The state banner comes first and the button is inside it, so the control
  // is present in the state where it matters most: nothing loaded yet.
  let banner;
  if (never) {
    banner = `<div class="notice">
  <strong>Nothing has been loaded from Helm yet.</strong>
  The cron runs every two hours. Pull now rather than waiting for it.
  <p style="margin:10px 0 0">${refreshForm('Load from Helm now')}</p>
</div>`;
  } else if (failing) {
    banner = `<div class="notice">
  <strong>The last pull failed.</strong> ${esc(meta.lastError)}
  The figures below are from the last good pull, at
  ${esc(String(meta.checked).replace('T', ' ').slice(0, 16))}.
  <p style="margin:10px 0 0">${refreshForm('Try again')}</p>
</div>`;
  } else if (stale) {
    banner = `<div class="notice">
  <strong>Data is more than three hours old.</strong>
  Last confirmed ${esc(String(meta.checked).replace('T', ' ').slice(0, 16))} Brisbane.
  <p style="margin:10px 0 0">${refreshForm()}</p>
</div>`;
  } else {
    banner = `<div class="notice calm">
  <strong>Data confirmed ${esc(String(meta.checked).replace('T', ' ').slice(0, 16))} Brisbane.</strong>
  ${meta.fetchedAt && meta.fetchedAt !== meta.checked
    ? `Last actually changed ${esc(String(meta.fetchedAt).replace('T', ' ').slice(0, 16))}.`
    : ''}
  <p style="margin:10px 0 0">${refreshForm()}</p>
</div>`;
  }

  const counts = meta?.counts ?? {};

  return page({
    title: 'Client reporting',
    session,
    current: '/',
    home: false,
    stamp,
    body: `${banner}

<h2>Client views</h2>
<div class="scroll"><table>
<thead><tr><th>Client</th><th class="num">Legs held</th><th>Daily trip log</th></tr></thead>
<tbody>
${Object.values(CLIENTS).map((c) => `<tr>
  <td>${esc(c.name)}</td>
  <td class="num">${counts[c.id] === undefined ? '<span class="absent"></span>'
    : counts[c.id].toLocaleString('en-AU')}</td>
  <td><a href="/daily?as=${c.id}&day=${day}">Open as ${esc(c.short)}</a></td>
</tr>`).join('')}
</tbody>
<caption>Opening a client page as an administrator is recorded in the view log
against your username.</caption>
</table></div>

<h2>Internal</h2>
<ul>
  <li><a href="/admin/accounts">Accounts</a> — add, disable and reset logins</li>
  <li><a href="/admin/unattributed">Attribution</a> — legs attributed to nobody
    ${meta?.unattributed !== undefined && meta?.unattributed !== null
      ? `<span class="pill ${meta.unattributed ? 'p-extra' : 'p-scheduled'}">${meta.unattributed}</span>`
      : ''}</li>
</ul>

<p class="sub">Helm is polled every two hours. Rows read last time:
${meta?.tripLogRows ? `${meta.tripLogRows.toLocaleString('en-AU')} trip log,
${(meta.dispatchRows ?? 0).toLocaleString('en-AU')} dispatch` : 'none yet'}.</p>`,
  });
}
