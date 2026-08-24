import {
  AU_KM,
  YEAR_DAYS,
  meanSunLongitudeAtAbsDays,
  sunStateAtAbsDays,
} from './calendar';
import { solveEccentricAnomalyRad, trueAnomalyRad } from './kepler';
import { sunDirEcliptic } from './orientation';
import {
  DEG,
  RAD,
  angleBetweenDeg,
  clamp,
  cross,
  dot,
  matVec,
  norm,
  normalize,
  scale,
  sub,
  geographicUnit,
} from './vec';
import type { Mat3, V3 } from './vec';

export { AU_KM };
/** Solar radius, km. */
export const SUN_RADIUS_KM = 695700;
/** Solar angular radius (degrees) seen from a given distance, about 0.2666 at 1 AU. */
export function sunAngularRadiusDeg(distanceKm: number): number {
  return (Math.asin(SUN_RADIUS_KM / distanceKm) * 180) / Math.PI;
}
/** Solar angular radius at the mean distance. */
export const SUN_ANGULAR_RADIUS_DEG = sunAngularRadiusDeg(AU_KM);
/** Mean Earth radius, km. */
export const EARTH_RADIUS_KM = 6371.0;
/** Mean lunar radius, km. */
export const MOON_RADIUS_KM = 1737.4;

/** Time to return to the same direction against the fixed stars. */
export const SIDEREAL_MONTH_DAYS = 27.321661;
/** Time from perigee to perigee; longer than sidereal because the apse creeps forward. */
export const ANOMALISTIC_MONTH_DAYS = 27.554550;
/** Time from ascending node to ascending node; shorter because the nodes regress. */
export const DRACONIC_MONTH_DAYS = 27.212221;

const ECCENTRICITY = 0.0549;
const INCLINATION_DEG = 5.145;
/** Semi-major axis of the lunar orbit, km. */
export const SEMI_MAJOR_AXIS_KM = 384400;

/**
 * Mean longitude rate, degrees per day. Not simply 360/SIDEREAL_MONTH_DAYS: the app's year
 * is 365.25 days, a little longer than the real tropical year, so its Sun runs fractionally
 * slow. Advancing the Moon by the same shortfall keeps the ELONGATION between the two
 * matching reality, and eclipse times with it. Using the raw sidereal rate instead leaves
 * a drift of about 0.6 minutes of eclipse timing per year.
 */
const REAL_MOON_RATE_DEG_PER_DAY = 13.17639648;
const REAL_SUN_RATE_DEG_PER_DAY = 0.98564736;
const MEAN_LON_RATE_DEG_PER_DAY =
  360 / YEAR_DAYS + (REAL_MOON_RATE_DEG_PER_DAY - REAL_SUN_RATE_DEG_PER_DAY);

// J2000 lunar angles give the synthetic epoch a J2000-like configuration. The 0.022 is an
// empirical trim: this truncated theory leaves a constant offset, and removing it cuts the
// error against the real record of six eclipses from 1999 to 2026 from 2.7 to 1.0 minutes
// RMS. It is not fitted to those six alone; the independent comparison against the standard
// longitude series improves at the same time, 0.119 to 0.101 degrees RMS.
const MEAN_LONGITUDE_EPOCH_DEG = 218.3164477 + 0.022;
const MEAN_ANOMALY_EPOCH_DEG = 134.9633964;
const ARG_LATITUDE_EPOCH_DEG = 93.2720950;

