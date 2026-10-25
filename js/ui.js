// ui.js — wires the form, map, and result rendering together.

import {
  haversineNM, initialBearing, midpoint, greatCirclePath, tasAtAltitude, windTriangle,
  timeEnrouteHours, tripFuelGal, reserveMinutes, reserveFuelGal, fuelVerdict, vfrAltitudeCheck,
  formatHours, formatDeg, TAXI_RUNUP_GAL, planRoute,
} from './nav.js';
import {
  loadAirports, searchAirports, getAirport, findAlternates, findAlternatesAlongRoute, findLayoverOptions, describeAirport,
} from './airports.js';
import { loadAircraft, resolveAircraft, getAircraftById, CUSTOM_ID } from './aircraft.js';
import { getMetar, getTaf, getMetars, getWindsAloft } from './weather.js';

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

const el = {
  dataStatus: $('dataStatus'), globalAlert: $('globalAlert'),
  form: $('planForm'), dep: $('dep'), dest: $('dest'), depList: $('depList'), destList: $('destList'),
  depHint: $('depHint'), destHint: $('destHint'), swapBtn: $('swapBtn'),
  aircraft: $('aircraft'), aircraftSpecs: $('aircraftSpecs'), customFields: $('customFields'),
  customKtas: $('customKtas'), customGph: $('customGph'), customUsable: $('customUsable'),
  fuelOnBoard: $('fuelOnBoard'), altitude: $('altitude'), fuelPrice: $('fuelPrice'),
  manualWind: $('manualWind'), windDir: $('windDir'), windSpeed: $('windSpeed'), windSourceHint: $('windSourceHint'),
  planBtn: $('planBtn'), formError: $('formError'),
  map: $('map'), results: $('results'), mapFallback: $('mapFallback'), emptyState: $('emptyState'), planOutput: $('planOutput'),
  planNotice: $('planNotice'), cards: $('cards'), fuelVerdict: $('fuelVerdict'), altitudeCheck: $('altitudeCheck'),
  windInfo: $('windInfo'), weather: $('weather'), alternates: $('alternates'),
  stopList: $('stopList'), addStopBtn: $('addStopBtn'), stopHint: $('stopHint'), legsCard: $('legsCard'),
};

const state = { dep: null, dest: null, planId: 0 };

// ---------- global error surfaces ----------
function showGlobalAlert(msg) {
  el.globalAlert.textContent = msg;
  el.globalAlert.hidden = false;
}
window.addEventListener('error', (e) => showGlobalAlert(`Something went wrong: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => showGlobalAlert(`Something went wrong: ${e.reason?.message || e.reason}`));

// ---------- map ----------
let map = null;
let routeLayer = null;
const hasLeaflet = typeof window.L !== 'undefined';

function initMap() {
  if (!hasLeaflet) {
    el.mapFallback.innerHTML = '<div><strong>Map unavailable.</strong><br>Leaflet could not be loaded from the CDN (offline or blocked). Calculations still work.</div>';
    el.mapFallback.hidden = false;
    return;
  }
  // Wheel zoom is off so the smooth-scrolling page never gets trapped over the map.
  // On touch screens one-finger dragging is off too (two-finger pan/zoom still works), so a swipe over the map scrolls the page.
  const touch = window.matchMedia('(pointer: coarse)').matches;
  map = L.map('map', { worldCopyJump: true, scrollWheelZoom: false, dragging: !touch }).setView([39, -98], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
}

function labelMarker(a, kind) {
  const color = kind === 'dep' ? '#15803d' : kind === 'dest' ? '#b91c1c' : kind === 'stop' ? '#7c3aed' : '#0f5fbf';
  const m = L.circleMarker([a.lat, a.lon], {
    radius: kind === 'alt' ? 6 : 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1,
  });
  m.bindTooltip(a.ident, { permanent: true, direction: 'top', offset: [0, -8], className: 'marker-label' });
  m.bindPopup(`<b>${esc(a.ident)}</b> ${esc(a.name)}<br>${esc(a.municipality || '')}${a.runway_length_ft ? `<br>Longest runway ${fmt(a.runway_length_ft)} ft ${esc(a.runway_surface || '')}` : ''}`);
  return m;
}

function drawRoute(route, alternates) {
  if (!map) return;
  routeLayer.clearLayers();
  const all = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const path = greatCirclePath(a.lat, a.lon, b.lat, b.lon, 96);
    all.push(...path);
    L.polyline(path, { color: '#0f5fbf', weight: 3, opacity: 0.9 }).addTo(routeLayer);
  }
  alternates.forEach((a) => labelMarker(a, 'alt').addTo(routeLayer));
  route.forEach((a, i) => labelMarker(a, i === 0 ? 'dep' : i === route.length - 1 ? 'dest' : 'stop').addTo(routeLayer));
  map.fitBounds(L.latLngBounds(all), { padding: [40, 40] });
}

// ---------- autocomplete ----------
function setupAutocomplete(input, list, hint, key) {
  let items = [];
  let active = -1;
  let timer = null;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const select = (a, advance = false) => {
    state[key] = a;
    input.value = a.ident;
    hint.textContent = describeAirport(a);
    hint.classList.add('selected');
    close();
    if (advance) input.dispatchEvent(new CustomEvent('chosen', { bubbles: true }));
  };
  const render = () => {
    if (items.length === 0) {
      list.innerHTML = '<li class="none">No matching airports</li>';
    } else {
      list.innerHTML = items
        .map((a, i) => `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}"><b>${esc(a.ident)}</b>${esc(a.name)}<small>${esc([a.municipality, a.iso_region].filter(Boolean).join(', '))}${a.runway_length_ft ? ` · rwy ${fmt(a.runway_length_ft)} ft` : ''}</small></li>`)
        .join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('input', () => {
    state[key] = null;
    hint.classList.remove('selected');
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hint.textContent = 'Type at least 2 characters'; close(); return; }
    timer = setTimeout(() => {
      items = searchAirports(q, 8);
      active = -1;
      hint.textContent = items.length ? 'Pick an airport from the list' : 'No match — try the ICAO code (e.g. KSMF)';
      render();
    }, 60);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') { if (items.length) { e.preventDefault(); select(items[Math.max(0, active)], true); } }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => {
    // Let a click on a suggestion land first, then accept an exact ident if typed.
    setTimeout(() => {
      if (!state[key]) {
        const exact = getAirport(input.value);
        if (exact) select(exact);
      }
      close();
    }, 150);
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); select(items[Number(li.dataset.i)], true); }
  });
}

