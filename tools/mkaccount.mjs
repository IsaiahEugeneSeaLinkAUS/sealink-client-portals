// Generate the SQL to create one account. Run locally; paste the output into
// `wrangler d1 execute`. Passwords are never stored or logged by this script.
//
//   node tools/mkaccount.mjs <username> "<display name>" <client|admin> [clientId]
//
// It prompts for the password and needs AUTH_PEPPER in the environment, the
// same value you set with `wrangler secret put AUTH_PEPPER`.

import { createInterface } from 'node:readline/promises';
import { webcrypto as crypto } from 'node:crypto';

const [username, displayName, role, clientId] = process.argv.slice(2);
if (!username || !displayName || !role) {
  console.error('usage: node tools/mkaccount.mjs <username> "<display name>" <client|admin> [clientId]');
  process.exit(1);
}
if (role === 'client' && !['aplng', 'qgc', 'glng'].includes(clientId)) {
  console.error('a client account needs a clientId of aplng, qgc or glng');
  process.exit(1);
}
const pepper = process.env.AUTH_PEPPER;
if (!pepper) { console.error('set AUTH_PEPPER first'); process.exit(1); }

const rl = createInterface({ input: process.stdin, output: process.stderr });
const password = await rl.question('Password: ');
const again = await rl.question('Again: ');
rl.close();
if (password !== again) { console.error('passwords did not match'); process.exit(1); }
if (password.length < 12) { console.error('use at least 12 characters'); process.exit(1); }

const enc = new TextEncoder();
const b64url = (b) => Buffer.from(b).toString('base64url');
// Must match src/auth.js exactly. Workers caps PBKDF2 at 100,000 iterations
// per call, so the derivation runs three times, chained.
const ITERATIONS = 100000;
const ROUNDS = 3;
const salt = crypto.getRandomValues(new Uint8Array(16));
let material = enc.encode(password + pepper);
let bits;
for (let i = 0; i < ROUNDS; i++) {
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  material = new Uint8Array(bits);
}
const hash = `pbkdf2r${ROUNDS}$${ITERATIONS}$${b64url(salt)}$${b64url(bits)}`;

const esc = (s) => String(s).replace(/'/g, "''");
console.log(`INSERT INTO accounts (username, display_name, role, client_id, password_hash, disabled, created_at, created_by)
VALUES ('${esc(username.toLowerCase())}', '${esc(displayName)}', '${esc(role)}', ${role === 'admin' ? 'NULL' : `'${esc(clientId)}'`}, '${hash}', 0, '${new Date().toISOString()}', 'setup');`);
