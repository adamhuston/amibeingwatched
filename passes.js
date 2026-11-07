// passes.js
import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@7.0.0/+esm';
import { getVisibilityState } from './satellites.js';

const STEP_SECONDS    = 60;       // 1-minute resolution — accurate enough for pass prediction
const LOOKAHEAD_HOURS = 24;
const PASS_EDGE_STEP_SECONDS = 30;
const MAX_PASS_DURATION_MINUTES = 120;
const R_EARTH_KM = 6371;
const OVERHEAD_PASS_MIN_ELEVATION_DEG = 80;

function getLookAnglesDeg(satrec, observerGd, date) {
  const gmst   = satellite.gstime(date);
  const pv     = satellite.propagate(satrec, date);
  if (!pv?.position) return null;

  const posEcf = satellite.eciToEcf(pv.position, gmst);
  const look   = satellite.ecfToLookAngles(observerGd, posEcf);
  if (!Number.isFinite(look.elevation) || !Number.isFinite(look.azimuth)) return null;
  return {
    azimuthDeg: look.azimuth * (180 / Math.PI),
    elevationDeg: look.elevation * (180 / Math.PI),
    position: pv.position,
  };
}

function getLookSnapshot(satrec, observerGd, date) {
  const look = getLookAnglesDeg(satrec, observerGd, date);
  if (!look?.position) return null;

  const distKm = Math.sqrt(look.position.x ** 2 + look.position.y ** 2 + look.position.z ** 2);
  const altitudeKm = distKm - R_EARTH_KM;

  return {
    ...look,
    altitudeKm,
    ...getVisibilityState(look.elevationDeg, altitudeKm),
  };
}

function computeSetAzimuthDeg(satrec, observerGd, riseDate) {
  const maxSteps = Math.floor((MAX_PASS_DURATION_MINUTES * 60) / PASS_EDGE_STEP_SECONDS);
  let previousLook = getLookAnglesDeg(satrec, observerGd, riseDate);
  if (!previousLook) return null;

  for (let i = 1; i <= maxSteps; i++) {
    const t = new Date(riseDate.getTime() + i * PASS_EDGE_STEP_SECONDS * 1000);
    const look = getLookAnglesDeg(satrec, observerGd, t);
    if (!look) continue;
    if (look.elevationDeg <= 0) return look.azimuthDeg;
    previousLook = look;
  }

  return previousLook.azimuthDeg;
}

function getUpcomingPassDetails(satrec, observerGd, riseDate, riseMinutesAway) {
  const maxSteps = Math.floor((MAX_PASS_DURATION_MINUTES * 60) / PASS_EDGE_STEP_SECONDS);
  const riseLook = getLookSnapshot(satrec, observerGd, riseDate);
  if (!riseLook) return null;

  let peakElevationDeg = riseLook.elevationDeg;
  let peakMinutesAway = riseMinutesAway;
  let setAzimuthDeg = riseLook.azimuthDeg;
  let setMinutesAway = riseMinutesAway + MAX_PASS_DURATION_MINUTES;

  for (let i = 1; i <= maxSteps; i++) {
    const t = new Date(riseDate.getTime() + i * PASS_EDGE_STEP_SECONDS * 1000);
    const look = getLookSnapshot(satrec, observerGd, t);
    if (!look) continue;
    if (look.elevationDeg <= 0) {
      setAzimuthDeg = look.azimuthDeg;
      setMinutesAway = riseMinutesAway + (i * PASS_EDGE_STEP_SECONDS) / 60;
      break;
    }

    if (look.elevationDeg > peakElevationDeg) {
      peakElevationDeg = look.elevationDeg;
      peakMinutesAway = riseMinutesAway + (i * PASS_EDGE_STEP_SECONDS) / 60;
    }

    setAzimuthDeg = look.azimuthDeg;
  }

  return {
    riseLook,
    setAzimuthDeg,
    peakElevationDeg,
    peakMinutesAway,
    setMinutesAway,
  };
}

/**
 * Find the next overhead-style pass for any satellite in `sats`.
 *
 * Exact 90-degree zenith passes are rare, so we treat "overhead" as any pass
 * with a predicted peak elevation of at least 80 degrees.
 *
 * Strategy:
 *   1. Compute current elevation for every satellite.
 *   2. Check whether any currently visible satellite is already in an overhead-quality pass.
 *   3. Sort satellites by elevation descending (closest to rising first).
 *   4. Step forward in time until a satellite rises.
 *   5. Inspect that pass and keep it only if its peak reaches the overhead threshold.
 *   6. Return the earliest qualifying overhead peak, whether already in progress or upcoming.
 *
 * This function is CPU-intensive and runs in a module worker.
 *
 * @param {object[]} sats       - OMM JSON objects from loadImagingSatellites()
 * @param {object}   observerGd - { latitude (rad), longitude (rad), height (km) }
 * @returns {{ name: string, noradId: string|number, confirmed?: boolean, minutesAway: number, riseMinutesAway?: number, peakElevationDeg?: number, trend: string, trackStartAzimuthDeg?: number, trackEndAzimuthDeg?: number } | null}
 */
