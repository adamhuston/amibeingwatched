// app.js
import { loadImagingSatellites, getOverheadSatellites, observationLikelihood, getSolarElevationDeg } from './satellites.js';
import { findNextPass } from './passes.js';
import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@7.0.0/+esm';

const REFRESH_INTERVAL_MS  = 10_000; // re-check positions every 10 seconds
const PASS_WARNING_MINS    = 5;      // fire "pass incoming" alert this many minutes ahead

let notificationEnabled = false;
let loadedSats          = [];   // cached after first load - OMM data, not positions

//  Notification state (persist across refresh ticks) 
let prevInFOVIds    = new Set();  // NORAD IDs that were inFOV last tick
let prevNearbyIds   = new Set();  // NORAD IDs that were nearby last tick
let notifiedPassIds    = new Set();  // IDs that already got a "pass incoming" warning
let nextPassCache      = null;       // last findNextPass() result
let nextPassComputedAt = 0;          // Date.now() when nextPassCache was computed
let updateNextPassFn   = null;
let nextPassRefreshPending = false;

//  DOM refs 
const elLocation         = document.getElementById('location');
const elStatus           = document.getElementById('status');
const elError            = document.getElementById('error');
const elRetryBtn         = document.getElementById('retry-btn');
const elImagingCount     = document.getElementById('imaging-count');
const elInFOV            = document.getElementById('in-fov');
const elNearby           = document.getElementById('nearby');
const elFovStat          = document.getElementById('fov-stat');
const elNearStat         = document.getElementById('near-stat');
const elTotalTracked     = document.getElementById('total-tracked');
const elConfirmedTracked = document.getElementById('confirmed-tracked');
const elProbableTracked  = document.getElementById('probable-tracked');
const elNextPass         = document.getElementById('next-pass');
const elNextPassMeta     = document.getElementById('next-pass-meta');
const elLikelihood       = document.getElementById('likelihood');
const elDaylightStatus   = document.getElementById('daylight-status');
const elSatTbody         = document.getElementById('sat-tbody');
const elSatListCount     = document.getElementById('sat-list-count');
const elNotifyBtn        = document.getElementById('notify-btn');

syncNotificationState();

function azimuthToCompass(azimuthDeg) {
  if (typeof azimuthDeg !== 'number' || Number.isNaN(azimuthDeg)) return '-';
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const normalized = ((azimuthDeg % 360) + 360) % 360;
  return labels[Math.round(normalized / 45) % labels.length];
}

function formatBearingTrend(sat) {
  const bearing = azimuthToCompass(sat.azimuthDeg ?? sat.trackStartAzimuthDeg);
  const trend = sat.trend || (sat.upcoming ? 'rising' : 'steady');
  return `${bearing} | ${trend}`;
}

function formatSkyTrack(sat) {
  const start = azimuthToCompass(sat.trackStartAzimuthDeg ?? sat.azimuthDeg);
  const end = azimuthToCompass(sat.trackEndAzimuthDeg ?? sat.azimuthDeg);
  return `${start}->${end}`;
}

function getLikelihoodFeedback(likelihood) {
  if (likelihood >= 75) return 'They can probably see you';
  if (likelihood >= 50) return 'There is a decent chance they can see you';
  if (likelihood >= 25) return 'There is a small chance they can see you';
  return 'They probably cannot see you';
}

function renderNextPass(result, minsLeft = result?.minutesAway ?? null) {
  if (!result) {
    elNextPass.textContent = 'No pass in 24h';
    if (elNextPassMeta) elNextPassMeta.textContent = '—';
    return;
  }

  if (typeof minsLeft === 'number' && minsLeft > 0.3) {
    elNextPass.textContent = `${result.name} in ${Math.round(minsLeft)}m`;
  } else {
    elNextPass.textContent = 'Updating next pass...';
  }

  if (elNextPassMeta) {
    elNextPassMeta.textContent = `${formatBearingTrend(result)} | ${formatSkyTrack(result)}`;
  }
}