// ---------- aircraft ----------
function populateAircraft(catalog) {
  el.aircraft.innerHTML =
    catalog.aircraft.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('') +
    `<option value="${CUSTOM_ID}">Custom aircraft (enter your own numbers)</option>`;
  el.aircraft.disabled = false;
  const defaultId = catalog.aircraft.find((a) => a.id === 'c172s') ? 'c172s' : catalog.aircraft[0].id;
  el.aircraft.value = defaultId;
  onAircraftChange();
}

function onAircraftChange() {
  const id = el.aircraft.value;
  const isCustom = id === CUSTOM_ID;
  el.customFields.hidden = !isCustom;
  el.aircraftSpecs.hidden = isCustom;
  if (isCustom) {
    el.fuelOnBoard.value = el.customUsable.value || '';
    return;
  }
  const a = getAircraftById(id);
  if (!a) return;
  el.aircraftSpecs.innerHTML =
    `<div><b>${a.cruise_ktas_8000}</b><span>KTAS @ 8,000</span></div>` +
    `<div><b>${a.burn_gph}</b><span>gph cruise</span></div>` +
    `<div><b>${a.usable_fuel_gal}</b><span>gal usable</span></div>`;
  el.fuelOnBoard.value = a.usable_fuel_gal;
}

// ---------- form reading & validation ----------
function readForm() {
  const errors = [];
  const dep = state.dep || getAirport(el.dep.value);
  const dest = state.dest || getAirport(el.dest.value);
  if (!dep) errors.push('Choose a departure airport from the list.');
  if (!dest) errors.push('Choose a destination airport from the list.');
  if (dep && dest && dep.ident === dest.ident) errors.push('Departure and destination are the same airport.');

  // Layovers: empty rows are ignored; filled rows must be real, distinct airports.
  const stops = [];
  readStopsLoose().forEach((st, i) => {
    if (!st.ap && !st.text) return;
    if (!st.ap) { errors.push(`Choose layover ${i + 1} from the list.`); return; }
    if ((dep && st.ap.ident === dep.ident) || (dest && st.ap.ident === dest.ident)) errors.push(`Layover ${i + 1} (${st.ap.ident}) is the same as your departure or destination.`);
    else if (stops.some((x) => x.ap.ident === st.ap.ident)) errors.push(`${st.ap.ident} is listed twice as a layover.`);
    stops.push(st);
  });

  let aircraft = null;
  try {
    aircraft = resolveAircraft(el.aircraft.value, { ktas: el.customKtas.value, gph: el.customGph.value, usable: el.customUsable.value });
  } catch (e) { errors.push(e.message); }

  const fuelOnBoard = Number(el.fuelOnBoard.value);
  if (!(fuelOnBoard > 0)) errors.push('Enter usable fuel on board (gallons).');
  if (aircraft && fuelOnBoard > aircraft.usable_fuel_gal + 0.01) {
    errors.push(`Fuel on board (${fuelOnBoard} gal) exceeds this aircraft's usable capacity (${aircraft.usable_fuel_gal} gal).`);
  }

  const altitude = Number(el.altitude.value);
  if (!Number.isFinite(altitude) || altitude < 500) errors.push('Enter a planned altitude of at least 500 ft MSL.');
  if (altitude > 60000) errors.push('That altitude is not realistic for this tool.');

  const fuelPrice = Number(el.fuelPrice.value);
  if (!(fuelPrice >= 0)) errors.push('Enter a fuel price (0 or more).');

  const dayNight = el.form.querySelector('input[name="dayNight"]:checked').value;
  const windSource = el.form.querySelector('input[name="windSource"]:checked').value;
  let manualWind = null;
  if (windSource === 'manual') {
    const dir = Number(el.windDir.value);
    const spd = Number(el.windSpeed.value);
    if (!(dir >= 0 && dir <= 360)) errors.push('Manual wind direction must be 0–360°.');
    if (!(spd >= 0)) errors.push('Manual wind speed must be 0 or more.');
    manualWind = { dir, speed: spd };
  }

  return { errors, dep, dest, aircraft, fuelOnBoard, altitude, fuelPrice, dayNight, windSource, manualWind, stops };
}

