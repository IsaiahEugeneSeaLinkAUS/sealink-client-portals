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
    throw new Error(`Failed to download CSV from Helm Connect. HTTP Status: ${response.status} ${response.statusText}`);
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
  const validTrips = records.filter(row => {
    const status = String(
      row['Status'] || 
      row['Job Status'] || 
      row['Trip Status'] || 
      ''
    ).toUpperCase().trim();

    const isCancelled = status.includes('CANCEL');
    const isComplete = status.includes('COMPLETE');
    const isDraft = status.includes('DRAFT') || status.includes('PENDING') || status.includes('UNCONFIRM');

    // Keep strictly active, confirmed upcoming runs
    return !isCancelled && !isComplete && !isDraft;
  });

  console.log(`Filtered down to ${validTrips.length} upcoming confirmed trips.`);

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
  // 4. GENERATE INDIVIDUAL CLIENT PORTALS
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

    const htmlContent = generateHtmlTable(client.name, clientTrips);
    fs.writeFileSync(path.join(clientDir, 'index.html'), htmlContent);
    console.log(`Generated schedule for ${client.name} (${clientTrips.length} upcoming trips) at /${client.slug}/`);
  });
}

function formatDate(dateStr) {
  if (!dateStr) return 'TBD';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  
  return d.toLocaleString('en-AU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
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

function generateHtmlTable(clientName, trips) {
  const rowsHtml = trips.length > 0
    ? trips.map(t => {
        const runType = t['Trip Type Name'] || 'Scheduled Run';
        const departure = formatDate(t['Start'] || t['Requested Date']);
        const origin = t['Location From Name'] || '';
        const destination = t['Location To Name'] || '';
        const status = formatStatus(t['Status']);

        const routeText = (origin && destination) 
          ? `${origin} &rarr; ${destination}` 
          : (origin || destination || 'Local Waters');

        return `
          <tr>
            <td><strong>${runType}</strong></td>
            <td>${departure}</td>
            <td>${routeText}</td>
            <td><span class="badge">${status}</span></td>
          </tr>
        `;
      }).join('')
    : `<tr><td colspan="4" style="text-align:center; padding: 25px; color: #666;">No upcoming confirmed trips scheduled.</td></tr>`;

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${clientName} - Upcoming Vessel Trips | SeaLink Gladstone</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f8; color: #333; margin: 0; padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #00529b; padding-bottom: 12px; margin-bottom: 20px; }
        h1 { color: #00529b; margin: 0; font-size: 24px; }
        .timestamp { font-size: 12px; color: #666; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e1e4e8; }
        th { background-color: #f8f9fa; color: #555; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
        .badge { background: #e6f4ea; color: #137333; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; }
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
        <table>
          <thead>
            <tr>
              <th>Run Type</th>
              <th>Departure / Time</th>
              <th>Route</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `;
}

generateSites().catch(err => {
  console.error('FATAL BUILD ERROR:', err);
  process.exit(1);
});
