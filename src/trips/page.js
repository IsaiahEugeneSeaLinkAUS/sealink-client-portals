// The daily trip log, reproducing the Power BI client report layout:
// vessel summary, then trip-level detail. Two differences from the PDF, both
// deliberate and both stated on the page:
//
//   1. Legs that cannot be attributed to this client by evidence are excluded
//      and counted, rather than assigned by vessel. Power BI assigns by vessel,
//      which is safe while a vessel is dedicated and wrong for Torresian, which
//      ran 663 GLNG and 325 QGC legs over the sample period.
//   2. An absent figure renders as "not recorded", never as a blank that reads
//      as zero.

import { page, esc, nn, tripPill } from '../brand.js';
import { CLIENTS } from '../clients.js';
import { legsOn, summarise, ofService, UNATTRIBUTED } from './transform.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function longDate(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

export function todayBrisbane(now = new Date()) {
  return new Date(now.getTime() + 10 * 3600_000).toISOString().slice(0, 10);
}

const time = (iso) => (iso ? iso.slice(11, 16) : '');

export function renderDaily({ clientId, day, legs, unattributed, meta, session }) {
  const client = CLIENTS[clientId];
  const all = legsOn(legs, day).sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  // Ferry service only. Shipping work is agent-booked and invoiced separately,
  // and barge activity belongs on the JV view, so neither belongs in these
  // totals. Both are counted below rather than dropped silently.
  const mine = ofService(all, 'ferry');
  const shipping = ofService(all, 'shipping');
  const jv = ofService(all, 'jv');
  const { vessels, total } = summarise(mine);

  // Excluded-from-this-page legs on the same day, on vessels this client uses.
  const vesselsUsed = new Set(mine.map((l) => l.resource));
  const withheld = legsOn(unattributed, day).filter((l) => vesselsUsed.has(l.resource));

  const stale = meta?.checked && (Date.now() - Date.parse(meta.checked)) > 3 * 3600_000;

  const body = `
<div class="notice${stale ? '' : ' calm'}">
  <strong>${esc(client.name)} — runs completed on ${esc(longDate(day))}.</strong>
  Ferry service only. These are legs recorded in the vessel trip log and
  attributed to ${esc(client.name)} by the berths they touched, the booking they
  were run against, or the legs either side of them. Figures are Brisbane time.
  ${shipping.length ? `${shipping.length} shipping movement${shipping.length === 1 ? '' : 's'}` : ''}${shipping.length && jv.length ? ' and ' : ''}${jv.length ? `${jv.length} barge movement${jv.length === 1 ? '' : 's'}` : ''}${shipping.length || jv.length ? ' ran for you on this day and are reported separately, so they are not in the figures below.' : ''}
  Data last confirmed from Helm ${meta?.checked ? esc(meta.checked.replace('T', ' ').slice(0, 16)) + ' Brisbane' : 'never'}${stale ? ' — this is more than three hours ago' : ''}.
</div>

<p class="sub" style="margin-top:14px">
  <a class="btn" href="?day=${prevDay(day)}">&larr; Previous day</a>
  <a class="btn" href="?day=${nextDay(day)}">Next day &rarr;</a>
</p>

<h2>Vessel summary</h2>
<div class="scroll"><table>
<thead><tr>
  <th>Vessel</th><th class="num">Legs</th><th class="num">Passengers</th>
  <th class="num">Distance (nmi)</th><th class="num">Fuel used (L)</th>
  <th class="num">CO₂ (kg)</th>
</tr></thead>
<tbody>
${vessels.map((v) => `<tr>
  <td>${esc(v.resource)}</td>
  <td class="num">${v.legs}</td>
  <td class="num">${v.missing.pax === v.legs ? notRec() : nn(v.pax, 0)}</td>
  <td class="num">${v.missing.nm === v.legs ? notRec() : nn(v.nm)}${partial(v.missing.nm, v.legs)}</td>
  <td class="num">${v.missing.fuelL === v.legs ? notRec() : nn(v.fuelL)}${partial(v.missing.fuelL, v.legs)}</td>
  <td class="num">${v.missing.co2 === v.legs ? notRec() : nn(v.co2)}${partial(v.missing.co2, v.legs)}</td>
</tr>`).join('')}
<tr class="total">
  <td>Total</td><td class="num">${total.legs}</td><td class="num">${nn(total.pax, 0)}</td>
  <td class="num">${nn(total.nm)}</td><td class="num">${nn(total.fuelL)}</td><td class="num">${nn(total.co2)}</td>
</tr>
</tbody>
<caption>Totals sum only the legs that carry a figure. A vessel showing
&ldquo;not recorded&rdquo; contributes nothing to the total for that column, so the
total is a floor, not a complete picture.</caption>
</table></div>

<h2>Trip detail</h2>
<div class="scroll"><table>
<thead><tr>
  <th>Vessel</th><th>Departed</th><th>Arrived</th><th>From</th><th>To</th>
  <th class="num">Mins</th><th class="num">Pax</th><th>Crew comment</th><th>Booking note</th>
  <th>Trip type</th><th class="num">CO₂ (kg)</th><th class="num">nmi</th>
  <th class="num">l/nm</th><th class="num">Fuel (L)</th>
</tr></thead>
<tbody>
${mine.map((l) => `<tr>
  <td>${esc(l.resource)}</td>
  <td>${time(l.start)}</td><td>${time(l.end)}</td>
  <td>${esc(l.from)}</td><td>${esc(l.to)}</td>
  <td class="num">${mins(l)}</td>
  <td class="num">${nn(l.pax, 0)}</td>
  <td class="wrapcol">${esc(l.comment)}</td>
  <td class="wrapcol">${esc(l.bookingNote)}</td>
  <td title="Attributed by ${esc(l.basis || 'unknown')}"><span class="pill ${
      tripPill(l.runType)}">${esc(l.runType || 'Unclassified')}</span></td>
  <td class="num">${nn(l.co2)}</td><td class="num">${nn(l.nm)}</td>
  <td class="num">${nn(l.fuelEff)}</td><td class="num">${nn(l.fuelL)}</td>
