// The refresh control must be reachable in the state where it matters most:
// nothing loaded yet. A control hidden behind a section that only renders once
// data exists is missing exactly when it is needed. That has happened before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHome } from '../src/pages/home.js';
import { refreshAll } from '../src/store.js';

function fakeKV(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(k, type) {
      if (data[k] === undefined) return null;
      return type === 'json' ? JSON.parse(data[k]) : data[k];
    },
    async put(k, v) { data[k] = v; },
  };
}

const admin = { username: 'isaiah', role: 'admin' };
const client = { username: 'b.wilson', role: 'client', clientId: 'qgc' };
const body = async (res) => res.text();

test('the refresh button is present when nothing has ever loaded', async () => {
  const out = await body(await renderHome({ CLIENT_KV: fakeKV() }, admin));
  assert.match(out, /action="\/admin\/refresh"/);
  assert.match(out, /Nothing has been loaded from Helm yet/);
});

test('the refresh button is still present once data exists', async () => {
  const kv = fakeKV({ 'meta:trips': JSON.stringify({ checked: new Date().toISOString(), counts: {} }) });
  const out = await body(await renderHome({ CLIENT_KV: kv }, admin));
  assert.match(out, /action="\/admin\/refresh"/);
});

test('a failed pull is shown, with the previous stamp and a retry', async () => {
  const kv = fakeKV({ 'meta:trips': JSON.stringify({
    checked: '2026-09-08T01:00:00.000Z', lastError: 'Helm report x returned 401', counts: {},
  }) });
  const out = await body(await renderHome({ CLIENT_KV: kv }, admin));
  assert.match(out, /The last pull failed/);
  assert.match(out, /401/);
  assert.match(out, /Try again/);
});

test('stale data says so rather than looking current', async () => {
  const kv = fakeKV({ 'meta:trips': JSON.stringify({
    checked: new Date(Date.now() - 5 * 3600_000).toISOString(), counts: {},
  }) });
  const out = await body(await renderHome({ CLIENT_KV: kv }, admin));
  assert.match(out, /more than three hours old/);
});

test('a client never sees the refresh control', async () => {
  const kv = fakeKV({ 'meta:trips': JSON.stringify({ checked: new Date().toISOString(), counts: {} }) });
  const out = await body(await renderHome({ CLIENT_KV: kv }, client));
  assert.equal(/admin\/refresh/.test(out), false);
  assert.equal(/\/admin\//.test(out), false);
});

test('a failed fetch keeps the previous data instead of blanking it', async () => {
  const kv = fakeKV({ 'legs:qgc': JSON.stringify([{ resource: 'Parangool' }]) });
  const env = {
    CLIENT_KV: kv,
    HELM_CSV_URL: 'https://example.invalid/{configId}',
    HELM_TRIPLOG_CONFIG_ID: 'a', HELM_DISPATCH_CONFIG_ID: 'b', HELM_API_KEY: 'x',
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const r = await refreshAll(env);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length);
    assert.deepEqual(JSON.parse(kv.data['legs:qgc']), [{ resource: 'Parangool' }],
      'existing legs must survive a failed pull');
  } finally { globalThis.fetch = originalFetch; }
});

test('an empty Helm response does not blank the registers', async () => {
  const kv = fakeKV({ 'legs:qgc': JSON.stringify([{ resource: 'Parangool' }]) });
  const env = {
    CLIENT_KV: kv,
    HELM_CSV_URL: 'https://example.invalid/{configId}',
    HELM_TRIPLOG_CONFIG_ID: 'a', HELM_DISPATCH_CONFIG_ID: 'b', HELM_API_KEY: 'x',
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 200 });
  try {
    const r = await refreshAll(env);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /no rows/);
    assert.deepEqual(JSON.parse(kv.data['legs:qgc']), [{ resource: 'Parangool' }]);
    const meta = JSON.parse(kv.data['meta:trips']);
    assert.ok(meta.lastError, 'the failure is recorded, not swallowed');
    assert.equal(meta.checked, null, 'a failed pull does not count as confirmed');
  } finally { globalThis.fetch = originalFetch; }
});
