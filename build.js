const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// Helm Connect CSV URL (stored securely in Netlify Environment Variables)
const CSV_URL = process.env.HELM_CSV_URL;

// Define your 3 clients and their unique URL slugs/folder names
const CLIENT_CONFIG = [
  { name: 'Client A', slug: 'client-a-trips-x9k2' },
  { name: 'Client B', slug: 'client-b-trips-m4p1' },
  { name: 'Client C', slug: 'client-c-trips-z8w7' }
];

async function generateSites() {
  console.log('Fetching latest Helm Connect CSV...');
  const response = await fetch(CSV_URL);
  const csvText = await response.text();

  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  // 1. FILTER: Exclude Cancelled, Unconfirmed, or Draft runs
  const validTrips = records.filter(row => {
    const status = (row['Status'] || row['Job Status'] || '').toLowerCase();
    const isCancelled = status.includes('cancel');
    const isUnconfirmed = status.includes('unconfirmed') || status.includes('draft') || status.includes('pending');
    
    return !isCancelled && !isUnconfirmed;
  });

  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  // Generate landing page / root index
  fs.writeFileSync(path.join(publicDir, 'index.html'), `
    <!DOCTYPE html>
    <html><head><title>SeaLink Gladstone Portal</title></head>
    <body style="font-family:sans-serif; text-align:center; padding:50px;">
      <h2>SeaLink Gladstone Operations Portal</h2>
      <p>Please use your direct client portal link to view upcoming schedules.</p>
    </body></html>
  `);

  // 2. FILTER & BUILD PER CLIENT
  CLIENT_CONFIG.forEach(client => {
    // Filter rows belonging exclusively to this customer
    const clientTrips = validTrips.filter(row => {
      const customer = (row['Customer'] || row['Account'] || row['Customer Account Name'] || '').toLowerCase();
      return customer.includes(client.name.toLowerCase());
    });

    const clientDir = path.join(publicDir, client.slug);
    if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir);

    const htmlContent = generateHtmlTable(client.name, clientTrips);
    fs.writeFileSync(path.join(clientDir, 'index.html'), htmlContent);
    console.log(`Generated schedule for ${client.name} at /${client.slug}/`);
  });
}

function generateHtmlTable(clientName, trips) {
  const rowsHtml = trips.length > 0 
    ? trips.map(t => `
        <tr>
          <td><strong>${t['Job #'] || t['Reference'] || 'N/A'}</strong></td>
          <td>${t['Vessel'] || 'TBD'}</td>
          <td>${t['Start Time'] || t['ETA'] || ''}</td>
          <td>${t['Origin'] || ''} &rarr; ${t['Destination'] || ''}</td>
          <td><span class="badge">${t['Status'] || 'Confirmed'}</span></td>
        </tr>
      `).join('')
    : `<tr><td colspan="5" style="text-align:center; padding: 20px;">No upcoming confirmed trips found.</td></tr>`;

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
        th { background-color: #f8f9fa; color: #555; font-size: 13px; text-transform: uppercase; }
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
  console.error(err);
  process.exit(1);
});
