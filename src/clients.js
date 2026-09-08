// Client identity, site geography and scope. This file is the segregation control.
//
// Attribution is by LOCATION first. The berths are physically separated pieces
// of infrastructure, so a leg that touched CP1 was an APLNG movement whatever
// any booking record says. That is a stronger primitive than a booking,
// because a booking can be absent, late or wrong and a wharf cannot.
//
// Do not add a fuzzy match, a lowercase-and-hope, or a "contains" here. Three
// systems already spell the same client three different ways, and the point of
// this file is that a fourth spelling is a visible fault, not a silent leak.

export const CLIENTS = {
  aplng: { id: 'aplng', name: 'Australia Pacific LNG', short: 'APLNG' },
  qgc:   { id: 'qgc',   name: 'Queensland Gas Company', short: 'QGC' },
  glng:  { id: 'glng',  name: 'Gladstone LNG',          short: 'GLNG' },
};

// ---------------------------------------------------------------- geography

// Berths belonging to exactly one client. Verified against 5,686 attributed
// legs over 5 July - 8 September 2026: each of these appeared with one client
// and no other, on both the from and the to side.
export const SITE_CLIENT = new Map(Object.entries({
  CP1: 'aplng',
  CP3: 'aplng',
  QC3: 'qgc',
  QC4: 'qgc',
  GL4: 'glng',
}));

// Sites used by more than one client, or by none. These carry no attribution.
// GL3 is the important one: 730 GLNG departures and 486 QGC departures across
// the sample. Reading GL3 as GLNG because of the name would misattribute
// roughly two thousand QGC legs.
export const SHARED_SITES = new Set([
  'GL3', 'Marina', 'Service Wharf', 'Maintenance Slipway', 'Maintenance Wharf',
  'Marine Operations Terminal', 'Gladstone', 'Bruce',
]);

// ------------------------------------------------------------------- fleet

// The barge is a QGC/GLNG joint venture: shown to both, and to neither as
// ferry activity. Barge movements are not dispatched, so they carry no trip
// number, and they run QC4 to GL4 between two clients' berths. Neither the
// location rule nor the booking rule can attribute them. Resource is the key.
export const BARGE_RESOURCES = new Set(['Bruce', 'Quandamooka']);
export const JV_CLIENTS = ['qgc', 'glng'];

// ---------------------------------------------------------------- services
//
// Three commercial arrangements, not one. Keeping them apart matters because
// shipping work is booked by agents and invoiced on a separate internal
// report, so a shipping leg appearing in the ferry service figures is the same
// activity presented twice under two different agreements.

export const SERVICE = { FERRY: 'ferry', SHIPPING: 'shipping', JV: 'jv' };

// R.B. Trojan runs shipping work for QGC: surveyors, off-signers, shore
// leavers, bunker attendance. 179 of her 221 legs over the sample touched QC3
// and she carried no ferry service at all. She does cover occasionally, so she
// is classified rather than deleted.
export const SHIPPING_RESOURCES = new Set(['R.B. Trojan']);

// QC3 is the shipping berth. Every one of the 279 legs that touched it over
// the sample attributed to QGC, and 100 of them were FERRIES doing agent work
// rather than Trojan.
//
// Those 100 are NOT reclassified. The daily report has always counted them as
// ferry service and they may well be charged that way; moving them would
// change a client's reported figures on a judgement nobody has made. They are
// flagged instead, so the question is visible and answerable. See STATUS.md.
export const SHIPPING_SITES = new Set(['QC3']);

export const EXCLUDED_RESOURCES = new Set(['Reef Quest']);

/**
 * Which arrangement a leg was run under. Attribution to a client is a separate
 * question, answered by berth, booking and adjacency in transform.js.
 */
export function serviceFor({ resource }) {
  if (BARGE_RESOURCES.has(resource)) return SERVICE.JV;
  if (SHIPPING_RESOURCES.has(resource)) return SERVICE.SHIPPING;
  return SERVICE.FERRY;
}

/**
 * Did this leg call at the shipping berth? A flag, not a classification.
 * A ferry that calls at QC3 is doing agent work under a different booking
 * arrangement, which is also one of the eight cl.2.3(b) categories that sit
 * outside the 20-trip allowance. Worth counting; not worth silently moving.
 */
export function touchedShippingBerth({ from, to }) {
  return SHIPPING_SITES.has(String(from ?? '').trim())
      || SHIPPING_SITES.has(String(to ?? '').trim());
}

// ---------------------------------------------------------------- bookings

// Exact upstream client strings. The second layer, and a continuous check on
// the first: location and booking agreed on 3,987 of 3,987 legs where both
// fired, with zero disagreements. A disagreement is reported, not resolved by
// preferring one source.
export const ALIASES = new Map(Object.entries({
  'Australian Pacific LNG': 'aplng',   // Helm Dispatch
  'Queensland Gas Company': 'qgc',
  'Gladstone LNG': 'glng',
  'Australia Pacific LNG': 'aplng',    // Power BI slicer
  'Shell QGC': 'qgc',
}));

export function resolveClient(raw) {
  if (raw === null || raw === undefined) return null;
  const hit = ALIASES.get(String(raw));
  return hit && CLIENTS[hit] ? hit : null;
}

/**
 * Attribution from the two berths a leg touched.
 * { client } | { conflict: [a, b] } | null.
 * A leg between two different clients' berths is a conflict, not a coin toss.
 */
export function resolveBySite(from, to) {
  const a = SITE_CLIENT.get(String(from ?? '').trim()) ?? null;
  const b = SITE_CLIENT.get(String(to ?? '').trim()) ?? null;
  if (a && b) return a === b ? { client: a } : { conflict: [a, b] };
  const one = a ?? b;
  return one ? { client: one } : null;
}

export function isSharedSite(site) {
  const s = String(site ?? '').trim();
  return s === '' || SHARED_SITES.has(s);
}

export function isKnownClient(id) {
  return Object.prototype.hasOwnProperty.call(CLIENTS, id);
}

/** The only visibility question the page layer is allowed to ask. */
export function visibleTo(leg, clientId) {
  return (leg.audience ?? []).some((a) => a.client === clientId);
}
