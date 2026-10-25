// airports.js — load data/airports.json, autocomplete search, alternate finder.

import { haversineNM, distanceToRouteSegmentNM } from './nav.js';

let _airports = [];
let _byIdent = new Map();
let _index = []; // pre-lowercased search fields
// Names that signal airfields the public can't normally use for a fuel stop.
const NOT_PUBLIC = /\b(naval|air force|afb|army|marine corps|joint base|air station|heliport|helipad|seaplane|nas)\b/i;

/** Load and index the airport database. Returns the number of airports loaded. */
export async function loadAirports(url = 'data/airports.json') {
  if (_airports.length) return _airports.length;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Could not load airport database (HTTP ${res.status}). ` +
        'If you are running locally, generate it first with: node scripts/build-airports.mjs',
    );
  }
  const json = await res.json();
  const list = Array.isArray(json) ? json : json?.airports;
  if (!Array.isArray(list) || list.length === 0) throw new Error('Airport database is empty or malformed.');

  _airports = list;
  _byIdent = new Map(list.map((a) => [a.ident.toUpperCase(), a]));
  _index = list.map((a) => ({
    a,
    ident: a.ident.toUpperCase(),
    name: (a.name || '').toLowerCase(),
    city: (a.municipality || '').toLowerCase(),
  }));
  return _airports.length;
}

export function airportCount() {
  return _airports.length;
}

export function getAirport(ident) {
  return _byIdent.get(String(ident || '').trim().toUpperCase()) || null;
}

/**
 * Autocomplete. Ranks exact ident > ident prefix > city prefix > name prefix > substring.
 * Within a rank, larger airports (longer runway) come first.
 */
export function searchAirports(query, limit = 8) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const qU = q.toUpperCase();
  const qL = q.toLowerCase();

  const scored = [];
  for (const e of _index) {
    let score;
    if (e.ident === qU) score = 0;
    else if (e.ident.startsWith(qU)) score = 1;
    else if (e.city.startsWith(qL)) score = 2;
    else if (e.name.startsWith(qL)) score = 3;
    else if (e.ident.includes(qU)) score = 4;
    else if (e.city.includes(qL) || e.name.includes(qL)) score = 5;
    else continue;
    scored.push({ score, a: e.a });
    if (scored.length > 400) break; // plenty to rank from; keeps typing snappy
  }
  scored.sort(
    (x, y) =>
      x.score - y.score ||
      (y.a.runway_length_ft || 0) - (x.a.runway_length_ft || 0) ||
      x.a.name.localeCompare(y.a.name),
  );
  return scored.slice(0, limit).map((s) => s.a);
}

/**
 * Alternates: airports within `maxOffsetNM` of the great-circle route segment,
 * with a runway ≥ `minRunwayFt`, excluding departure/destination,
 * sorted by distance from destination. Returns up to `limit` entries with
 * `distFromRouteNM` and `distFromDestNM` attached.
 */
export function findAlternates(dep, dest, { maxOffsetNM = 25, minRunwayFt = 2500, limit = 5 } = {}) {
  // Coarse bounding box first (25 NM ≈ 0.42° lat), then exact spherical distance.
  const pad = maxOffsetNM / 60 + 0.1;
  const minLat = Math.min(dep.lat, dest.lat) - pad;
  const maxLat = Math.max(dep.lat, dest.lat) + pad;
  const cosLat = Math.max(0.2, Math.cos(((dep.lat + dest.lat) / 2) * (Math.PI / 180)));
  const lonPad = pad / cosLat;
  const minLon = Math.min(dep.lon, dest.lon) - lonPad;
  const maxLon = Math.max(dep.lon, dest.lon) + lonPad;

  const out = [];
  for (const a of _airports) {
    if (a.ident === dep.ident || a.ident === dest.ident) continue;
    if (!(a.runway_length_ft >= minRunwayFt)) continue;
    if (a.lat < minLat || a.lat > maxLat || a.lon < minLon || a.lon > maxLon) continue;
    const off = distanceToRouteSegmentNM(dep.lat, dep.lon, dest.lat, dest.lon, a.lat, a.lon);
    if (off > maxOffsetNM) continue;
    out.push({
      ...a,
      distFromRouteNM: off,
      distFromDestNM: haversineNM(dest.lat, dest.lon, a.lat, a.lon),
    });
  }
  out.sort((x, y) => x.distFromDestNM - y.distFromDestNM);
  return out.slice(0, limit);
}

/**
 * Alternates for a multi-leg route: airports within `maxOffsetNM` of ANY leg, runway ≥ `minRunwayFt`,
 * excluding every airport on the route, sorted by distance from the final destination.
 */
export function findAlternatesAlongRoute(route, { maxOffsetNM = 25, minRunwayFt = 2500, limit = 5 } = {}) {
  const dest = route[route.length - 1];
  const ids = new Set(route.map((r) => r.ident));
  const pad = maxOffsetNM / 60 + 0.1;
  const lats = route.map((r) => r.lat);
  const lons = route.map((r) => r.lon);
  const cosLat = Math.max(0.2, Math.cos((lats.reduce((s, v) => s + v, 0) / lats.length) * (Math.PI / 180)));
  const minLat = Math.min(...lats) - pad, maxLat = Math.max(...lats) + pad;
  const minLon = Math.min(...lons) - pad / cosLat, maxLon = Math.max(...lons) + pad / cosLat;

  const out = [];
  for (const a of _airports) {
    if (ids.has(a.ident)) continue;
    if (!(a.runway_length_ft >= minRunwayFt)) continue;
    if (a.lat < minLat || a.lat > maxLat || a.lon < minLon || a.lon > maxLon) continue;
    let off = Infinity;
    for (let i = 0; i < route.length - 1; i++) {
      off = Math.min(off, distanceToRouteSegmentNM(route[i].lat, route[i].lon, route[i + 1].lat, route[i + 1].lon, a.lat, a.lon));
    }
    if (off > maxOffsetNM) continue;
    out.push({ ...a, distFromRouteNM: off, distFromDestNM: haversineNM(dest.lat, dest.lon, a.lat, a.lon) });
  }
  out.sort((x, y) => x.distFromDestNM - y.distFromDestNM);
  return out.slice(0, limit);
}

/**
 * Layover (fuel stop) options between airports `a` and `b`: airports close to the direct route with a
 * decent runway. `feasible(d1, d2)` lets the caller reject stops that are out of range
 * (d1 = a → stop, d2 = stop → b, both in NM). Sorted by the extra distance flown (detour).
 * NOTE: the airport database has no fuel-availability data, so callers must remind pilots to check.
 */
export function findLayoverOptions(a, b, { maxOffsetNM = 25, minRunwayFt = 4000, exclude = new Set(), feasible = () => true, limit = 3 } = {}) {
  const direct = haversineNM(a.lat, a.lon, b.lat, b.lon);
  const pad = maxOffsetNM / 60 + 0.1;
  const cosLat = Math.max(0.2, Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)));
  const minLat = Math.min(a.lat, b.lat) - pad, maxLat = Math.max(a.lat, b.lat) + pad;
  const minLon = Math.min(a.lon, b.lon) - pad / cosLat, maxLon = Math.max(a.lon, b.lon) + pad / cosLat;
  const minHop = Math.min(20, direct * 0.15);   // don't "stop" a few miles from where you already are

  const out = [];
  for (const c of _airports) {
    if (exclude.has(c.ident) || !(c.runway_length_ft >= minRunwayFt) || NOT_PUBLIC.test(c.name || '')) continue;
    if (c.lat < minLat || c.lat > maxLat || c.lon < minLon || c.lon > maxLon) continue;
    const off = distanceToRouteSegmentNM(a.lat, a.lon, b.lat, b.lon, c.lat, c.lon);
    if (off > maxOffsetNM) continue;
    const d1 = haversineNM(a.lat, a.lon, c.lat, c.lon);
    const d2 = haversineNM(c.lat, c.lon, b.lat, b.lon);
    if (d1 < minHop || d2 < minHop || !feasible(d1, d2)) continue;
    const detourNM = d1 + d2 - direct;
    // Lower is better: small detour, a stop near the middle of the leg, and a long runway
    // (the closest thing we have to "has services" — the database does not list fuel).
    const score = detourNM + Math.abs(d1 - d2) * 0.15 - Math.min(c.runway_length_ft, 8000) / 400;
    out.push({ ...c, d1, d2, detourNM, distFromRouteNM: off, score });
  }
  out.sort((x, y) => x.score - y.score);
  return out.slice(0, limit);
}

/** "KSMF — Sacramento Intl (Sacramento, US-CA)" */
export function describeAirport(a) {
  const where = [a.municipality, a.iso_region].filter(Boolean).join(', ');
  return `${a.ident} — ${a.name}${where ? ` (${where})` : ''}`;
}
