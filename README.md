# SeaLink Gladstone — Client Schedule Portals

**v1.2**

Static, per-client schedule sites (Australian Pacific LNG, Gladstone LNG,
Queensland Gas Company) hosted on GitHub Pages, showing upcoming vessel
trips pulled from Helm Connect plus a genuinely live vessel position map
from OnWatch VMS.

> **What changed in v1.2 —** the three Power Automate URLs that were
> hardcoded in `build.js` are now repo secrets; the `?live=true` opt-in
> gate is gone and live mode is permanent; the Refresh button no longer
> triggers a rebuild; the rebuild-triggering Power Automate flows have
> been retired and the cron cut from hourly to weekly. Separately, a
> Cloudflare Worker now serves a live `/alarm-feed` JSON endpoint for the
> physical alarm boxes — that lives outside this repo, see
> "Related: the alarm feed" below.

## How it's built

A single Node script (`build.js`) does everything at build time:

1. Fetches the Helm Connect trip CSV (`HELM_CSV_URL` / `HELM_API_KEY`)
2. Fetches current fleet positions from OnWatch VMS (`ONWATCH_API_KEY` /
   `ONWATCH_FLEET_ID`) — in parallel with the Helm fetch, not after it
3. Filters, de-dupes, sorts, and splits trips per client (see "How runs
   are filtered and assigned" below)
4. Generates one static page per client under `public/<slug>/index.html`:
   - `aplng-x9k2` — Australian Pacific LNG
   - `glng-m4p1` — Gladstone LNG
   - `qgc-z8w7` — Queensland Gas Company
5. Writes `public/positions.json` — a normalized snapshot of vessel
   positions, used as a fallback if the live map proxy is unreachable
6. Copies `favicon.png` (SEALINK wordmark, cropped square) into the build

Both external fetches (Helm and OnWatch) have a 20-second timeout — if
either API hangs, the build fails fast with a clear "timed out" error
rather than hanging indefinitely, which previously could jam the GitHub
Pages deployment queue for hours.

GitHub Actions (`.github/workflows/deploy.yml`) runs this and deploys the
`public/` folder to GitHub Pages, all in one job (checkout → Node 24 w/
npm cache → `npm ci` → `node build.js` → upload-pages-artifact →
deploy-pages). Typical run time is ~25–30s. The repo is public, so none
of this counts against any Actions-minutes quota.

**Debugging tip:** every build log includes a `Trips by vessel:` line
right after dedup, showing an exact count per vessel name as Helm spells
it. If a run you added isn't showing up on the site, check this line
first — a 0 or missing count means the trip isn't reaching the script
from Helm at all (a Helm-side issue), while a correct count alongside a
run that's still not visible points to something in the site's own logic
instead.

## How runs are filtered and assigned

Three separate matching steps happen, in order:

1. **Status filtering** — a trip is dropped if its Status field contains
   `CANCEL`, `COMPLETE`, `DRAFT`, `PENDING`, or `UNCONFIRM` (case-insensitive,
   substring match). Everything else passes through.

2. **De-duplication** — trips are de-duped on the combination of
   customer + vessel + run type + start + end + origin + destination,
   since Helm's export can contain the same trip from more than one
   underlying source.

3. **Client assignment** — each client's page only shows trips whose
   `Customer Account Name` *contains* that client's configured name
   (e.g. any row mentioning "Queensland Gas Company" goes to QGC's
   page) — a substring match, not exact, so minor variations in how
   Helm records the customer name still get picked up correctly.

**Vessel name matching is a separate, second layer**, used for the live
map and the Departed/Delayed/Arrived status badges specifically (not
for the schedule table itself, which just displays whatever Helm calls
the vessel). Helm's `Resource` field and OnWatch's `vessel_name` don't
always use identical spelling for the same vessel — e.g. Helm has
**"R.B. Trojan"**, OnWatch just has **"Trojan"**. A `VESSEL_NAME_ALIASES`
table in `build.js` maps known Helm spellings to their OnWatch
equivalent; the schedule always displays Helm's original spelling, but
live-data matching resolves through the alias first. If a vessel's map
marker or status badges ever silently stop working after Helm renames
something, this is the first place to check — the per-vessel trip count
in the build log will show the exact string Helm's actually using.

Matching against known **stops** (CP1, CP3, GL3, GL4, QC3, QC4, Marina —
see `STOPS` in `build.js`) works the same way, via an `aliases` list per
stop covering the different ways Helm's Location From/To Name text might
spell it.

**Known gap:** some Torresian runs use a stop called **"Bruce"**, which
isn't in `STOPS` and has no coordinates. Those trips still display
normally, they just can't get live Delayed/Arrived detection at that end
and will show Helm's raw status instead.

## Live data vs. rebuilds

Worth understanding before touching the trigger config, because it's the
reason the rebuild cadence is now so low:

**The pages are live independently of the build.** Both the map and the
schedule table poll Power Automate proxy flows directly from the browser,
bypassing GitHub Pages entirely. A rebuild only needs to happen when the
*code* changes — not to keep data fresh. Freshness used to depend on
rebuild frequency; it doesn't any more.

The `?live=true` opt-in gate that guarded this while it was being tested
has been removed. Live mode is the permanent default with no query
parameter needed.

The **Refresh button** on each client page no longer triggers a rebuild.
It calls `window.reloadLiveSchedule` plus a position re-poll, so one
click refreshes both the table and the map client-side.

## What triggers a rebuild

| Trigger | Mechanism | Purpose |
|---|---|---|
| `workflow_dispatch` (external) | Power Automate → GitHub REST API, `POST` with `{"ref":"main"}` | Primary — the reliable external clock |
| `schedule` (weekly) | GitHub cron `0 20 * * 0` — Sun 20:00 UTC ≈ Mon 06:00 AEST | Passive fallback only |
| `workflow_dispatch` (manual) | Actions tab | Ad hoc testing |
| `push` to `main` | Any commit | Rebuilds whenever the code changes |

GitHub's own `schedule:` cron proved unreliable at short intervals — it
silently drops most triggers under queue load (a `'10 * * * *'` schedule
was observed firing only every 4–5 hours). That can't be fixed in YAML,
so external dispatch from Power Automate is the real clock and the cron
is just a safety net.

Runs **queue** rather than cancel each other (`cancel-in-progress:
false`), which matches GitHub's own recommended Pages config — cancelling
mid-deploy was found to leave GitHub Pages' own deployment target stuck
as "in progress," blocking every subsequent deploy until manually
cleared. A `timeout-minutes: 4` safety net still kills a genuinely
hung run so it can't block the queue indefinitely.

⚠️ **Watch out:** GitHub auto-disables scheduled workflows on public
repos after **60 days with no commits**. With the cron now weekly and
the repo likely to go quiet between changes, this is a live risk — if
the weekly build silently stops, check whether the workflow has been
disabled before debugging anything else.

**If the site ever gets stuck serving stale content** despite the
Actions logs showing healthy, successful runs: this happened once,
traced to a GitHub Pages edge-cache issue (compounded by a genuine
GitHub-wide Actions+Pages outage on Aug 6, 2026) rather than anything in
this repo. The fix was toggling Pages' **Source** setting (Settings →
Pages) away from "GitHub Actions" and back, which forces a full
re-provision and clears whatever's stuck.

