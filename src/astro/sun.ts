// Horizontal (alt/az) Sun coordinates for an observer at a given latitude/longitude,
// plus the local east-north-up basis in the earth-fixed frame.

import { axisParamsAt, earthMatrix, sunDirEcliptic } from './orientation';
import { sunLongitudeDeg } from './config';
import type { RotationConfig } from './config';
import { DEG, RAD, clamp, dot, matVec, transpose, geographicUnit, posMod } from './vec';
import type { Mat3, V3 } from './vec';

interface LocalBasis {
  up: V3; // local zenith
  north: V3; // toward the geographic north pole along the surface
  east: V3; // toward increasing longitude along the surface
}

/**
 * Local east-north-up basis vectors in the earth-fixed frame for a location.
 * Latitude/longitude in degrees; longitude measured eastward from the prime meridian.
 */
function localBasis(latDeg: number, lonDeg: number): LocalBasis {
  const phi = latDeg * DEG;
  const lam = lonDeg * DEG;
  const cphi = Math.cos(phi);
  const sphi = Math.sin(phi);
  const clam = Math.cos(lam);
  const slam = Math.sin(lam);
  return {
    up: geographicUnit(latDeg, lonDeg),
    north: [-sphi * clam, -sphi * slam, cphi],
    east: [-slam, clam, 0],
  };
}

export interface AltAz {
  altDeg: number; // angle above the horizon (negative = below)
  azDeg: number; // compass azimuth: 0 = North, 90 = East, 180 = South, 270 = West
}

/**
 * Sun altitude and azimuth, given the Earth orientation matrix M (earth-fixed ->
 * ecliptic), the Sun direction in the ecliptic frame, and the observer location.
 */
export function sunAltAz(
  M: Mat3,
  sunDirEcl: V3,
  latDeg: number,
  lonDeg: number,
): AltAz {
  // Rotate the Sun direction into the earth-fixed frame (M is orthonormal).
  const sunFixed = matVec(transpose(M), sunDirEcl);
  const { up, north, east } = localBasis(latDeg, lonDeg);
  const sUp = dot(sunFixed, up);
  const sNorth = dot(sunFixed, north);
  const sEast = dot(sunFixed, east);
  const altDeg = Math.asin(clamp(sUp, -1, 1)) * RAD;
  const azDeg = posMod(Math.atan2(sEast, sNorth) * RAD, 360);
  return { altDeg, azDeg };
}

/**
 * Sun alt/az for a single instant defined by config, day-of-year, spin angle and
 * location. Used by the day-path sampler and for the live 3D readout. `axisPhaseLonDeg`
 * optionally supplies the accumulated-across-orbits longitude for a precessing axis.
 */
export function sunAltAzAt(
  config: RotationConfig,
  dayOfYear: number,
  spinDeg: number,
  latDeg: number,
  lonDeg: number,
  axisPhaseLonDeg?: number,
): AltAz {
  const sunLon = sunLongitudeDeg(dayOfYear);
  const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(config, sunLon, axisPhaseLonDeg);
  const M = earthMatrix(obliquityDeg, axisLongitudeDeg, spinDeg);
  return sunAltAz(M, sunDirEcliptic(sunLon), latDeg, lonDeg);
}
