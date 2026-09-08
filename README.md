# sealink-gladstone-client

Per-client reporting for the three Gladstone Harbour charterers, served from a
Cloudflare Worker at `client.sealinkgladstone.com`.

```
client.sealinkgladstone.com
├── /login                 username and password          open
├── /                      report index                   any session
├── /daily?day=YYYY-MM-DD  daily trip log, client-scoped  any session
├── /admin/unattributed    legs attributed to nobody      admin only
├── /admin/refresh (POST)  force a Helm pull              admin only
└── /healthz                                              open
```

Three clients: `aplng`, `qgc`, `glng`. Read `STATUS.md` before changing
anything about attribution or scoping.

## The one thing to understand

A client seeing another client's data is a commercial incident, not a bug.
Two controls, both deliberate:

**Platform.** This Worker binds exactly one KV namespace, `CLIENT_KV`. It has
no binding to `DRILLS_KV`, `CERTS_KV`, `PM_KV`, `WORK_KV`, `FORMS_KV`,
`CREW_KV` or `TASKS_KV`, so it cannot read an internal register at all. Adding
one of those bindings to `wrangler.toml` defeats the control.

**Code.** `src/clients.js` maps exact upstream strings to client ids and fails
closed. `test/segregation.test.mjs` signs in as each client and asserts it
cannot see the others. That test is the reason this repo exists.

## Data

Two Helm Connect CSV reports on a two-hourly cron: the trip log (what ran) and
dispatch (what was booked, and for whom).

Attribution is by **berth** first, then booking, then adjacency, then barge.
CP1 and CP3 are APLNG, QC3 and QC4 are QGC, GL4 is GLNG, and those are separate
pieces of infrastructure, so they attribute a leg more reliably than a booking
that may never have been made. GL3 and Marina are shared and attribute nothing.
`src/trips/transform.js` carries the profiling behind each layer.

Never attribute by vessel. Torresian ran 663 GLNG and 325 QGC legs over the
sample; Nancy Wake is covering Torresian, which is covering James Grant.

`meta:trips` records `checked` (when the source was last confirmed) separately
from `fetchedAt` (when it last changed). Conflating them makes a healthy static
day look dead.

## Setup

`SETUP.md` uses the command line. `SETUP-no-node.md` does the same thing
entirely in a browser, for a machine where Node cannot be installed.

Accounts are administered at `/admin/accounts` in either case.
`tools/mkaccount.mjs` produces identical hashes offline if you prefer.

## Tests

```
npm test
```

Fixtures are the real Helm exports for Monday 7 September 2026, so every
asserted number is checkable against the Power BI PDF for that day.
