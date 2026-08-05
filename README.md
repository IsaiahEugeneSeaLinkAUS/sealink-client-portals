# SeaLink Gladstone — Client Schedule Portals

Static, per-client schedule sites (Australian Pacific LNG, Gladstone LNG,
Queensland Gas Company) hosted on GitHub Pages, showing upcoming vessel
trips pulled from Helm Connect plus a live-ish vessel position map from
OnWatch VMS.

## How it's built

A single Node script (`build.js`) does everything at build time:

1. Fetches the Helm Connect trip CSV (`HELM_CSV_URL` / `HELM_API_KEY`)
2. Fetches current fleet positions from OnWatch VMS (`ONWATCH_API_KEY` /
   `ONWATCH_FLEET_ID`) — in parallel with the Helm fetch, not after it
3. Filters out cancelled/completed/draft trips, de-dupes, sorts
   chronologically
4. Generates one static page per client under `public/<slug>/index.html`:
   - `aplng-x9k2` — Australian Pacific LNG
   - `glng-m4p1` — Gladstone LNG
   - `qgc-z8w7` — Queensland Gas Company
5. Writes `public/positions.json` — a normalized snapshot of vessel
   positions, used as the fallback/initial data source for the map
6. Copies `favicon.png` (SEALINK wordmark, cropped square) into the build

GitHub Actions (`.github/workflows/deploy.yml`) runs this and deploys the
`public/` folder to GitHub Pages, all in one job (checkout → Node 24 w/
npm cache → `npm ci` → `node build.js` → upload-pages-artifact →
deploy-pages). Typical run time is ~25–30s.

## What triggers a rebuild

GitHub's own `schedule:` cron trigger turned out to be unreliable at
short intervals (was only firing every few hours in practice), so it's
now just an hourly safety net. The real cadence comes from **Power
Automate**, which calls GitHub's `repository_dispatch` API — this is
more reliable and sidesteps that flakiness entirely.

| Trigger | Mechanism | Purpose |
|---|---|---|
| `repository_dispatch` (`rebuild-request`) | Power Automate → GitHub connector's "Create a repository dispatch event" | Primary — fires every 10 min via a Recurrence-triggered flow, and on-demand via the client-facing Refresh button |
| `schedule` (hourly) | GitHub's native cron | Safety net only |
| `workflow_dispatch` | Manual, from the Actions tab | Ad hoc testing |
| `push` to `main` | Any commit | Rebuilds whenever the code changes |

Two Power Automate flows exist for this:

- **"Rebuild Scheduled Site"** — Recurrence (every 10 min) → GitHub
  connector, event name `rebuild-request`. This is the main clock.
- **Refresh-button flow** — "When an HTTP request is received" → same
  GitHub connector action, same event name. Its HTTP POST URL is wired
  into `build.js` as `POWER_AUTOMATE_REFRESH_URL`, called fire-and-forget
  (`mode: 'no-cors'`) when someone clicks the Refresh button on a client
  page. A 90-second client-side cooldown stops rapid re-clicks from
  spamming it or cancelling an in-flight GitHub build.

**Important:** both flows call the GitHub connector, not a raw HTTP
action — the raw HTTP action reliably returned a 403 from GitHub's edge
("administrative rules") that never fully resolved, even with all the
right headers set. The native GitHub connector avoids that class of
problem entirely, since it authenticates via a proper OAuth connection
rather than manually-set headers.

## Required repo secrets

Set under Settings → Secrets and variables → Actions:

- `HELM_CSV_URL`
- `HELM_API_KEY`
- `ONWATCH_API_KEY`
- `ONWATCH_FLEET_ID` — `b636ff4f-50d0-4b87-9eb2-f767c0c20d44`

## The live vessel map

Each client page shows a Leaflet map (free OpenStreetMap tiles, no API
key) with markers for whichever vessels are relevant to that client's
trips — matched by name against OnWatch's `vessel_name`, case- and
whitespace-insensitively so a small naming difference between Helm and
OnWatch doesn't silently drop a vessel.

The fleet currently includes: Brahminy Kite, Bruce, Capricornian Spirit,
Goodna, James Grant, Osprey, Parangool, Reef Quest, Torresian, Trojan.
Note — Reef Quest often sits well outside Gladstone Harbour (near the
Whitsundays); the map's default view is centred on Gladstone
(`-23.83, 151.25`, zoom 11), so that vessel won't be visible without
panning out if it ever shows up on a client's schedule.

**Current freshness:** positions come from `positions.json`, baked in at
build time — so as fresh as the last rebuild (~10 min via Power
Automate, or immediately after a manual Refresh click).

## Next steps

1. **Wire up truly live positions.** `build.js` already has a
   `LIVE_POSITION_PROXY_URL` placeholder and the client-side code to use
   it — currently blank, so the map falls back to the static snapshot.
   To finish this:
   - Build a third Power Automate flow: "When an HTTP request is
     received" → a raw HTTP `GET` action calling
     `https://api.onwatchvms.com/v1/fleets/b636ff4f-50d0-4b87-9eb2-f767c0c20d44/position?time_zone=Australia/Brisbane`
     with the OnWatch Bearer key → a Response action passing that body
     straight through.
   - Paste its trigger URL into `LIVE_POSITION_PROXY_URL` in `build.js`.
   - **Untested unknown:** whether a browser can actually read the
     response back from that flow (Power Automate's CORS behaviour on
     HTTP triggers is inconsistently documented). If it's blocked, the
     client code already fails gracefully back to the static snapshot —
     nothing breaks either way, but the map won't go live until this is
     confirmed working.

2. **Consider a server-side guard on the Refresh button flow.** The
   90-second cooldown is client-side only — it stops accidental
   spam-clicking, but the trigger URL sits in public page source, so
   someone who extracts it could call it directly, bypassing the
   cooldown. Not an urgent risk (worst case is a wasted GitHub Actions
   run), but if it matters, the fix is a check inside the flow itself
   (e.g. a stored last-run timestamp) that skips the GitHub call if
   triggered too recently.

3. **Public vs private repo decision, still open.** Affects whether the
   hourly safety-net schedule (and any Actions usage generally) is free
   (public repo) or counts against the 2,000 free minutes/month
   (private repo).

4. **Favicon** — currently a cropped "SEALINK" wordmark only (the full
   logo with "Gladstone" underneath doesn't survive being shrunk to tab-icon
   size legibly). Fine as-is; flagging in case a more deliberate icon
   design is wanted later.