/** Geocentric lunar position in the ecliptic frame, km, at an absolute day count. */
export function moonPositionKm(absDays: number): V3 {
  const meanLonDeg = MEAN_LONGITUDE_EPOCH_DEG + MEAN_LON_RATE_DEG_PER_DAY * absDays;
  const meanAnomDeg = MEAN_ANOMALY_EPOCH_DEG + (360 * absDays) / ANOMALISTIC_MONTH_DAYS;
  const argLatDeg = ARG_LATITUDE_EPOCH_DEG + (360 * absDays) / DRACONIC_MONTH_DAYS;

  // Differencing the months yields 18.6-year node and 8.85-year apse precession.
  const nodeRad = (meanLonDeg - argLatDeg) * DEG;
  const argPerigeeRad = (argLatDeg - meanAnomDeg) * DEG;

  const E = solveEccentricAnomalyRad(meanAnomDeg * DEG, ECCENTRICITY);
  const trueAnomRad = trueAnomalyRad(E, ECCENTRICITY);
  const rBase = SEMI_MAJOR_AXIS_KM * (1 - ECCENTRICITY * Math.cos(E));

  // The ellipse alone is the Moon to about a degree. These are the large perturbations it
  // omits, chiefly the Sun pulling on the orbit: evection, variation and the annual
  // equation. Without them a new moon lands hours out, which rotates an eclipse shadow
  // right off the continent it belongs on.
  // Terms the ellipse ALREADY supplies are deliberately absent: the equation of centre
  // carries sin(2M') and sin(3M'), the radius carries cos(2M'), and projecting the
  // inclined orbit carries sin(2F). Adding those again doubles them.
  const D = (meanLonDeg - meanSunLongitudeAtAbsDays(absDays)) * DEG; // mean elongation
  const M = (357.5291092 + 0.98560028 * absDays) * DEG; // Sun's mean anomaly
  const Mp = meanAnomDeg * DEG;
  const F = argLatDeg * DEG;
  const dLonDeg =
    1.274 * Math.sin(2 * D - Mp) + // evection
    0.658 * Math.sin(2 * D) + // variation
    -0.186 * Math.sin(M) + // annual equation
    -0.059 * Math.sin(2 * Mp - 2 * D) +
    -0.057 * Math.sin(Mp - 2 * D + M) +
    0.053 * Math.sin(Mp + 2 * D) +
    0.046 * Math.sin(2 * D - M) +
    0.041 * Math.sin(Mp - M) +
    -0.035 * Math.sin(D) +
    -0.031 * Math.sin(Mp + M) +
    0.015 * Math.sin(2 * D - 2 * F) +
    -0.013 * Math.sin(Mp + 2 * F) +
    0.011 * Math.sin(Mp - 2 * F) +
    0.011 * Math.sin(4 * D - Mp) +
    0.009 * Math.sin(4 * D - 2 * Mp);
  const dRadiusKm = -3699.111 * Math.cos(2 * D - Mp) + -2955.968 * Math.cos(2 * D);

  const u = argPerigeeRad + trueAnomRad + dLonDeg * DEG; // true argument of latitude
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosN = Math.cos(nodeRad);
  const sinN = Math.sin(nodeRad);
  const cosI = Math.cos(INCLINATION_DEG * DEG);
  const sinI = Math.sin(INCLINATION_DEG * DEG);
  const r = rBase + dRadiusKm;
  return [
    r * (cosN * cosU - sinN * sinU * cosI),
    r * (sinN * cosU + cosN * sinU * cosI),
    r * (sinU * sinI),
  ];
}

/** Geocentric lunar state at one absolute instant. */
export interface MoonState {
  /** Geocentric position in the ecliptic frame, km. */
  posKm: V3;
  /** Geocentric unit direction. */
  dir: V3;
  /** Distance from Earth's centre, km. */
  distanceKm: number;
  /** Angular radius of the disc seen from Earth's centre, degrees (~0.26). */
  angularRadiusDeg: number;
  /** Sun-Moon-Earth angle at the Moon: 0 = full, 180 = new. */
  phaseAngleDeg: number;
  /** Illuminated fraction of the disc, 0 (new) to 1 (full). */
  illuminated: number;
  /** True when the Moon is east of the Sun, the conventional waxing test. */
  waxing: boolean;
  /** Angular separation from the Sun seen from Earth, 0..180 degrees. */
  elongationDeg: number;
  /** The Sun's ecliptic longitude at the same instant, for callers that need both. */
  sunLonDeg: number;
  /** Earth to Sun distance, km. It varies by 3.3 per cent, which decides annular vs total. */
  sunDistanceKm: number;
}

