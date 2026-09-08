// Join the Helm trip log to the dispatch schedule and attribute each leg.
//
// The two sources answer different questions. Dispatch is what was booked, and
// carries the client. The trip log is what the vessel actually did, and does
// not. Crews log a run whether or not it was booked, so the trip log is the
// larger set and the booking cannot be the only key.
//
// Four layers, in this order, each recorded on the leg so a figure can be
// traced back to the evidence that produced it.
//
//   1. LOCATION   CP1, CP3 are APLNG. QC3, QC4 are QGC. GL4 is GLNG. These are
//                 separate pieces of infrastructure, so a leg that touched one
//                 was that client's movement. GL3, Marina and Service Wharf
//                 are shared and carry nothing.
//   2. BOOKING    Trip Number joins to dispatch. Unique across 5,338 dispatch
//                 rows; 4,973 of 4,978 numbered legs matched; vessel agreed on
//                 all 4,973.
//   3. ADJACENCY  A repositioning leg between two shared berths belongs to
//                 whatever the same vessel was doing either side of it, within
//                 six hours. Vessels move between clients during breakdowns and
//                 cover, so this must be computed per leg and never per vessel.
//   4. BARGE      Resource only. See clients.js.
//
// Measured on the 5 July - 8 September 2026 exports: 6,101 legs, 17 left
// unattributed (0.28%), carrying zero passengers and five litres of fuel.
// Layer 1 alone resolved 4,608, layer 2 a further 986, layer 3 a further 276.
//
// Layers 1 and 2 agreed on 3,987 of 3,987 legs where both fired. That
// agreement is a standing check: a disagreement means a berth changed hands or
// a booking is against the wrong vessel, and it is surfaced rather than
// silently resolved in favour of either source.

import { num } from '../helm.js';
import {
  resolveClient, resolveBySite, BARGE_RESOURCES, JV_CLIENTS,
  SERVICE, EXCLUDED_RESOURCES, CLIENTS, serviceFor, touchedShippingBerth,
} from '../clients.js';

export const UNATTRIBUTED = 'unattributed';

/** How far either side of a leg adjacency will look. */
export const ADJACENCY_WINDOW_MS = 6 * 3600_000;

const ts = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + '+10:00') : NaN);

export function buildLegs(tripLogRows, dispatchRows) {
  const byTrip = new Map();
  for (const d of dispatchRows) {
    const tn = (d['Trip Number'] || '').trim();
    if (tn) byTrip.set(tn, d);
  }

  const legs = [];
  for (const t of tripLogRows) {
    const resource = (t.Resource || '').trim();
    if (!resource || EXCLUDED_RESOURCES.has(resource)) continue;

    // Helm stamps Archived with a datetime when a record is withdrawn. An
    // archived leg is a correction, not activity, and must not be reported.
    if ((t.Archived || '').trim() !== '') continue;

    const tn = (t['Trip Number'] || '').trim();
    const d = tn ? byTrip.get(tn) : undefined;
    const mismatch = !!d && (d.Resource || '').trim() !== resource;
    const disp = mismatch ? undefined : d;

    // Nancy Wake has no OnWatch unit, so 649 of her 722 legs carry no location
    // in the trip log at all. Fall back to the booked berths, the same
    // consolidation the Power BI model does.
    const from = (t['Location From Name'] || '').trim() || (disp?.['Location From Name'] || '').trim();
    const to = (t['Location To Name'] || '').trim() || (disp?.['Location To Name'] || '').trim();

    legs.push({
      resource,
      tripNumber: tn || null,
      start: t.Start || null,
      end: t.End || null,
      from: from || null,
      to: to || null,
      runType: (t['Run Type'] || disp?.['Trip Type Name'] || '').trim() || null,
      comment: t.Comment || null,
      pax: num(t.PAX),
      co2: num(t['CO2 Emissions (kg CO2)']),
      nm: num(t['Distance (nmi)']),
      fuelL: num(t['Fuel Used (L)']),
      fuelEff: num(t['Fuel Efficiency (l/nm)']),
      recordedBy: t['Recorded By'] || null,
      activityType: t['Activity Type Name'] || null,
      clientRaw: disp?.['Customer Account Name'] ?? null,
      scheduledStart: disp?.Start ?? null,
      bookingNote: disp?.['Comments to Crew'] ?? null,
      dispatchStatus: disp?.Status ?? null,
      service: serviceFor({ resource }),
      shippingBerth: touchedShippingBerth({ from, to }),
      _t: ts(t.Start),
      vesselMismatch: mismatch,
      client: null,
      basis: null,
      unmatchedReason: null,
      conflict: null,
    });
  }

  attribute(legs);
  for (const leg of legs) leg.audience = audience(leg);
  return legs;
}

