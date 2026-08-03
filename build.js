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
  console.error('CRITICAL ERROR: HELM_CSV_URL environment variable is missing or empty in Netlify settings.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. CLIENT CONFIGURATION
// ---------------------------------------------------------------------------
const CLIENT_CONFIG = [
  { name: 'Client A', slug: 'client-a-trips-x9k2' },
  { name: 'Client B', slug: 'client-b-trips-m4p1' },
  { name: 'Client C', slug: 'client-c-trips-z8w7' }
];

async function generateSites() {
  console.log('Fetching latest Helm Connect CSV with Api-Key Header...');

  // Set the specific Api-Key header expected by Helm Connect
  const headers = {};
  if (API_KEY) {
    headers['Api-Key'] = API_KEY;
  } else {
    console.warn('WARNING: HELM_API_KEY environment variable is missing in Netlify settings.');
  }

  const response = await fetch(CSV_URL, { headers });

  console.log(`HTTP Fetch Status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    throw new Error(`Failed to download CSV from Helm Connect. HTTP Status: ${response.status} ${response.statusText}`);
  }

  const csvText = await response.text();

  console.log('--- RAW CSV SNIPPET (First 250 Characters) ---');
  console.log(csvText.substring(0, 250));
  console.log('----------------------------------------------');

  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  console.log(`Successfully parsed ${records.length} total rows from CSV.`);

  if (records.length > 0) {
    console.log('--- DETECTED CSV COLUMN HEADERS ---');
    console.log(Object.keys(records[0]));
    console.log('--- SAMPLE ROW DATA ---');
    console.log(records[0]);
    console.log('----------------------------------');
  }

  // ---------------------------------------------------------------------------
  // 3. FILTER OUT CANCELLED / UNCONFIRMED TRIPS
  // ---------------------------------------------------------------------------
  const validTrips = records.filter(row => {
    const status = (
      row['Status'] || 
      row['Job Status'] || 
      row['State'] || 
      row['Trip Status'] || 
      ''
    ).toLowerCase();

    const isCancelled = status.includes('cancel');
    const isUnconfirmed = status.includes('unconfirm') || status.includes('draft') || status.includes('pending');

    return !isCancelled && !isUnconfirmed;
  });

  console.log(`Filtered dataset down to ${validTrips.length} active/confirmed trips.`);

  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  fs.writeFileSync(path.join(publicDir, 'index.html'), `
    <!DOCTYPE html>
    <html><head><title>SeaLink Gladstone Portal</title></head>
    <body style="font-family:sans-serif; text-align:center; padding:50px;">
      <h2>SeaLink Gladstone Operations Portal</h2>
      <p>Please use your direct client portal link to view upcoming schedules.</p>
    </body></html>
  `);

  // ---------------------------------------------------------------------------
  // 4. FILTER & GENERATE PAGES PER CLIENT
  // ---------------------------------------------------------------------------
  CLIENT_CONFIG.forEach(client => {
    const clientTrips = validTrips.filter(row => {
      const customer = (
        row['Customer'] || 
        row['Account'] || 
        row['Customer Account Name'] || 
        row['Customer Name'] || 
        row['Client'] || 
        ''
      ).toLowerCase();

      return customer.includes(client.name.toLowerCase());
    });

    const clientDir = path.join(publicDir, client.slug);
    if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir);

    const htmlContent = generateHtmlTable(client.name, clientTrips);
    fs.writeFileSync(path.join(clientDir, 'index.html'), htmlContent);
    console.log(`Generated page for ${client.name} (${clientTrips.length} trips matched) at /${client.slug}/`);
  });
}

function generateHtmlTable(clientName, trips) {
  const rowsHtml = trips.length > 0
    ? trips.map(t => {
        const jobRef = t['Job #'] || t['Job Number'] || t['Reference'] || t['Job ID'] || 'N/A';
        const vessel = t['Vessel'] || t['Asset'] || t['Vessel Name'] || 'TBD';
        const departure = t['Start Time'] || t['Departure'] || t['ETA'] || t['Date'] || 'TBD';
        const origin = t['Origin'] || t['From'] || t['Departure Location'] || '';
        const destination = t['Destination'] || t['To'] || t['Arrival Location'] || '';
        const status = t['Status'] || t['Job Status'] || 'Confirmed';

        const routeText = (origin && destination) 
          ? `${origin} &rarr; ${destination}` 
          : (origin || destination || 'Local Waters');

        return `
          <tr>
            <td><strong>${jobRef}</strong></td>
            <td>${vessel}</td>
            <td>${departure}</td>
            <td>${routeText}</td>
            <td><span class="badge">${status}</span></td>
          </tr>
        `;
      }).join('')
    : `<tr><td colspan="5" style="text-align:center; padding: 25px; color: #666;">No upcoming confirmed trips found.</td></tr>`;

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
              <th>Job Ref</th>
              <th>Vessel</th>
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