// ---------- rendering ----------
function statCard(label, value, unit, sub) {
  return `<div class="card stat"><div class="label">${label}</div><div class="value">${value}${unit ? `<small>${unit}</small>` : ''}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function renderPlan(p, wind, wt) {
  const { dep, dest, aircraft, altitude, fuelOnBoard, fuelPrice, dayNight } = p;
  const distance = haversineNM(dep.lat, dep.lon, dest.lat, dest.lon);
  const tc = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);
  const tas = tasAtAltitude(aircraft.cruise_ktas_8000, altitude);

  const hours = timeEnrouteHours(distance, wt.groundSpeed);
  const trip = tripFuelGal(hours, aircraft.burn_gph);
  const resMin = reserveMinutes(dayNight);
  const reserve = reserveFuelGal(dayNight, aircraft.burn_gph);
  const verdict = fuelVerdict({ tripGal: trip, reserveGal: reserve, usableGal: fuelOnBoard, gph: aircraft.burn_gph });
  const cost = trip * fuelPrice;

  el.cards.innerHTML = [
    statCard('Distance', fmt(distance, 1), 'NM', 'Great-circle (haversine)'),
    statCard('True course', formatDeg(tc), '', 'Initial great-circle bearing'),
    statCard('True heading', formatDeg(wt.trueHeading), '', Math.abs(wt.wca) < 0.05 ? 'No wind correction needed' : `WCA ${wt.wca > 0 ? '+' : '−'}${Math.abs(wt.wca).toFixed(1)}° (${wt.wca > 0 ? 'crab right' : 'crab left'})`),
    statCard('Ground speed', fmt(wt.groundSpeed), 'kt', `TAS ${fmt(tas)} kt at ${fmt(altitude)} ft (approx.)`),
    statCard('Time enroute', formatHours(hours), '', `${fmt(hours, 2)} h at ${fmt(wt.groundSpeed)} kt GS`),
    statCard('Fuel required', fmt(trip, 1), 'gal', `${fmt(hours * aircraft.burn_gph, 1)} enroute + ${TAXI_RUNUP_GAL} taxi/run-up`),
    statCard('Fuel cost', `$${fmt(cost, 2)}`, '', `${fmt(trip, 1)} gal × $${fmt(fuelPrice, 2)}`),
  ].join('');

  // Fuel verdict
  const v = verdict.verdict;
  showVerdictAlert(v, {
    verdict, trip, reserve, fuelOnBoard, dep, dest,
    options: v === 'GO' ? [] : fuelStopOptions([dep, dest], 0, p, fuelOnBoard), insertAt: 0,
  });
  el.fuelVerdict.className = `card v-${v}`;
  el.fuelVerdict.innerHTML =
    `<h3>Fuel &amp; reserves <span class="verdict ${v}">${v}</span></h3>` +
    `<div class="row"><span>Trip fuel (incl. taxi)</span><span>${fmt(trip, 1)} gal</span></div>` +
    `<div class="row"><span>Legal reserve — VFR ${dayNight} (${resMin} min @ ${aircraft.burn_gph} gph)</span><span>${fmt(reserve, 1)} gal</span></div>` +
    `<div class="row"><span><strong>Required total</strong></span><span><strong>${fmt(verdict.requiredGal, 1)} gal</strong></span></div>` +
    `<div class="row"><span>Usable fuel on board</span><span>${fmt(fuelOnBoard, 1)} gal</span></div>` +
    `<div class="row"><span>Margin beyond legal reserve</span><span>${verdict.marginGal >= 0 ? '' : '−'}${fmt(Math.abs(verdict.marginGal), 1)} gal (${verdict.marginMin >= 0 ? '' : '−'}${fmt(Math.abs(verdict.marginMin))} min)</span></div>` +
    `<p class="note">${
      v === 'NO-GO' ? 'Required fuel exceeds usable fuel on board. Add fuel, plan a fuel stop, or choose a different aircraft.'
      : v === 'TIGHT' ? 'Legal, but with less than 30 extra minutes beyond the FAR minimum. Consider a fuel stop; headwinds or a diversion could consume the margin.'
      : 'At least 30 extra minutes beyond the FAR minimum reserve.'
    } Reserves per 14 CFR 91.151 (${dayNight === 'night' ? '45 min night' : '30 min day'}).</p>`;

  // Altitude check
  const ac = vfrAltitudeCheck(tc, altitude);
  const acClass = !ac.applies ? (ac.legal ? 'v-info' : 'v-bad') : ac.legal ? 'v-ok' : 'v-warn';
  el.altitudeCheck.className = `card ${acClass}`;
  el.altitudeCheck.innerHTML =
    `<h3>VFR cruising altitude — 14 CFR 91.159</h3>` +
    `<div class="row"><span>Planned altitude</span><span>${fmt(altitude)} ft MSL</span></div>` +
    `<div class="row"><span>Course used</span><span>${formatDeg(tc)} true (${ac.eastbound ? '000–179°' : '180–359°'})</span></div>` +
    `<div class="row"><span>Rule for this course</span><span>${ac.rule}</span></div>` +
    `<p class="note">${esc(ac.message)}</p>` +
    `<p class="note">The rule uses <em>magnetic</em> course; this app uses true course as an approximation. Near 000°/180° magnetic variation can change the answer — check your chart.</p>`;

  // Wind info
  const hw = wt.headwind;
  el.windInfo.className = 'card v-info';
  el.windInfo.innerHTML =
    `<h3>Winds aloft used in the wind triangle</h3>` +
    `<div class="row"><span>Wind</span><span>${formatDeg(wind.dir)} true at ${fmt(wind.speed)} kt</span></div>` +
    `<div class="row"><span>Source</span><span>${esc(wind.sourceLabel)}</span></div>` +
    `<div class="row"><span>Components</span><span>${Math.abs(hw) < 0.5 ? 'no head/tailwind' : `${fmt(Math.abs(hw))} kt ${hw > 0 ? 'headwind' : 'tailwind'}`}, ${Math.abs(wt.crosswind) < 0.5 ? 'no crosswind' : `${fmt(Math.abs(wt.crosswind))} kt crosswind from the ${wt.crosswind > 0 ? 'right' : 'left'}`}</span></div>` +
    `<p class="note">WCA = asin(W·sin(θ)/TAS), GS = TAS·cos(WCA) − W·cos(θ), where θ = wind direction − true course. Single sample at the route midpoint; actual winds vary along the route and with time.</p>`;
}

function wxCard(title, a, metar, taf) {
  const head = `<div class="wx-head"><h3>${esc(a.ident)} <span class="muted">${esc(a.name)}</span></h3>${metar?.status === 'ok' && metar.fltCat ? `<span class="fltcat ${esc(metar.fltCat)}">${esc(metar.fltCat)}</span>` : ''}</div>`;
  let body = `<div class="wx-sub">METAR</div>`;
  if (!metar) body += `<div class="loading">Fetching METAR…</div>`;
  else if (metar.status === 'ok') {
    body += `<div class="raw">${esc(metar.raw)}</div><dl class="decoded">${metar.decoded.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  } else if (metar.status === 'not_found') body += `<div class="wx-msg">No METAR — ${esc(a.ident)} is not a reporting station. Use the nearest station with weather reporting.</div>`;
  else body += `<div class="wx-msg error">${esc(metar.message)}</div>`;

  body += `<div class="wx-sub">TAF</div>`;
  if (!taf) body += `<div class="loading">Fetching TAF…</div>`;
  else if (taf.status === 'ok') {
    body += `<div class="raw">${esc(taf.raw)}</div>`;
    if (taf.decoded.valid) body += `<div class="wx-msg">Valid ${esc(taf.decoded.valid)}</div>`;
    body += taf.decoded.periods.map((p) => `<div class="taf-period"><b>${esc(p.when)}</b>${esc(p.text)}</div>`).join('');
  } else if (taf.status === 'not_found') body += `<div class="wx-msg">No TAF issued for ${esc(a.ident)}. Most smaller airports don't have one — check the nearest TAF station.</div>`;
  else body += `<div class="wx-msg error">${esc(taf.message)}</div>`;

  return `<div class="card" id="wx-${esc(a.ident)}">${head}${body}</div>`;
}