export function findNextOverheadPass(sats, observerGd) {
  const now   = new Date();
  const gmst0 = satellite.gstime(now);
  let earliest = null;
  let propagatedCount = 0;

  // Step 1 & 2: compute current elevations, keep any qualifying pass already in progress,
  // and collect satellites for scanning subsequent passes.
  const candidates = [];
  for (const omm of sats) {
    try {
      const satrec = satellite.json2satrec(omm);
      const pv0    = satellite.propagate(satrec, now);
      if (!pv0?.position) continue;
      const posEcf0 = satellite.eciToEcf(pv0.position, gmst0);
      const look0   = satellite.ecfToLookAngles(observerGd, posEcf0);
      if (!Number.isFinite(look0.elevation) || !Number.isFinite(look0.azimuth)) continue;
      propagatedCount++;

      let startMinutesAway = 0;
      if (look0.elevation > 0) {
        const details = getUpcomingPassDetails(satrec, observerGd, now, 0);
        if (!details) continue;
        startMinutesAway = details.setMinutesAway;

        if (details.peakElevationDeg >= OVERHEAD_PASS_MIN_ELEVATION_DEG &&
            (!earliest || details.peakMinutesAway < earliest.minutesAway)) {
          earliest = {
            name: omm.OBJECT_NAME,
            noradId: omm.NORAD_CAT_ID,
            confirmed: omm.confirmed,
            minutesAway: details.peakMinutesAway,
            riseMinutesAway: 0,
            peakElevationDeg: details.peakElevationDeg,
            trend: details.peakMinutesAway <= 0.3 ? 'overhead' : 'rising',
            trackStartAzimuthDeg: details.riseLook.azimuthDeg,
            trackEndAzimuthDeg: details.setAzimuthDeg ?? details.riseLook.azimuthDeg,
          };
        }
      }
      candidates.push({ omm, satrec, elevation: look0.elevation, startMinutesAway });
    } catch (err) {
      console.warn(`[passes] Could not propagate ${omm.NORAD_CAT_ID}:`, err.message);
    }
  }
  if (propagatedCount === 0) throw new Error('No satellite positions could be calculated');

  // Step 3: scan higher-elevation satellites first.
  candidates.sort((a, b) => b.elevation - a.elevation);

  // Step 4: scan each candidate through the entire lookahead window.
  const totalSteps = (LOOKAHEAD_HOURS * 3600) / STEP_SECONDS;

  for (const { omm, satrec, startMinutesAway } of candidates) {
    for (let i = Math.floor(startMinutesAway) + 1; i <= totalSteps; i++) {
      if (earliest && (i * STEP_SECONDS) / 60 >= earliest.minutesAway) break;
      const t = new Date(now.getTime() + i * STEP_SECONDS * 1000);
      try {
        const gmst   = satellite.gstime(t);
        const pv     = satellite.propagate(satrec, t);
        if (!pv?.position) continue;

        const posEcf = satellite.eciToEcf(pv.position, gmst);
        const look   = satellite.ecfToLookAngles(observerGd, posEcf);

        if (look.elevation > 0) {
          const riseMinutesAway = (i * STEP_SECONDS) / 60;
          const riseDate = t;
          const details = getUpcomingPassDetails(satrec, observerGd, riseDate, riseMinutesAway);
          if (!details) continue;
          if (details.peakElevationDeg < OVERHEAD_PASS_MIN_ELEVATION_DEG ||
              details.peakMinutesAway > LOOKAHEAD_HOURS * 60) {
            i = Math.floor(details.setMinutesAway);
            continue;
          }

          const overheadMinutesAway = details.peakMinutesAway;
          if (!earliest || overheadMinutesAway < earliest.minutesAway) {
            const fallbackSetAzimuthDeg = computeSetAzimuthDeg(satrec, observerGd, riseDate);
            earliest = {
              name: omm.OBJECT_NAME,
              noradId: omm.NORAD_CAT_ID,
              confirmed: omm.confirmed,
              minutesAway: overheadMinutesAway,
              riseMinutesAway,
              peakElevationDeg: details.peakElevationDeg,
              trend: 'rising',
              trackStartAzimuthDeg: details.riseLook.azimuthDeg,
              trackEndAzimuthDeg: details.setAzimuthDeg ?? fallbackSetAzimuthDeg ?? details.riseLook.azimuthDeg,
            };
          }
          break; // earliest pass for this satellite found; move on
        }
      } catch (err) {
        console.warn(`[passes] Could not predict ${omm.NORAD_CAT_ID}:`, err.message);
        break;
      }
    }
  }

  return earliest; // null = no pass found within 24 hours
}
