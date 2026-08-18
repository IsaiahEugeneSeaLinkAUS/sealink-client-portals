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
const STOPS = [
  { name: 'CP1', aliases: ['cp1'], lat: -23.78493, lon: 151.16916 },
  { name: 'CP3', aliases: ['cp3'], lat: -23.75329, lon: 151.17814 },
  { name: 'GL3', aliases: ['gl3'], lat: -23.82395, lon: 151.24208 },
  { name: 'GL4', aliases: ['gl4'], lat: -23.79165, lon: 151.21203 },
  { name: 'QC3', aliases: ['qc3'], lat: -23.77970, lon: 151.19851 },
  { name: 'QC4', aliases: ['qc4'], lat: -23.76711, lon: 151.18861 },
  { name: 'Marina', aliases: ['marina', 'sealink marina', 'gladstone marina'], lat: -23.82783, lon: 151.24350 }
];

// Keyed on Helm's spelling (lowercase), value is OnWatch's spelling.
const VESSEL_NAME_ALIASES = {
  'r.b. trojan': 'trojan'
};

function onWatchVesselKey(helmName) {
  const key = (helmName || '').trim().toLowerCase();
  return VESSEL_NAME_ALIASES[key] || key;
}

// Helper to parse Helm CSV date strings as explicit Brisbane time (UTC+10)
function parseHelmDate(dateStr) {
  if (!dateStr) {
    return { isoDate: '', dateLabel: 'TBD', timeStr: 'TBD', timestamp: 0 };
  }

  const clean = String(dateStr).trim().replace('T', ' ');
  const parts = clean.split(' ');
  const isoDate = parts[0]; 
  const rawTime = parts[1] ? parts[1].substring(0, 5) : '00:00'; 

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
    } catch (_) { }
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
    .filter(v => typeof v.lat === 'number' && typeof v.lon === 'number');
}