function renderAlternates(alts, dest, metars) {
  if (alts.length === 0) {
    el.alternates.innerHTML = `<div class="wx-msg">No airports with a runway ≥ 2,500 ft within 25 NM of the route (other than ${esc(dest.ident)} itself).</div>`;
    return;
  }
  const rows = alts.map((a, i) => {
    let wx;
    if (i >= 3) wx = '<span class="muted">—</span>';
    else if (!metars) wx = '<span class="loading">METAR…</span>';
    else {
      const m = metars.get(a.ident.toUpperCase());
      if (m?.status === 'ok') wx = `${m.fltCat ? `<span class="fltcat ${esc(m.fltCat)}">${esc(m.fltCat)}</span>` : ''}<div class="raw">${esc(m.raw)}</div>`;
      else if (m?.status === 'error') wx = `<span class="wx-msg error">${esc(m.message)}</span>`;
      else wx = '<span class="muted">No METAR (not a reporting station)</span>';
    }
    return `<tr><td><b>${esc(a.ident)}</b><br><small>${esc(a.name)}<br>${esc([a.municipality, a.iso_region].filter(Boolean).join(', '))}</small></td>` +
      `<td class="num">${fmt(a.runway_length_ft)} ft<br><small>${esc(a.runway_surface || '')}</small></td>` +
      `<td class="num">${fmt(a.distFromDestNM, 1)} NM</td><td class="num">${fmt(a.distFromRouteNM, 1)} NM</td><td>${wx}</td></tr>`;
  });
  el.alternates.innerHTML =
    `<div class="alt-table-wrap"><table class="alt-table"><thead><tr><th>Airport</th><th>Longest rwy</th><th>From dest.</th><th>Off route</th><th>Current METAR (top 3)</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

// ---------- full-screen TIGHT / NO-GO alert ----------
const va = {
  root: $('verdictAlert'), route: $('vaRoute'), title: $('vaTitle'), text: $('vaText'), stats: $('vaStats'),
  review: $('vaReview'), change: $('vaChange'), sound: $('vaSound'),
};
let vaReturnFocus = null;

// ---- warning sound (synthesized with Web Audio — no audio files) ----
const sound = { ctx: null, master: null, muted: false };
try { sound.muted = localStorage.getItem('fp-muted') === '1'; } catch { /* storage unavailable */ }

// Browsers only allow audio after a user gesture; the Plan click/keypress unlocks it.
function unlockAudio() {
  try {
    if (!sound.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      sound.ctx = new AC();
      sound.master = sound.ctx.createGain();
      sound.master.gain.value = 0.22;
      sound.master.connect(sound.ctx.destination);
    }
    if (sound.ctx.state === 'suspended') sound.ctx.resume();
  } catch { /* audio unsupported */ }
}
['pointerdown', 'keydown', 'touchstart', 'touchend', 'click'].forEach((t) => document.addEventListener(t, unlockAudio, { passive: true }));

function stopAlarm() {
  if (!sound.master) return;
  const g = sound.master.gain, t = sound.ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(0, t, 0.03);
  setTimeout(() => { if (sound.master) sound.master.gain.value = 0.22; }, 400);
  (sound.nodes || []).forEach((o) => { try { o.stop(t + 0.15); } catch { /* already stopped */ } });
  sound.nodes = [];
}

function beep(freq, start, dur, type) {
  const o = sound.ctx.createOscillator(), g = sound.ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(1, start + 0.02);
  g.gain.setValueAtTime(1, start + dur - 0.03);
  g.gain.linearRampToValueAtTime(0, start + dur);
  o.connect(g); g.connect(sound.master);
  o.start(start); o.stop(start + dur + 0.02);
  (sound.nodes ||= []).push(o);
}

function playAlarm(v) {
  if (sound.muted || !sound.ctx || sound.ctx.state !== 'running') return;
  stopAlarm();
  const t0 = sound.ctx.currentTime + 0.05;
  if (v === 'GO') {
    // Soft rising two-note chime.
    beep(523, t0, 0.22, 'sine'); beep(784, t0 + 0.2, 0.4, 'sine');
  } else if (v === 'NO-GO') {
    // Urgent two-tone siren, ~3 s.
    for (let i = 0; i < 10; i++) beep(i % 2 ? 640 : 960, t0 + i * 0.3, 0.28, 'sawtooth');
  } else {
    // Caution: two double-beeps.
    for (let r = 0; r < 2; r++) for (let i = 0; i < 2; i++) beep(740, t0 + r * 0.9 + i * 0.28, 0.2, 'triangle');
  }
}

function renderSoundToggle() {
  va.sound.textContent = sound.muted ? '🔇 Sound off' : '🔊 Sound on';
  va.sound.setAttribute('aria-pressed', String(sound.muted));
}

function closeVerdictAlert() {
  if (va.root.hidden) return;
  va.root.hidden = true;
  stopAlarm();
  document.body.classList.remove('va-open');
  if (window.lenis) window.lenis.start();
  if (vaReturnFocus?.focus) vaReturnFocus.focus({ preventScroll: true });
}

function showVerdictAlert(v, d) {
  if (v !== 'NO-GO' && v !== 'TIGHT' && v !== 'GO') { closeVerdictAlert(); return; }
  const { verdict, trip, reserve, fuelOnBoard, dep, dest } = d;
  const nogo = v === 'NO-GO';
  va.root.className = `verdict-alert ${nogo ? 'va-nogo' : v === 'TIGHT' ? 'va-tight' : 'va-go'}`;
  va.route.textContent = d.routeLabel || `${dep.ident} → ${dest.ident}`;
  va.title.textContent = v;
  const lead = d.legLabel ? `${d.legLabel}: ` : '';
  va.text.textContent = nogo
    ? `${lead}You do not have enough fuel for this ${d.legLabel ? 'leg' : 'flight'}. Short by ${fmt(Math.abs(verdict.marginGal), 1)} gal (${fmt(Math.abs(verdict.marginMin))} min) once the legal reserve is included.`
    : v === 'TIGHT'
      ? `${lead}Legal, but only ${fmt(verdict.marginMin)} minutes of extra fuel (${fmt(verdict.marginGal, 1)} gal) beyond the legal reserve. A headwind or a diversion could use it up.`
      : d.legLabel
        ? `Every leg has enough fuel. The tightest, ${d.legLabel}, still has ${fmt(verdict.marginMin)} minutes (${fmt(verdict.marginGal, 1)} gal) to spare beyond the legal reserve. Still check weather and NOTAMs before you fly.`
        : `You have enough fuel, with ${fmt(verdict.marginMin)} minutes (${fmt(verdict.marginGal, 1)} gal) to spare beyond the legal reserve. Still check weather and NOTAMs before you fly.`;
  va.change.hidden = v === 'GO';
  va.stats.innerHTML =
    `<div><dt>Trip fuel</dt><dd>${fmt(trip, 1)} gal</dd></div>` +
    `<div><dt>Legal reserve</dt><dd>${fmt(reserve, 1)} gal</dd></div>` +
    `<div><dt>Required</dt><dd>${fmt(verdict.requiredGal, 1)} gal</dd></div>` +
    `<div><dt>On board</dt><dd>${fmt(fuelOnBoard, 1)} gal</dd></div>`;
  const optBox = $('vaOptions');
  va.pending = null;
  if (d.options?.length) {
    va.pending = { options: d.options, insertAt: d.insertAt || 0 };
    optBox.innerHTML = '<p>Add a fuel stop?</p><div class="va-opt-list">' +
      d.options.map((o, i) => `<button type="button" class="va-opt" data-i="${i}">${esc(o.ident)} · ${esc(o.name)}<small>${esc(o.municipality || '')} · +${fmt(o.detourNM)} NM detour · runway ${fmt(o.runway_length_ft)} ft</small></button>`).join('') +
      '</div><small>The airport data does not say whether fuel is sold there. Confirm fuel and hours in the Chart Supplement or with the airport before relying on a stop.</small>';
    optBox.hidden = false;
  } else {
    optBox.hidden = true;
    optBox.innerHTML = '';
  }
  if (va.root.hidden) vaReturnFocus = document.activeElement;
  va.root.hidden = false;
  document.body.classList.add('va-open');
  if (window.lenis) window.lenis.stop();
  va.review.focus({ preventScroll: true });
  renderSoundToggle();
  playAlarm(v);
}

va.sound.addEventListener('click', () => {
  sound.muted = !sound.muted;
  try { localStorage.setItem('fp-muted', sound.muted ? '1' : '0'); } catch { /* storage unavailable */ }
  if (sound.muted) stopAlarm();
  renderSoundToggle();
});
va.review.addEventListener('click', closeVerdictAlert);
$('vaOptions').addEventListener('click', (e) => {
  const btn = e.target.closest('.va-opt');
  if (!btn || !va.pending) return;
  const o = va.pending.options[Number(btn.dataset.i)];
  const rows = readStopsLoose();
  rows.splice(va.pending.insertAt, 0, { ap: o, text: o.ident, minutes: 45, refuel: true });
  renderStopRows(rows);
  closeVerdictAlert();
  plan({ preventDefault() {} });
});
va.change.addEventListener('click', () => {
  closeVerdictAlert();
  const step = $('fuelOnBoard')?.closest('.step');
  if (step && window.lenis) window.lenis.scrollTo(step, { offset: -64, duration: 1.2 });
  else step?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.addEventListener('keydown', (e) => {
  if (va.root.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeVerdictAlert(); }
  else if (e.key === 'Tab') {
    const f = [va.review, ...$('vaOptions').querySelectorAll('button'), va.change, va.sound].filter((b) => !b.hidden);
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  }
});

// ---------- layovers ----------
const MAX_STOPS = 3;
const STOP_HINT = el.stopHint.textContent;

function readStopsLoose() {
  return [...el.stopList.querySelectorAll('.stop-row')].map((row, i) => ({
    ap: state[`s${i}`] || getAirport($(`stop${i}`).value),
    text: $(`stop${i}`).value.trim(),
    minutes: Number($(`stop${i}Min`).value),
    refuel: $(`stop${i}Refuel`).value === 'full',
  }));
}

function renderStopRows(data) {
  el.stopList.innerHTML = '';
  for (let i = 0; i < MAX_STOPS; i++) state[`s${i}`] = null;
  const stepIdx = String([...document.querySelectorAll('.step')].indexOf(el.stopList.closest('.step')));
  data.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'stop-row';
    row.innerHTML =
      `<div class="field autocomplete"><label class="sr-only" for="stop${i}">Layover ${i + 1}</label>` +
      `<input id="stop${i}" type="text" placeholder="Layover ${i + 1} — e.g. KBFL" spellcheck="false" autocapitalize="characters" autocorrect="off" enterkeyhint="next" aria-autocomplete="list" aria-controls="stop${i}List" aria-expanded="false">` +
      `<ul class="suggestions" id="stop${i}List" role="listbox" data-lenis-prevent hidden></ul>` +
      `<div class="hint" id="stop${i}Hint">Layover ${i + 1}: type an ICAO code, airport name, or city</div></div>` +
      `<div class="stop-opts">` +
      `<label>On the ground<select id="stop${i}Min"><option value="30">30 min</option><option value="45">45 min</option><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option></select></label>` +
      `<label>Fuel<select id="stop${i}Refuel"><option value="full">Refuel to full</option><option value="none">Don't refuel</option></select></label>` +
      `<button type="button" class="stop-remove" aria-label="Remove layover ${i + 1}">Remove</button></div>`;
    el.stopList.appendChild(row);
    const input = $(`stop${i}`);
    input.dataset.step = stepIdx;           // Enter moves to the next page…
    input.dataset.noAdvance = '1';          // …but picking an airport does not (you may want another stop)
    const hint = $(`stop${i}Hint`);
    setupAutocomplete(input, $(`stop${i}List`), hint, `s${i}`);
    if (d.ap) {
      state[`s${i}`] = d.ap;
      input.value = d.ap.ident;
      hint.textContent = describeAirport(d.ap);
      hint.classList.add('selected');
    } else if (d.text) input.value = d.text;
    $(`stop${i}Min`).value = String(d.minutes || 45);
    $(`stop${i}Refuel`).value = d.refuel === false ? 'none' : 'full';
    row.querySelector('.stop-remove').addEventListener('click', () => {
      const rows = readStopsLoose();
      rows.splice(i, 1);
      renderStopRows(rows);
    });
  });
  el.addStopBtn.hidden = data.length >= MAX_STOPS;
  el.stopHint.textContent = data.length ? 'Stops are flown in the order shown. Remove them all to fly nonstop.' : STOP_HINT;
}

