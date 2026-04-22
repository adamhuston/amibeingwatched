// passes.js
import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@7.0.0/+esm';

const STEP_SECONDS    = 60;       // 1-minute resolution — accurate enough for pass prediction
const LOOKAHEAD_HOURS = 24;
const MAX_CANDIDATES  = 50;       // limit CPU: check only the most-likely-to-rise satellites
const NEXT_PASS_TRACK_OFFSET_STEPS = 3;

function getLookAnglesDeg(satrec, observerGd, date) {
  const gmst   = satellite.gstime(date);
  const pv     = satellite.propagate(satrec, date);
  if (!pv?.position) return null;

  const posEcf = satellite.eciToEcf(pv.position, gmst);
  const look   = satellite.ecfToLookAngles(observerGd, posEcf);
  return {
    azimuthDeg: look.azimuth * (180 / Math.PI),
    elevationDeg: look.elevation * (180 / Math.PI),
  };
}

/**
 * Find the next overhead pass for any satellite in `sats`.
 *
 * Strategy:
 *   1. Compute current elevation for every satellite.
 *   2. Discard satellites already overhead — they will appear in the overhead count instead.
 *   3. Sort below-horizon satellites by elevation descending (closest to 0 = rising soonest).
 *   4. Take the top MAX_CANDIDATES and step forward in time until elevation crosses 0.
 *   5. Return the {name, minutesAway} of the earliest crossing found.
 *
 * This function is CPU-intensive. The caller should defer it with setTimeout(fn, 0)
 * so the overhead count renders first.
 *
 * @param {object[]} sats       - OMM JSON objects from loadImagingSatellites()
 * @param {object}   observerGd - { latitude (rad), longitude (rad), height (km) }
 * @returns {{ name: string, noradId: string|number, confirmed?: boolean, minutesAway: number, trend: string, trackStartAzimuthDeg?: number, trackEndAzimuthDeg?: number } | null}
 */
export function findNextPass(sats, observerGd) {
  const now   = new Date();
  const gmst0 = satellite.gstime(now);

  // Step 1 & 2: compute current elevations, collect below-horizon satellites
  const candidates = [];
  for (const omm of sats) {
    try {
      const satrec = satellite.json2satrec(omm);
      const pv0    = satellite.propagate(satrec, now);
      if (!pv0?.position) continue;

      const posEcf0 = satellite.eciToEcf(pv0.position, gmst0);
      const look0   = satellite.ecfToLookAngles(observerGd, posEcf0);

      if (look0.elevation <= 0) {
        candidates.push({ omm, satrec, elevation: look0.elevation });
      }
    } catch (_) { /* bad elements — skip */ }
  }

  // Step 3: sort so the satellite with elevation nearest 0 (most negative → 0) is first
  candidates.sort((a, b) => b.elevation - a.elevation);
  const toCheck = candidates.slice(0, MAX_CANDIDATES);

  // Step 4: step forward in time for each candidate
  let earliest   = null;
  const totalSteps = (LOOKAHEAD_HOURS * 3600) / STEP_SECONDS;

  for (const { omm, satrec } of toCheck) {
    for (let i = 1; i <= totalSteps; i++) {
      const t = new Date(now.getTime() + i * STEP_SECONDS * 1000);
      try {
        const gmst   = satellite.gstime(t);
        const pv     = satellite.propagate(satrec, t);
        if (!pv?.position) continue;

        const posEcf = satellite.eciToEcf(pv.position, gmst);
        const look   = satellite.ecfToLookAngles(observerGd, posEcf);

        if (look.elevation > 0) {
          const minutesAway = (i * STEP_SECONDS) / 60;
          if (!earliest || minutesAway < earliest.minutesAway) {
            const riseLook = {
              azimuthDeg: look.azimuth * (180 / Math.PI),
              elevationDeg: look.elevation * (180 / Math.PI),
            };
            const trackLook = getLookAnglesDeg(
              satrec,
              observerGd,
              new Date(now.getTime() + (i + NEXT_PASS_TRACK_OFFSET_STEPS) * STEP_SECONDS * 1000)
            ) || riseLook;
            earliest = {
              name: omm.OBJECT_NAME,
              noradId: omm.NORAD_CAT_ID,
              confirmed: omm.confirmed,
              minutesAway: Math.round(minutesAway),
              trend: 'rising',
              trackStartAzimuthDeg: riseLook.azimuthDeg,
              trackEndAzimuthDeg: trackLook.azimuthDeg,
            };
          }
          break; // earliest pass for this satellite found; move on
        }
      } catch (_) { /* skip */ }
    }
  }

  return earliest; // null = no pass found within 24 hours
}