async function generateSites() {
  console.log('Fetching latest Helm Connect CSV...');

  const headers = {};
  if (API_KEY) {
    headers['Api-Key'] = API_KEY;
  }

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
    const hasVessel = (row['Resource'] || row['Vessel'] || row['Resource Name'] || row['Asset'] || '').trim() !== '';

    return !isCancelled && !isComplete && !isDraft && hasVessel;
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

  validTrips.sort((a, b) => {
    const startA = parseHelmDate(a['Start'] || a['Requested Date']).timestamp;
    const startB = parseHelmDate(b['Start'] || b['Requested Date']).timestamp;
    return startA - startB;
  });

  console.log(`Deduplicated and sorted down to ${validTrips.length} upcoming confirmed trips.`);

  const tripCountByVessel = {};
  validTrips.forEach(row => {
    const v = (row['Resource'] || row['Vessel'] || row['Resource Name'] || row['Asset'] || 'Unassigned').trim();
    tripCountByVessel[v] = (tripCountByVessel[v] || 0) + 1;
  });
  console.log('Trips by vessel:', JSON.stringify(tripCountByVessel));

  // ---------------------------------------------------------------------------
  // 4b. LIVE VESSEL POSITIONS (OnWatch VMS)
  // ---------------------------------------------------------------------------
  const rawPositions = await onWatchPromise;
  const positions = normalizeOnWatchPositions(rawPositions);
  console.log(`Fetched ${positions.length} vessel position(s) from OnWatch.`);

  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  const faviconSrc = path.join(__dirname, 'favicon.png');
  if (fs.existsSync(faviconSrc)) {
    fs.copyFileSync(faviconSrc, path.join(publicDir, 'favicon.png'));
  } else {
    console.warn('favicon.png not found at repo root - tab icon will be broken until it is added.');
  }

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
// POWER AUTOMATE WEBHOOK ENDPOINTS
// Read from GitHub Actions secrets (same pattern as HELM_CSV_URL/HELM_API_KEY
// above) instead of being hardcoded here. Note this only keeps the sig
// tokens out of the repo/build.js itself - all three still get embedded
// into the generated client-side <script> blocks below, since the browser
// has to call them directly for the live refresh button, the live position
// poll, and ?live=true schedule mode. That part of the exposure (visible
// via "view source" on the deployed pages) isn't changed by this.
// ---------------------------------------------------------------------------
const POWER_AUTOMATE_REFRESH_URL = (process.env.POWER_AUTOMATE_REFRESH_URL || '').trim().replace(/^["']|["']$/g, '');
const LIVE_POSITION_PROXY_URL = (process.env.LIVE_POSITION_PROXY_URL || '').trim().replace(/^["']|["']$/g, '');
const HELM_SCHEDULE_PROXY_URL = (process.env.HELM_SCHEDULE_PROXY_URL || '').trim().replace(/^["']|["']$/g, '');

if (!POWER_AUTOMATE_REFRESH_URL) console.warn('POWER_AUTOMATE_REFRESH_URL not set - the map "Refresh" button will fall back to re-checking existing data instead of forcing a rebuild.');
if (!LIVE_POSITION_PROXY_URL) console.warn('LIVE_POSITION_PROXY_URL not set - the map will fall back to the static positions.json snapshot instead of live polling.');
if (!HELM_SCHEDULE_PROXY_URL) console.warn('HELM_SCHEDULE_PROXY_URL not set - ?live=true schedule mode will have nothing to fetch.');

// ---------------------------------------------------------------------------
// LIVE SCHEDULE MODE (now the default for every visitor - previously
// opt-in via ?live=true while this was being tested)
// ---------------------------------------------------------------------------
function generateLiveScheduleScript(clientName) {
  return `
    <script>
      (function () {
        var HELM_SCHEDULE_PROXY_URL = ${JSON.stringify(HELM_SCHEDULE_PROXY_URL)};
        var CLIENT_NAME = ${JSON.stringify(clientName)};
        var VESSEL_NAME_ALIASES_LIVE = ${JSON.stringify(VESSEL_NAME_ALIASES)};
        var LIVE_SCHEDULE_POLL_MS = 10 * 60 * 1000; // 10 min

        function onWatchVesselKeyLive(helmName) {
          var key = (helmName || '').trim().toLowerCase();
          return VESSEL_NAME_ALIASES_LIVE[key] || key;
        }

        function parseHelmDateLive(dateStr) {
          if (!dateStr) return { isoDate: '', dateLabel: 'TBD', timeStr: 'TBD', timestamp: 0 };
          var clean = String(dateStr).trim().replace('T', ' ');
          var parts = clean.split(' ');
          var isoDate = parts[0];
          var rawTime = parts[1] ? parts[1].substring(0, 5) : '00:00';
          var dateObj = new Date(isoDate + 'T' + rawTime + ':00+10:00');
          var dateLabel = 'TBD';
          if (!isNaN(dateObj.getTime())) {
            dateLabel = dateObj.toLocaleDateString('en-AU', {
              weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Brisbane'
            });
          }
          return { isoDate: isoDate, dateLabel: dateLabel, timeStr: rawTime, timestamp: isNaN(dateObj.getTime()) ? 0 : dateObj.getTime() };
        }

        function formatStatusLive(statusStr) {
          if (!statusStr) return 'Confirmed';
          var clean = statusStr.replace(/^STATUS_/i, '');
          return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
        }

        function formatRunTypeHtmlLive(runTypeStr) {
          var clean = (runTypeStr || 'Scheduled Run').trim();
          var lower = clean.toLowerCase();
          if (lower.indexOf('internal') !== -1 || lower.indexOf('return') !== -1) return '<em class="run-type-italic">' + clean + '</em>';
          if (lower.indexOf('scheduled') !== -1) return '<span class="run-type-scheduled-text">' + clean + '</span>';
          if (lower.indexOf('extra') !== -1) return '<span class="run-type-extra-badge">' + clean + '</span>';
          return '<span>' + clean + '</span>';
        }

        function rebuildFilterDropdowns(trips) {
          var vessels = [], seenV = {}, runTypes = [], seenR = {};
          trips.forEach(function (t) {
            var v = (t['Resource'] || t['Vessel'] || 'Unassigned').trim();
            if (!seenV[v]) { seenV[v] = true; vessels.push(v); }
            var rt = (t['Trip Type Name'] || 'Scheduled Run').trim();
            if (!seenR[rt]) { seenR[rt] = true; runTypes.push(rt); }
          });
          vessels.sort();
          runTypes.sort();

          var vesselSelect = document.getElementById('vesselFilter');
          if (vesselSelect) {
            var keepV = vesselSelect.value;
            vesselSelect.innerHTML = '<option value="">All Vessels</option>' +
              vessels.map(function (v) { return '<option value="' + v + '">' + v + '</option>'; }).join('');
            vesselSelect.value = keepV;
          }
          var runTypeSelect = document.getElementById('runTypeFilter');
          if (runTypeSelect) {
            var keepR = runTypeSelect.value;
            runTypeSelect.innerHTML = '<option value="">All Run Types</option>' +
              runTypes.map(function (rt) { return '<option value="' + rt + '">' + rt + '</option>'; }).join('');
            runTypeSelect.value = keepR;
          }
        }

        function renderLiveSchedule(trips) {
          var scheduleContentEl = document.getElementById('scheduleContent');
          if (!scheduleContentEl) return;

          if (trips.length === 0) {
            scheduleContentEl.innerHTML = '<div style="text-align:center; padding: 40px; color: #666;">No upcoming confirmed trips scheduled.</div>';
            rebuildFilterDropdowns(trips);
            return;
          }

          var dayGroups = {};
          trips.forEach(function (t) {
            var vessel = (t['Resource'] || t['Vessel'] || 'Unassigned').trim();
            var parsedStart = parseHelmDateLive(t['Start'] || t['Requested Date']);
            var parsedEnd = parseHelmDateLive(t['End']);
            var dateLabel = parsedStart.dateLabel;
            if (!dayGroups[dateLabel]) dayGroups[dateLabel] = { isoDate: parsedStart.isoDate, order: parsedStart.timestamp, vessels: {} };
            if (!dayGroups[dateLabel].vessels[vessel]) dayGroups[dateLabel].vessels[vessel] = [];
            dayGroups[dateLabel].vessels[vessel].push({ row: t, parsedStart: parsedStart, parsedEnd: parsedEnd, isoDate: parsedStart.isoDate });
          });

          var dayLabels = Object.keys(dayGroups).sort(function (a, b) { return dayGroups[a].order - dayGroups[b].order; });
          var contentHtml = '';

          dayLabels.forEach(function (dateLabel) {
            var dayData = dayGroups[dateLabel];
            contentHtml += '<div class="day-block" data-date="' + dayData.isoDate + '">' +
              '<div class="day-header-banner">📅 ' + dateLabel + '</div>';

            Object.keys(dayData.vessels).forEach(function (vesselName) {
              var dayVesselTrips = dayData.vessels[vesselName];
              contentHtml += '<div class="vessel-block" data-vessel-name="' + vesselName.toLowerCase() + '">' +
                '<div class="vessel-sub-header">🚢 Vessel: <strong>' + vesselName + '</strong></div>' +
                '<div class="table-scroll"><table class="schedule-table"><thead><tr>' +
                '<th>Run Type</th><th>Route</th><th>Dep Time</th><th>Arr Time</th><th>Status</th>' +
                '</tr></thead><tbody>';

              dayVesselTrips.forEach(function (entry, tripIndex) {
                var row = entry.row, parsedStart = entry.parsedStart, parsedEnd = entry.parsedEnd, isoDate = entry.isoDate;
                var runTypeRaw = row['Trip Type Name'] || 'Scheduled Run';
                var depLoc = row['Location From Name'] || row['Origin'] || '-';
                var arrLoc = row['Location To Name'] || row['Destination'] || '-';
                var status = formatStatusLive(row['Status']);
                var routeText = (depLoc && arrLoc) ? (depLoc + ' &rarr; ' + arrLoc) : (depLoc || arrLoc || 'Local Waters');
                var lowerType = runTypeRaw.toLowerCase();
                var rowClass = 'data-row';
                if (lowerType.indexOf('scheduled') !== -1) rowClass += ' scheduled-run-row';
                if (lowerType.indexOf('extra') !== -1) rowClass += ' extra-run-row';

                var nextTrip = dayVesselTrips[tripIndex + 1];
                var nextDepTs = nextTrip ? nextTrip.parsedStart.timestamp : '';

                contentHtml += '<tr class="' + rowClass + '"' +
                  ' data-vessel="' + vesselName.toLowerCase() + '"' +
                  ' data-onwatch-vessel="' + onWatchVesselKeyLive(vesselName) + '"' +
                  ' data-runtype="' + lowerType + '"' +
                  ' data-date="' + isoDate + '"' +
                  ' data-dep-ts="' + parsedStart.timestamp + '"' +
                  ' data-arr-ts="' + parsedEnd.timestamp + '"' +
                  ' data-next-dep-ts="' + nextDepTs + '"' +
                  ' data-from="' + depLoc.trim().toLowerCase() + '"' +
                  ' data-to="' + arrLoc.trim().toLowerCase() + '">' +
                  '<td>' + formatRunTypeHtmlLive(runTypeRaw) + '</td>' +
                  '<td class="route-cell">' + routeText + '</td>' +
                  '<td>' + parsedStart.timeStr + '</td>' +
                  '<td>' + parsedEnd.timeStr + '</td>' +
                  '<td><span class="badge status-badge" data-original-status="' + status + '">' + status + '</span></td>' +
                  '</tr>';
              });

              contentHtml += '</tbody></table></div></div>';
            });

            contentHtml += '</div>';
          });

          scheduleContentEl.innerHTML = contentHtml;
          rebuildFilterDropdowns(trips);

          // RACE CONDITION BRIDGE: Re-apply the live Map statuses to the brand new HTML elements
          if (typeof window.reapplyStatuses === 'function') {
            window.reapplyStatuses();
          }

          var timestampEl = document.querySelector('.timestamp');
          if (timestampEl) {
            timestampEl.textContent = 'Updated: ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }) + ' AEST (live)';
          }
        }

        function loadLiveSchedule() {
          if (!HELM_SCHEDULE_PROXY_URL) {
            console.warn('HELM_SCHEDULE_PROXY_URL is not set yet - ?live=true has nothing to fetch.');
            return;
          }

          fetch(HELM_SCHEDULE_PROXY_URL, { method: 'POST' })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + res.statusText);
              return res.text();
            })
            .then(function (csvText) {
              if (!csvText || !csvText.trim()) throw new Error('Empty CSV received from proxy');

              var parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
              var records = parsed.data || [];

              if (records.length === 0) {
                console.warn('Live schedule parsed 0 rows - retaining static build view');
                return;
              }

              var filtered = records.filter(function (row) {
                var status = String(row['Status'] || row['Job Status'] || row['Trip Status'] || '').toUpperCase().trim();
                var isCancelled = status.indexOf('CANCEL') !== -1;
                var isComplete = status.indexOf('COMPLETE') !== -1;
                var isDraft = status.indexOf('DRAFT') !== -1 || status.indexOf('PENDING') !== -1 || status.indexOf('UNCONFIRM') !== -1;
                var hasVessel = (row['Resource'] || row['Vessel'] || row['Resource Name'] || row['Asset'] || '').trim() !== '';
                return !isCancelled && !isComplete && !isDraft && hasVessel;
              });

              var seen = {}, deduped = [];
              filtered.forEach(function (row) {
                var cust = (row['Customer Account Name'] || row['Customer'] || row['Account'] || '').trim();
                var vessel = (row['Resource'] || row['Vessel'] || row['Resource Name'] || row['Asset'] || '').trim();
                var type = (row['Trip Type Name'] || row['Trip Type'] || '').trim();
                var start = (row['Start'] || row['Requested Date'] || '').trim();
                var end = (row['End'] || '').trim();
                var from = (row['Location From Name'] || row['Origin'] || '').trim();
                var to = (row['Location To Name'] || row['Destination'] || '').trim();
                var key = cust + '|' + vessel + '|' + type + '|' + start + '|' + end + '|' + from + '|' + to;
                if (!seen[key]) { seen[key] = true; deduped.push(row); }
              });

              deduped.sort(function (a, b) {
                return parseHelmDateLive(a['Start'] || a['Requested Date']).timestamp - parseHelmDateLive(b['Start'] || b['Requested Date']).timestamp;
              });

              var clientTrips = deduped.filter(function (row) {
                var customer = String(row['Customer Account Name'] || row['Customer'] || row['Account'] || '').toLowerCase();
                return customer.indexOf(CLIENT_NAME.toLowerCase()) !== -1;
              });

              renderLiveSchedule(clientTrips);
            })
            .catch(function (err) {
              console.error('Live schedule fetch failed - leaving current content in place', err);
            });
        }

        loadLiveSchedule();
        setInterval(loadLiveSchedule, LIVE_SCHEDULE_POLL_MS);
      })();
    </script>
  `;
}

// ---------------------------------------------------------------------------
// LIVE VESSEL POSITION MAP
// ---------------------------------------------------------------------------
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
        var REFRESH_COOLDOWN_MS = 90000;

        // GLOBAL BRIDGE: Save vessel statuses so the Schedule logic can request them during redraws
        window.lastKnownVessels = {};
        window.reapplyStatuses = function() {
          updateRowStatuses(window.lastKnownVessels);
        };

        var map = L.map('vessel-map', { scrollWheelZoom: false }).setView([-23.793, 151.250], 12);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
          maxZoom: 17
        }).addTo(map);

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

        var MAINTENANCE_SLIPWAY = { lat: -23.83619, lon: 151.24365 };
        var HIDE_RADIUS_M = 200;

        function isInMaintenanceZone(vessel) {
          return distanceMeters(vessel.lat, vessel.lon, MAINTENANCE_SLIPWAY.lat, MAINTENANCE_SLIPWAY.lon) <= HIDE_RADIUS_M;
        }

        var STALE_POSITION_HOURS = 12;

        function isStalePosition(vessel) {
          if (!vessel.lastUpdated) return true;
          var ageMs = Date.now() - new Date(vessel.lastUpdated).getTime();
          return ageMs > STALE_POSITION_HOURS * 3600000;
        }

        function isInactiveAtStop(vessel) {
          var key = (vessel.name || '').trim().toLowerCase();
          var stopName = nearestStopName(vessel);
          if (!stopName) return false;
          if (key === 'trojan' && stopName === 'Marina') return false;
          return true;
        }

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

        var STOPS = ${JSON.stringify(STOPS)};
        var STOP_BY_ALIAS = {};
        STOPS.forEach(function (stop) {
          stop.aliases.forEach(function (alias) { STOP_BY_ALIAS[alias] = stop; });
        });

        var AT_STOP_RADIUS_M = 100;
        var AT_STOP_SLOW_RADIUS_M = 150;
        var AT_STOP_SPEED_KN = 1.0;
        var DELAY_GRACE_MIN = 2;
        var ARRIVED_LOOSE_RADIUS_M = 500;
        var DELAY_STALE_HOURS = 3;

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

        function nearestStopName(vessel) {
          for (var i = 0; i < STOPS.length; i++) {
            if (isNearStop(vessel, STOPS[i])) return STOPS[i].name;
          }
          return null;
        }

        var markers = {};
        var refreshBtn = document.getElementById('refresh-positions-btn');

        function computeRunStatus(row, vessel, now) {
          var depTs = parseInt(row.getAttribute('data-dep-ts'), 10);
          var arrTs = parseInt(row.getAttribute('data-arr-ts'), 10);
          if (!depTs || now < depTs) return null;

          var nextDepTs = parseInt(row.getAttribute('data-next-dep-ts'), 10);
          if (nextDepTs && now >= nextDepTs) return null;

          var origin = STOP_BY_ALIAS[row.getAttribute('data-from')];
          var dest = STOP_BY_ALIAS[row.getAttribute('data-to')];
          if (!origin) return null;

          var atOrigin = isNearStop(vessel, origin);

          if (atOrigin) {
            var overdueMin = Math.round((now - depTs) / 60000);
            if (overdueMin > DELAY_GRACE_MIN && overdueMin <= DELAY_STALE_HOURS * 60) {
              return { text: 'Delayed ' + overdueMin + 'min', className: 'badge-delayed' };
            }
            return null;
          }

          var atDest = dest && isNearStop(vessel, dest);
          var roughlyNearDest = dest && distanceMeters(vessel.lat, vessel.lon, dest.lat, dest.lon) <= ARRIVED_LOOSE_RADIUS_M;

          if (atDest || (now >= arrTs && roughlyNearDest)) {
            return { text: 'Arrived', className: 'badge-arrived' };
          }

          if ((now - depTs) > DELAY_STALE_HOURS * 3600000) {
            return null; 
          }

          var statusText = 'Departed';
          
          if (dest && typeof vessel.speedKn === 'number' && vessel.speedKn > 1.5) {
            var distMeters = distanceMeters(vessel.lat, vessel.lon, dest.lat, dest.lon);
            var distNm = distMeters / 1852;
            var hoursRemaining = distNm / vessel.speedKn;
            var minsRemaining = Math.round(hoursRemaining * 60);

            if (minsRemaining > 0 && minsRemaining < 240) {
              var etaTs = now + (minsRemaining * 60000);
              var etaDate = new Date(etaTs);
              
              var etaStr = etaDate.toLocaleTimeString('en-AU', { 
                hour: '2-digit', 
                minute: '2-digit', 
                hour12: false, 
                timeZone: 'Australia/Brisbane' 
              });
              statusText = 'ETA ' + etaStr;
            }
          }

          return { text: statusText, className: 'badge-departed' };
        }

        function updateRowStatuses(vesselByName) {
          var now = Date.now();
          document.querySelectorAll('.data-row').forEach(function (row) {
            var onWatchKey = row.getAttribute('data-onwatch-vessel');
            var vessel = vesselByName[onWatchKey];
            var badge = row.querySelector('.status-badge');
            if (!vessel || !badge) return;

            var result = computeRunStatus(row, vessel, now);
            badge.className = 'badge status-badge' + (result ? ' ' + result.className : '');
            badge.textContent = result ? result.text : badge.getAttribute('data-original-status');
          });
        }

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

        function applyPositions(vessels, labelText) {
          var vesselByName = {};
          var visibleEntries = [];

          vessels
            .filter(function (v) { return relevantVessels.indexOf((v.name || '').trim().toLowerCase()) !== -1; })
            .forEach(function (v) {
              vesselByName[(v.name || '').trim().toLowerCase()] = v;

              if (isInMaintenanceZone(v) || isStalePosition(v)) {
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

          window.lastKnownVessels = vesselByName;
          resolveLabelPlacements(visibleEntries);
          updateRowStatuses(vesselByName);

          var updatedEl = document.getElementById('map-updated');
          if (updatedEl) updatedEl.textContent = labelText;
        }

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
                  headingDeg: v.heading && v.heading.value,
                  lastUpdated: v.last_updated
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

        function refreshPositions() {
          if (liveProxyUrl) {
            fetchLivePositions();
          } else {
            fetchStaticSnapshot();
          }
        }

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

              var secondsLeft = Math.round(REFRESH_COOLDOWN_MS / 1000);
              var countdown = setInterval(function () {
                secondsLeft -= 1;
                if (secondsLeft <= 0) {
                  clearInterval(countdown);
                  refreshBtn.disabled = false;
                  refreshBtn.textContent = '↻ Refresh';
                  refreshPositions();
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
                data-onwatch-vessel="${onWatchVesselKey(vesselName)}"
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

      contentHtml += `</div>`;
    }
  }

  const mapHtml = generateVesselMapHtml(uniqueVessels.map(onWatchVesselKey));

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
      <script src="https://unpkg.com/papaparse@5.4.1/papaparse.min.js"></script>
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

        .scheduled-run-row { background-color: #e8f4fd; font-weight: bold; color: #0a3663; border-left: 4px solid #00529b; }
        .scheduled-run-row td { color: #0a3663; font-weight: bold; }

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

      ${generateLiveScheduleScript(clientName)}

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

          document.querySelectorAll('.vessel-block').forEach(vesselBlock => {
            const visibleChildRows = vesselBlock.querySelectorAll('.data-row:not([style*="display: none"])');
            vesselBlock.style.display = visibleChildRows.length > 0 ? '' : 'none';
          });

          document.querySelectorAll('.day-block').forEach(dayBlock => {
            const visibleVesselBlocks = dayBlock.querySelectorAll('.vessel-block:not([style*="display: none"])');
            dayBlock.style.display = visibleVesselBlocks.length > 0 ? '' : 'none';
          });

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