/**
 * Fuel-stop suggestions for a leg that is TIGHT or NO-GO: nearby airports with a decent runway where
 * (a) you can reach the stop with the fuel you have, and (b) the rest of the leg is reachable on full tanks.
 * Range is a rough no-wind estimate (90% of true airspeed); the re-plan gives the exact answer.
 */
function fuelStopOptions(route, legIndex, p, fuelAtTakeoff) {
  if (p.stops.length >= MAX_STOPS) return [];
  const a = route[legIndex], b = route[legIndex + 1];
  const tas = tasAtAltitude(p.aircraft.cruise_ktas_8000, p.altitude);
  const rangeNM = (fuel) => Math.max(0, (fuel - TAXI_RUNUP_GAL) / p.aircraft.burn_gph - reserveMinutes(p.dayNight) / 60) * tas * 0.9;
  if (rangeNM(fuelAtTakeoff) <= 0) return [];
  return findLayoverOptions(a, b, {
    exclude: new Set(route.map((r) => r.ident)),
    feasible: (d1, d2) => d1 <= rangeNM(fuelAtTakeoff) && d2 <= rangeNM(p.aircraft.usable_fuel_gal),
  });
}

function renderRoutePlan(p, route, result, winds, tas) {
  const { legs, totals, worstIndex, overall } = result;
  const groundH = totals.groundMinutes / 60;
  const name = (l) => `${esc(l.from.ident)} → ${esc(l.to.ident)}`;

  el.cards.innerHTML = [
    statCard('Total distance', fmt(totals.distanceNM, 1), 'NM', `${legs.length} legs · ${legs.length - 1} layover${legs.length > 2 ? 's' : ''}`),
    statCard('Time in the air', formatHours(totals.flightHours), '', 'at forecast ground speeds'),
    statCard('Time on the ground', totals.groundMinutes ? formatHours(groundH) : '—', '', 'at your layovers'),
    statCard('Total trip time', formatHours(totals.flightHours + groundH), '', 'air + ground'),
    statCard('Fuel burned', fmt(totals.tripGal, 1), 'gal', `incl. ${TAXI_RUNUP_GAL} gal taxi per leg`),
    statCard('Fuel cost', `$${fmt(totals.tripGal * p.fuelPrice, 2)}`, '', `${fmt(totals.tripGal, 1)} gal × $${fmt(p.fuelPrice, 2)}`),
  ].join('');

  // Leg-by-leg table with the layovers in between.
  const rows = legs.map((l, i) => {
    const stop = p.stops[i];
    const layover = i < legs.length - 1 && stop
      ? `<tr class="layover-row"><td colspan="8">Layover at <b>${esc(l.to.ident)}</b> — ${fmt(stop.minutes)} min on the ground · ${stop.refuel ? `refuel to full (${fmt(p.aircraft.usable_fuel_gal, 1)} gal)` : 'no refuel'}</td></tr>`
      : '';
    return `<tr><td><b>Leg ${i + 1}</b><br><small>${name(l)}</small></td>` +
      `<td class="num">${fmt(l.distanceNM, 1)} NM</td><td class="num">${formatDeg(l.trueCourse)}</td><td class="num">${formatDeg(l.wt.trueHeading)}</td>` +
      `<td class="num">${fmt(l.wt.groundSpeed)} kt</td><td class="num">${formatHours(l.hours)}</td>` +
      `<td class="num">${fmt(l.fuelAtTakeoff, 1)} → ${fmt(l.fuelAtLanding, 1)}</td>` +
      `<td><span class="verdict ${l.verdict}">${l.verdict}</span></td></tr>${layover}`;
  }).join('');
  el.legsCard.className = 'card v-info';
  el.legsCard.hidden = false;
  el.legsCard.innerHTML =
    '<h3>Your legs</h3><div class="alt-table-wrap"><table class="alt-table legs-table"><thead><tr>' +
    '<th>Leg</th><th>Dist.</th><th>Course</th><th>Hdg</th><th>GS</th><th>Time</th><th>Fuel (gal)</th><th>Verdict</th>' +
    `</tr></thead><tbody>${rows}</tbody></table></div>` +
    '<p class="note">Fuel (gal) is shown as takeoff → landing. Each leg is checked on its own: the fuel at takeoff must cover that leg\'s trip fuel plus the legal reserve, so you land with the reserve intact.</p>';

  // Fuel verdict for the whole trip = the tightest leg.
  const w = legs[worstIndex];
  el.fuelVerdict.className = `card v-${overall}`;
  el.fuelVerdict.innerHTML =
    `<h3>Fuel &amp; reserves <span class="verdict ${overall}">${overall}</span></h3>` +
    `<div class="row"><span>Fuel burned, all legs</span><span>${fmt(totals.tripGal, 1)} gal</span></div>` +
    `<div class="row"><span>Legal reserve at every landing — VFR ${esc(p.dayNight)} (${reserveMinutes(p.dayNight)} min @ ${p.aircraft.burn_gph} gph)</span><span>${fmt(w.reserveGal, 1)} gal</span></div>` +
    `<div class="row"><span><strong>Tightest leg</strong></span><span><strong>Leg ${worstIndex + 1}: ${name(w)}</strong></span></div>` +
    `<div class="row"><span>Fuel at takeoff on that leg</span><span>${fmt(w.fuelAtTakeoff, 1)} gal</span></div>` +
    `<div class="row"><span>Margin beyond legal reserve</span><span>${w.marginGal >= 0 ? '' : '−'}${fmt(Math.abs(w.marginGal), 1)} gal (${w.marginMin >= 0 ? '' : '−'}${fmt(Math.abs(w.marginMin))} min)</span></div>` +
    `<p class="note">${overall === 'NO-GO' ? 'At least one leg does not have enough fuel. Add fuel, refuel at a layover, add a stop, or choose a different aircraft.' : overall === 'TIGHT' ? 'Every leg is legal, but at least one has less than 30 extra minutes beyond the FAR minimum.' : 'Every leg has at least 30 extra minutes beyond the FAR minimum reserve.'} Reserves per 14 CFR 91.151 (${p.dayNight === 'night' ? '45 min night' : '30 min day'}).</p>`;

  // VFR cruising altitude check, leg by leg (course changes at each stop).
  const checks = legs.map((l) => vfrAltitudeCheck(l.trueCourse, p.altitude));
  const allLegal = checks.every((c) => c.legal || !c.applies);
  el.altitudeCheck.className = `card ${allLegal ? 'v-ok' : 'v-warn'}`;
  el.altitudeCheck.innerHTML =
    '<h3>VFR cruising altitude — 14 CFR 91.159</h3>' +
    `<div class="row"><span>Planned altitude</span><span>${fmt(p.altitude)} ft MSL</span></div>` +
    legs.map((l, i) => {
      const c = checks[i];
      const verdict = !c.applies ? 'rule not applicable here' : c.legal ? 'legal' : `change to ${c.suggestions.map((x) => fmt(x)).join(' or ')} ft`;
      return `<div class="row"><span>Leg ${i + 1} · ${formatDeg(l.trueCourse)} true (${c.rule})</span><span>${verdict}</span></div>`;
    }).join('') +
    '<p class="note">The rule uses <em>magnetic</em> course; this app uses true course as an approximation. Near 000°/180° magnetic variation can change the answer — check your chart. Your course changes at each layover, so the legal altitude can too.</p>';

  // Winds used, leg by leg.
  el.windInfo.className = 'card v-info';
  el.windInfo.innerHTML =
    '<h3>Winds aloft used in each wind triangle</h3>' +
    legs.map((l, i) => {
      const hw = l.wt.headwind;
      return `<div class="row"><span>Leg ${i + 1} · ${name(l)}</span><span>${formatDeg(winds[i].dir)} at ${fmt(winds[i].speed)} kt (${Math.abs(hw) < 0.5 ? 'no head/tailwind' : `${fmt(Math.abs(hw))} kt ${hw > 0 ? 'head' : 'tail'}wind`})</span></div>`;
    }).join('') +
    `<div class="row"><span>Source</span><span>${esc(winds[0].sourceLabel)}</span></div>` +
    `<p class="note">One forecast sample at each leg's midpoint, TAS ${fmt(tas)} kt at ${fmt(p.altitude)} ft (approx.). Actual winds vary along each leg and with time.</p>`;

  showVerdictAlert(overall, {
    verdict: { requiredGal: w.requiredGal, marginGal: w.marginGal, marginMin: w.marginMin },
    trip: w.tripGal, reserve: w.reserveGal, fuelOnBoard: w.fuelAtTakeoff,
    dep: w.from, dest: w.to,
    routeLabel: route.map((r) => r.ident).join(' → '),
    legLabel: `Leg ${worstIndex + 1} (${w.from.ident} → ${w.to.ident})`,
    options: overall === 'GO' ? [] : fuelStopOptions(route, worstIndex, p, w.fuelAtTakeoff),
    insertAt: worstIndex,
  });
}

