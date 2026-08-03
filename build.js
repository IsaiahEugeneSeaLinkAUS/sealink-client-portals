const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// ---------------------------------------------------------------------------
// 1. ENVIRONMENT VARIABLES & SANITIZATION
// ---------------------------------------------------------------------------
const rawUrl = process.env.HELM_CSV_URL || '';
const CSV_URL = rawUrl.trim().replace(/^["']|["']$/g, '');
const API_KEY = (process.env.HELM_API_KEY || '').trim().replace(/^["']|["']$/g, '');

if (!CSV_URL) {
  console.error('CRITICAL ERROR: HELM_CSV_URL environment variable is missing in Netlify settings.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. CLIENT CONFIGURATION (Helm Customer Account Names & URL Slugs)
// ---------------------------------------------------------------------------
const CLIENT_CONFIG = [
  { name: 'Australian Pacific LNG', slug: 'aplng-schedules-x9k2' },
  { name: 'Gladstone LNG', slug: 'glng-schedules-m4p1' },
  { name: 'Queensland Gas Company', slug: 'qgc-schedules-z8w7' }
];

async function generateSites() {
  console.log('Fetching latest Helm Connect CSV...');

  const headers = {};
  if (API_KEY) {
    headers['Api-Key'] = API_KEY;
  }

  const response = await fetch(CSV_URL, { headers });
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

  // Sort chronologically ascending (earliest upcoming trip first)
  validTrips.sort((a, b) => {
    const dateA = new Date(a['Start'] || a['Requested Date']);
    const dateB = new Date(b['Start'] || b['Requested Date']);
    return dateA - dateB;
  });

  console.log(`Deduplicated and sorted down to ${validTrips.length} upcoming confirmed trips.`);

  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  // Root Landing Page
  fs.writeFileSync(path.join(publicDir, 'index.html'), `
    <!DOCTYPE html>
    <html><head><title>SeaLink Gladstone Portal</title></head>
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

function formatDateHeader(dateObj) {
  if (isNaN(dateObj.getTime())) return 'Upcoming Trips';
  
  return dateObj.toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Brisbane'
  });
}

function formatIsoDate(dateObj) {
  if (isNaN(dateObj.getTime())) return '';
  // YYYY-MM-DD for date filtering comparisons
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimeOnly(dateObj) {
  if (isNaN(dateObj.getTime())) return 'TBD';

  return dateObj.toLocaleTimeString('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Australia/Brisbane'
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

  if (lower.includes('internal')) {
    return `<em class="run-type-internal">${clean}</em>`;
  } else if (lower.includes('scheduled')) {
    return `<strong class="run-type-scheduled">${clean}</strong>`;
  } else if (lower.includes('extra')) {
    return `<span class="run-type-extra">${clean}</span>`;
  } else {
    return `<span>${clean}</span>`;
  }
}

function generateGroupedHtmlTable(clientName, trips) {
  // Collect unique vessels and run types for dropdown options
  const uniqueVessels = Array.from(new Set(trips.map(t => (t['Resource'] || t['Vessel'] || 'Unassigned').trim()))).sort();
  const uniqueRunTypes = Array.from(new Set(trips.map(t => (t['Trip Type Name'] || 'Scheduled Run').trim()))).sort();

  // Vessel Options
  const vesselOptionsHtml = uniqueVessels.map(v => `<option value="${v}">${v}</option>`).join('');
  // Run Type Options
  const runTypeOptionsHtml = uniqueRunTypes.map(rt => `<option value="${rt}">${rt}</option>`).join('');

  let contentHtml = '';

  if (trips.length === 0) {
    contentHtml = `<div style="text-align:center; padding: 40px; color: #666;">No upcoming confirmed trips scheduled.</div>`;
  } else {
    // Structure: Group by Vessel -> Group by Date
    const vesselGroups = {};

    trips.forEach(t => {
      const vessel = (t['Resource'] || t['Vessel'] || 'Unassigned').trim();
      const dStart = new Date(t['Start'] || t['Requested Date']);
      const dEnd = new Date(t['End']);
      const dateLabel = formatDateHeader(dStart);
      const isoDate = formatIsoDate(dStart);

      if (!vesselGroups[vessel]) {
        vesselGroups[vessel] = {};
      }
      if (!vesselGroups[vessel][dateLabel]) {
        vesselGroups[vessel][dateLabel] = [];
      }

      vesselGroups[vessel][dateLabel].push({ row: t, dStart, dEnd, isoDate });
    });

    for (const [vesselName, datesDict] of Object.entries(vesselGroups)) {
      contentHtml += `
        <div class="vessel-block" data-vessel-name="${vesselName.toLowerCase()}">
          <div class="vessel-header-banner">
            <span>🚢 Vessel: <strong>${vesselName}</strong></span>
          </div>
          <table class="schedule-table">
            <thead>
              <tr>
                <th>Run Type</th>
                <th>Departure Loc</th>
                <th>Dep Time</th>
                <th>Arrival Loc</th>
                <th>Arr Time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
      `;

      for (const [dateLabel, dayTrips] of Object.entries(datesDict)) {
        const dateKey = `${vesselName.toLowerCase()}-${dayTrips[0].isoDate}`;

        contentHtml += `
          <tr class="date-header-row" data-date-group="${dateKey}">
            <td colspan="6" class="date-header">📅 ${dateLabel}</td>
          </tr>
        `;

        dayTrips.forEach(({ row, dStart, dEnd, isoDate }) => {
          const runTypeRaw = row['Trip Type Name'] || 'Scheduled Run';
          const runTypeHtml = formatRunTypeHtml(runTypeRaw);
          const depLoc = row['Location From Name'] || row['Origin'] || '-';
          const depTime = formatTimeOnly(dStart);
          const arrLoc = row['Location To Name'] || row['Destination'] || '-';
          const arrTime = formatTimeOnly(dEnd);
          const status = formatStatus(row['Status']);

          const isExtra = runTypeRaw.toLowerCase().includes('extra');
          const rowClass = isExtra ? 'data-row extra-run-row' : 'data-row';

          contentHtml += `
            <tr class="${rowClass}" 
                data-vessel="${vesselName.toLowerCase()}" 
                data-runtype="${runTypeRaw.toLowerCase()}" 
                data-date="${isoDate}"
                data-date-group="${dateKey}">
              <td>${runTypeHtml}</td>
              <td><strong>${depLoc}</strong></td>
              <td>${depTime}</td>
              <td><strong>${arrLoc}</strong></td>
              <td>${arrTime}</td>
              <td><span class="badge">${status}</span></td>
            </tr>
          `;
        });
      }

      contentHtml += `
            </tbody>
          </table>
        </div>
      `;
    }
  }

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${clientName} - Upcoming Vessel Trips | SeaLink Gladstone</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f8; color: #333; margin: 0; padding: 20px; }
        .container { max-width: 1100px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #00529b; padding-bottom: 12px; margin-bottom: 20px; }
        h1 { color: #00529b; margin: 0; font-size: 24px; }
        .timestamp { font-size: 12px; color: #666; }
        
        /* Filter Control Bar */
        .filter-panel { background: #f0f4f8; border: 1px solid #d0dbe5; border-radius: 6px; padding: 16px; margin-bottom: 24px; display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; }
        .filter-group { display: flex; flex-direction: column; gap: 6px; }
        .filter-group label { font-size: 12px; font-weight: bold; color: #00529b; text-transform: uppercase; letter-spacing: 0.5px; }
        .filter-group select, .filter-group input { padding: 8px 12px; border: 1px solid #b0c4de; border-radius: 4px; font-size: 13px; background: #fff; min-width: 160px; }
        .btn-reset { padding: 8px 16px; background: #00529b; color: #fff; border: none; border-radius: 4px; font-weight: bold; font-size: 13px; cursor: pointer; transition: background 0.2s; }
        .btn-reset:hover { background: #003a6e; }

        /* Vessel Group Styling */
        .vessel-block { margin-bottom: 28px; border: 1px solid #d0dbe5; border-radius: 6px; overflow: hidden; background: #fff; }
        .vessel-header-banner { background: #00529b; color: #fff; padding: 12px 16px; font-size: 16px; font-weight: bold; }

        /* Schedule Tables */
        .schedule-table { width: 100%; border-collapse: collapse; }
        .schedule-table th, .schedule-table td { text-align: left; padding: 12px; border-bottom: 1px solid #e1e4e8; }
        .schedule-table th { background-color: #f8f9fa; color: #555; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
        
        .date-header-row { background-color: #e8f1f8; }
        .date-header { color: #00529b; font-weight: bold; font-size: 13px; padding: 10px 12px; border-top: 1px solid #00529b; border-bottom: 1px solid #00529b; }
        
        /* Run Type Specific Formatting */
        .run-type-scheduled { font-weight: bold; color: #111; }
        .run-type-internal { font-style: italic; color: #444; }
        .run-type-extra { background-color: #ffe8cc; color: #d97706; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; border: 1px solid #fbd38d; display: inline-block; }
        .extra-run-row { background-color: #fffaf0; }

        .badge { background: #e6f4ea; color: #137333; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; }
        .no-results { display: none; text-align: center; padding: 40px; color: #888; font-size: 15px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div>
            <h1>${clientName} Schedule</h1>
            <p style="margin: 4px 0 0 0; color: #666;">SeaLink Gladstone Operational Portal</p>
          </div>
          <div class="timestamp">Updated: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })} AEST</div>
        </div>

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

          // Toggle Date Header Row Visibility
          document.querySelectorAll('.date-header-row').forEach(header => {
            const dateGroupKey = header.getAttribute('data-date-group');
            const matchingRows = document.querySelectorAll('.data-row[data-date-group="' + dateGroupKey + '"]');
            const hasVisibleChild = Array.from(matchingRows).some(r => r.style.display !== 'none');
            header.style.display = hasVisibleChild ? '' : 'none';
          });

          // Toggle Vessel Block Visibility
          document.querySelectorAll('.vessel-block').forEach(block => {
            const visibleChildRows = block.querySelectorAll('.data-row:not([style*="display: none"])');
            block.style.display = visibleChildRows.length > 0 ? '' : 'none';
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
