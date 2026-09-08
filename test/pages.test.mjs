// Every page goes through page() in brand.js, so every page gets the same
// masthead and the same way back. This asserts that, because a page that
// renders its own shell is how navigation quietly goes missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { page } from '../src/brand.js';
import { parseCsv } from '../src/helm.js';
import { buildLegs, scopeLegs } from '../src/trips/transform.js';
import { renderDaily } from '../src/trips/page.js';
import { renderLogin } from '../src/pages/login.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => parseCsv(readFileSync(join(here, 'fixtures', n), 'utf8'));
const scoped = scopeLegs(buildLegs(fx('trip-log-2026-09-07.csv'), fx('dispatch-2026-09-07.csv')));

const html = (res) => res.text();

test('a signed-in page carries navigation and a way home', async () => {
  const out = await html(renderDaily({
    clientId: 'qgc', day: '2026-09-07', legs: scoped.qgc,
    unattributed: scoped.unattributed, meta: { checked: new Date().toISOString() },
    session: { username: 'b.wilson', role: 'client', clientId: 'qgc' },
  }));
  assert.match(out, /class="tabs"/);
  assert.match(out, /class="home" href="\/"/);
  assert.match(out, /href="\/logout"/);
});

test('a client never sees an admin link in the navigation', async () => {
  const out = await html(renderDaily({
    clientId: 'qgc', day: '2026-09-07', legs: scoped.qgc,
    unattributed: scoped.unattributed, meta: null,
    session: { username: 'b.wilson', role: 'client', clientId: 'qgc' },
  }));
  assert.equal(/\/admin\//.test(out), false, 'no admin route may appear on a client page');
});

test('an administrator gets the admin tabs', async () => {
  const out = await html(page({
    title: 'Test', body: '<p>x</p>', session: { username: 'isaiah', role: 'admin' },
  }));
  assert.match(out, /\/admin\/accounts/);
  assert.match(out, /\/admin\/unattributed/);
});

test('the sign-in page shows no navigation', async () => {
  const out = await html(renderLogin({}));
  assert.equal(/class="tabs"/.test(out), false);
  assert.equal(/\/logout/.test(out), false);
});

test('the current tab is marked for screen readers', async () => {
  const out = await html(page({
    title: 'Test', body: '', session: { username: 'isaiah', role: 'admin' },
    current: '/admin/accounts',
  }));
  assert.match(out, /aria-current="page"/);
});

test('the masthead carries the brand tab, the operation name and Home', async () => {
  const out = await html(page({
    title: 'Test', body: '', session: { username: 'isaiah', role: 'admin' },
  }));
  assert.match(out, /src="\/logo\.png"/);
  assert.match(out, /class="opname">Gladstone/);
  assert.match(out, /class="home" href="\/"/);
});

test('the masthead is white, not navy', async () => {
  // The tab logo is navy with a transparent surround. On a navy masthead the
  // curve vanishes and controls styled for a dark bar come out invisible.
  const out = await html(page({ title: 'Test', body: '' }));
  assert.match(out, /\.masthead\{\s*background:#fff/);
});

test('brand tokens are the crew Worker values', async () => {
  const out = await html(page({ title: 'Test', body: '' }));
  for (const token of ['--navy:#1f3d7c', '--gold:#faa21b', '--ink:#172e5d', '--rule:#dde2ea']) {
    assert.ok(out.includes(token), `${token} must match the crew Worker`);
  }
});

test('home and sign-in pages have no Home button', async () => {
  const out = await html(renderLogin({}));
  assert.equal(/class="home"/.test(out), false);
});

test('pages set the security headers', async () => {
  const res = page({ title: 'Test', body: '' });
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
});
