// satellites.js
import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@7.0.0/+esm';

const CELESTRAK_BASE        = 'https://celestrak.org/NORAD/elements/gp.php';
const FALLBACK_SNAPSHOT_URL = './satellites-fallback.json';
const CACHE_TTL_MS          = 2 * 60 * 60 * 1000; // 2 hours — CelesTrak enforced rate limit
const R_EARTH_KM            = 6371;
const MU_KM3_S2             = 398600.4418;          // Earth gravitational parameter km³/s²
const FOV_HALF_ANGLE_DEG  = 30;  // max off-nadir for typical imaging satellite
const NEARBY_ELEVATION_DEG = 25; // elevation above which a satellite is considered "nearby" (~30-40 min before imaging range)
const MOTION_SAMPLE_SECONDS = 30;

// Named imaging operators — CelesTrak regular catalog
const IMAGING_GROUPS      = ['resource', 'planet', 'DMC'];
// Broader groups scanned with orbital filter for probable imaging satellites
const PROBABLE_GROUPS     = ['military', 'cubesat'];

function readCachedGroup(dataKey) {
  const raw = localStorage.getItem(dataKey);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch one CelesTrak GP group. Reads from localStorage cache if data is < 2h old.
 * Falls back to stale cache on HTTP error (403/404) — does NOT retry.
 */
async function fetchGroup(group, baseUrl = CELESTRAK_BASE, param = 'GROUP') {
  const cacheKey = `${param}_${group}`;
  const tsKey    = `tle_timestamp_${cacheKey}`;
  const dataKey  = `tle_data_${cacheKey}`;
  const cachedTs = parseInt(localStorage.getItem(tsKey) || '0', 10);
  const cachedData = readCachedGroup(dataKey);

  if (Date.now() - cachedTs < CACHE_TTL_MS) {
    return cachedData || [];
  }

  const url = `${baseUrl}?${param}=${group}&FORMAT=JSON`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // 403 = over rate limit, 404 = bad group name — return stale cache, do not retry
      console.warn(`[satellites] ${group}: HTTP ${res.status}`);
      if (cachedData) return cachedData;
      throw new Error(`Satellite group ${group} unavailable (HTTP ${res.status})`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      console.warn(`[satellites] ${group}: empty or non-array response`);
      if (cachedData) return cachedData;
      throw new Error(`Satellite group ${group} returned no usable data`);
    }
    localStorage.setItem(dataKey, JSON.stringify(data));
    localStorage.setItem(tsKey, String(Date.now()));
    return data;
  } catch (err) {
    // Network failure, JSON parse error, etc. — return stale cache
    console.warn(`[satellites] ${group}: fetch/parse error —`, err.message);
    if (cachedData) return cachedData;
    throw err;
  }
}

/**
 * Returns true if orbital elements match the profile of an Earth-imaging satellite:
 * LEO altitude 300–1200 km, inclination ≥ 40° (not equatorial), eccentricity < 0.02 (circular).
 * Used to flag "probable imaging" satellites from broader catalogs where purpose is unlisted.
 */
function isImagingLikeOrbit(omm) {
  const inc  = parseFloat(omm.INCLINATION  || 0);
  const ecc  = parseFloat(omm.ECCENTRICITY || 1);
  const nRev = parseFloat(omm.MEAN_MOTION  || 0); // rev/day
  if (!nRev) return false;
  const nRads = nRev * 2 * Math.PI / 86400;              // rad/s
  const a     = Math.cbrt(MU_KM3_S2 / (nRads * nRads));  // semi-major axis km
  const alt   = a - R_EARTH_KM;
  return alt >= 300 && alt <= 1200 && inc >= 40 && ecc < 0.02;
}

function getLookAnglesDeg(satrec, observerGd, date) {
  const gmst   = satellite.gstime(date);
  const pv     = satellite.propagate(satrec, date);
  if (!pv?.position) return null;

  const posEcf = satellite.eciToEcf(pv.position, gmst);
  const look   = satellite.ecfToLookAngles(observerGd, posEcf);
  return {
    azimuthDeg: look.azimuth * (180 / Math.PI),
    elevationDeg: look.elevation * (180 / Math.PI),
    position: pv.position,
  };
}