/** Everything about the Moon at one instant of absolute time. */
export function moonStateAt(absDays: number): MoonState {
  const posKm = moonPositionKm(absDays);
  const distanceKm = norm(posKm);
  const dir = normalize(posKm);

  const { longitudeDeg: sunLonDeg, distanceKm: sunDistanceKm } = sunStateAtAbsDays(absDays);
  const sunDir = sunDirEcliptic(sunLonDeg);

  // Use finite Sun distance for the phase angle at the Moon.
  const toSun = sub(scale(sunDir, sunDistanceKm), posKm);
  const toEarth = scale(posKm, -1);
  const phaseAngleDeg = angleBetweenDeg(toSun, toEarth);

  return {
    posKm,
    dir,
    distanceKm,
    angularRadiusDeg: Math.asin(clamp(MOON_RADIUS_KM / distanceKm, -1, 1)) * RAD,
    phaseAngleDeg,
    illuminated: (1 + Math.cos(phaseAngleDeg * DEG)) / 2,
    waxing: dot(cross(sunDir, dir), [0, 0, 1]) > 0,
    elongationDeg: angleBetweenDeg(dir, sunDir),
    sunLonDeg,
    sunDistanceKm,
  };
}

/** The eight conventional phases, in the order they run from new to new. */
export type MoonPhase =
  | 'new'
  | 'waxing crescent'
  | 'first quarter'
  | 'waxing gibbous'
  | 'full'
  | 'waning gibbous'
  | 'last quarter'
  | 'waning crescent';

// Classify phase independently of its presentation.
function phaseOf(illuminated: number, waxing: boolean): MoonPhase {
  if (illuminated < 0.02) return 'new';
  if (illuminated > 0.98) return 'full';
  if (Math.abs(illuminated - 0.5) < 0.06) return waxing ? 'first quarter' : 'last quarter';
  if (illuminated < 0.5) return waxing ? 'waxing crescent' : 'waning crescent';
  return waxing ? 'waxing gibbous' : 'waning gibbous';
}


const PHASE_GLYPHS: Record<MoonPhase, string> = {
  new: '\u{1F311}',
  'waxing crescent': '\u{1F312}',
  'first quarter': '\u{1F313}',
  'waxing gibbous': '\u{1F314}',
  full: '\u{1F315}',
  'waning gibbous': '\u{1F316}',
  'last quarter': '\u{1F317}',
  'waning crescent': '\u{1F318}',
};

/** The matching moon glyph, so a compact readout can show the phase at a glance. */
export function phaseGlyph(illuminated: number, waxing: boolean): string {
  return PHASE_GLYPHS[phaseOf(illuminated, waxing)];
}

/** Observer offset from Earth's centre in the ecliptic frame, km. */
export function observerOffsetKm(M: Mat3, latDeg: number, lonDeg: number): V3 {
  return scale(matVec(M, geographicUnit(latDeg, lonDeg)), EARTH_RADIUS_KM);
}

/** Topocentric illuminated fraction, which differs geocentrically by up to 0.88 points. */
export function topocentricIlluminated(
  moon: MoonState,
  M: Mat3,
  latDeg: number,
  lonDeg: number,
): number {
  const observer = observerOffsetKm(M, latDeg, lonDeg);
  const sunPos = scale(sunDirEcliptic(moon.sunLonDeg), moon.sunDistanceKm);
  const toSun = normalize(sub(sunPos, moon.posKm));
  const toObserver = normalize(sub(observer, moon.posKm));
  return clamp((1 + dot(toSun, toObserver)) / 2, 0, 1);
}

/** Topocentric lunar direction, distance, and angular radius. */
export function moonTopocentric(
  moon: MoonState,
  M: Mat3,
  latDeg: number,
  lonDeg: number,
): { dir: V3; distanceKm: number; angularRadiusDeg: number } {
  const rel = sub(moon.posKm, observerOffsetKm(M, latDeg, lonDeg));
  const distanceKm = norm(rel);
  return {
    dir: normalize(rel),
    distanceKm,
    angularRadiusDeg: Math.asin(clamp(MOON_RADIUS_KM / distanceKm, -1, 1)) * RAD,
  };
}