function attribute(legs) {
  // --- layer 4 first, because it removes the barge from every other rule ---
  for (const leg of legs) {
    if (BARGE_RESOURCES.has(leg.resource)) {
      leg.client = 'jv';
      leg.basis = 'barge';
    }
  }

  // --- layers 1 and 2, with the cross-check between them ---
  for (const leg of legs) {
    if (leg.client) continue;

    const site = resolveBySite(leg.from, leg.to);
    const booked = resolveClient(leg.clientRaw);

    if (site?.conflict) {
      // Between two clients' berths on a ferry. Fall to the booking if there
      // is one, and record the conflict either way.
      leg.conflict = `berths name ${site.conflict.join(' and ')}`;
      if (booked) { leg.client = booked; leg.basis = 'booking (berths conflict)'; }
      else leg.unmatchedReason = `leg runs between ${leg.from} and ${leg.to}, which belong to different clients`;
      continue;
    }

    if (site?.client && booked && site.client !== booked) {
      // Never seen in the sample. If it happens, neither source is trusted.
      leg.conflict = `berth says ${site.client}, booking says ${booked}`;
      leg.unmatchedReason = leg.conflict;
      continue;
    }

    if (site?.client) { leg.client = site.client; leg.basis = 'berth'; continue; }
    if (booked) { leg.client = booked; leg.basis = 'booking'; continue; }

    if (leg.vesselMismatch) {
      leg.unmatchedReason = `booking ${leg.tripNumber} is against a different vessel`;
    } else if (leg.clientRaw) {
      leg.unmatchedReason = `client string not in the map: ${JSON.stringify(leg.clientRaw)}`;
    }
  }

  // --- layer 3: adjacency, per vessel, in time order ---
  const byVessel = new Map();
  for (const leg of legs) {
    if (BARGE_RESOURCES.has(leg.resource)) continue;
    if (!byVessel.has(leg.resource)) byVessel.set(leg.resource, []);
    byVessel.get(leg.resource).push(leg);
  }

  for (const run of byVessel.values()) {
    run.sort((a, b) => (a._t || 0) - (b._t || 0));
    for (let i = 0; i < run.length; i++) {
      const leg = run[i];
      if (leg.client || leg.conflict || !Number.isFinite(leg._t)) continue;

      const before = nearest(run, i, -1, leg._t);
      const after = nearest(run, i, +1, leg._t);

      if (before && after) {
        if (before === after) { leg.client = before; leg.basis = 'adjacent legs, both sides agree'; }
        else leg.unmatchedReason = `the legs either side belong to different clients (${before}, ${after})`;
      } else if (before) {
        leg.client = before; leg.basis = 'the previous leg on this vessel';
      } else if (after) {
        leg.client = after; leg.basis = 'the next leg on this vessel';
      } else {
        leg.unmatchedReason ??= 'no berth, no booking, and no attributed leg within six hours';
      }
    }
  }

  for (const leg of legs) {
    if (!leg.client && !leg.unmatchedReason) leg.unmatchedReason = 'could not be attributed';
  }
}

function nearest(run, i, dir, t) {
  for (let k = i + dir; k >= 0 && k < run.length; k += dir) {
    const c = run[k];
    if (!c.client || c.client === 'jv') continue;
    if (!Number.isFinite(c._t) || Math.abs(c._t - t) > ADJACENCY_WINDOW_MS) return null;
    return c.client;
  }
  return null;
}

function audience(leg) {
  if (leg.client === 'jv') return JV_CLIENTS.map((c) => ({ client: c, service: SERVICE.JV }));
  if (leg.client && CLIENTS[leg.client]) return [{ client: leg.client, service: leg.service }];
  return [];
}

export function scopeLegs(legs) {
  const out = { aplng: [], qgc: [], glng: [], [UNATTRIBUTED]: [] };
  for (const leg of legs) {
    if (!leg.audience.length) { out[UNATTRIBUTED].push(leg); continue; }
    for (const a of leg.audience) {
      if (!out[a.client]) { out[UNATTRIBUTED].push(leg); continue; }
      out[a.client].push({ ...leg, service: a.service });
    }
  }
  return out;
}

const SUM_FIELDS = ['pax', 'nm', 'fuelL', 'co2'];

export function summarise(legs) {
  const byVessel = new Map();
  for (const leg of legs) {
    if (!byVessel.has(leg.resource)) {
      byVessel.set(leg.resource, {
        resource: leg.resource, legs: 0, pax: 0, nm: 0, fuelL: 0, co2: 0,
        missing: { pax: 0, nm: 0, fuelL: 0, co2: 0 },
      });
    }
    const v = byVessel.get(leg.resource);
    v.legs += 1;
    for (const f of SUM_FIELDS) {
      if (leg[f] === null) v.missing[f] += 1; else v[f] += leg[f];
    }
  }
  const vessels = [...byVessel.values()].sort((a, b) => a.resource.localeCompare(b.resource));
  const total = { resource: 'Total', legs: 0, pax: 0, nm: 0, fuelL: 0, co2: 0, missing: { pax: 0, nm: 0, fuelL: 0, co2: 0 } };
  for (const v of vessels) {
    total.legs += v.legs;
    for (const f of SUM_FIELDS) { total[f] += v[f]; total.missing[f] += v.missing[f]; }
  }
  return { vessels, total };
}

/** Brisbane is a fixed +10 offset with no daylight saving. */
export const brisbaneDate = (iso) => (iso || '').slice(0, 10);
export const legsOn = (legs, day) => legs.filter((l) => brisbaneDate(l.start) === day);
export const ofService = (legs, service) => legs.filter((l) => l.service === service);