</tr>`).join('')}
</tbody>
<caption>Showing all ${mine.length} legs recorded for ${esc(client.short)} on this day.
Hover a trip type to see how the leg was attributed.</caption>
</table></div>

${withheld.length ? `
<h2>Not included above</h2>
<div class="notice">
  ${withheld.length} further leg${withheld.length === 1 ? '' : 's'} ran on
  ${withheld.length === 1 ? 'a vessel' : 'vessels'} serving you on this day but could not be
  matched to a booking, so ${withheld.length === 1 ? 'it is' : 'they are'} not attributed to
  ${esc(client.short)} and ${withheld.length === 1 ? 'is' : 'are'} excluded from every figure
  on this page. SeaLink is working through these at source.
</div>
<div class="scroll"><table>
<thead><tr><th>Vessel</th><th>Departed</th><th>From</th><th>To</th><th>Trip type</th></tr></thead>
<tbody>${withheld.map((l) => `<tr><td>${esc(l.resource)}</td><td>${time(l.start)}</td>
  <td>${esc(l.from)}</td><td>${esc(l.to)}</td><td>${esc(l.runType || 'Unclassified')}</td></tr>`).join('')}
</tbody></table></div>` : ''}
`;

  return page({
    title: `Daily trip log — ${client.short}`,
    body,
    session,
    current: '/daily',
    stamp: meta?.checked
      ? `Data to ${esc(meta.checked.replace('T', ' ').slice(0, 16))} Brisbane`
      : 'No data loaded',
  });
}

const notRec = () => '<span class="absent"></span>';
const partial = (missing, legs) => (missing > 0 && missing < legs
  ? ` <span class="note">(${missing} of ${legs} legs not recorded)</span>` : '');

function mins(l) {
  if (!l.start || !l.end) return '';
  return Math.round((Date.parse(l.end.replace(' ', 'T') + '+10:00')
    - Date.parse(l.start.replace(' ', 'T') + '+10:00')) / 60000);
}

function shift(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const prevDay = (d) => shift(d, -1);
export const nextDay = (d) => shift(d, 1);
export { UNATTRIBUTED };