//  Entry point 
async function run() {
  // Reset any previous error state on each attempt
  document.body.classList.add('loading');
  elError.textContent      = '';
  elRetryBtn.style.display = 'none';
  elLocation.textContent   = 'Acquiring location...';

  // 1. Geolocation
  let pos;
  try {
    pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 10_000,
        maximumAge: 60_000,
      })
    );
  } catch (err) {
    elLocation.textContent   = '';
    elRetryBtn.style.display = 'inline-block';
    document.body.classList.remove('loading');

    // GeolocationPositionError codes: 1=PERMISSION_DENIED, 2=UNAVAILABLE, 3=TIMEOUT
    if (err.code === 1) {
      showError(
        'Location permission was not granted. ' +
        'Click "Try again" to re-prompt, or enable Location in your browser site settings and reload.'
      );
    } else if (err.code === 3) {
      showError('Location request timed out. Check your device\'s location services and try again.');
    } else {
      showError('Could not determine your location. Try again.');
    }
    return;
  }

  const { latitude: lat, longitude: lon } = pos.coords;
  elLocation.textContent = `${lat.toFixed(4)}\u00b0, ${lon.toFixed(4)}\u00b0`;

  // satellite.js expects radians; height is in km (0 = ground level)
  const observerGd = {
    latitude:  satellite.degreesToRadians(lat),
    longitude: satellite.degreesToRadians(lon),
    height:    0.0,
  };

  // 2. Load satellite OMM data (localStorage-cached; fetches CelesTrak on cold start)
  showStatus('Loading satellite data...');
  try {
    loadedSats = await loadImagingSatellites();
  } catch (err) {
    console.error('[app] loadImagingSatellites threw:', err);
    document.body.classList.remove('loading');
    elRetryBtn.style.display = 'inline-block';
    showError(
      err?.message?.includes('bundled fallback snapshot')
        ? 'Live satellite data could not be reached, and no local fallback snapshot is bundled with this build.'
        : 'Failed to load satellite data. Check your connection and reload.'
    );
    return;
  }
  showStatus('');

  // Update confirmed vs probable tracking counts (set once; doesn't change on refresh)
  const confirmedCount = loadedSats.filter(s => s.confirmed !== false).length;
  const probableCount  = loadedSats.filter(s => s.confirmed === false).length;
  elTotalTracked.textContent     = loadedSats.length;
  if (elConfirmedTracked) elConfirmedTracked.textContent = confirmedCount;
  if (elProbableTracked)  elProbableTracked.textContent  = probableCount;

  // 3. Overhead count - fast, runs synchronously on the already-loaded data
  refresh(observerGd);

  // 4. Next pass - CPU-intensive; defer first run, then re-run every 5 min.
  //    Stored in nextPassCache so refresh() can fire the "pass incoming" warning.
  function updateNextPass() {
    const result       = findNextPass(loadedSats, observerGd);
    nextPassCache      = result;
    nextPassComputedAt = Date.now();
    nextPassRefreshPending = false;
    renderNextPass(result);
  }
  updateNextPassFn = updateNextPass;
  setTimeout(updateNextPass, 0);
  setInterval(updateNextPass, 5 * 60_000);

  // 5. Refresh positions every 10 seconds - satellites move ~7 km/s
  setInterval(() => refresh(observerGd), REFRESH_INTERVAL_MS);
}