function getMotionMetadata(satrec, observerGd, now, currentLook) {
  const futureLook = getLookAnglesDeg(satrec, observerGd, new Date(now.getTime() + MOTION_SAMPLE_SECONDS * 1000));
  if (!futureLook) {
    return {
      trend: 'steady',
      trackStartAzimuthDeg: currentLook.azimuthDeg,
      trackEndAzimuthDeg: currentLook.azimuthDeg,
    };
  }

  const deltaElevation = futureLook.elevationDeg - currentLook.elevationDeg;
  const trend = deltaElevation > 0.15 ? 'rising' : deltaElevation < -0.15 ? 'setting' : 'steady';
  return {
    trend,
    trackStartAzimuthDeg: currentLook.azimuthDeg,
    trackEndAzimuthDeg: futureLook.azimuthDeg,
  };
}

async function loadGroupSet(groups) {
  const settled = await Promise.allSettled(groups.map(group => fetchGroup(group, CELESTRAK_BASE, 'GROUP')));
  const loadedGroups = [];
  const failedGroups = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const group = groups[i];
    if (result.status === 'fulfilled') {
      loadedGroups.push(result.value);
    } else {
      failedGroups.push({ group, reason: result.reason });
    }
  }

  return { loadedGroups, failedGroups };
}

async function loadBundledFallbackSnapshot() {
  try {
    const res = await fetch(FALLBACK_SNAPSHOT_URL, { cache: 'no-store' });
    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    console.warn(`[satellites] using bundled fallback snapshot from ${FALLBACK_SNAPSHOT_URL}`);
    return data;
  } catch (_) {
    return null;
  }
}

/**
 * Load all imaging satellite OMM records from CelesTrak.
 * Sources:
 *   confirmed — named imaging operators (regular + supplemental catalogs)
 *   probable  — military & CubeSat catalogs filtered by imaging-like orbital characteristics
 * Deduplicates by NORAD_CAT_ID; each record gains a `confirmed` boolean.
 * @returns {Promise<object[]>}
 */
export async function loadImagingSatellites() {
  const [regularSet, probableSet] = await Promise.all([
    loadGroupSet(IMAGING_GROUPS),
    loadGroupSet(PROBABLE_GROUPS),
  ]);

  const regularResults = regularSet.loadedGroups;
  const probableResults = probableSet.loadedGroups;
  const failedGroups = [...regularSet.failedGroups, ...probableSet.failedGroups];

  if (failedGroups.length > 0) {
    console.warn(
      '[satellites] proceeding with partial data; unavailable groups:',
      failedGroups.map(({ group, reason }) => `${group}: ${reason?.message || String(reason)}`).join(', ')
    );
  }

  if (regularResults.length === 0 && probableResults.length === 0) {
    const fallbackSnapshot = await loadBundledFallbackSnapshot();
    if (fallbackSnapshot) return fallbackSnapshot;

    throw new Error('All satellite groups were unavailable and no bundled fallback snapshot was found');
  }

  const seen = new Set();
  const all  = [];

  // Confirmed: named imaging operators from regular catalog
  for (const group of regularResults) {
    for (const omm of group) {
      if (!seen.has(omm.NORAD_CAT_ID)) {
        seen.add(omm.NORAD_CAT_ID);
        all.push({ ...omm, confirmed: true });
      }
    }
  }

  // Probable: broader catalogs filtered to imaging-like orbits
  for (const group of probableResults) {
    for (const omm of group) {
      if (!seen.has(omm.NORAD_CAT_ID) && isImagingLikeOrbit(omm)) {
        seen.add(omm.NORAD_CAT_ID);
        all.push({ ...omm, confirmed: false });
      }
    }
  }

  return all;
}

/**
 * Given a list of OMM satellite records and an observer geodetic position,
 * return the subset currently above the horizon (elevation > 0).
 *
 * @param {object[]} sats  - OMM JSON objects from loadImagingSatellites()
 * @param {object}   observerGd - { latitude (rad), longitude (rad), height (km) }
 * @returns {object[]} overhead satellites with elevation, azimuth, altitudeKm
 */
