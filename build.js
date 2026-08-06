const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// fetch() has no default timeout - a hung external API (Helm or OnWatch)
// would previously hang the whole build indefinitely, which under
// cancel-in-progress:false queues every subsequent trigger behind it,
// eventually causing GitHub Pages itself to start cancelling the backlog
// ("higher priority waiting request" errors). This makes a hang fail fast
// and loudly instead, so it never gets the chance to jam the queue.
const FETCH_TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 1. ENVIRONMENT VARIABLES & SANITIZATION
// ---------------------------------------------------------------------------
const rawUrl = process.env.HELM_CSV_URL || '';
const CSV_URL = rawUrl.trim().replace(/^["']|["']$/g, '');
const API_KEY = (process.env.HELM_API_KEY || '').trim().replace(/^["']|["']$/g, '');

// OnWatch VMS - used for live vessel positions
const ONWATCH_API_KEY = (process.env.ONWATCH_API_KEY || '').trim();
const ONWATCH_FLEET_ID = (process.env.ONWATCH_FLEET_ID || '').trim();

if (!CSV_URL) {
  console.error('CRITICAL ERROR: HELM_CSV_URL environment variable is missing.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. CLIENT CONFIGURATION (Helm Customer Account Names & URL Slugs)
// ---------------------------------------------------------------------------
const CLIENT_CONFIG = [
  { name: 'Australian Pacific LNG', slug: 'aplng-x9k2' },
  { name: 'Gladstone LNG', slug: 'glng-m4p1' },
  { name: 'Queensland Gas Company', slug: 'qgc-z8w7' }
];

// ---------------------------------------------------------------------------
// 2b. STOP COORDINATES (for departed/delayed/arrived status + map labels)
// ---------------------------------------------------------------------------
// From OnWatch's Stops list. Maintenance Slipway, Maintenance Wharf, and
// Service Wharf deliberately excluded - not operational client stops.
// `aliases` should cover every way Helm's Location From/To Name text might
// spell this stop - matched case/whitespace-insensitively. Add more here
// if a stop ever fails to match in practice.
const STOPS = [
  { name: 'CP1', aliases: ['cp1'], lat: -23.78493, lon: 151.16916 },
  { name: 'CP3', aliases: ['cp3'], lat: -23.75329, lon: 151.17814 },
  { name: 'GL3', aliases: ['gl3'], lat: -23.82395, lon: 151.24208 },
  { name: 'GL4', aliases: ['gl4'], lat: -23.79165, lon: 151.21203 },
  { name: 'QC3', aliases: ['qc3'], lat: -23.77970, lon: 151.19851 },
  { name: 'QC4', aliases: ['qc4'], lat: -23.76711, lon: 151.18861 },
  { name: 'Marina', aliases: ['marina', 'sealink marina', 'gladstone marina'], lat: -23.82783, lon: 151.24350 }
];

// Helper to parse Helm CSV date strings as explicit Brisbane time (UTC+10)
function parseHelmDate(dateStr) {
  if (!dateStr) {
    return { isoDate: '', dateLabel: 'TBD', timeStr: 'TBD', timestamp: 0 };
  }

  const clean = String(dateStr).trim().replace('T', ' ');
  const parts = clean.split(' ');
  const isoDate = parts[0]; // YYYY-MM-DD
  const rawTime = parts[1] ? parts[1].substring(0, 5) : '00:00'; // HH:MM

  // Explicitly append +10:00 offset so JS interprets as Australia/Brisbane local time
  const isoWithOffset = `${isoDate}T${rawTime}:00+10:00`;
  const dateObj = new Date(isoWithOffset);

  let dateLabel = 'TBD';
  if (!isNaN(dateObj.getTime())) {
    dateLabel = dateObj.toLocaleDateString('en-AU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Australia/Brisbane'
    });
  }

  return {
    isoDate,
    dateLabel,
    timeStr: rawTime,
    timestamp: isNaN(dateObj.getTime()) ? 0 : dateObj.getTime()
  };
}

// ---------------------------------------------------------------------------
// ONWATCH VMS - VESSEL POSITIONS
// ---------------------------------------------------------------------------
// GET https://api.onwatchvms.com/v1/fleets/{fleet_id}/position
// Confirmed against a real sample response:
//   { "object": "list", "data": [
//       { "vessel_id", "vessel_name", "latitude", "longitude",
//         "heading": { "value", "unit" },
//         "speed_over_ground": { "value", "unit" },
//         "last_updated" }
//   ] }
// heading and speed_over_ground are nested {value, unit} objects, not bare
// numbers - everything (including those nested values) comes back null for
// a vessel with no GPS reading yet.
async function fetchOnWatchPositions() {
  if (!ONWATCH_API_KEY || !ONWATCH_FLEET_ID) {
    console.warn('ONWATCH_API_KEY or ONWATCH_FLEET_ID not set - skipping position pull.');
    return [];
  }

  const url = `https://api.onwatchvms.com/v1/fleets/${ONWATCH_FLEET_ID}/position?time_zone=Australia/Brisbane`;
  const response = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${ONWATCH_API_KEY}` }
  });

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.json();
      detail = errBody?.error?.code ? ` (${errBody.error.code}: ${errBody.error.param || ''})` : '';
    } catch (_) { /* body wasn't JSON, or was empty - ignore */ }
    throw new Error(`OnWatch VMS returned HTTP ${response.status}${detail}`);
  }

  const body = await response.json();
  return body.data || [];
}

function normalizeOnWatchPositions(rawVessels) {
  return rawVessels
    .map(v => ({
      name: v.vessel_name || v.vessel_id || 'Unknown',
      lat: v.latitude,
      lon: v.longitude,
      headingDeg: v.heading?.value,
      speedKn: v.speed_over_ground?.value,
      lastUpdated: v.last_updated
    }))
    // Vessels with no GPS reading yet report every one of these fields as
    // null - skip them rather than plotting a marker at (null, null).
    .filter(v => typeof v.lat === 'number' && typeof v.lon === 'number');
}

async function generateSites() {
  console.log('Fetching latest Helm Connect CSV...');

  const headers = {};
  if (API_KEY) {
    headers['Api-Key'] = API_KEY;
  }

  // Kick this off now and only await it once we actually need it below -
  // it's completely independent of the Helm CSV work, so there's no reason
  // to make it wait in line behind the CSV fetch/parse/processing.
  const onWatchPromise = fetchOnWatchPositions().catch(err => {
    console.error('Could not fetch OnWatch positions:', err.message);
    return [];
  });

  const response = await fetchWithTimeout(CSV_URL, { headers });
  console.log(`HTTP Fetch Status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    throw new Error(`Failed to download CSV from Helm Connect. HTTP Status: ${response.status}`);
  }

  const csvText = await response.text();

  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  console.log(`Parsed ${records.length} total rows from Helm.`);

  // ---------------------------------------------------------------------------
  // 3. FILTER OUT CANCELLED, COMPLETED, DRAFT & PENDING TRIPS
  // ---------------------------------------------------------------------------
  const filteredTrips = records.filter(row => {
    const status = String(
      row['Status'] ||
      row['Job Status'] ||
      row['Trip Status'] ||
      ''
    ).toUpperCase().trim();

    const isCancelled = status.includes('CANCEL');
    const isComplete = status.includes('COMPLETE');
    const isDraft = status.includes('DRAFT') || status.includes('PENDING') || status.includes('UNCONFIRM');

    return !isCancelled && !isComplete && !isDraft;
  });

  // ---------------------------------------------------------------------------
  // 4. DEDUPLICATE & SORT CHRONOLOGICALLY ASCENDING
  // ---------------------------------------------------------------------------
  const seenKeys = new Set();
  const validTrips = [];

  for (const row of filteredTrips) {
    const cust = (row['Customer Account Name'] || row['Customer'] || row['Account'] || '').trim();
    const vessel = (row['Resource'] || row['Vessel'] || row['Resource Name'] || row['Asset'] || '').trim();
    const type = (row['Trip Type Name'] || row['Trip Type'] || '').trim();
    const start = (row['Start'] || row['Requested Date'] || '').trim();
    const end = (row['End'] || '').trim();
    const from = (row['Location From Name'] || row['Origin'] || '').trim();
    const to = (row['Location To Name'] || row['Destination'] || '').trim();

    const dedupKey = `${cust}|${vessel}|${type}|${start}|${end}|${from}|${to}`;

    if (!seenKeys.has(dedupKey)) {
      seenKeys.add(dedupKey);
      validTrips.push(row);
    }
  }

  // Sort chronologically ascending
  validTrips.sort((a, b) => {
    const startA = parseHelmDate(a['Start'] || a['Requested Date']).timestamp;
    const startB = parseHelmDate(b['Start'] || b['Requested Date']).timestamp;
    return startA - startB;
  });

  console.log(`Deduplicated and sorted down to ${validTrips.length} upcoming confirmed trips.`);

  // ---------------------------------------------------------------------------
  // 4b. LIVE VESSEL POSITIONS (OnWatch VMS) - fetch was already kicked off
  // above, in parallel with the Helm CSV work, so this is usually an
  // instant await rather than another round trip.
  // ---------------------------------------------------------------------------
  const rawPositions = await onWatchPromise;
  const positions = normalizeOnWatchPositions(rawPositions);
  console.log(`Fetched ${positions.length} vessel position(s) from OnWatch.`);

  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  // Copy the committed favicon into the build output, if it's there.
  const faviconSrc = path.join(__dirname, 'favicon.png');
  if (fs.existsSync(faviconSrc)) {
    fs.copyFileSync(faviconSrc, path.join(publicDir, 'favicon.png'));
  } else {
    console.warn('favicon.png not found at repo root - tab icon will be broken until it is added.');
  }

  // Static positions file, served alongside the client pages on GitHub
  // Pages. No credentials in here - just the position snapshot from this
  // build run. Client pages fetch this via a relative path.
  fs.writeFileSync(
    path.join(publicDir, 'positions.json'),
    JSON.stringify({ fetchedAt: new Date().toISOString(), vessels: positions })
  );

  // Root Landing Page
  fs.writeFileSync(path.join(publicDir, 'index.html'), `
    <!DOCTYPE html>
    <html><head><title>SeaLink Gladstone Portal</title><link rel="icon" type="image/png" href="favicon.png"></head>
    <body style="font-family:sans-serif; text-align:center; padding:50px;">
      <h2>SeaLink Gladstone Operations Portal</h2>
      <p>Please use your direct client portal link to view upcoming schedules.</p>
    </body></html>
  `);

  // ---------------------------------------------------------------------------
  // 5. GENERATE INDIVIDUAL CLIENT PORTALS
  // ---------------------------------------------------------------------------
  CLIENT_CONFIG.forEach(client => {
    const clientTrips = validTrips.filter(row => {
      const customer = String(
        row['Customer Account Name'] ||
        row['Customer'] ||
        row['Account'] ||
        ''
      ).toLowerCase();

      return customer.includes(client.name.toLowerCase());
    });

    const clientDir = path.join(publicDir, client.slug);
    if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir);

    const htmlContent = generateGroupedHtmlTable(client.name, clientTrips);
    fs.writeFileSync(path.join(clientDir, 'index.html'), htmlContent);
    console.log(`Generated schedule for ${client.name} (${clientTrips.length} upcoming trips) at /${client.slug}/`);
  });
}

function formatStatus(statusStr) {
  if (!statusStr) return 'Confirmed';
  const clean = statusStr.replace(/^STATUS_/i, '');
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

function formatRunTypeHtml(runTypeStr) {
  const clean = (runTypeStr || 'Scheduled Run').trim();
  const lower = clean.toLowerCase();

  if (lower.includes('internal') || lower.includes('return')) {
    return `<em class="run-type-italic">${clean}</em>`;
  } else if (lower.includes('scheduled')) {
    return `<span class="run-type-scheduled-text">${clean}</span>`;
  } else if (lower.includes('extra')) {
    return `<span class="run-type-extra-badge">${clean}</span>`;
  } else {
    return `<span>${clean}</span>`;
  }
}

// ---------------------------------------------------------------------------
// LIVE VESSEL POSITION MAP
// ---------------------------------------------------------------------------
// Renders a Leaflet map (free tiles, no API key) that reads a static
// positions.json - generated once per build, alongside this page, by
// fetchOnWatchPositions() above. On GitHub Pages there's no server to poll
// live, so "live" here really means "as fresh as the last GitHub Actions
// run" (plus a little GitHub CDN caching) - see the workflow schedule for
// ---------------------------------------------------------------------------
// how often that is.
//
// The "Refresh" button fires the Power Automate HTTP-triggered flow that
// kicks off the same GitHub Actions rebuild - see the note in chat about
// setting POWER_AUTOMATE_REFRESH_URL below. It's a fire-and-forget POST:
// mode: 'no-cors' is used deliberately, since Power Automate's HTTP trigger
// doesn't reliably send CORS headers a browser can read, and we don't need
// to read the response anyway - we just need the request to go out.
const POWER_AUTOMATE_REFRESH_URL = 'https://defaulta34bc0aba98f4dfe94203ff8ed2844.a5.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/15/workflows/acd148e9258345fe9d06ea0c27ccbe18/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=EeYMoctJ_NBYz8naEbTZ4ocKDiJGUV-wvedCFaWkMFA';

// Optional: a second HTTP-triggered Power Automate flow that calls OnWatch
// directly and returns its raw response (see chat for the setup steps).
// When this is set, position polling bypasses the rebuild cycle entirely -
// genuinely live, bounded only by OnWatch's own ~2 min GPS reporting lag.
// Left blank, the map just falls back to whatever positions.json says.
const LIVE_POSITION_PROXY_URL = 'https://defaulta34bc0aba98f4dfe94203ff8ed2844.a5.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/23/workflows/5dcebc97cfd740069d8cf07fc5320a90/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=2vF8GXOU11kmSuoCa6bIDrNeRMw94X8A-GW0cXaPdJk';

function generateVesselMapHtml(relevantVesselNames) {
  if (relevantVesselNames.length === 0) return '';

  return `
    <div class="map-panel">
      <div class="map-panel-header">
        🛰️ Live Vessel Position
        <span class="map-header-right">
          <button id="refresh-positions-btn" class="btn-refresh-map" type="button">↻ Refresh</button>
          <span id="map-updated" class="map-updated-label">Loading…</span>
        </span>
      </div>
      <div id="vessel-map"></div>
    </div>
    <script>
      (function () {
        var relevantVessels = ${JSON.stringify(relevantVesselNames)}.map(function (n) { return n.trim().toLowerCase(); });
        var powerAutomateUrl = ${JSON.stringify(POWER_AUTOMATE_REFRESH_URL)};
        var liveProxyUrl = ${JSON.stringify(LIVE_POSITION_PROXY_URL)};
        var REFRESH_COOLDOWN_MS = 90000; // matches a realistic build+deploy time - also caps how often this can fire

        var map = L.map('vessel-map', { scrollWheelZoom: false }).setView([-23.793, 151.250], 12);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
          maxZoom: 17
        }).addTo(map);

        // Underway threshold for the heading arrow - below this, no arrow
        // shows at all (reads as stopped/arrived); above it, a single
        // small arrow rotates to match the vessel's current heading.
        var UNDERWAY_SPEED_KN = 5;
        var HULL_R = 7;
        var HULL_CY = 16;
        var CANVAS_SIZE = 28;

        function buildVesselIcon(vessel, inactive) {
          var heading = typeof vessel.headingDeg === 'number' ? vessel.headingDeg : 0;
          var underway = typeof vessel.speedKn === 'number' && vessel.speedKn > UNDERWAY_SPEED_KN;

          var arrowSvg = underway
            ? '<polygon points="16,1 20,11 16,8 12,11" fill="#d97706" stroke="#00529b" stroke-width="0.5" transform="rotate(' + heading + ' 16 ' + HULL_CY + ')"></polygon>'
            : '';

          var html =
            '<svg width="' + CANVAS_SIZE + '" height="' + CANVAS_SIZE + '" viewBox="0 0 ' + CANVAS_SIZE + ' ' + CANVAS_SIZE + '" class="' + (inactive ? 'vessel-icon-inactive' : '') + '">' +
            arrowSvg +
            '<circle cx="16" cy="' + HULL_CY + '" r="' + HULL_R + '" fill="#00529b" stroke="#fff" stroke-width="1.5"></circle>' +
            '</svg>';

          return L.divIcon({
            className: 'vessel-marker-icon',
            html: html,
            iconSize: [CANVAS_SIZE, CANVAS_SIZE],
            iconAnchor: [16, HULL_CY]
          });
        }

        // Vessels within this radius of the Maintenance Slipway are hidden
        // from the map entirely - not client-relevant, and this location
        // deliberately isn't in STOPS so it never shows as a labelled stop
        // or feeds into the departed/delayed/arrived logic.
        var MAINTENANCE_SLIPWAY = { lat: -23.83619, lon: 151.24365 };
        var HIDE_RADIUS_M = 200;

        function isInMaintenanceZone(vessel) {
          return distanceMeters(vessel.lat, vessel.lon, MAINTENANCE_SLIPWAY.lat, MAINTENANCE_SLIPWAY.lon) <= HIDE_RADIUS_M;
        }

        // Vessels sitting at the Marina are shown greyed-out (inactive),
        // except Trojan, which actually operates trips out of the Marina.
        // Greys out whenever the vessel is sitting at any known stop -
        // the same condition that puts a stop name next to its label on
        // the map. Trojan is the one exception, since it actually
        // operates trips out of the Marina rather than sitting idle there.
        function isInactiveAtStop(vessel) {
          var key = (vessel.name || '').trim().toLowerCase();
          var stopName = nearestStopName(vessel);
          if (!stopName) return false;
          if (key === 'trojan' && stopName === 'Marina') return false;
          return true;
        }

        // Short codes for the map label - falls back to the full name (as
        // given) for any vessel not in this list, so a new or unmapped
        // vessel still shows something rather than nothing.
        var VESSEL_SHORT_NAMES = {
          'goodna': 'GOOD',
          'brahminy kite': 'BRKI',
          'parangool': 'PARA',
          'capricornian spirit': 'SPIR',
          'james grant': 'JAGR',
          'torresian': 'TORR',
          'trojan': 'TROJ'
        };

        function shortNameFor(vesselName) {
          var key = (vesselName || '').trim().toLowerCase();
          return VESSEL_SHORT_NAMES[key] || vesselName;
        }

        // Stop coordinates, aliases, and the thresholds used to decide
        // whether a vessel counts as "at" a given stop right now. Same
        // list as build.js's STOPS - kept here since this all runs
        // client-side, computed against whatever time it is when the
        // browser checks, not build time.
        var STOPS = ${JSON.stringify(STOPS)};
        var STOP_BY_ALIAS = {};
        STOPS.forEach(function (stop) {
          stop.aliases.forEach(function (alias) { STOP_BY_ALIAS[alias] = stop; });
        });

        var AT_STOP_RADIUS_M = 100;
        var AT_STOP_SLOW_RADIUS_M = 150; // wider allowance when clearly stationary, to absorb GPS jitter
        var AT_STOP_SPEED_KN = 1.0;
        var DELAY_GRACE_MIN = 2;
        var ARRIVED_WINDOW_MIN = 10;
        var ARRIVED_LOOSE_RADIUS_M = 500; // generous tolerance for docking GPS imprecision, without accepting "still transiting nearby" as arrived
        var DELAY_STALE_HOURS = 3; // ignore a row's departure time if it's this far in the past - avoids flagging long-finished runs

        // Haversine distance in meters between two lat/lon points.
        function distanceMeters(lat1, lon1, lat2, lon2) {
          var R = 6371000;
          var toRad = function (d) { return d * Math.PI / 180; };
          var dLat = toRad(lat2 - lat1);
          var dLon = toRad(lon2 - lon1);
          var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
          return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }

        function isNearStop(vessel, stop) {
          if (!stop) return false;
          var d = distanceMeters(vessel.lat, vessel.lon, stop.lat, stop.lon);
          if (d <= AT_STOP_RADIUS_M) return true;
          if (typeof vessel.speedKn === 'number' && vessel.speedKn < AT_STOP_SPEED_KN && d <= AT_STOP_SLOW_RADIUS_M) return true;
          return false;
        }

        // Which known stop (if any) is this vessel currently sitting at -
        // used for the "GOOD CP1" style map label, independent of any
        // particular scheduled run.
        function nearestStopName(vessel) {
          for (var i = 0; i < STOPS.length; i++) {
            if (isNearStop(vessel, STOPS[i])) return STOPS[i].name;
          }
          return null;
        }

        var markers = {};
        var refreshBtn = document.getElementById('refresh-positions-btn');

        // Departed / Delayed / Arrived, computed fresh every check from the
        // schedule's own times vs right now - no history or persisted
        // state needed. Returns null when the build-time "Confirmed" badge
        // should just be left alone (not due yet, too long ago to still be
        // live-tracked, or sitting at destination outside the arrived window).
        function computeRunStatus(row, vessel, now) {
          var depTs = parseInt(row.getAttribute('data-dep-ts'), 10);
          var arrTs = parseInt(row.getAttribute('data-arr-ts'), 10);
          if (!depTs || now < depTs) return null;

          // Once the vessel's next scheduled run has begun, this row is
          // done - stop evaluating it live. Without this cap, a vessel
          // that returns to this row's origin stop later (as the
          // destination of a subsequent leg) looks identical to "never
          // left in the first place", which would wrongly revive a
          // Delayed badge on a run that already completed on time.
          var nextDepTs = parseInt(row.getAttribute('data-next-dep-ts'), 10);
          if (nextDepTs && now >= nextDepTs) return null;

          var origin = STOP_BY_ALIAS[row.getAttribute('data-from')];
          var dest = STOP_BY_ALIAS[row.getAttribute('data-to')];
          if (!origin) return null; // can't assess delay without knowing where it started from

          var atOrigin = isNearStop(vessel, origin);

          if (atOrigin) {
            var overdueMin = Math.round((now - depTs) / 60000);
            if (overdueMin > DELAY_GRACE_MIN && overdueMin <= DELAY_STALE_HOURS * 60) {
              return { text: 'Delayed ' + overdueMin + 'min', className: 'badge-delayed' };
            }
            return null;
          }

          // Left the origin. "Arrived" combines two signals rather than
          // relying on either alone:
          //  - being detected right at the destination (handles early
          //    arrivals, before the scheduled time)
          //  - the scheduled time passing AND being at least roughly
          //    close by (handles imprecise docking GPS - a vessel can sit
          //    just outside the strict 100/150m "at stop" radius without
          //    having actually failed to arrive)
          // What this rules out: a vessel genuinely still transiting miles
          // away when its scheduled time ticks over - that should read as
          // still Departed (running late), not falsely Arrived.
          var atDest = dest && isNearStop(vessel, dest);
          var roughlyNearDest = dest && distanceMeters(vessel.lat, vessel.lon, dest.lat, dest.lon) <= ARRIVED_LOOSE_RADIUS_M;
          var arrivedWindowOpen = arrTs && now <= arrTs + ARRIVED_WINDOW_MIN * 60000;

          if (arrivedWindowOpen && (atDest || (now >= arrTs && roughlyNearDest))) {
            return { text: 'Arrived', className: 'badge-arrived' };
          }

          if (!arrivedWindowOpen) return null; // past the arrived window - drop back to Confirmed

          if ((now - depTs) <= DELAY_STALE_HOURS * 3600000) {
            return { text: 'Departed', className: 'badge-departed' };
          }
          return null;
        }

        function updateRowStatuses(vesselByName) {
          var now = Date.now();
          document.querySelectorAll('.data-row').forEach(function (row) {
            var vesselName = row.getAttribute('data-vessel');
            var vessel = vesselByName[vesselName];
            var badge = row.querySelector('.status-badge');
            if (!vessel || !badge) return;

            var result = computeRunStatus(row, vessel, now);
            badge.className = 'badge status-badge' + (result ? ' ' + result.className : '');
            badge.textContent = result ? result.text : badge.getAttribute('data-original-status');
          });
        }

        // When two or more vessels are close enough on screen that their
        // permanent labels would overlap, stagger them onto different
        // sides instead of letting them stack illegibly. Distance is
        // measured in screen pixels (not lat/lon), since that's what
        // actually determines whether labels visually collide - the same
        // lat/lon gap looks totally different at different zoom levels.
        // Re-resolved from scratch every refresh rather than remembered,
        // so a cluster that splits up on a later check goes straight back
        // to normal placement.
        var LABEL_COLLISION_PX = 40;
        var LABEL_DIRECTIONS = ['top', 'bottom', 'right', 'left'];
        var LABEL_OFFSETS = { top: [0, -8], bottom: [0, 8], right: [14, 0], left: [-14, 0] };

        function resolveLabelPlacements(entries) {
          var points = entries.map(function (e) {
            return { entry: e, pt: map.latLngToContainerPoint(e.marker.getLatLng()) };
          });

          var directionByName = {};

          points.forEach(function (p, i) {
            if (directionByName[p.entry.name]) return;

            var cluster = [p];
            points.forEach(function (q, j) {
              if (i === j) return;
              var dx = p.pt.x - q.pt.x, dy = p.pt.y - q.pt.y;
              if (Math.sqrt(dx * dx + dy * dy) < LABEL_COLLISION_PX) cluster.push(q);
            });

            cluster.forEach(function (c, idx) {
              directionByName[c.entry.name] = LABEL_DIRECTIONS[idx % LABEL_DIRECTIONS.length];
            });
          });

          points.forEach(function (p) {
            var dir = directionByName[p.entry.name] || 'top';
            var className = 'vessel-label' + (p.entry.inactive ? ' vessel-label-inactive' : '');
            if (p.entry.marker.getTooltip()) p.entry.marker.unbindTooltip();
            p.entry.marker.bindTooltip(p.entry.labelHtml, {
              permanent: true,
              direction: dir,
              offset: LABEL_OFFSETS[dir],
              className: className
            });
          });
        }

        // Shared renderer - both the live proxy and the static snapshot
        // feed into this once normalized to the same {name, lat, lon,
        // speedKn, headingDeg} shape, so marker-drawing logic only lives
        // in one place.
        function applyPositions(vessels, labelText) {
          var vesselByName = {};
          var visibleEntries = []; // {name, marker, labelHtml, inactive, topClearance} - tooltip placement resolved after all markers are positioned

          vessels
            .filter(function (v) { return relevantVessels.indexOf((v.name || '').trim().toLowerCase()) !== -1; })
            .forEach(function (v) {
              // Populated regardless of map visibility - the schedule
              // badges (Departed/Delayed/Arrived) should still reflect
              // reality even for a vessel currently hidden from the map.
              vesselByName[(v.name || '').trim().toLowerCase()] = v;

              if (isInMaintenanceZone(v)) {
                if (markers[v.name]) {
                  map.removeLayer(markers[v.name]);
                  delete markers[v.name];
                }
                return;
              }

              var popupHtml = '<strong>' + v.name + '</strong><br>' +
                (typeof v.speedKn === 'number' ? v.speedKn.toFixed(1) + ' kn' : 'Speed unavailable');

              var stopName = nearestStopName(v);
              var labelHtml = shortNameFor(v.name) + (stopName ? ' ' + stopName : '');
              var inactive = isInactiveAtStop(v);
              var icon = buildVesselIcon(v, inactive);

              if (markers[v.name]) {
                markers[v.name].setLatLng([v.lat, v.lon]).setPopupContent(popupHtml).setIcon(icon);
              } else {
                markers[v.name] = L.marker([v.lat, v.lon], { icon: icon }).addTo(map).bindPopup(popupHtml);
              }

              visibleEntries.push({
                name: v.name,
                marker: markers[v.name],
                labelHtml: labelHtml,
                inactive: inactive
              });
            });

          resolveLabelPlacements(visibleEntries);
          updateRowStatuses(vesselByName);

          var updatedEl = document.getElementById('map-updated');
          if (updatedEl) updatedEl.textContent = labelText;
        }

        // Fallback: whatever was baked in at the last GitHub Pages build.
        function fetchStaticSnapshot() {
          fetch('../positions.json?t=' + Date.now())
            .then(function (res) { return res.json(); })
            .then(function (data) {
              var labelText = data.fetchedAt
                ? 'Updated ' + new Date(data.fetchedAt).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' }) + ' AEST'
                : 'Position data unavailable';
              applyPositions(data.vessels || [], labelText);
            })
            .catch(function (err) {
              console.error('Could not fetch static position snapshot', err);
            });
        }

        // Live: call OnWatch directly via the Power Automate proxy, bypassing
        // the rebuild cycle. Parses OnWatch's raw response shape client-side
        // since the proxy just passes it straight through.
        function fetchLivePositions() {
          fetch(liveProxyUrl, { method: 'POST' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
              var raw = data.data || data.vessels || [];
              var normalized = raw.map(function (v) {
                return {
                  name: v.vessel_name || v.vessel_id || 'Unknown',
                  lat: v.latitude,
                  lon: v.longitude,
                  speedKn: v.speed_over_ground && v.speed_over_ground.value,
                  headingDeg: v.heading && v.heading.value
                };
              }).filter(function (v) { return typeof v.lat === 'number' && typeof v.lon === 'number'; });

              var labelText = 'Live - checked ' + new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' }) + ' AEST';
              applyPositions(normalized, labelText);
            })
            .catch(function (err) {
              console.error('Live position proxy failed, falling back to static snapshot', err);
              fetchStaticSnapshot();
            });
        }

        // Passive re-fetch, used on load, every 60s automatically, and once
        // right after a rebuild request. Prefers the live proxy when it's
        // configured; otherwise just re-checks the static snapshot.
        function refreshPositions() {
          if (liveProxyUrl) {
            fetchLivePositions();
          } else {
            fetchStaticSnapshot();
          }
        }

        // Active: ask Power Automate to kick off a brand-new OnWatch pull +
        // rebuild, then show the freshest published data straight away and
        // let the normal 60s poll pick up the new build once it lands.
        function requestFreshRebuild() {
          if (!refreshBtn) return;

          if (!powerAutomateUrl) {
            console.warn('POWER_AUTOMATE_REFRESH_URL is not set - button will only re-check existing data.');
            refreshPositions();
            return;
          }

          refreshBtn.disabled = true;
          refreshBtn.textContent = '↻ Requesting…';

          fetch(powerAutomateUrl, { method: 'POST', mode: 'no-cors' })
            .catch(function (err) {
              console.error('Could not reach Power Automate trigger', err);
            })
            .finally(function () {
              refreshPositions();
              refreshBtn.textContent = '↻ Refreshing data…';

              // Cooldown - stops rapid re-clicks from spamming Power
              // Automate / cancelling GitHub's in-flight build over and
              // over. Countdown text just keeps the wait understandable.
              var secondsLeft = Math.round(REFRESH_COOLDOWN_MS / 1000);
              var countdown = setInterval(function () {
                secondsLeft -= 1;
                if (secondsLeft <= 0) {
                  clearInterval(countdown);
                  refreshBtn.disabled = false;
                  refreshBtn.textContent = '↻ Refresh';
                  refreshPositions(); // one more check - the rebuild should have landed by now
                } else {
                  refreshBtn.textContent = '↻ Wait ' + secondsLeft + 's';
                }
              }, 1000);
            });
        }

        if (refreshBtn) {
          refreshBtn.addEventListener('click', requestFreshRebuild);
        }

        refreshPositions();
        setInterval(refreshPositions, 60000);
      })();
    </script>
  `;
}

function generateGroupedHtmlTable(clientName, trips) {
  const uniqueVessels = Array.from(new Set(trips.map(t => (t['Resource'] || t['Vessel'] || 'Unassigned').trim()))).sort();
  const uniqueRunTypes = Array.from(new Set(trips.map(t => (t['Trip Type Name'] || 'Scheduled Run').trim()))).sort();

  const vesselOptionsHtml = uniqueVessels.map(v => `<option value="${v}">${v}</option>`).join('');
  const runTypeOptionsHtml = uniqueRunTypes.map(rt => `<option value="${rt}">${rt}</option>`).join('');

  let contentHtml = '';

  if (trips.length === 0) {
    contentHtml = `<div style="text-align:center; padding: 40px; color: #666;">No upcoming confirmed trips scheduled.</div>`;
  } else {
    // Structure: Group by Day -> Group by Vessel
    const dayGroups = {};

    trips.forEach(t => {
      const vessel = (t['Resource'] || t['Vessel'] || 'Unassigned').trim();
      const parsedStart = parseHelmDate(t['Start'] || t['Requested Date']);
      const parsedEnd = parseHelmDate(t['End']);

      const dateLabel = parsedStart.dateLabel;
      const isoDate = parsedStart.isoDate;

      if (!dayGroups[dateLabel]) {
        dayGroups[dateLabel] = { isoDate, vessels: {} };
      }
      if (!dayGroups[dateLabel].vessels[vessel]) {
        dayGroups[dateLabel].vessels[vessel] = [];
      }

      dayGroups[dateLabel].vessels[vessel].push({ row: t, parsedStart, parsedEnd, isoDate });
    });

    for (const [dateLabel, dayData] of Object.entries(dayGroups)) {
      contentHtml += `
        <div class="day-block" data-date="${dayData.isoDate}">
          <div class="day-header-banner">
            📅 ${dateLabel}
          </div>
      `;

      for (const [vesselName, dayVesselTrips] of Object.entries(dayData.vessels)) {
        contentHtml += `
          <div class="vessel-block" data-vessel-name="${vesselName.toLowerCase()}">
            <div class="vessel-sub-header">
              🚢 Vessel: <strong>${vesselName}</strong>
            </div>
            <div class="table-scroll">
            <table class="schedule-table">
              <thead>
                <tr>
                  <th>Run Type</th>
                  <th>Route</th>
                  <th>Dep Time</th>
                  <th>Arr Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
        `;

        dayVesselTrips.forEach(({ row, parsedStart, parsedEnd, isoDate }, tripIndex) => {
          const runTypeRaw = row['Trip Type Name'] || 'Scheduled Run';
          const runTypeHtml = formatRunTypeHtml(runTypeRaw);
          const depLoc = row['Location From Name'] || row['Origin'] || '-';
          const arrLoc = row['Location To Name'] || row['Destination'] || '-';
          const depTime = parsedStart.timeStr;
          const arrTime = parsedEnd.timeStr;
          const status = formatStatus(row['Status']);

          // The vessel's next scheduled departure after this run, if any -
          // used client-side to stop treating this row as "live" once the
          // vessel has clearly moved on. Without this, a vessel returning
          // to this row's origin stop later (as the destination of a
          // later leg) can look identical to "never left in the first
          // place", wrongly reviving a Delayed badge on an already-
          // completed run.
          const nextTrip = dayVesselTrips[tripIndex + 1];
          const nextDepTs = nextTrip ? nextTrip.parsedStart.timestamp : '';

          const routeText = (depLoc && arrLoc)
            ? `${depLoc} &rarr; ${arrLoc}`
            : (depLoc || arrLoc || 'Local Waters');

          const isScheduled = runTypeRaw.toLowerCase().includes('scheduled');
          const isExtra = runTypeRaw.toLowerCase().includes('extra');

          let rowClass = 'data-row';
          if (isScheduled) rowClass += ' scheduled-run-row';
          if (isExtra) rowClass += ' extra-run-row';

          contentHtml += `
            <tr class="${rowClass}"
                data-vessel="${vesselName.toLowerCase()}"
                data-runtype="${runTypeRaw.toLowerCase()}"
                data-date="${isoDate}"
                data-dep-ts="${parsedStart.timestamp}"
                data-arr-ts="${parsedEnd.timestamp}"
                data-next-dep-ts="${nextDepTs}"
                data-from="${depLoc.trim().toLowerCase()}"
                data-to="${arrLoc.trim().toLowerCase()}">
              <td>${runTypeHtml}</td>
              <td class="route-cell">${routeText}</td>
              <td>${depTime}</td>
              <td>${arrTime}</td>
              <td><span class="badge status-badge" data-original-status="${status}">${status}</span></td>
            </tr>
          `;
        });

        contentHtml += `
              </tbody>
            </table>
            </div>
          </div>
        `;
      }

      contentHtml += `</div>`; // End day-block
    }
  }

  const mapHtml = generateVesselMapHtml(uniqueVessels);

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${clientName} - Upcoming Vessel Trips | SeaLink Gladstone</title>
      <link rel="icon" type="image/png" href="../favicon.png">
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f8; color: #333; margin: 0; padding: 20px; }
        .container { max-width: 1100px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #00529b; padding-bottom: 12px; margin-bottom: 20px; }
        h1 { color: #00529b; margin: 0; font-size: 24px; }
        .timestamp { font-size: 12px; color: #666; text-align: right; }
        .refresh-note { font-size: 11px; color: #888; margin-top: 4px; }

        /* Live Vessel Map Panel */
        .map-panel { border: 1px solid #c4d7e6; border-radius: 6px; overflow: hidden; margin-bottom: 24px; }
        .map-panel-header { background: #00529b; color: #fff; padding: 12px 16px; font-size: 15px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
        .map-header-right { display: flex; align-items: center; gap: 12px; }
        .btn-refresh-map { background: rgba(255,255,255,0.15); color: #fff; border: 1px solid rgba(255,255,255,0.4); border-radius: 4px; padding: 5px 10px; font-size: 12px; font-weight: bold; cursor: pointer; transition: background 0.2s; }
        .btn-refresh-map:hover:not(:disabled) { background: rgba(255,255,255,0.3); }
        .btn-refresh-map:disabled { opacity: 0.6; cursor: default; }
        .map-updated-label { font-size: 12px; font-weight: normal; opacity: 0.85; }
        #vessel-map { height: 320px; width: 100%; }
        .vessel-marker-icon { filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)); }
        .vessel-marker-icon svg.vessel-icon-inactive { filter: grayscale(1) opacity(0.75); }
        .leaflet-tooltip.vessel-label { background: #00529b; color: #fff; border: none; border-radius: 4px; padding: 2px 6px; font-size: 11px; font-weight: bold; letter-spacing: 0.3px; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
        .leaflet-tooltip.vessel-label::before { border-top-color: #00529b; }
        .leaflet-tooltip.vessel-label-inactive { background: #8a8f98; }
        .leaflet-tooltip.vessel-label-inactive::before { border-top-color: #8a8f98; }

        /* Filter Control Bar */
        .filter-panel { background: #f0f4f8; border: 1px solid #d0dbe5; border-radius: 6px; padding: 16px; margin-bottom: 24px; display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; }
        .filter-group { display: flex; flex-direction: column; gap: 6px; }
        .filter-group label { font-size: 12px; font-weight: bold; color: #00529b; text-transform: uppercase; letter-spacing: 0.5px; }
        .filter-group select, .filter-group input { padding: 8px 12px; border: 1px solid #b0c4de; border-radius: 4px; font-size: 13px; background: #fff; min-width: 160px; }
        .btn-reset { padding: 8px 16px; background: #00529b; color: #fff; border: none; border-radius: 4px; font-weight: bold; font-size: 13px; cursor: pointer; transition: background 0.2s; }
        .btn-reset:hover { background: #003a6e; }

        /* Day Block Styling */
        .day-block { margin: 0 auto 32px; border: 1px solid #c4d7e6; border-radius: 6px; overflow: hidden; background: #fff; width: fit-content; max-width: 100%; }
        .day-header-banner { background: #00529b; color: #fff; padding: 14px 18px; font-size: 17px; font-weight: bold; letter-spacing: 0.3px; }

        /* Vessel Sub-Block Styling */
        .vessel-block { margin: 16px; border: 1px solid #d0dbe5; border-radius: 6px; overflow: hidden; background: #fff; width: fit-content; max-width: calc(100% - 32px); }
        .vessel-sub-header { background: #e8f1f8; color: #00529b; padding: 10px 14px; font-size: 14px; font-weight: bold; border-bottom: 1px solid #d0dbe5; }

        /* Schedule Tables */
        .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .schedule-table { border-collapse: collapse; }
        .schedule-table th, .schedule-table td { text-align: left; padding: 9px 14px; border-bottom: 1px solid #e1e4e8; white-space: nowrap; }
        .schedule-table th { background-color: #f8f9fa; color: #555; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
        .route-cell { white-space: normal; }

        .route-cell { font-weight: normal; color: #333; }

        /* Run Type Specific Styling */
        .run-type-italic { font-style: italic; color: #555; font-weight: normal; }
        .run-type-scheduled-text { font-weight: bold; color: #0a3663; }

        /* SCHEDULED RUN ROW: Entire row fully bolded with pleasant blue background */
        .scheduled-run-row { background-color: #e8f4fd; font-weight: bold; color: #0a3663; border-left: 4px solid #00529b; }
        .scheduled-run-row td { color: #0a3663; font-weight: bold; }

        /* EXTRA RUN ROW: Light orange background & orange badge */
        .extra-run-row { background-color: #fffaf0; }
        .run-type-extra-badge { background-color: #ffe8cc; color: #d97706; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; border: 1px solid #fbd38d; display: inline-block; }

        .badge { background: #e6f4ea; color: #137333; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; }
        .badge-departed { background: #e3edfb; color: #1a56b0; }
        .badge-delayed { background: #fdecea; color: #c0392b; }
        .badge-arrived { background: #e0f6f4; color: #067a6f; }
        .no-results { display: none; text-align: center; padding: 40px; color: #888; font-size: 15px; }

        /* Mobile */
        @media (max-width: 640px) {
          body { padding: 10px; }
          .container { padding: 14px; }
          .header { flex-direction: column; align-items: flex-start; gap: 6px; }
          .timestamp { text-align: left; }
          h1 { font-size: 20px; }
          .map-panel-header { flex-wrap: wrap; gap: 8px; }
          #vessel-map { height: 240px; }
          .filter-panel { padding: 12px; gap: 10px; }
          .filter-group select, .filter-group input { min-width: 130px; }
          .schedule-table th, .schedule-table td { padding: 8px 8px; font-size: 12.5px; }
          .vessel-block { margin: 10px; max-width: calc(100% - 20px); }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div>
            <h1>${clientName} Schedule</h1>
            <p style="margin: 4px 0 0 0; color: #666;">SeaLink Gladstone Operational Portal</p>
          </div>
          <div>
            <div class="timestamp">Updated: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })} AEST</div>
            <div class="refresh-note">Schedule data refreshes automatically every 10 minutes</div>
          </div>
        </div>

        ${mapHtml}

        <!-- Filter Controls -->
        <div class="filter-panel">
          <div class="filter-group">
            <label for="vesselFilter">Vessel Name</label>
            <select id="vesselFilter" onchange="applyFilters()">
              <option value="">All Vessels</option>
              ${vesselOptionsHtml}
            </select>
          </div>

          <div class="filter-group">
            <label for="runTypeFilter">Run Type</label>
            <select id="runTypeFilter" onchange="applyFilters()">
              <option value="">All Run Types</option>
              ${runTypeOptionsHtml}
            </select>
          </div>

          <div class="filter-group">
            <label for="startDate">From Date</label>
            <input type="date" id="startDate" onchange="applyFilters()">
          </div>

          <div class="filter-group">
            <label for="endDate">To Date</label>
            <input type="date" id="endDate" onchange="applyFilters()">
          </div>

          <div class="filter-group" style="margin-left: auto;">
            <button class="btn-reset" onclick="resetFilters()">Reset Filters</button>
          </div>
        </div>

        <!-- Filter No Results Banner -->
        <div id="noResults" class="no-results">
          ⚠️ No upcoming trips match your filter criteria. Try resetting or adjusting your filter selections.
        </div>

        <!-- Schedule Content -->
        <div id="scheduleContent">
          ${contentHtml}
        </div>
      </div>

      <script>
        function applyFilters() {
          const selectedVessel = document.getElementById('vesselFilter').value.toLowerCase().trim();
          const selectedRunType = document.getElementById('runTypeFilter').value.toLowerCase().trim();
          const startDate = document.getElementById('startDate').value;
          const endDate = document.getElementById('endDate').value;

          const rows = document.querySelectorAll('.data-row');
          let visibleCount = 0;

          rows.forEach(row => {
            const rowVessel = (row.getAttribute('data-vessel') || '').toLowerCase();
            const rowRunType = (row.getAttribute('data-runtype') || '').toLowerCase();
            const rowDate = row.getAttribute('data-date') || '';

            let show = true;

            if (selectedVessel && rowVessel !== selectedVessel) show = false;
            if (selectedRunType && rowRunType !== selectedRunType) show = false;
            if (startDate && rowDate < startDate) show = false;
            if (endDate && rowDate > endDate) show = false;

            row.style.display = show ? '' : 'none';
            if (show) visibleCount++;
          });

          // Toggle Vessel Block Visibility inside Day Blocks
          document.querySelectorAll('.vessel-block').forEach(vesselBlock => {
            const visibleChildRows = vesselBlock.querySelectorAll('.data-row:not([style*="display: none"])');
            vesselBlock.style.display = visibleChildRows.length > 0 ? '' : 'none';
          });

          // Toggle Day Block Visibility
          document.querySelectorAll('.day-block').forEach(dayBlock => {
            const visibleVesselBlocks = dayBlock.querySelectorAll('.vessel-block:not([style*="display: none"])');
            dayBlock.style.display = visibleVesselBlocks.length > 0 ? '' : 'none';
          });

          // Toggle No Results Banner
          document.getElementById('noResults').style.display = (visibleCount === 0) ? 'block' : 'none';
        }

        function resetFilters() {
          document.getElementById('vesselFilter').value = '';
          document.getElementById('runTypeFilter').value = '';
          document.getElementById('startDate').value = '';
          document.getElementById('endDate').value = '';
          applyFilters();
        }
      </script>
    </body>
    </html>
  `;
}

generateSites().catch(err => {
  console.error('FATAL BUILD ERROR:', err);
  process.exit(1);
});
