// Pull from Helm on demand.
//
// The cron runs every two hours, which is fine in steady state and useless the
// first time you deploy, after a Helm outage, or when someone has just fixed a
// record at source and wants to see it. This is the manual pull.
//
// It lives on the home page, not behind a section that only appears once data
// exists. A refresh control that is hidden until there is data to refresh is
// missing exactly when it is needed.

import { page, esc } from '../brand.js';
import { CLIENTS } from '../clients.js';
import { refreshAll, loadMeta } from '../store.js';
import { logAuthEvent } from '../auth.js';

export async function handleRefresh(request, env, session) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 303, headers: { Location: '/' } });
  }

  const result = await refreshAll(env);
  await logAuthEvent(env, {
    username: session.username,
    event: result.ok ? 'refresh_ok' : 'refresh_failed',
    detail: result.errors.length ? result.errors.join(' ') : `${result.tripLogRows} trip log rows`,
  });

  const meta = await loadMeta(env);
  const secs = (result.ms / 1000).toFixed(1);

  const body = result.errors.length
    ? `<div class="notice">
    <strong>The pull did not complete.</strong>
    <ul>${result.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
    Nothing was overwritten, so the pages still show whatever was loaded last.
    Check that <code>HELM_API_KEY</code> is set and that the two report config
    ids in <code>wrangler.toml</code> still exist in Helm.
  </div>`
    : `<div class="notice calm">
    <strong>Loaded from Helm in ${esc(secs)} seconds.</strong>
    ${result.tripLogRows.toLocaleString('en-AU')} trip log rows and
    ${result.dispatchRows.toLocaleString('en-AU')} dispatch rows.
    ${result.wrote
      ? `Updated: ${result.changed.map(esc).join(', ')}.`
      : 'Nothing had changed since the last pull, so no writes were needed.'}
  </div>

<h2>What each client can now see</h2>
<div class="scroll"><table>
<thead><tr><th>Client</th><th class="num">Legs</th></tr></thead>
<tbody>
${Object.values(CLIENTS).map((c) => `<tr><td>${esc(c.name)}</td>
  <td class="num">${(result.counts?.[c.id] ?? 0).toLocaleString('en-AU')}</td></tr>`).join('')}
<tr class="total"><td>Attributed to nobody</td>
  <td class="num">${(result.unattributed ?? 0).toLocaleString('en-AU')}</td></tr>
</tbody>
<caption>Legs attributed to nobody appear on no client page.
<a href="/admin/unattributed">See why</a>.</caption>
</table></div>`;

  return page({
    title: 'Load from Helm',
    session,
    current: '/',
    body: `${body}
<p class="sub" style="margin-top:20px">
  <a class="btn" href="/">Back to home</a>
  <a class="btn" href="/daily?as=aplng">APLNG</a>
  <a class="btn" href="/daily?as=qgc">QGC</a>
  <a class="btn" href="/daily?as=glng">GLNG</a>
</p>`,
    stamp: meta?.checked
      ? `Data to ${esc(meta.checked.replace('T', ' ').slice(0, 16))}`
      : 'No data loaded',
  });
}

/** The button itself, so the home page and any future page render it the same. */
export function refreshForm(label = 'Load from Helm now') {
  return `<form method="post" action="/admin/refresh" style="display:inline">
  <button class="primary" style="width:auto;margin:0">${esc(label)}</button>
</form>`;
}