async function planMultiLeg(p) {
  const route = [p.dep, ...p.stops.map((s) => s.ap), p.dest];
  const myId = ++state.planId;
  const stale = () => myId !== state.planId;
  el.planBtn.disabled = true;
  el.planBtn.textContent = 'Planning…';
  el.emptyState.hidden = true;
  el.planOutput.hidden = false;
  el.planNotice.hidden = true;
  el.legsCard.hidden = true;
  el.cards.innerHTML = '<div class="card stat loading">Computing each leg and fetching winds aloft…</div>';
  el.fuelVerdict.innerHTML = el.altitudeCheck.innerHTML = el.windInfo.innerHTML = '';
  el.fuelVerdict.className = el.altitudeCheck.className = el.windInfo.className = 'card';
  el.weather.innerHTML = route.map((a) => wxCard('', a, null, null)).join('');

  const alternates = findAlternatesAlongRoute(route);
  drawRoute(route, alternates);
  renderAlternates(alternates, p.dest, null);
  if (map) map.invalidateSize();
  if (window.lenis) window.lenis.scrollTo(el.results, { offset: -64, duration: 1.6 });
  else el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const wxPromises = route.map((a) => Promise.all([getMetar(a.ident), getTaf(a.ident)]));
  const altMetarsPromise = getMetars(alternates.slice(0, 3).map((a) => a.ident));

  // One wind sample per leg, at that leg's midpoint.
  const notices = [];
  const winds = await Promise.all(route.slice(0, -1).map(async (a, i) => {
    if (p.windSource === 'manual') return { dir: p.manualWind.dir, speed: p.manualWind.speed, sourceLabel: 'Manual entry' };
    const mid = midpoint(a.lat, a.lon, route[i + 1].lat, route[i + 1].lon);
    const w = await getWindsAloft(mid.lat, mid.lon, p.altitude);
    if (w.ok) return { dir: w.dir, speed: w.speed, sourceLabel: `Open-Meteo forecast, ${w.level.hpa} hPa (≈${fmt(w.level.ft)} ft), ${w.time}, sampled at each leg's midpoint` };
    notices.push(`Leg ${i + 1}: ${w.message} That leg is calculated with ZERO wind.`);
    return { dir: 0, speed: 0, sourceLabel: 'NONE for at least one leg — forecast unavailable, zero wind used there' };
  }));
  if (stale()) return;

  const tas = tasAtAltitude(p.aircraft.cruise_ktas_8000, p.altitude);
  const result = planRoute({
    route, tas, winds, burnGph: p.aircraft.burn_gph, usableGal: p.aircraft.usable_fuel_gal,
    startFuelGal: p.fuelOnBoard, dayNight: p.dayNight, stops: p.stops,
  });
  if (!result.ok) {
    el.cards.innerHTML = '';
    el.planNotice.hidden = false;
    el.planNotice.className = 'alert alert-error';
    el.planNotice.textContent = `Leg ${result.legIndex + 1} (${route[result.legIndex].ident} → ${route[result.legIndex + 1].ident}) has no wind-triangle solution: ${result.error} Try a different altitude or enter winds manually.`;
  } else {
    renderRoutePlan(p, route, result, winds, tas);
    if (notices.length) {
      el.planNotice.className = 'alert alert-warn';
      el.planNotice.textContent = notices.join(' ');
      el.planNotice.hidden = false;
    }
  }
  el.planBtn.disabled = false;
  el.planBtn.textContent = 'Plan flight';

  for (let i = 0; i < route.length; i++) {
    const [metar, taf] = await wxPromises[i];
    if (stale()) return;
    const node = $(`wx-${route[i].ident}`);
    if (node) node.outerHTML = wxCard('', route[i], metar, taf);
  }
  const altMetars = await altMetarsPromise;
  if (stale()) return;
  renderAlternates(alternates, p.dest, altMetars);
}

