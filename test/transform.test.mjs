// Numbers asserted here are checkable against the Power BI daily report PDFs
// for Monday 7 September 2026. Where this build and the PDF disagree, the
// disagreement is written down rather than reconciled away.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCsv, unwrap } from '../src/helm.js';
import { buildLegs, scopeLegs, summarise, ofService, UNATTRIBUTED } from '../src/trips/transform.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => parseCsv(readFileSync(join(here, 'fixtures', n), 'utf8'));

const legs = buildLegs(fx('trip-log-2026-09-07.csv'), fx('dispatch-2026-09-07.csv'));
const scoped = scopeLegs(legs);
const ferry = (id) => ofService(scoped[id], 'ferry');
const vessel = (id, name) => summarise(ferry(id)).vessels.find((v) => v.resource === name);
const round = (n) => Math.round(n * 100) / 100;

test('Helm ="value" wrapping is stripped', () => {
  assert.equal(unwrap('="Torresian"'), 'Torresian');
  assert.equal(unwrap('2026-09-07 06:30'), '2026-09-07 06:30');
  assert.equal(unwrap(''), '');
});

test('APLNG matches the PDF exactly', () => {
  const bk = vessel('aplng', 'Brahminy Kite');
  assert.equal(bk.legs, 18);
  assert.equal(bk.pax, 175);
  assert.equal(round(bk.nm), 57.97);
  assert.equal(round(bk.fuelL), 416.92);
  assert.equal(round(bk.co2), 1100.66);

  const g = vessel('aplng', 'Goodna');
  assert.equal(g.legs, 21);
  assert.equal(g.pax, 320);
  assert.equal(round(g.nm), 61.07);
  assert.equal(round(g.fuelL), 474.09);
  assert.equal(round(g.co2), 1251.61);
});

test('QGC ferries match the PDF exactly', () => {
  const cs = vessel('qgc', 'Capricornian Spirit');
  assert.equal(cs.pax, 352);
  assert.equal(round(cs.nm), 37.75);
  assert.equal(round(cs.fuelL), 492.96);
  assert.equal(round(cs.co2), 1301.42);

  const p = vessel('qgc', 'Parangool');
  assert.equal(p.pax, 107);
  assert.equal(round(p.nm), 42.43);
  assert.equal(round(p.fuelL), 293.48);
  assert.equal(round(p.co2), 774.82);
});

test('GLNG Nancy Wake carries passengers and nothing else', () => {
  // No OnWatch unit, so no position, distance, fuel or emissions telemetry.
  // Her berths come from the booking, not the trip log.
  const nw = vessel('glng', 'Nancy Wake');
  assert.equal(nw.legs, 12);
  assert.equal(nw.pax, 142);
  assert.equal(nw.missing.fuelL, nw.legs);
  assert.equal(nw.missing.nm, nw.legs);
  assert.equal(nw.missing.co2, nw.legs);
});

test('Torresian carries four legs the PDF does not show', () => {
  // This build: 23 legs, 94 pax. PDF: 19 legs, 79 pax. The archived record is
  // already dropped by both. The remaining four are two GL3-to-GL3 hops at
  // 05:20 and 16:40, the 16:25 Marina-to-GL3 that precedes one of them, and
  // 05:25, also GL3 to GL3. Together they carry the 15 passenger difference. Open
  // reconciliation item, see STATUS.md.
  const t = vessel('glng', 'Torresian');
  assert.equal(t.legs, 23);
  assert.equal(t.pax, 94);
  const sameBerth = scoped.glng.filter((l) => l.resource === 'Torresian' && l.from === l.to);
  assert.equal(sameBerth.length, 3);
});

test('the barge reaches both QGC and GLNG and carries no telemetry', () => {
  const q = summarise(ofService(scoped.qgc, 'jv')).vessels.find((v) => v.resource === 'Bruce');
  const g = summarise(ofService(scoped.glng, 'jv')).vessels.find((v) => v.resource === 'Bruce');
  assert.deepEqual([q.legs, q.pax], [g.legs, g.pax]);
  assert.equal(q.legs, 4);
  assert.equal(q.missing.fuelL, q.legs);
});

test('every leg on this day is attributed', () => {
  assert.equal(scoped[UNATTRIBUTED].length, 0);
});

test('attribution basis is recorded on every leg', () => {
  const bases = new Set(legs.map((l) => l.basis));
  assert.ok(bases.has('berth'));
  assert.ok(bases.has('booking'));
  assert.ok(bases.has('barge'));
  for (const leg of legs) assert.ok(leg.basis || leg.unmatchedReason);
});

test('archived legs are dropped', () => {
  const kept = buildLegs([
    { Resource: 'Torresian', Start: '2026-09-07 09:25', 'Location From Name': 'GL4',
      'Location To Name': 'GL3', Archived: '2026-09-07 22:19' },
  ], []);
  assert.equal(kept.length, 0);
});

test('R.B. Trojan is QGC shipping, and never in the ferry figures', () => {
  assert.equal(vessel('qgc', 'R.B. Trojan'), undefined);
  const ship = ofService(scoped.qgc, 'shipping');
  assert.ok(ship.some((l) => l.resource === 'R.B. Trojan'));
  for (const leg of ship) assert.equal(leg.client, 'qgc');
  // No other client receives shipping work.
  assert.equal(ofService(scoped.aplng, 'shipping').length, 0);
  assert.equal(ofService(scoped.glng, 'shipping').length, 0);
});

test('a ferry calling at QC3 stays in the ferry figures but is flagged', () => {
  const flagged = ferry('qgc').filter((l) => l.shippingBerth);
  assert.ok(flagged.length > 0, 'ferries do run agent work to QC3');
  for (const leg of flagged) {
    assert.equal(leg.service, 'ferry');
    assert.ok(leg.from === 'QC3' || leg.to === 'QC3');
  }
});

test('a summarised total distinguishes absent from zero', () => {
  const { total } = summarise(ferry('glng'));
  assert.ok(total.missing.fuelL > 0);
  assert.notEqual(total.fuelL, 0);
});