## Power Automate flows

Power Automate holds all Helm Connect and OnWatch credentials. Nothing
public-facing ever sees an upstream API key — only a scoped flow URL.

- **Live position proxy** — "When an HTTP request is received" → raw HTTP
  `GET` to OnWatch → Response passes the body straight through. Wired in
  as `LIVE_POSITION_PROXY_URL`. This is what makes the map genuinely live
  (~60s browser poll).
- **Helm schedule proxy** — "When an HTTP request is received" → fetches
  and parses the Helm CSV, returns JSON. Wired in as
  `HELM_SCHEDULE_PROXY_URL`. Backs the live schedule table.
- **GitHub rebuild trigger** — Recurrence → `POST` to GitHub's REST
  `workflow_dispatch` endpoint using a fine-grained PAT scoped to Actions
  read/write on this repo.

*Retired in v1.2:* the "Rebuild Scheduled Site" 10-minute recurrence and
the Refresh-button rebuild flow. `POWER_AUTOMATE_REFRESH_URL` has been
removed from `build.js` and `deploy.yml` entirely.

**Important gotchas, all learned the hard way:**

- Use the **native GitHub connector or the REST API with a PAT** when
  calling GitHub — a raw HTTP action reliably returned a 403 from
  GitHub's edge that never fully resolved. (The OnWatch-facing proxy
  flow *does* use a raw HTTP action, since that's calling OnWatch, not
  GitHub — `GET` is correct there.)
- HTTP-triggered flows must be called with **`method: 'POST'`**. A
  browser `fetch()` without it defaults to `GET` and fails *silently* —
  no error, and no entry in Power Automate's run history at all, because
  the request never starts a run. If a flow "isn't firing" and run
  history is empty, check the method first.

## Required repo secrets

Set under Settings → Secrets and variables → Actions. All are read via
`process.env` in `build.js` and passed through the workflow's `env:`
block — nothing is hardcoded in source.

- `HELM_CSV_URL`
- `HELM_API_KEY`
- `ONWATCH_API_KEY`
- `ONWATCH_FLEET_ID` — `b636ff4f-50d0-4b87-9eb2-f767c0c20d44`
- `HELM_SCHEDULE_PROXY_URL` — Power Automate, live schedule polling
- `LIVE_POSITION_PROXY_URL` — Power Automate, live position polling

Note that the two proxy URLs are necessarily baked into the generated
HTML and therefore visible in public page source. Storing them as
secrets keeps them out of git history, which is the real benefit — it
doesn't make them private at runtime. See "Next steps".

## The live vessel map

Each client page shows a Leaflet map (free OpenStreetMap tiles, no API
key) with a marker for each vessel relevant to that client's trips.

**Positions are genuinely live** — the browser polls the OnWatch proxy
flow directly every ~60 seconds, bypassing GitHub Pages entirely.
`positions.json` (baked in at build time) is only used as a fallback if
that live call fails.

