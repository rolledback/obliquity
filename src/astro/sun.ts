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

/** Earth-fixed east-north-up basis for geographic coordinates in degrees. */
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

/** Altitude and azimuth of an ecliptic-frame direction for an observer. */
export function directionAltAz(
  M: Mat3,
  dirEcl: V3,
  latDeg: number,
  lonDeg: number,
): AltAz {
  // The inverse of orthonormal M is its transpose.
  const fixed = matVec(transpose(M), dirEcl);
  const { up, north, east } = localBasis(latDeg, lonDeg);
  const sUp = dot(fixed, up);
  const sNorth = dot(fixed, north);
  const sEast = dot(fixed, east);
  const altDeg = Math.asin(clamp(sUp, -1, 1)) * RAD;
  const azDeg = posMod(Math.atan2(sEast, sNorth) * RAD, 360);
  return { altDeg, azDeg };
}

/** Sun altitude and azimuth from an orientation matrix and ecliptic direction. */
export function sunAltAz(
  M: Mat3,
  sunDirEcl: V3,
  latDeg: number,
  lonDeg: number,
): AltAz {
  return directionAltAz(M, sunDirEcl, latDeg, lonDeg);
}

/** Sun alt/az at a date and spin, optionally using an unwrapped axis phase. */
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
