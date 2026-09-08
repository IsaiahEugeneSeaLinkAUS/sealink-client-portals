// Internal only. Every leg that reached no client, and why.
//
// This page exists because fail-closed is only safe if somebody can see what
// closed. A leg quietly belonging to nobody is a client under-reporting their
// own activity, which is the failure mode nobody complains about.

import { page, esc } from '../brand.js';
import { loadScope, loadMeta } from '../store.js';

export async function renderUnattributed(env, session) {
  const rows = await loadScope(env, 'unattributed');
  const meta = await loadMeta(env);

  const byReason = new Map();
  for (const r of rows) {
    const k = (r.unmatchedReason || 'unknown').replace(/\d+\.\d+/g, 'N');
    byReason.set(k, (byReason.get(k) || 0) + 1);
  }

  const recent = rows.slice().sort((a, b) => (b.start || '').localeCompare(a.start || '')).slice(0, 200);

  // Ferry legs that called at the shipping berth. Counted as ferry service
  // today; possibly agent work invoiced separately. See STATUS.md.
  const qgc = await loadScope(env, 'qgc');
  const qc3 = qgc.filter((l) => l.service === 'ferry' && l.shippingBerth);

  return page({
    title: 'Attribution',
    session,
    current: '/admin/unattributed',
    body: `<div class="notice">
  ${rows.length} legs of ${meta ? Object.values(meta.counts).reduce((a, b) => a + b, 0) : '?'}
  reached no client. They appear on no client page. Each one is activity a client
  is not being credited with.
</div>

<h2>Why</h2>
<div class="scroll"><table><thead><tr><th>Reason</th><th class="num">Legs</th></tr></thead><tbody>
${[...byReason.entries()].sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `<tr><td class="wrapcol">${esc(k)}</td><td class="num">${v}</td></tr>`).join('')}
</tbody></table></div>

<h2>Ferry legs calling at QC3</h2>
<div class="notice plain">
  ${qc3.length} ferry leg${qc3.length === 1 ? '' : 's'} called at the shipping berth and
  are counted as QGC ferry service. If they are agent work billed on the shipping
  report, they are being presented twice under two arrangements. They are also
  shipping-related transfers under cl.2.3(b), which sit outside the 20-trip allowance.
</div>
<div class="scroll"><table><thead><tr><th>Vessel</th><th>Start</th><th>From</th><th>To</th>
<th>Trip type</th><th class="num">Pax</th></tr></thead><tbody>
${qc3.slice(0, 100).map((r) => `<tr><td>${esc(r.resource)}</td><td>${esc(r.start)}</td>
<td>${esc(r.from)}</td><td>${esc(r.to)}</td><td>${esc(r.runType)}</td>
<td class="num">${r.pax ?? ''}</td></tr>`).join('')}
</tbody><caption>Showing ${Math.min(qc3.length, 100)} of ${qc3.length}.</caption></table></div>

<h2>Most recent</h2>
<div class="scroll"><table><thead><tr><th>Vessel</th><th>Start</th><th>From</th><th>To</th>
<th>Trip type</th><th class="num">Pax</th><th>Reason</th></tr></thead><tbody>
${recent.map((r) => `<tr><td>${esc(r.resource)}</td><td>${esc(r.start)}</td>
<td>${esc(r.from)}</td><td>${esc(r.to)}</td><td>${esc(r.runType)}</td>
<td class="num">${r.pax ?? ''}</td><td class="wrapcol">${esc(r.unmatchedReason)}</td></tr>`).join('')}
</tbody>
<caption>Showing ${recent.length} of ${rows.length}.</caption></table></div>`,
  });
}