// ---------- plan ----------
async function plan(e) {
  e.preventDefault();
  el.formError.hidden = true;
  const p = readForm();
  if (p.errors.length) {
    el.formError.innerHTML = p.errors.map(esc).join('<br>');
    el.formError.hidden = false;
    return;
  }
  if (p.stops.length) return planMultiLeg(p);
  el.legsCard.hidden = true;

  const myId = ++state.planId;
  const stale = () => myId !== state.planId;
  el.planBtn.disabled = true;
  el.planBtn.textContent = 'Planning…';
  el.emptyState.hidden = true;
  el.planOutput.hidden = false;
  el.planNotice.hidden = true;
  el.cards.innerHTML = '<div class="card stat loading">Computing route and fetching winds aloft…</div>';
  el.fuelVerdict.innerHTML = el.altitudeCheck.innerHTML = el.windInfo.innerHTML = '';
  el.fuelVerdict.className = el.altitudeCheck.className = el.windInfo.className = 'card';
  el.weather.innerHTML = wxCard('Departure', p.dep, null, null) + wxCard('Destination', p.dest, null, null);

  // Alternates + map are synchronous — draw immediately.
  const alternates = findAlternates(p.dep, p.dest);
  drawRoute([p.dep, p.dest], alternates);
  renderAlternates(alternates, p.dest, null);
  // The results sit below the last form page — scroll down to the map.
  if (map) map.invalidateSize();
  if (window.lenis) window.lenis.scrollTo(el.results, { offset: -64, duration: 1.6 });
  else el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Kick off weather fetches in parallel with the wind lookup.
  const wxPromises = {
    depMetar: getMetar(p.dep.ident), depTaf: getTaf(p.dep.ident),
    destMetar: getMetar(p.dest.ident), destTaf: getTaf(p.dest.ident),
    altMetars: getMetars(alternates.slice(0, 3).map((a) => a.ident)),
  };

  // Wind
  let wind;
  const notices = [];
  if (p.windSource === 'manual') {
    wind = { dir: p.manualWind.dir, speed: p.manualWind.speed, sourceLabel: 'Manual entry' };
  } else {
    const mid = midpoint(p.dep.lat, p.dep.lon, p.dest.lat, p.dest.lon);
    const w = await getWindsAloft(mid.lat, mid.lon, p.altitude);
    if (stale()) return;
    if (w.ok) {
      wind = { dir: w.dir, speed: w.speed, sourceLabel: `Open-Meteo forecast, ${w.level.hpa} hPa (≈${fmt(w.level.ft)} ft), ${w.time}, at route midpoint ${mid.lat.toFixed(2)}, ${mid.lon.toFixed(2)}` };
    } else {
      wind = { dir: 0, speed: 0, sourceLabel: 'NONE — forecast unavailable, calculated with zero wind' };
      notices.push(`${w.message} Results below assume ZERO wind — treat heading, ground speed, and fuel as no-wind figures.`);
    }
  }

  // Wind triangle
  const tc = initialBearing(p.dep.lat, p.dep.lon, p.dest.lat, p.dest.lon);
  const tas = tasAtAltitude(p.aircraft.cruise_ktas_8000, p.altitude);
  const wt = windTriangle({ trueCourse: tc, tas, windDir: wind.dir, windSpeed: wind.speed });
  if (!wt.ok) {
    el.cards.innerHTML = '';
    el.planNotice.hidden = false;
    el.planNotice.className = 'alert alert-error';
    el.planNotice.textContent = `Wind triangle has no solution: ${wt.error} Try a different altitude or enter winds manually.`;
    el.windInfo.className = 'card v-bad';
    el.windInfo.innerHTML = `<h3>Winds aloft</h3><div class="row"><span>Wind</span><span>${formatDeg(wind.dir)} at ${fmt(wind.speed)} kt</span></div><div class="row"><span>Source</span><span>${esc(wind.sourceLabel)}</span></div><div class="row"><span>TAS</span><span>${fmt(tas)} kt</span></div>`;
  } else {
    renderPlan(p, wind, wt);
    if (notices.length) {
      el.planNotice.className = 'alert alert-warn';
      el.planNotice.textContent = notices.join(' ');
      el.planNotice.hidden = false;
    }
  }
  el.planBtn.disabled = false;
  el.planBtn.textContent = 'Plan flight';

  // Weather — render each card as soon as both pieces are in.
  const [depMetar, depTaf] = await Promise.all([wxPromises.depMetar, wxPromises.depTaf]);
  if (stale()) return;
  $(`wx-${p.dep.ident}`).outerHTML = wxCard('Departure', p.dep, depMetar, depTaf);
  const [destMetar, destTaf] = await Promise.all([wxPromises.destMetar, wxPromises.destTaf]);
  if (stale()) return;
  $(`wx-${p.dest.ident}`).outerHTML = wxCard('Destination', p.dest, destMetar, destTaf);
  const altMetars = await wxPromises.altMetars;
  if (stale()) return;
  renderAlternates(alternates, p.dest, altMetars);
}

