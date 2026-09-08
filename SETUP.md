# Setup — step by step

Everything below is done once. Steps 1–4 are the repo, 5–11 are Cloudflare,
12–14 are accounts, 15–16 are go-live. Nothing here touches the crew Worker.

Times are rough. The whole thing is about ninety minutes if the Helm report
config ids are to hand.

---

## Repo

### 1. Create the private repo

On GitHub, under your account, **New repository**:

- Name: `sealink-gladstone-client`
- Visibility: **Private**
- Do not add a README, .gitignore or licence — this zip has them.

### 2. Push this code

From the unzipped folder:

```bash
cd sealink-gladstone-client
git init
git add .
git commit -m "Client reporting scaffold: auth, client map, dispatch join, segregation tests"
git branch -M main
git remote add origin https://github.com/IsaiahEugeneSeaLinkAUS/sealink-gladstone-client.git
git push -u origin main
```

### 3. Install and run the tests

```bash
npm install
npm test
```

Expect **16 passing**. If `segregation.test.mjs` is red at any point from here
on, stop and fix it before doing anything else.

### 4. Add a branch protection rule (optional, recommended)

Settings → Branches → Add rule for `main` → require status checks to pass.
Once Workers Builds is connected in step 11 it will report as a check, so a
red segregation test blocks the deploy rather than shipping it.

---

## Cloudflare

### 5. Create the KV namespace

Dashboard → Storage & Databases → KV → **Create a namespace**.

- Name: `CLIENT_KV`

Copy the ID into `wrangler.toml`. The existing value is
`bfe5da5ff6474e9f9e64605d63c8ab95`.

Or from the CLI:

```bash
npx wrangler kv namespace create CLIENT_KV
```

### 6. Create the D1 database

```bash
npx wrangler d1 create sealink-client-auth
```

Copy the `database_id` into `wrangler.toml`. The existing value is
`5ee58624-66e5-4066-be4c-c748085a899e`.

### 7. Apply the schema

```bash
npx wrangler d1 execute sealink-client-auth --remote --file=./migrations/0001_init.sql
```

Check it took:

```bash
npx wrangler d1 execute sealink-client-auth --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table';"
```

You should see `accounts`, `auth_events`, `view_events`.

### 8. Turn on the Workers Paid plan (required, not optional)

**This is required, not a nice-to-have.** The free plan caps CPU at 10 ms per
request. Password hashing alone is well past that, so sign-in would fail, and
so would the cron that parses six thousand CSV rows. $5/month.
Dashboard → Workers & Pages → Plans.

### 9. Fill in the dispatch report config id

In `wrangler.toml`, replace `PASTE_DISPATCH_CONFIG_ID`. Find it in Power BI
Desktop: Transform Data, select the `GLD- Dispatch1` query, Advanced Editor,
and copy the `configId=` value from the first line.

The trip log id and the URL pattern are already set, taken from the working
`GLD- Trip Log` query. Commit and push.

### 10. Set the secrets

Three, none of which go in `wrangler.toml`:

```bash
npx wrangler secret put HELM_API_KEY
# paste the same Helm bearer token the crew Worker uses

openssl rand -base64 48        # copy the output
npx wrangler secret put SESSION_SECRET

openssl rand -base64 48        # copy a DIFFERENT output
npx wrangler secret put AUTH_PEPPER
```

**Keep `AUTH_PEPPER` somewhere you will not lose it.** Every password hash is
derived with it. If it changes, every client login stops working and each one
has to be reissued. Put it in the same place the crew Worker's secrets are
recorded.

`SESSION_SECRET` is the opposite: rotating it signs everyone out immediately,
which is your emergency revocation.

### 11. First deploy, then connect push-to-deploy

Deploy once by hand so you can see it work:

```bash
npx wrangler deploy
```

Then Dashboard → Workers & Pages → `sealink-gladstone-client` → Settings →
Builds → **Connect to Git**, pick the repo, branch `main`. Same as the crew
Worker.