/** Re-compute which satellites are currently overhead and update the UI. */
function refresh(observerGd) {
  const overhead   = getOverheadSatellites(loadedSats, observerGd);
  const inFOV   = overhead.filter(s => s.inFOV);
  const nearby  = overhead.filter(s => s.nearby);
  const solarElev  = getSolarElevationDeg(observerGd);
  const likelihood = observationLikelihood(overhead, solarElev);
  let nextPassMinsLeft = null;

  elImagingCount.textContent = overhead.length;
  elInFOV.textContent        = inFOV.length;
  elNearby.textContent       = nearby.length;
  elLikelihood.textContent   = `${likelihood}%`;
  document.body.classList.remove('loading');

  elFovStat.classList.toggle('alert-fov',    inFOV.length > 0);
  elNearStat.classList.toggle('alert-nearby', nearby.length > 0);

  const likelihoodClass =
    likelihood >= 75 ? 'likelihood-high' :
    likelihood >= 50 ? 'likelihood-elevated' :
    likelihood >= 25 ? 'likelihood-guarded' :
                       'likelihood-low';
  elLikelihood.className = likelihoodClass;
  const likelihoodFeedback = getLikelihoodFeedback(likelihood);

  const daylightLabel = solarElev > 0 ? 'daytime' : solarElev > -6 ? 'civil twilight' : 'nighttime';
  if (inFOV.length === 0) {
    elDaylightStatus.textContent = `${likelihoodFeedback}  |  ${daylightLabel}  |  no satellites within imaging swath`;
  } else if (solarElev <= -6) {
    elDaylightStatus.textContent = `${likelihoodFeedback}  |  nighttime  |  optical imaging unlikely  |  SAR satellites unaffected`;
  } else {
    elDaylightStatus.textContent = `${likelihoodFeedback}  |  ${daylightLabel}  |  ${inFOV.length} satellite${inFOV.length !== 1 ? 's' : ''} within imaging swath`;
  }

  // Update next-pass countdown every tick using elapsed time since last computation
  if (nextPassCache && nextPassComputedAt) {
    const minsLeft = nextPassCache.minutesAway - (Date.now() - nextPassComputedAt) / 60_000;
    nextPassMinsLeft = minsLeft;
    if (minsLeft > 0.3) {
      renderNextPass(nextPassCache, minsLeft);
    } else {
      renderNextPass(nextPassCache, minsLeft);
      if (updateNextPassFn && !nextPassRefreshPending) {
        nextPassRefreshPending = true;
        setTimeout(() => updateNextPassFn?.(), 0);
      }
    }
  } else if (!nextPassCache) {
    renderNextPass(null);
  }

  // Rebuild satellite table
  renderSatTable(overhead, nextPassCache, nextPassMinsLeft);
  const currentInFOVIds  = new Set(inFOV.map(s => s.noradId));
  const currentNearbyIds = new Set(nearby.map(s => s.noradId));
  const overheadIds      = new Set(overhead.map(s => s.noradId));

  // LEVEL 2: satellite newly entered imaging range
  for (const sat of inFOV) {
    if (!prevInFOVIds.has(sat.noradId)) notifyFOVEntry(sat);
  }
  // LEVEL 3: satellite newly became nearby (elevation > 25\u00b0)
  for (const sat of nearby) {
    if (!prevNearbyIds.has(sat.noradId)) notifyNearby(sat);
  }

  // Reset pass-incoming dedup once a satellite actually rises
  for (const id of notifiedPassIds) {
    if (overheadIds.has(id)) notifiedPassIds.delete(id);
  }

  prevInFOVIds  = currentInFOVIds;
  prevNearbyIds = currentNearbyIds;

  // LEVEL 1: next pass is within the warning window
  if (nextPassCache) {
    const minsLeft = nextPassCache.minutesAway - (Date.now() - nextPassComputedAt) / 60_000;
    if (minsLeft <= PASS_WARNING_MINS) notifyPassIncoming(nextPassCache, minsLeft);
  }
}

// -- Satellite table ---------------------------------------------------------