// ---------- init ----------
async function init() {
  initMap();
  setupAutocomplete(el.dep, el.depList, el.depHint, 'dep');
  setupAutocomplete(el.dest, el.destList, el.destHint, 'dest');
  renderStopRows([]);
  el.addStopBtn.addEventListener('click', () => {
    const rows = readStopsLoose();
    if (rows.length >= MAX_STOPS) return;
    rows.push({ ap: null, text: '', minutes: 45, refuel: true });
    renderStopRows(rows);
    $(`stop${rows.length - 1}`).focus({ preventScroll: true });
  });

  el.aircraft.addEventListener('change', onAircraftChange);
  el.customUsable.addEventListener('input', () => { if (el.aircraft.value === CUSTOM_ID) el.fuelOnBoard.value = el.customUsable.value; });
  el.form.querySelectorAll('input[name="windSource"]').forEach((r) =>
    r.addEventListener('change', () => {
      const manual = r.value === 'manual' && r.checked;
      el.manualWind.hidden = !manual;
      el.windSourceHint.textContent = manual
        ? 'Enter the wind direction it blows FROM (° true) and speed in knots, e.g. from a winds-aloft (FB) forecast.'
        : 'Open-Meteo forecast at the route midpoint, nearest pressure level to your altitude.';
    }),
  );
  el.swapBtn.addEventListener('click', () => {
    const [a, b] = [state.dep, state.dest];
    state.dep = b; state.dest = a;
    el.dep.value = b ? b.ident : ''; el.dest.value = a ? a.ident : '';
    el.depHint.textContent = b ? describeAirport(b) : 'Type at least 2 characters';
    el.destHint.textContent = a ? describeAirport(a) : 'Type at least 2 characters';
    el.depHint.classList.toggle('selected', !!b);
    el.destHint.classList.toggle('selected', !!a);
    renderStopRows(readStopsLoose().reverse());   // the layovers are flown in the opposite order too
  });
  el.form.addEventListener('submit', plan);

  const results = await Promise.allSettled([loadAirports(), loadAircraft()]);
  const [airportsRes, aircraftRes] = results;
  const problems = [];
  if (airportsRes.status === 'fulfilled') {
    el.dataStatus.textContent = `${fmt(airportsRes.value)} airports loaded`;
    el.dataStatus.classList.add('ok');
  } else {
    problems.push(airportsRes.reason.message);
    el.dataStatus.textContent = 'Airport database failed to load';
    el.dataStatus.classList.add('err');
    el.dep.disabled = el.dest.disabled = true;
  }
  if (aircraftRes.status === 'fulfilled') populateAircraft(aircraftRes.value);
  else { problems.push(aircraftRes.reason.message); el.aircraft.innerHTML = '<option>Unavailable</option>'; }

  if (problems.length) showGlobalAlert(problems.join(' '));
  else el.planBtn.disabled = false;
}

init().catch((err) => showGlobalAlert(`The app failed to start: ${err.message}`));
