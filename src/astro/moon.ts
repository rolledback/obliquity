import { sunLongitudeAtAbsDays } from './calendar';
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

/** Mean Earth-Sun distance, km. */
export const AU_KM = 149597870.7;
/** Solar radius, km. */
export const SUN_RADIUS_KM = 695700;
/** Geocentric solar angular radius, degrees, about 0.2666. */
export const SUN_ANGULAR_RADIUS_DEG = (Math.asin(SUN_RADIUS_KM / AU_KM) * 180) / Math.PI;
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

// J2000 lunar angles give the synthetic epoch a J2000-like configuration.
const MEAN_LONGITUDE_EPOCH_DEG = 218.3164477;
const MEAN_ANOMALY_EPOCH_DEG = 134.9633964;
const ARG_LATITUDE_EPOCH_DEG = 93.2720950;

// Solve Kepler's equation by bounded Newton iteration.
function eccentricAnomaly(meanAnomalyRad: number, e: number): number {
  let E = meanAnomalyRad;
  for (let i = 0; i < 12; i++) {
    const delta = (E - e * Math.sin(E) - meanAnomalyRad) / (1 - e * Math.cos(E));
    E -= delta;
    if (Math.abs(delta) < 1e-13) break;
  }
  return E;
}

/** Geocentric lunar position in the ecliptic frame, km, at an absolute day count. */
export function moonPositionKm(absDays: number): V3 {
  const meanLonDeg = MEAN_LONGITUDE_EPOCH_DEG + (360 * absDays) / SIDEREAL_MONTH_DAYS;
  const meanAnomDeg = MEAN_ANOMALY_EPOCH_DEG + (360 * absDays) / ANOMALISTIC_MONTH_DAYS;
  const argLatDeg = ARG_LATITUDE_EPOCH_DEG + (360 * absDays) / DRACONIC_MONTH_DAYS;

  // Differencing the months yields 18.6-year node and 8.85-year apse precession.
  const nodeRad = (meanLonDeg - argLatDeg) * DEG;
  const argPerigeeRad = (argLatDeg - meanAnomDeg) * DEG;

  const E = eccentricAnomaly(meanAnomDeg * DEG, ECCENTRICITY);
  const trueAnomRad =
    2 *
    Math.atan2(
      Math.sqrt(1 + ECCENTRICITY) * Math.sin(E / 2),
      Math.sqrt(1 - ECCENTRICITY) * Math.cos(E / 2),
    );
  const r = SEMI_MAJOR_AXIS_KM * (1 - ECCENTRICITY * Math.cos(E));

  const u = argPerigeeRad + trueAnomRad; // true argument of latitude
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosN = Math.cos(nodeRad);
  const sinN = Math.sin(nodeRad);
  const cosI = Math.cos(INCLINATION_DEG * DEG);
  const sinI = Math.sin(INCLINATION_DEG * DEG);
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
}

/** Everything about the Moon at one instant of absolute time. */
export function moonStateAt(absDays: number): MoonState {
  const posKm = moonPositionKm(absDays);
  const distanceKm = norm(posKm);
  const dir = normalize(posKm);

  const sunLonDeg = sunLongitudeAtAbsDays(absDays);
  const sunDir = sunDirEcliptic(sunLonDeg);

  // Use finite Sun distance for the phase angle at the Moon.
  const toSun = sub(scale(sunDir, AU_KM), posKm);
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
  const sunPos = scale(sunDirEcliptic(moon.sunLonDeg), AU_KM);
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
