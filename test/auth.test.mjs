// Password hashing has to work on the Workers runtime, which caps PBKDF2 at
// 100,000 iterations per call and throws above it. That throw surfaces as a
// bare "Worker threw exception" with no detail, so it is worth a test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS, PBKDF2_ROUNDS } from '../src/auth.js';

const PEPPER = 'test-pepper-value';

test('no single derivation exceeds the Workers ceiling', () => {
  assert.ok(PBKDF2_ITERATIONS <= 100000,
    'Workers throws above 100,000 iterations in one deriveBits call');
  assert.ok(PBKDF2_ITERATIONS * PBKDF2_ROUNDS >= 300000,
    'total work factor should stay well above the single-call ceiling');
});

test('a password verifies against its own hash', async () => {
  const stored = await hashPassword('correct horse battery staple', PEPPER);
  assert.equal(await verifyPassword('correct horse battery staple', stored, PEPPER), true);
});

test('a wrong password does not verify', async () => {
  const stored = await hashPassword('correct horse battery staple', PEPPER);
  assert.equal(await verifyPassword('correct horse battery stapl', stored, PEPPER), false);
  assert.equal(await verifyPassword('', stored, PEPPER), false);
});

test('the pepper is required', async () => {
  const stored = await hashPassword('a-real-password', PEPPER);
  assert.equal(await verifyPassword('a-real-password', stored, 'wrong-pepper'), false);
  assert.equal(await verifyPassword('a-real-password', stored, ''), false);
});

test('the same password hashes differently each time', async () => {
  const a = await hashPassword('same-password', PEPPER);
  const b = await hashPassword('same-password', PEPPER);
  assert.notEqual(a, b, 'salts must differ');
  assert.equal(await verifyPassword('same-password', a, PEPPER), true);
  assert.equal(await verifyPassword('same-password', b, PEPPER), true);
});

test('a malformed or empty stored hash is rejected', async () => {
  for (const bad of ['', null, undefined, 'nonsense', 'pbkdf2$100000$x$y', '$$$']) {
    assert.equal(await verifyPassword('anything', bad, PEPPER), false);
  }
});

test('the hash records its own parameters', async () => {
  const stored = await hashPassword('x'.repeat(20), PEPPER);
  const [scheme, iters] = stored.split('$');
  assert.equal(scheme, `pbkdf2r${PBKDF2_ROUNDS}`);
  assert.equal(Number(iters), PBKDF2_ITERATIONS);
});