/** Rebuild the collapsible satellite list table, sorted by elevation descending. */
function renderSatTable(overhead, nextPass, nextPassMinsLeft) {
  if (!elSatTbody) return;
  const sorted = [...overhead].sort((a, b) => b.elevationDeg - a.elevationDeg);
  const rows = [...sorted];
  const nextPassAlreadyVisible = nextPass && sorted.some(sat => sat.noradId === nextPass.noradId);

  if (nextPass && !nextPassAlreadyVisible && typeof nextPassMinsLeft === 'number' && nextPassMinsLeft > 0.3) {
    rows.push({
      ...nextPass,
      upcoming: true,
      displayMinutesAway: Math.max(1, Math.round(nextPassMinsLeft)),
    });
  }

  if (elSatListCount) elSatListCount.textContent = rows.length;
  const fragment = document.createDocumentFragment();

  for (const sat of rows) {
    const rowCls = sat.upcoming ? 'sat-row-next' : sat.inFOV ? 'sat-row-fov' : sat.nearby ? 'sat-row-nearby' : '';
    const status = sat.upcoming ? 'NEXT PASS' : sat.inFOV ? 'IN RANGE' : sat.nearby ? 'NEARBY' : '-';
    const name   = (sat.name + (sat.confirmed === false ? ' ?' : '')).slice(0, 24);

    const row = document.createElement('tr');
    if (rowCls) row.className = rowCls;

    const nameCell = document.createElement('td');
    nameCell.textContent = name;

    const elevationCell = document.createElement('td');
    elevationCell.textContent = sat.upcoming
      ? `in ${sat.displayMinutesAway}m`
      : `${sat.elevationDeg.toFixed(0)}\u00b0`;

    const statusCell = document.createElement('td');
    statusCell.textContent = status;

    const bearingCell = document.createElement('td');
    bearingCell.textContent = formatBearingTrend(sat);

    const trackCell = document.createElement('td');
    trackCell.textContent = formatSkyTrack(sat);

    row.append(nameCell, elevationCell, statusCell, bearingCell, trackCell);
    fragment.appendChild(row);
  }

  elSatTbody.replaceChildren(fragment);
}

// -- Notifications ----------------------------------------------------------

/**
 * Request notification permission on explicit user action (button click).
 * Never call this automatically - browsers block auto-permission requests.
 * Exported so index.html can wire it to the button.
 */
export function requestNotifications() {
  if (!('Notification' in window)) return;
  Notification.requestPermission().then(perm => {
    notificationEnabled = perm === 'granted';
    updateNotifyButton();
  });
}

function syncNotificationState() {
  if (!('Notification' in window)) {
    if (elNotifyBtn) {
      elNotifyBtn.textContent = 'Alerts unavailable';
      elNotifyBtn.disabled = true;
    }
    return;
  }

  notificationEnabled = Notification.permission === 'granted';
  updateNotifyButton();
}

function updateNotifyButton() {
  if (!elNotifyBtn) return;

  elNotifyBtn.textContent = notificationEnabled
    ? 'Alerts enabled'
    : Notification.permission === 'denied'
      ? 'Alerts blocked'
      : 'Enable overhead alerts';
}

// LEVEL 1 - satellite is approaching the horizon (~5 min warning)
function notifyPassIncoming(pass, minsLeft) {
  if (!notificationEnabled || notifiedPassIds.has(pass.noradId)) return;
  notifiedPassIds.add(pass.noradId);
  const mins = Math.max(1, Math.round(minsLeft));
  new Notification('Satellite approaching', {
    body: `${pass.name} passes overhead in ${mins} minute${mins !== 1 ? 's' : ''}`,
    icon: './icons/icon-192.png',
    tag:  `pass-${pass.noradId}`,
  });
}

// LEVEL 2 - satellite entered imaging swath (nadir < 30\u00b0) - it can see your location
function notifyFOVEntry(sat) {
  if (!notificationEnabled) return;
  new Notification('Satellite in imaging range', {
    body: `${sat.name} can see your location  |  ${sat.elevationDeg.toFixed(0)}\u00b0 elevation`,
    icon: './icons/icon-192.png',
    tag:  `fov-${sat.noradId}`,
  });
}

// LEVEL 3 - satellite is elevated above 25\u00b0 - tracking arc is well established
function notifyNearby(sat) {
  if (!notificationEnabled) return;
  new Notification('Satellite nearby', {
    body: `${sat.name} is ${sat.elevationDeg.toFixed(0)}\u00b0 above the horizon`,
    icon: './icons/icon-192.png',
    tag:  `near-${sat.noradId}`,
  });
}

//  UI helpers 
function showStatus(msg) { elStatus.textContent = msg; }
function showError(msg)  { elError.textContent  = msg; }

//  Boot 
elRetryBtn.addEventListener('click', run);
run();
