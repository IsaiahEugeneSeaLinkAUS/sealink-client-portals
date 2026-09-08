# STATUS — client reporting

Build state, business rules and the reason for each. Written 8 September 2026.

## Where it is

Phase 1 scaffold. Not deployed. Auth, client map, attribution transform, the
daily page and the test suite are written and green against real 7 September
2026 data. Helm config ids, KV id, D1 id and secrets are not yet filled in.

16 tests pass. `test/segregation.test.mjs` is the one that must never be
allowed to fail; if a change makes it red, the change is wrong.

## Decisions

1. **Third Worker.** `sealink-gladstone-client`, separate from
   `sealink-gladstone-crew` and `floral-glade-7953`. Different audience,
   different auth, different uptime expectation.
2. **One codebase, three scopes.** Not three deployments. Scoping is enforced
   at the binding layer as well as in code, which is what makes one codebase
   safe here.
3. **`CLIENT_KV` is the only KV binding.** The Worker has no binding to any
   internal namespace. It cannot read a compliance register even if a future
   route asks it to. Do not add one to save a fetch.
4. **Attribution is by dispatch join, never by vessel.** See below.
5. **Named accounts, not a shared per-client password.** A commercial incident
   has to be answerable with who saw what and when. `view_events` is that
   record.
6. **Scope comes from the session only.** Never from a path segment, a query
   parameter or a header. The one exception is an admin using `?as=`, which is
   checked against the session role first and logged against their username.
7. **JV is barge-only and visible to both QGC and GLNG.** Ferry activity stays
   strictly with its own client. Barge resources: Bruce, and Quandamooka while
   Bruce is on the slip.
8. **Internal runs are included** in client figures. They show where fuel goes.
9. **Crew names are shown**, matching current practice in the Power BI daily
   report.
10. **The daily PDF push continues.** A live site does not discharge the
    reporting obligation: APLNG Annex F Table 7.1 names two mailboxes every 24
    hours, and QGC/GLNG Sec IV cl.11.3 requires the monthly sent electronically.
    Power BI Desktop stays for the push.

## Business rules

### Attribution — four layers

Dispatch is what was booked and carries the client. The trip log is what the
vessel did and does not. Crews log a run whether or not it was booked, so the
trip log is the larger set and a booking join alone leaves 18% of legs
unattributed.

Applied in this order, and the layer used is recorded on every leg:

| | Layer | Legs resolved |
|---|---|---|
| 1 | **Berth.** CP1 and CP3 are APLNG. QC3 and QC4 are QGC. GL4 is GLNG. | 4,608 |
| 2 | **Booking.** Trip Number joins to dispatch. | 986 |
| 3 | **Adjacency.** A repositioning leg between shared berths belongs to what the same vessel was doing either side of it, within six hours. | 276 |
| 4 | **Barge.** By resource. Bruce, and Quandamooka while Bruce is on the slip. | 214 |
| | Unattributed | **17 (0.28%)** |

The 17 carry zero passengers and five litres of fuel between them.

**GL3 and Marina are shared and attribute nothing.** GL3 saw 730 GLNG
departures and 486 QGC departures over the sample. Reading GL3 as GLNG on the
strength of the name would misattribute roughly two thousand QGC legs.

**Layers 1 and 2 agreed on 3,987 of 3,987 legs where both fired, with zero
disagreements.** That agreement is kept as a standing check rather than being
consumed: if a berth and a booking ever disagree, neither is trusted and the
leg is surfaced. A disagreement means a berth changed hands or a booking is
against the wrong vessel, and both are worth knowing about.

**Attribution must never be by vessel.** Torresian ran 663 GLNG legs and 325
QGC legs over the sample. Nancy Wake is a temporary fill-in covering Torresian,
which is covering James Grant, and also runs overages in busy periods. A vessel
fallback would follow none of that.

**A leg between two clients' berths is a conflict, not a coin toss.** QC4 to
GL4 and back accounts for 120 of the 122 such legs, and all 120 are the barge.
The remaining two fall to the booking.

### Three services, not one

`service` on every leg is `ferry`, `shipping` or `jv`. The client daily report
shows **ferry only**, and states on the page how many shipping and barge
movements ran that day so their absence is visible rather than silent.