### 12. Point the hostname at it

Dashboard → Workers & Pages → `sealink-gladstone-client` → Settings → Domains
& Routes → **Add custom domain** → `client.sealinkgladstone.com`.

Cloudflare creates the DNS record itself because the zone is already on the
account. The route in `wrangler.toml` covers the same ground; the custom domain
is what issues the certificate.

Check `https://client.sealinkgladstone.com/healthz`. It lists which bindings
the running Worker can read, names and true/false only. Any `false` was added
after the last deployment and needs a redeploy to take effect.

---

## Accounts

### 13. Create the two admin accounts

Yourself and the operations scheduler. From the repo folder, with the same
`AUTH_PEPPER` value in your shell:

```bash
export AUTH_PEPPER='the value from step 10'

node tools/mkaccount.mjs isaiah "Isaiah Eugene" admin
```

It asks for a password twice and prints one `INSERT` statement. Run it:

```bash
npx wrangler d1 execute sealink-client-auth --remote --command="<paste the INSERT>"
```

Repeat for the scheduler. Admin accounts have no client scope, so they see the
index and `/admin/unattributed`, and can view a client page with `?as=` — which
is written to the view log against their username.

### 14. Do not create client accounts yet

Sign in as yourself first and work through step 15. Client logins are the last
thing to issue, not the first.

---

## Before anyone outside SeaLink signs in

### 15. Load real data and check it against the PDF

Sign in and press **Load from Helm now** on the home page. Then:

1. Open `/daily?as=qgc&day=2026-09-07`. Capricornian Spirit should read
   352 passengers, 37.75 nmi, 492.96 L, 1,301.42 kg. Those match the QGC PDF
   exactly.
2. Open `/daily?as=aplng&day=2026-09-07`. Goodna matches its PDF line exactly.
   **Brahminy Kite will not** — it shows 16 legs and 174 passengers against the
   PDF's 18 and 175, and the two missing legs appear under "Not included above".
   That difference is the build working correctly, not a fault. Read
   `STATUS.md` §Attribution.
3. Open `/admin/unattributed`. Expect roughly 900 legs fleet-wide. Every one is
   client activity nobody is being credited with.
4. Open `/daily?as=glng&day=2026-09-07`. Nancy Wake shows "not recorded" across
   fuel, distance and CO₂. That is a real Helm gap, not a rendering bug, and it
   is the first thing to fix at source.

### 16. Issue client logins

Only once you are satisfied with what each page shows. One account per named
person, not one per company:

```bash
node tools/mkaccount.mjs b.wilson "Bruce Wilson" client qgc
node tools/mkaccount.mjs m.dcruz "Melvin D'Cruz" client glng
node tools/mkaccount.mjs r.mitchell "Rob Mitchell" client aplng
```

Hand the password over in person or by phone, not by email. To revoke:

```bash
npx wrangler d1 execute sealink-client-auth --remote \
  --command="UPDATE accounts SET disabled=1 WHERE username='b.wilson';"
```

To see who has looked at what:

```bash
npx wrangler d1 execute sealink-client-auth --remote \
  --command="SELECT at, username, client_id, path, day FROM view_events ORDER BY at DESC LIMIT 50;"
```

---

## If something goes wrong

| Symptom | Cause |
|---|---|
| Everyone signed out at once | `SESSION_SECRET` changed |
| Every password rejected | `AUTH_PEPPER` changed or was lost |
| Pages load but are empty | The cron has not run; POST `/admin/refresh` |
| Error 1101 on any page | Turn on **Settings → Observability → Logs**, reproduce, and read the exception in the Logs tab |
| A client string appears on `/admin/unattributed` | Someone renamed a customer account in Helm. Add the exact new string to `ALIASES` in `src/clients.js`. Do not make the match fuzzy |
| `wrangler deploy` cannot find the zone | The custom domain in step 12 was not added |