**Markers:**
- A navy circle hull, with a small amber heading-arrow shown only when
  a vessel's speed is above 5 knots — no arrow at all reads as
  stopped/arrived.
- A short-code label above each marker: `GOOD` (Goodna), `BRKI`
  (Brahminy Kite), `PARA` (Parangool), `SPIR` (Capricornian Spirit),
  `JAGR` (James Grant), `TORR` (Torresian), `TROJ` (Trojan) — unmapped
  vessels fall back to showing their full name. While docked at a known
  stop, the label also shows which one (e.g. `GOOD CP1`).
- If two or more vessels are close enough on screen that labels would
  overlap, they automatically stagger onto different sides — recomputed
  fresh every refresh, not remembered between checks.
- A vessel shows **greyed out** while sitting at any known stop
  (inactive), except **Trojan**, which actually operates trips out of
  the Marina rather than idling there.
- A vessel within 200m of the Maintenance Slipway is **hidden entirely**
  — not a client-relevant location, deliberately excluded from `STOPS`.
- A vessel whose last position report is **more than 12 hours old**
  (e.g. offline over a weekend) is also hidden, rather than showing a
  frozen marker that looks live but isn't.

**Schedule status badges** (Departed / Delayed / Arrived) replace the
plain "Confirmed" badge once a run is actually due, computed fresh
client-side from the schedule's own times vs. the vessel's current
position — no history or persisted state:
- **Delayed Xmin** — past scheduled departure + 2min grace, vessel still
  at the origin stop
- **Departed** — past scheduled departure, vessel's moved off
- **Arrived** — vessel's at the destination (or scheduled arrival time
  has passed and it's at least roughly nearby — a pure geofence check
  was found to be too strict for GPS/docking imprecision, but trusting
  the clock alone was found to be too loose, wrongly marking vessels
  "Arrived" while genuinely still transiting) — shown for 10 minutes
  after scheduled arrival, then reverts to Confirmed
- Each row stops evaluating itself live once the vessel's **next**
  scheduled run begins, so a vessel returning to an earlier run's origin
  stop later (very common on a shuttle route) can't wrongly revive a
  stale Delayed badge on an already-completed run

The fleet currently includes: Brahminy Kite, Bruce, Capricornian Spirit,
Goodna, James Grant, Osprey, Parangool, Reef Quest, Torresian, Trojan
(Helm: "R.B. Trojan"). Reef Quest often sits well outside Gladstone
Harbour (near the Whitsundays); the map's default view is centred on the
harbour, so that vessel won't be visible without panning out if it ever
shows up on a client's schedule.

## Related: the alarm feed

A separate Cloudflare Worker (`floral-glade-7953`) sits in front of the
`sealinkgladstone.com` domain and serves
**`GET https://sealinkgladstone.com/alarm-feed`** — a combined live JSON
feed of fleet-wide trips and vessel positions, built for the physical
alarm boxes. Anything that isn't a worker route passes straight through
to GitHub Pages unchanged.

It is **not in this repo**, but it re-implements much of the same logic
found in `build.js`: the `VESSEL_NAME_ALIASES` table, the `STOPS`
coordinates, and the Departed/Delayed/Arrived rules including the
next-departure cap.

⚠️ **Any change to that shared logic here must be mirrored in the
worker, and vice versa.** The next-departure-cap fix has already had to
be written twice for exactly this reason.

Behavioural differences that are intentional, not drift:

| | This site | Alarm feed |
|---|---|---|
| Stale position | Hidden after **12h** | Flagged `stagnant: true` after **24h** |
| Slipway vessels | Hidden entirely | Flagged `stagnant: true`, still listed |
| Reef Quest | Shown if scheduled | Excluded entirely (`EXCLUDED_VESSELS`) |
| Arrived trips | Badge reverts after 10 min | Trip drops out after a 5 min KV-backed grace window |

The worker also carries scaffolding for a future per-client key-gated
API (`/aplng/api.json`, `/glng/api.json`, `/qgc/api.json`). That's
intentionally preserved but not wired to real data yet.

## Next steps

1. **Guard against the 60-day workflow auto-disable.** Now that the cron
   is weekly and the repo may go quiet, GitHub disabling the schedule is
   a realistic failure mode. Either a calendar reminder to check, or a
   trivial periodic commit.
2. **Server-side rate guard on the proxy flows.** The trigger URLs sit
   in public page source, so someone who extracts them could call them
   directly. Not urgent — both are read-only — but a stored last-run
   timestamp check inside each flow would close it.
3. **Coordinates for "Bruce"** so Torresian's runs to/from there can get
   live status detection.
4. **Deduplicate the shared logic** between `build.js` and the worker,
   or at minimum document the sync requirement somewhere both sides will
   see it.
5. **Parangool's missing evening runs** — confirmed to be a Helm-side
   data issue (the trips aren't present in Helm's own report output),
   not something in this site's filtering. Being chased down on the
   Helm side.
6. **Favicon** — currently a cropped "SEALINK" wordmark only (the full
   logo with "Gladstone" underneath doesn't survive being shrunk to
   tab-icon size legibly). Fine as-is; flagging in case a more
   deliberate icon design is wanted later.