**R.B. Trojan is QGC shipping.** Agent-booked surveyor, off-signer, shore leave
and bunker attendance work, invoiced on a separate internal report. 179 of her
221 legs over the sample touched QC3 and she carried no ferry service at all;
her three legs on a ferry berth were touch-and-goes in preparation for cover
and one engineer run to a breakdown. She is classified, not deleted, so the
cover case is visible when it happens.

**100 ferry legs called at QC3 and are NOT reclassified.** 62 Parangool and 38
Torresian, all attributed to QGC, mostly late-night single-passenger extra
runs — surveyors and agents. They are counted as ferry service today and the
Power BI daily counts them the same way, so moving them would change a client's
reported figures on a judgement nobody has made. They carry a `shippingBerth`
flag and are listed on `/admin/unattributed` instead. Two reasons to settle it:

1. If they are billed on the shipping report as well, QGC is being shown the
   same activity twice under two arrangements.
2. Shipping-related transfers are one of the eight cl.2.3(b) categories that
   sit **outside** the 20-trip allowance, so every one of them currently
   inflating the extra-run count is inflating it wrongly. QC3 is the closest
   thing to a machine-readable reason code in the data today, and it feeds
   action A-03 directly.

### Archived records

Helm stamps `Archived` with a datetime when a record is withdrawn. An archived
leg is a correction, not activity, and is dropped. The Power BI model does the
same with `[Archived] = ""`.

### Fail closed

`src/clients.js` maps exact upstream strings to client ids and exact berth
names to clients. An unrecognised value belongs to nobody and is reported on
`/admin/unattributed`. There is no default branch that shows data.

### Absent is not zero

A figure Helm did not record renders as "not recorded", never as a blank or a
zero. Vessel totals sum only the legs that carry a figure and say so.

## Reconciliation against the Power BI PDFs for 7 September 2026

| Vessel | This build | PDF |
|---|---|---|
| Brahminy Kite | 18 legs, 175 pax, 57.97 nmi, 416.92 L, 1,100.66 kg | identical |
| Goodna | 21 legs, 320 pax, 61.07 nmi, 474.09 L, 1,251.61 kg | identical |
| Capricornian Spirit | 352 pax, 37.75 nmi, 492.96 L, 1,301.42 kg | identical |
| Parangool | 107 pax, 42.43 nmi, 293.48 L, 774.82 kg | identical |
| Nancy Wake | 12 legs, 142 pax, no telemetry | identical |
| Torresian | 23 legs, 94 pax | 19 legs, 79 pax |

**The Torresian gap is the one open reconciliation item.** Four legs this build
keeps and the PDF does not: three that begin and end at GL3 (05:20, 05:25,
16:40) and the 16:25 Marina to GL3 that precedes one of them. They carry the
15 passenger difference. Either the PDF is filtering same-berth hops somewhere
I have not found, or those legs are duplicates the Power BI dedup steps remove.
Worth settling before go-live, because 5 passengers on a GL3-to-GL3 hop is
either a real transfer or a data entry artefact, and the answer changes the
passenger count.

## Known data faults, at source

These are Helm capture gaps, not display bugs. They should be fixed upstream.

1. **Nancy Wake records no fuel, distance, efficiency or CO₂ at all.** 722 of
   722 legs blank across the whole export, from 5 July onward. GLNG has
   therefore never received a fuel or emissions figure for one of its two
   ferries, and its daily totals read as roughly a third of the other clients'
   because half the vessel activity is missing from the numbers. **Highest
   priority item on this list.**
2. R.B. Trojan (221 of 221) and Bruce (214 of 214) likewise record no fuel or
   distance. Expected for barges without the same telemetry, but confirm.
3. Capricornian Spirit is blank on 131 of 386 legs, Goodna on 96 of 1,475.
4. Crew hours in the Power BI daily do not reconcile with the start and end
   times printed beside them: differences of exactly 12 hours on several
   people, on all three reports. Deputy is the source; exposure hours feed
   every HSE frequency rate.
5. Operational hours can exceed 24 for a single day where the window crosses
   midnight and the label drops the day.

## Deliberately not on a client page yet

- **On-time performance.** The median variance on strict runs is exactly 0.0
  minutes for every vessel, which suggests actuals are recorded as scheduled
  rather than observed. Publishing a percentage built on that is publishing a
  tautology. Wait for OnWatch GPS.
- **Marine fauna.** Zero records across ~2,000 legs. Once the field feeds a
  client page, zero becomes a reported position.
