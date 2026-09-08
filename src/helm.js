// Helm Connect CSV fetch and parse.
//
// Helm wraps every text cell as ="value" so Excel treats it as a string. The
// raw bytes for one cell are: ="""Torresian""" . Numeric and date cells are
// not wrapped. Strip the wrapper before anything else touches the value.

const BOM = '\uFEFF';

export function parseCsv(text) {
  if (text.startsWith(BOM)) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];

  const header = rows[0].map(unwrap);
  return rows.slice(1)
    .filter((r) => r.length > 1)
    .map((r) => {
      const o = {};
      header.forEach((h, i) => { o[h] = unwrap(r[i] ?? ''); });
      return o;
    });
}

// ="Torresian"  ->  Torresian
export function unwrap(v) {
  if (typeof v !== 'string') return v;
  let s = v.trim();
  if (s.startsWith('="') && s.endsWith('"')) s = s.slice(2, -1);
  return s.replace(/^"+|"+$/g, '').trim();
}

// Helm authenticates with an Api-Key header, not a bearer token, and the
// timezone is a query parameter rather than a header. Taken from the working
// Power Query definition in Daily Trip Data - Client Report Fork 2.pbix.
export async function fetchReport(env, configId) {
  const url = env.HELM_CSV_URL.replace('{configId}', configId);
  const res = await fetch(url, {
    headers: { 'Api-Key': env.HELM_API_KEY, Accept: 'text/csv' },
  });
  if (!res.ok) throw new Error(`Helm report ${configId} returned ${res.status}`);
  return parseCsv(await res.text());
}

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
