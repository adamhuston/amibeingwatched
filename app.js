// app.js
import { CACHE_TTL_MS, loadImagingSatellites, getOverheadSatellites, observationLikelihood, getSolarElevationDeg } from './satellites.js';
import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@7.0.0/+esm';

const REFRESH_INTERVAL_MS  = 5_000;
const RETRY_INTERVAL_MS = 30_000;
const PASS_REFRESH_INTERVAL_MS = 5 * 60_000;

let loadedSats = [];
let running = false;
let positionTimer;
let passTimer;
let reloadTimer;
let passTimeout;
let passWorker = null;

let nextPassCache      = null;       // last findNextOverheadPass() result
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

function formatSoonText(minutesAway) {
  if (typeof minutesAway !== 'number' || Number.isNaN(minutesAway)) return null;
  if (minutesAway <= 0.3) return 'now';
  return `${Math.max(1, Math.round(minutesAway))}m`;
}

function getRemainingPassMinutes(sat, targetMinutesAway, currentRiseMinutesAway) {
  if (typeof targetMinutesAway !== 'number' || Number.isNaN(targetMinutesAway)) return null;
  if (typeof sat?.minutesAway !== 'number' || Number.isNaN(sat.minutesAway)) return targetMinutesAway;
  if (typeof currentRiseMinutesAway !== 'number' || Number.isNaN(currentRiseMinutesAway)) return targetMinutesAway;

  return Math.max(0, targetMinutesAway - (sat.minutesAway - currentRiseMinutesAway));
}

function getVisibleStatus(sat) {
  return sat.inFOV ? 'IN RANGE' : sat.nearby ? 'NEARBY' : 'VISIBLE';
}

function describeOverheadPass(sat, minsLeft = sat?.minutesAway ?? null) {
  if (!sat) return null;

  const parts = [];
  const riseText = formatSoonText(getRemainingPassMinutes(sat, sat.riseMinutesAway, minsLeft));
  if (riseText && riseText !== 'now') {
    parts.push(`rises in ${riseText}`);
  }
  if (typeof sat.peakElevationDeg === 'number') {
    parts.push(`${sat.peakElevationDeg.toFixed(0)}° peak`);
  }

  return parts.join(' | ');
}

function getLikelihoodFeedback(likelihood) {
  if (likelihood >= 90) return 'Panic: they absolutely have line of sight.';
  if (likelihood >= 75) return 'Very high chance they can see you right now.';
  if (likelihood >= 60) return 'The odds are solidly in their favor.';
  if (likelihood >= 45) return 'Fifty-shmifty. Could go either way.';
  if (likelihood >= 30) return 'Honestly just keep your head down.';
  if (likelihood >= 15) return 'Low chance they can see you.';
  return 'All clear!';
}

function renderNextPass(result, minsLeft = result?.minutesAway ?? null) {
  if (!result) {
    elNextPass.textContent = 'No overhead pass in 24h';
    if (elNextPassMeta) elNextPassMeta.textContent = '—';
    return;
  }

  if (typeof minsLeft === 'number' && minsLeft > 0.3) {
    elNextPass.textContent = `${result.name} overhead in ${Math.round(minsLeft)}m`;
  } else {
    elNextPass.textContent = `${result.name} overhead now`;
  }

  if (elNextPassMeta) {
    const passDescription = describeOverheadPass(result, minsLeft);
    elNextPassMeta.textContent = [formatBearingTrend(result), formatSkyTrack(result), passDescription]
      .filter(Boolean)
      .join(' | ');
  }
}

function stopTracking() {
  clearInterval(positionTimer);
  clearInterval(passTimer);
  clearTimeout(reloadTimer);
  clearTimeout(passTimeout);
  passWorker?.terminate();
  passWorker = null;
  nextPassCache = null;
  nextPassComputedAt = 0;
  nextPassRefreshPending = false;
  updateNextPassFn = null;
}

function clearReadings() {
  for (const el of [elImagingCount, elInFOV, elNearby, elLikelihood, elTotalTracked,
    elConfirmedTracked, elProbableTracked, elSatListCount, elDaylightStatus, elNextPassMeta]) {
    if (el) el.textContent = '—';
  }
  elNextPass.textContent = 'Awaiting satellite data...';
  elFovStat.classList.remove('alert-fov');
  elNearStat.classList.remove('alert-nearby');
  elSatTbody?.replaceChildren();
}

function failTracking(message, retry = true) {
  stopTracking();
  clearReadings();
  document.body.classList.remove('loading');
  showStatus('');
  showError(message + (retry ? ' Retrying automatically in 30 seconds.' : ''));
  elRetryBtn.style.display = 'inline-block';
  if (retry) reloadTimer = setTimeout(run, RETRY_INTERVAL_MS);
}

//  Entry point 
async function run() {
  if (running) return;
  running = true;
  stopTracking();
  clearReadings();
  try {
    await startTracking();
  } catch (err) {
    console.error('[app] Tracking failed:', err);
    failTracking('Satellite tracking is unavailable: ' + err.message);
  } finally {
    running = false;
  }
}