- **Extra runs against allowance.** Threshold is 15 where the contract says 20
  per COMPANY, eight exempt categories are being counted, and no allowance
  exists in the APLNG contract at all. Extra runs are *labelled* on the trip
  table, which is factual; the allowance position is not shown.
- **HSSE.** Blocked on SafeConnect. Build the slot, leave it stated as
  unavailable rather than absent.
- **Certificates and any compliance register.** Not in scope.

## Presentation

`src/brand.js` carries the same tokens and the same masthead CSS as the crew
Worker, copied rather than reimplemented, so the two sites read as one system.
`src/logo.png` and `src/favicon.png` are the same assets and are served ungated
at `/logo.png` and `/favicon.png`, because the sign-in page shows the logo
before anyone has signed in and browsers request the favicon without a cookie.

**The masthead is white, not navy.** The tab logo is brand navy on a
transparent surround, so on a navy bar the curve disappears and only the
wordmark shows. A control styled for a dark bar comes out white on white:
present, correctly unhidden, and invisible. That has happened once on the crew
build. `test/pages.test.mjs` asserts the background.

Navigation: the masthead carries a Home button on every page except the landing
page and sign-in, which have nowhere to go. A tab row sits under it, scoped by
role, and one test asserts no `/admin/` route ever appears in a client page.

## Refreshing

`POST /admin/refresh`, administrators only, rendered as a page rather than JSON
so it says what it did. The cron still runs every two hours.

Three rules, all tested:

1. **The button is on the home page in every state**, including "nothing loaded
   yet". A refresh control that only appears once there is data to refresh is
   missing exactly when it is needed.
2. **A failed or empty pull keeps the previous data.** An empty Helm response
   and a genuinely quiet day are the same shape, and a client page reading "no
   runs today" because a fetch failed is worse than one showing yesterday's
   figures under a stale stamp.
3. **A failed pull does not update `checked`.** It records `lastError` and
   leaves the old confirmation time, so the page cannot claim to be current.

The home page distinguishes four states: never loaded, last pull failed, older
than three hours, and current. Each says which it is and offers the button.

## Runtime constraints worth knowing

**Workers caps PBKDF2 at 100,000 iterations per `deriveBits` call** and throws
above it. The throw surfaces as a bare 1101 "Worker threw exception" with no
detail, which cost a deploy to find. `src/auth.js` therefore runs three chained
derivations of 100,000, for 300,000 iterations of work, and `test/auth.test.mjs`
asserts the ceiling so it cannot regress. `tools/mkaccount.mjs` matches exactly.

The stronger protection is the pepper: it lives in Cloudflare as a secret and
never touches D1, so a stolen accounts table cannot be attacked offline at all.

**The Workers Paid plan is required.** The free plan allows 10 ms of CPU per
request. Three chained PBKDF2 rounds are on the order of a hundred milliseconds
on their own, and the cron parses roughly 11,000 CSV rows across two reports
and runs the attribution over them. Both are well past 10 ms, so sign-in and
the refresh would both fail on the free tier. Paid is $5/month and raises the
per-request ceiling to 30 seconds by default.

**Secrets bind at deploy time.** A secret added in the dashboard after the last
deployment is invisible to the running Worker until a new one goes out.
`/healthz` reports which bindings are readable, names and true/false only.

## Open

1. Helm report config ids for the trip log and dispatch exports.
2. Confirm Quandamooka's exact resource string in Helm before it enters service.
3. Free-text leak: `Comment` and `Comments to Crew` are passed through and can
   name another client. Row scoping cannot catch that. Needs a review flag.
4. The Torresian GL3-to-GL3 reconciliation above.
5. Whether the 100 QC3 ferry legs are ferry service or shipping work.
6. Trojan cover: she fills in occasionally, and when she does those legs should
   move from shipping to ferry. Nothing in the sample needed it, so no rule is
   written. Revisit when a real cover run appears.
5. `sealinkgladstone.com/aplng-x9k2/` is live behind an unguessable URL. Fold
   in or retire at cutover.
6. Date range cap for client users. Currently unbounded.
7. The crew Worker builds pages from `.html` files with `withBrand()`
   substitution; this one builds them in JS. The tokens and the masthead CSS
   are identical, but a change to either needs making twice. Worth unifying if
   a third Worker ever appears.
