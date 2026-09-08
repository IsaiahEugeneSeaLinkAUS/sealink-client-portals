# Setup without installing anything

Everything here is done in a browser: the Cloudflare dashboard, the D1 console
and GitHub. No Node, no wrangler, no admin rights on your laptop.

The tests run on GitHub instead of your machine, and accounts are created
through a page on the Worker instead of `tools/mkaccount.mjs`.

Use this file instead of `SETUP.md`. The two produce the same result.

---

## 1. Run the tests on GitHub

In the repo: **Add file → Create new file**. Type this exact filename, which
makes GitHub create the folders as you type:

```
.github/workflows/test.yml
```

Paste the contents of `.github/workflows/test.yml` from the zip, commit to
`main`. Then open the **Actions** tab. A run called "Tests" starts within a
few seconds. Green tick means all 24 passed.

While you are there, also create a file called `.gitignore` with these four
lines. Browser upload skipped it because Windows hides dotfiles.

```
node_modules/
.wrangler/
.dev.vars
*.log
```

## 2. Create the KV namespace

Cloudflare dashboard → **Storage & Databases → KV → Create a namespace**.
Name it `CLIENT_KV`. Copy the ID it shows.

## 3. Create the D1 database

Dashboard → **Storage & Databases → D1 SQL Database → Create**.
Name it `sealink-client-auth`. Copy the Database ID.

## 4. Apply the schema

Select the database, then the **Console** tab.

**Use `migrations/0001_init.console.sql`, not `0001_init.sql`.** The console
collapses a pasted block onto one line, which turns the first `--` comment into
a comment on everything after it, and the whole paste is then ignored. The
console version has no comments and each statement sits on a single line.

Paste and run the five statements **one at a time**, pressing Execute after
each. The console runs one query per request.

Check it worked by running:

```sql
SELECT name FROM sqlite_master WHERE type='table';
```

You want `accounts`, `auth_events` and `view_events`.

## 5. Put the four ids into wrangler.toml

In GitHub, open `wrangler.toml` and press the pencil. Replace:

- `PASTE_DISPATCH_CONFIG_ID` — the Helm config id for the dispatch report

Everything else is filled in. To find the dispatch config id: open the .pbix in
Power BI Desktop, Transform Data, select the `GLD- Dispatch1` query, Advanced
Editor, and copy the `configId=` value out of the first line.

Commit.

## 6. Create the Worker from the repo

Dashboard → **Workers & Pages → Create application**, then choose to import an
existing Git repository, and pick `sealink-gladstone-client` on branch `main`.
Cloudflare builds and deploys it, and every later push deploys automatically.

If it asks for a build command, leave it empty. There is no build step.

## 7. Set the four secrets

Dashboard → your Worker → **Settings → Variables and Secrets → Add**, type
**Secret** (not plaintext), one at a time:

| Name | Value |
|---|---|
| `HELM_API_KEY` | the same Helm bearer token the crew Worker uses |
| `SESSION_SECRET` | a long random string |
| `AUTH_PEPPER` | a different long random string |
| `SETUP_TOKEN` | a third random string, used once in step 9 |

For random strings, any password generator will do. Aim for 40 characters or
more. **Record `AUTH_PEPPER` where the crew Worker's secrets are recorded.**
Every password hash is derived from it, so if it is lost every login has to be
reissued. `SESSION_SECRET` is the opposite: changing it signs everyone out at
once, which is your emergency revocation.

## 8a. Turn on the Workers Paid plan

**Required.** The free plan caps CPU at 10 ms per request. Password hashing
alone is well past that, so sign-in would fail on the free tier, and so would
the cron that parses six thousand CSV rows.

Dashboard → **Workers & Pages → Plans → Workers Paid**, $5/month. See
`STATUS.md` for the numbers.

## 8b. Add the hostname

Your Worker → **Settings → Domains & Routes → Add custom domain** →
`client.sealinkgladstone.com`. Cloudflare creates the DNS record itself.

Check `https://client.sealinkgladstone.com/healthz`. It returns JSON listing
which bindings the running Worker can read — names and true/false only, never
values. Every one should be `true`. Any that are `false` were added after the
last deployment: redeploy from the **Deployments** tab and check again.

## 9. Create your own login

Go to:

```
https://client.sealinkgladstone.com/setup
```

Enter the `SETUP_TOKEN` from step 7, then your username, name and a password.

**That page then closes permanently.** It only answers while the accounts table
is empty, and returns "not found" afterwards. There is no way back in through
it, so if every administrator password is lost the only route is adding a row
through the D1 console.

## 10. Add the operations scheduler

Sign in, then **Accounts** on the index page. Add them as an Administrator.
That page also disables accounts, re-enables them, and sets new passwords.

## 11. Load data and check it against the PDFs

Sign in and press **Load from Helm now** on the home page. It reports what it
read and how many legs each client now holds. The cron also runs every two
hours from here on.

Then check these four things:

1. `/daily?as=qgc&day=2026-09-07` — Capricornian Spirit reads 352 passengers,
   37.75 nmi, 492.96 L, 1,301.42 kg. Matches the QGC PDF exactly.
2. `/daily?as=aplng&day=2026-09-07` — Brahminy Kite 18 legs, 175 passengers,
   57.97 nmi, 416.92 L. Goodna 21 legs, 320 passengers. Both match exactly.
3. `/daily?as=glng&day=2026-09-07` — Nancy Wake shows "not recorded" across
   fuel, distance and CO₂, because she has no OnWatch unit.
4. `/admin/unattributed` — expect a handful of legs, not hundreds, plus the
   list of ferry legs that called at QC3.

## 12. Issue the client logins

Only once step 11 looks right. **Accounts → Add someone**, role Client, and
pick their company. One login per named person, not one per company, because
the view log is what answers a question about who saw what.

Hand passwords over in person or by phone.

---

## If something goes wrong

| Symptom | Cause |
|---|---|
| `/setup` returns "not found" | An account already exists. Sign in and use Accounts instead |
| `/setup` says SETUP_TOKEN is not set | Step 7 was missed, or the Worker has not redeployed since |
| Everyone signed out at once | `SESSION_SECRET` changed |
| Every password rejected | `AUTH_PEPPER` changed or was lost |
| Pages load but are empty | The cron has not run yet |
| Error 1101 on any page | Turn on **Settings → Observability → Logs**, reproduce, and read the exception in the Logs tab |
| A client string appears on `/admin/unattributed` | Someone renamed a customer account in Helm. Add the exact new string to `ALIASES` in `src/clients.js`. Do not make the match fuzzy |