async function startTracking() {
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

    // GeolocationPositionError codes: 1=PERMISSION_DENIED, 2=UNAVAILABLE, 3=TIMEOUT
    if (err.code === 1) {
      failTracking(
        'Location permission was not granted. ' +
        'Click "Try again" to re-prompt, or enable Location in your browser site settings and reload.',
        false
      );
    } else if (err.code === 3) {
      failTracking('Location request timed out. Check your device\'s location services.');
    } else {
      failTracking('Could not determine your location.');
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
  loadedSats = await loadImagingSatellites();
  showStatus('');

  // Update confirmed vs probable tracking counts (set once; doesn't change on refresh)
  const confirmedCount = loadedSats.filter(s => s.confirmed !== false).length;
  const probableCount  = loadedSats.filter(s => s.confirmed === false).length;
  elTotalTracked.textContent     = loadedSats.length;
  if (elConfirmedTracked) elConfirmedTracked.textContent = confirmedCount;
  if (elProbableTracked)  elProbableTracked.textContent  = probableCount;

  // 3. Overhead count - fast, runs synchronously on the already-loaded data
  refresh(observerGd);

  // Prediction runs off the UI thread so position refreshes remain responsive.
  function updateNextPass() {
    if (passWorker) return;
    nextPassRefreshPending = true;
    function predictionFailed(message) {
      clearTimeout(passTimeout);
      passWorker?.terminate();
      passWorker = null;
      nextPassRefreshPending = false;
      nextPassCache = null;
      nextPassComputedAt = 0;
      elNextPass.textContent = 'Pass prediction unavailable';
      if (elNextPassMeta) elNextPassMeta.textContent = message;
      console.error('[app] Pass prediction failed:', message);
    }
    try {
      const worker = new Worker(new URL('./passes-worker.js', import.meta.url), { type: 'module' });
      passWorker = worker;
      worker.onmessage = ({ data }) => {
        if (passWorker !== worker) return;
        if (data.error) {
          predictionFailed(data.error);
          return;
        }
        clearTimeout(passTimeout);
        worker.terminate();
        passWorker = null;
        nextPassCache = data.result;
        nextPassComputedAt = data.computedAt;
        nextPassRefreshPending = false;
        renderNextPass(data.result, data.result
          ? data.result.minutesAway - (Date.now() - data.computedAt) / 60_000 : null);
      };
      worker.onerror = event => {
        event.preventDefault();
        if (passWorker === worker) predictionFailed(event.message || 'Worker could not load');
      };
      passTimeout = setTimeout(() => predictionFailed('Prediction timed out; will retry automatically.'), 120_000);
      if (!nextPassComputedAt) elNextPass.textContent = 'Calculating next overhead pass...';
      worker.postMessage({ sats: loadedSats, observerGd });
    } catch (err) {
      predictionFailed(err.message);
    }
  }
  updateNextPassFn = updateNextPass;
  updateNextPass();
  passTimer = setInterval(updateNextPass, PASS_REFRESH_INTERVAL_MS);

  positionTimer = setInterval(() => {
    try {
      refresh(observerGd);
    } catch (err) {
      console.error('[app] Position refresh failed:', err);
      failTracking('Satellite positions are unavailable: ' + err.message);
    }
  }, REFRESH_INTERVAL_MS);
  reloadTimer = setTimeout(run, CACHE_TTL_MS);
}

/** Re-compute which satellites are currently overhead and update the UI. */
function refresh(observerGd) {
  const overhead   = getOverheadSatellites(loadedSats, observerGd);
  const inFOV   = overhead.filter(s => s.inFOV);
  const nearby  = overhead.filter(s => s.nearby);
  const solarElev  = getSolarElevationDeg(observerGd);
  const likelihood = observationLikelihood(overhead, solarElev);

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

  // Update next-overhead countdown every tick using elapsed time since last computation
  if (nextPassCache && nextPassComputedAt) {
    const minsLeft = nextPassCache.minutesAway - (Date.now() - nextPassComputedAt) / 60_000;
    if (minsLeft > 0.3) {
      renderNextPass(nextPassCache, minsLeft);
    } else {
      renderNextPass(nextPassCache, minsLeft);
      if (updateNextPassFn && !nextPassRefreshPending) {
        nextPassRefreshPending = true;
        setTimeout(() => updateNextPassFn?.(), 0);
      }
    }
  } else if (nextPassComputedAt) {
    renderNextPass(null);
  }

  // Rebuild satellite table
  renderSatTable(overhead);
}

// -- Satellite table ---------------------------------------------------------

/** Rebuild the collapsible satellite list table, sorted by elevation descending. */
function renderSatTable(overhead) {
  if (!elSatTbody) return;
  const sorted = [...overhead].sort((a, b) => b.elevationDeg - a.elevationDeg);

  if (elSatListCount) elSatListCount.textContent = sorted.length;
  const fragment = document.createDocumentFragment();

  for (const sat of sorted) {
    const rowCls = sat.inFOV ? 'sat-row-fov' : sat.nearby ? 'sat-row-nearby' : '';
    const status = getVisibleStatus(sat);
    const name   = (sat.name + (sat.confirmed === false ? ' ?' : '')).slice(0, 24);

    const row = document.createElement('tr');
    if (rowCls) row.className = rowCls;

    const nameCell = document.createElement('td');
    nameCell.textContent = name;

    const elevationCell = document.createElement('td');
    elevationCell.textContent = `${sat.elevationDeg.toFixed(0)}\u00b0`;

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

//  UI helpers 
function showStatus(msg) { elStatus.textContent = msg; }
function showError(msg)  { elError.textContent  = msg; }

//  Boot 
elRetryBtn.addEventListener('click', run);
window.addEventListener('online', run);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') run();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) run();
});
run();
