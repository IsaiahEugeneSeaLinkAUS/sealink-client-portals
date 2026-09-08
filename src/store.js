// KV read/write. CLIENT_KV is the only namespace bound to this Worker.
//
// The Worker has no binding to DRILLS_KV, CERTS_KV, PM_KV, WORK_KV, FORMS_KV,
// CREW_KV or TASKS_KV. That is the segregation control at the platform layer:
// this code cannot read an internal register even if a future route asks it to.

import { fetchReport } from './helm.js';
import { buildLegs, scopeLegs, UNATTRIBUTED } from './trips/transform.js';

const KEY = (scope) => `legs:${scope}`;
const META = 'meta:trips';

export async function loadScope(env, scope) {
  return (await env.CLIENT_KV.get(KEY(scope), 'json')) ?? [];
}

export async function loadMeta(env) {
  return (await env.CLIENT_KV.get(META, 'json')) ?? null;
}

/** Write only when the value moved, so a static day does not burn a KV write. */
async function putIfChanged(env, key, value) {
  const next = JSON.stringify(value);
  const prev = await env.CLIENT_KV.get(key);
  if (prev === next) return false;
  await env.CLIENT_KV.put(key, next);
  return true;
}

/**
 * Pull both Helm reports and rebuild every scope.
 *
 * A refresh that comes back empty KEEPS THE PREVIOUS DATA rather than blanking
 * the registers. An empty Helm response and a genuinely empty day are the same
 * shape, and a client page reading "no runs today" because a fetch failed is
 * worse than one reading yesterday's figures with a stale stamp on it.
 *
 * Never throws. The caller gets an object it can render.
 */
export async function refreshAll(env) {
  const startedAt = Date.now();
  const result = {
    ok: false, startedAt: new Date(startedAt).toISOString(),
    ms: 0, errors: [], counts: null, changed: [], wrote: false,
    tripLogRows: 0, dispatchRows: 0,
  };

  let tripLog = [];
  let dispatch = [];
  try {
    [tripLog, dispatch] = await Promise.all([
      fetchReport(env, env.HELM_TRIPLOG_CONFIG_ID),
      fetchReport(env, env.HELM_DISPATCH_CONFIG_ID),
    ]);
  } catch (e) {
    result.errors.push(String(e && e.message ? e.message : e));
    result.ms = Date.now() - startedAt;
    await stamp(env, result);
    return result;
  }

  result.tripLogRows = tripLog.length;
  result.dispatchRows = dispatch.length;

  if (!tripLog.length) result.errors.push('The trip log report came back with no rows.');
  if (!dispatch.length) result.errors.push('The dispatch report came back with no rows.');
  if (result.errors.length) {
    result.errors.push('Previous data kept. Nothing was overwritten.');
    result.ms = Date.now() - startedAt;
    await stamp(env, result);
    return result;
  }

  const scoped = scopeLegs(buildLegs(tripLog, dispatch));
  for (const [scope, rows] of Object.entries(scoped)) {
    if (await putIfChanged(env, KEY(scope), rows)) result.changed.push(scope);
  }

  result.ok = true;
  result.wrote = result.changed.length > 0;
  result.counts = Object.fromEntries(Object.entries(scoped).map(([k, v]) => [k, v.length]));
  result.unattributed = scoped[UNATTRIBUTED].length;
  result.ms = Date.now() - startedAt;
  await stamp(env, result);
  return result;
}

/**
 * `checked` is when the source was last CONFIRMED. `fetchedAt` is when it last
 * CHANGED. Conflating them makes a healthy static register look dead.
 */
async function stamp(env, result) {
  const prev = await loadMeta(env);
  const now = new Date().toISOString();
  await env.CLIENT_KV.put(META, JSON.stringify({
    checked: result.errors.length ? (prev?.checked ?? null) : now,
    attempted: now,
    fetchedAt: result.wrote ? now : (prev?.fetchedAt ?? null),
    counts: result.counts ?? prev?.counts ?? null,
    unattributed: result.unattributed ?? prev?.unattributed ?? null,
    tripLogRows: result.tripLogRows || prev?.tripLogRows || 0,
    dispatchRows: result.dispatchRows || prev?.dispatchRows || 0,
    lastError: result.errors.length ? result.errors.join(' ') : null,
    ms: result.ms,
  }));
}
