// The one test that must never be allowed to fail.
//
// Everything else in this repo is a feature. This file is the reason the repo
// exists: three charterers who compete in the same harbour, on one codebase.
// If a change makes this red, the change is wrong, not the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCsv } from '../src/helm.js';
import { buildLegs, scopeLegs, UNATTRIBUTED } from '../src/trips/transform.js';
import { CLIENTS, resolveClient, resolveBySite, visibleTo } from '../src/clients.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => parseCsv(readFileSync(join(here, 'fixtures', n), 'utf8'));

const tripLog = fx('trip-log-2026-09-07.csv');
const dispatch = fx('dispatch-2026-09-07.csv');
const legs = buildLegs(tripLog, dispatch);
const scoped = scopeLegs(legs);

const IDS = Object.keys(CLIENTS);

test('every leg in a client bucket names that client, or is barge', () => {
  for (const id of IDS) {
    for (const leg of scoped[id]) {
      assert.ok(
        visibleTo(leg, id),
        `${leg.resource} ${leg.start} landed in ${id} but audienceFor disagrees`,
      );
    }
  }
});

test('no client can see another client ferry leg', () => {
  for (const mine of IDS) {
    for (const theirs of IDS) {
      if (mine === theirs) continue;
      for (const leg of scoped[theirs]) {
        if (leg.service !== 'ferry') continue;
        assert.equal(
          visibleTo(leg, mine), false,
          `${mine} can see ${theirs} ferry leg: ${leg.resource} ${leg.start} (trip ${leg.tripNumber})`,
        );
      }
    }
  }
});

test('APLNG sees no barge activity at all', () => {
  const barge = scoped.aplng.filter((l) => l.service === 'jv');
  assert.equal(barge.length, 0, 'JV is a QGC/GLNG venture; APLNG must not receive it');
});

test('barge legs reach both QGC and GLNG and nobody else', () => {
  const bruce = legs.filter((l) => l.resource === 'Bruce');
  assert.ok(bruce.length > 0, 'fixture should contain barge legs');
  for (const leg of bruce) {
    const seen = IDS.filter((id) => visibleTo(leg, id)).sort();
    assert.deepEqual(seen, ['glng', 'qgc']);
  }
});

test('unattributed legs are visible to nobody', () => {
  // The 7 September fixture attributes every leg, so this exercises the path
  // with a leg that cannot be resolved by any layer.
  const orphan = buildLegs(
    [{ Resource: 'Goodna', Start: '2026-09-07 06:00', 'Location From Name': 'Marina',
       'Location To Name': 'Service Wharf' }], [],
  );
  for (const leg of [...scoped[UNATTRIBUTED], ...orphan.filter((l) => !l.audience.length)]) {
    for (const id of IDS) {
      assert.equal(
        visibleTo(leg, id), false,
        `unattributed ${leg.resource} ${leg.start} is reachable by ${id}`,
      );
    }
    assert.ok(leg.unmatchedReason, 'an unattributed leg must record why');
  }
});

test('an unrecognised client string resolves to nobody', () => {
  for (const bad of [
    'Australian Pacific LNG Pty Ltd', // a rename
    'australian pacific lng',          // a case change
    'Queensland Gas Company ',         // a trailing space
    'QGC',                             // an abbreviation nobody mapped
    '', null, undefined, 0, '*',
  ]) {
    assert.equal(resolveClient(bad), null, `${JSON.stringify(bad)} must not resolve`);
  }
});

test('a vessel serving two clients does not carry legs across', () => {
  // Torresian ran 663 GLNG and 325 QGC legs over the sample period, and is
  // currently covering James Grant. It is the reason attribution can never be
  // done by vessel.
  const torresian = legs.filter((l) => l.resource === 'Torresian' && l.client);
  assert.ok(torresian.length > 0);
  for (const leg of torresian) {
    assert.equal(leg.audience.length, 1, 'a ferry leg belongs to exactly one client');
    assert.notEqual(leg.client, 'jv');
  }
});

test('a vessel disagreement between the two systems drops to unattributed', () => {
  const forged = buildLegs(
    [{ Resource: 'Goodna', Start: '2026-09-07 06:00', 'Trip Number': '999.1', PAX: '10',
       'Location From Name': 'Marina', 'Location To Name': 'GL3' }],
    [{ 'Trip Number': '999.1', Resource: 'Torresian', 'Customer Account Name': 'Gladstone LNG',
       'Location From Name': 'Marina', 'Location To Name': 'GL3' }],
  );
  assert.equal(forged[0].audience.length, 0);
  assert.match(forged[0].unmatchedReason, /different vessel/);
});

test('GL3 attributes to nobody on its own', () => {
  assert.equal(resolveBySite('GL3', 'Marina'), null);
  assert.equal(resolveBySite('Marina', 'GL3'), null);
  assert.equal(resolveBySite('GL3', 'GL3'), null);
});

test('the decisive berths attribute, and only to their own client', () => {
  assert.deepEqual(resolveBySite('Marina', 'CP1'), { client: 'aplng' });
  assert.deepEqual(resolveBySite('GL3', 'QC4'), { client: 'qgc' });
  assert.deepEqual(resolveBySite('GL3', 'GL4'), { client: 'glng' });
  assert.deepEqual(resolveBySite('QC4', 'GL4'), { conflict: ['qgc', 'glng'] });
});

test('berth and booking never disagree in the sample', () => {
  for (const leg of legs) {
    assert.equal(Boolean(leg.conflict) && !leg.client, false,
      `unresolved conflict on ${leg.resource} ${leg.start}: ${leg.conflict}`);
  }
});

test('adding a client id without an alias grants no data', () => {
  const ghost = 'santos';
  for (const leg of legs) assert.equal(visibleTo(leg, ghost), false);
});