export function getOverheadSatellites(sats, observerGd) {
  const now    = new Date();
  const overhead = [];

  for (const omm of sats) {
    try {
      const satrec = satellite.json2satrec(omm);
      const lookNow = getLookAnglesDeg(satrec, observerGd, now);
      if (!lookNow || lookNow.elevationDeg <= 0) continue;

      const distKm     = Math.sqrt(lookNow.position.x ** 2 + lookNow.position.y ** 2 + lookNow.position.z ** 2);
      const altitudeKm = distKm - R_EARTH_KM;
      const elevationRad = lookNow.elevationDeg * (Math.PI / 180);
      const motion = getMotionMetadata(satrec, observerGd, now, lookNow);

      // Off-nadir angle: angle from sub-satellite point to observer, measured at the satellite.
      // Derived from spherical Earth geometry: sin(θ) = R·cos(ε) / (R + h)
      const sinNadir     = Math.min(1, (R_EARTH_KM * Math.cos(elevationRad)) / (R_EARTH_KM + altitudeKm));
      const nadirAngleDeg = Math.asin(sinNadir) * (180 / Math.PI);

      overhead.push({
        name:             omm.OBJECT_NAME,
        noradId:          omm.NORAD_CAT_ID,
        confirmed:        omm.confirmed,
        elevationDeg:     lookNow.elevationDeg,
        azimuthDeg:       lookNow.azimuthDeg,
        altitudeKm,
        nadirAngleDeg,
        trend:            motion.trend,
        trackStartAzimuthDeg: motion.trackStartAzimuthDeg,
        trackEndAzimuthDeg: motion.trackEndAzimuthDeg,
        inFOV:   nadirAngleDeg < FOV_HALF_ANGLE_DEG,
        nearby:  lookNow.elevationDeg > NEARBY_ELEVATION_DEG,
      });
    } catch (_) {
      // Bad orbital elements — skip silently
    }
  }

  return overhead;
}

/**
 * Compute solar elevation angle (degrees) for the observer's position.
 * Uses a simplified solar position model accurate to ±1°.
 * Returns positive values for daytime, negative for night.
 *
 * @param {object} observerGd - { latitude (rad), longitude (rad) }
 * @returns {number} solar elevation in degrees
 */
export function getSolarElevationDeg(observerGd) {
  const now       = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86_400_000);
  const declRad   = -23.45 * (Math.PI / 180) * Math.cos(2 * Math.PI / 365 * (dayOfYear + 10));
  const lonDeg    = observerGd.longitude * (180 / Math.PI);
  const utcHours  = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const hourAngle = ((utcHours + lonDeg / 15) - 12) * 15 * (Math.PI / 180);
  const sinElev   = Math.sin(observerGd.latitude) * Math.sin(declRad)
                  + Math.cos(observerGd.latitude) * Math.cos(declRad) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) * (180 / Math.PI);
}

/**
 * Compute observation likelihood as a percentage (0–99).
 *
 * Uses a probabilistic "exposure" model:
 *   – Only satellites within the imaging FOV (nadir < 30°) contribute.
 *   – Each satellite's weight = (1 − nadirAngle/30)², quadratic falloff toward FOV edge.
 *   – Combined exposure converted via 1 − e^(−Σweights): independent-events model.
 *   – Multiplied by a daylight factor — optical satellites need sunlight.
 *
 * Caps at 99: certainty is never warranted (tasking schedules are unknown).
 *
 * @param {object[]} overhead         - result of getOverheadSatellites()
 * @param {number}   solarElevationDeg - from getSolarElevationDeg()
 * @returns {number} integer 0–99
 */
export function observationLikelihood(overhead, solarElevationDeg) {
  // Geometric access: how much of the imaging swath are we exposed to right now?
  // Linear weight (not quadratic) so a satellite at nadir=15° still registers meaningfully.
  // Scale factor 1.8 → 1 satellite directly overhead (nadir≈0°) scores ~84%.
  let exposure = 0;
  for (const sat of overhead) {
    if (!sat.inFOV) continue;
    const w = Math.max(0, 1 - sat.nadirAngleDeg / FOV_HALF_ANGLE_DEG);
    exposure += w;
  }

  const geometricScore = 1 - Math.exp(-1.8 * exposure);

  // Daylight factor: optical sensors need sunlight, but we never suppress to 0.
  // Floor at 0.2 — SAR satellites (Capella, ICEYE, Umbra) operate at night,
  // and tasking schedules for any satellite are unknown to us.
  const daylightFactor = Math.max(0.2, Math.min(1, (solarElevationDeg + 12) / 6));

  return Math.min(99, Math.round(geometricScore * daylightFactor * 100));
}
