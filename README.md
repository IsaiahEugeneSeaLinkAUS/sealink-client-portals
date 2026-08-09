# SeaLink Gladstone — Client Schedule Portals

**v1.1**

Static, per-client schedule sites (Australian Pacific LNG, Gladstone LNG,
Queensland Gas Company) hosted on GitHub Pages, showing upcoming vessel
trips pulled from Helm Connect plus a genuinely live vessel position map
from OnWatch VMS.

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
either API hangs, the build now fails fast with a clear "timed out"
error rather than hanging indefinitely, which previously could jam the
GitHub Pages deployment queue for hours.

GitHub Actions (`.github/workflows/deploy.yml`) runs this and deploys the
`public/` folder to GitHub Pages, all in one job (checkout → Node 24 w/
npm cache → `npm ci` → `node build.js` → upload-pages-artifact →
deploy-pages). Typical run time is ~25–30s. The repo is public, so none
of this counts against any Actions-minutes quota.

**Debugging tip:** every build log now includes a `Trips by vessel:`
line right after dedup, showing an exact count per vessel name as Helm
spells it. If a run you added isn't showing up on the site, check this
line first — a 0 or missing count means the trip isn't reaching the
script from Helm at all (a Helm-side issue), while a correct count
alongside a run that's still not visible points to something in the
site's own logic instead.

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

## What triggers a rebuild

GitHub's own `schedule:` cron trigger turned out to be unreliable at
short intervals (was only firing every few hours in practice), so it's
now just an hourly safety net. The real cadence comes from **Power
Automate**, which calls GitHub's `repository_dispatch` API.

| Trigger | Mechanism | Purpose |
|---|---|---|
| `repository_dispatch` (`rebuild-request`) | Power Automate → GitHub connector's "Create a repository dispatch event" | Primary — fires every 10 min via a Recurrence-triggered flow, and on-demand via the client-facing Refresh button |
| `schedule` (hourly) | GitHub's native cron | Safety net only |
| `workflow_dispatch` | Manual, from the Actions tab | Ad hoc testing |
| `push` to `main` | Any commit | Rebuilds whenever the code changes |

Runs **queue** rather than cancel each other (`cancel-in-progress:
false`), which matches GitHub's own recommended Pages config — cancelling
mid-deploy was found to leave GitHub Pages' own deployment target stuck
as "in progress," blocking every subsequent deploy until manually
cleared. A `timeout-minutes: 4` safety net still kills a genuinely
hung run so it can't block the queue indefinitely.

**If the site ever gets stuck serving stale content** despite the
Actions logs showing healthy, successful runs: this happened once,
traced to a GitHub Pages edge-cache issue (compounded by a genuine
GitHub-wide Actions+Pages outage on Aug 6, 2026) rather than anything in
this repo. The fix was toggling Pages' **Source** setting (Settings →
Pages) away from "GitHub Actions" and back, which forces a full
re-provision and clears whatever's stuck.

Three Power Automate flows exist:

- **"Rebuild Scheduled Site"** — Recurrence (every 10 min) → GitHub
  connector, event name `rebuild-request`. The main clock.
- **Refresh-button flow** — "When an HTTP request is received" → same
  GitHub connector action, same event name. Its URL is wired into
  `build.js` as `POWER_AUTOMATE_REFRESH_URL`, called fire-and-forget
  when someone clicks Refresh on a client page. A 90-second client-side
  cooldown limits how often it can fire.
- **Live position proxy** — "When an HTTP request is received" → a raw
  HTTP `GET` to OnWatch → Response passes the body straight through.
  Its URL is wired into `build.js` as `LIVE_POSITION_PROXY_URL`. This is
  what makes the map genuinely live (~60s browser poll, bypassing
  GitHub Pages entirely) rather than only as fresh as the last rebuild.

**Important:** the two GitHub-triggering flows use the native GitHub
connector, not a raw HTTP action — the raw HTTP action reliably returned
a 403 from GitHub's edge that never fully resolved. The OnWatch-facing
proxy flow does use a raw HTTP action, since that's calling OnWatch, not
GitHub — GET is correct there. The two GitHub-triggering flows must
POST (matching what their triggers expect); the client-side `fetch()`
calls were originally missing `method: 'POST'` and defaulted to GET,
which silently fails with no error visible in Power Automate's run
history at all (the request never even starts a run).

## Required repo secrets

Set under Settings → Secrets and variables → Actions:

- `HELM_CSV_URL`
- `HELM_API_KEY`
- `ONWATCH_API_KEY`
- `ONWATCH_FLEET_ID` — `b636ff4f-50d0-4b87-9eb2-f767c0c20d44`

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

## Next steps

1. **Server-side guard on the Refresh button flow.** The 90-second
   cooldown is client-side only — the trigger URL sits in public page
   source, so someone who extracts it could call it directly, bypassing
   the cooldown. Not urgent (worst case is a wasted Actions run), but if
   it matters, the fix is a check inside the flow itself (e.g. a stored
   last-run timestamp) that skips the GitHub call if triggered too
   recently.
2. **Parangool's missing evening runs** — confirmed to be a Helm-side
   data issue (the trips aren't present in Helm's own report output),
   not something in this site's filtering. Being chased down on the
   Helm side.
3. **Favicon** — currently a cropped "SEALINK" wordmark only (the full
   logo with "Gladstone" underneath doesn't survive being shrunk to
   tab-icon size legibly). Fine as-is; flagging in case a more
   deliberate icon design is wanted later.
