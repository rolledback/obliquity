import { posMod } from './vec';
import { solveEccentricAnomalyRad, trueAnomalyRad } from './kepler';

export const YEAR_DAYS = 365.25;

/** Whole-day chart grid, distinct from the 365.25-day physical year. */
export const CALENDAR_DAYS = 365;
export const YEAR_HOURS = YEAR_DAYS * 24;
/**
 * March equinox, with Jan 1 as day 1. Not a round number: it is set so the model's Sun sits
 * where the real Sun sat at J2000 (true longitude 280.3822), which is what lines the model's
 * eclipses up with the real calendar.
 */
const DAY_OF_MARCH_EQUINOX = 79.805434;

export const ECCENTRICITY = 0.0167086;

/** Semi-major axis of the Earth's orbit, and the unit the eclipse geometry measures in. */
export const AU_KM = 149597870.7;

/** Sun's geocentric longitude at perihelion, measured from the March equinox. */
const PERIHELION_LON_DEG = 282.9372;

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/**
 * True anomaly and Sun distance for a mean anomaly. The true anomaly is unwrapped onto the
 * mean one, so a mean anomaly that keeps climbing gives a true anomaly that keeps climbing.
 */
function sunOrbitAt(meanAnomDeg: number): { trueAnomDeg: number; radiusKm: number } {
  const meanAnomRad = meanAnomDeg * DEG;
  const e = solveEccentricAnomalyRad(meanAnomRad, ECCENTRICITY);
  const wrapped = trueAnomalyRad(e, ECCENTRICITY);
  const turns = Math.round((meanAnomRad - wrapped) / TWO_PI);
  return {
    trueAnomDeg: (wrapped + turns * TWO_PI) / DEG,
    radiusKm: AU_KM * (1 - ECCENTRICITY * Math.cos(e)),
  };
}

/** Mean anomaly whose true anomaly puts the Sun at the March equinox. */
const MEAN_ANOM_AT_EQUINOX = (() => {
  const trueAnom = -PERIHELION_LON_DEG * DEG;
  const half = Math.atan(
    Math.sqrt((1 - ECCENTRICITY) / (1 + ECCENTRICITY)) * Math.tan(trueAnom / 2),
  );
  return ((2 * half - ECCENTRICITY * Math.sin(2 * half)) / DEG) % 360;
})();

const TRUE_ANOM_AT_EQUINOX = sunOrbitAt(MEAN_ANOM_AT_EQUINOX).trueAnomDeg;

/** Mean anomaly after a uniform advance (degrees) from the March equinox. */
function meanAnomalyDeg(advanceDeg: number): number {
  return MEAN_ANOM_AT_EQUINOX + advanceDeg;
}

/**
 * The Sun's geocentric ecliptic longitude (degrees) measured from the March equinox.
 * Time runs uniformly and the Sun does not: the orbit is an ellipse, so the longitude
 * runs up to 1.9 degrees ahead of or behind a uniform sweep. Stays unwrapped to keep
 * fractional precession continuous.
 */
export function sunLongitudeDeg(dayOfYear: number): number {
  const advance = ((dayOfYear - DAY_OF_MARCH_EQUINOX) / YEAR_DAYS) * 360;
  return sunOrbitAt(meanAnomalyDeg(advance)).trueAnomDeg - TRUE_ANOM_AT_EQUINOX;
}

/**
 * Earth to Sun distance (km) at a true solar longitude measured from the March equinox.
 * The orbit view draws its ellipse from this, so the drawn ring and the drawn Earth cannot
 * disagree with the physics or with each other.
 */
export function sunDistanceKmAtLonDeg(lonDeg: number): number {
  const trueAnomRad = (lonDeg + TRUE_ANOM_AT_EQUINOX) * DEG;
  return (
    (AU_KM * (1 - ECCENTRICITY * ECCENTRICITY)) /
    (1 + ECCENTRICITY * Math.cos(trueAnomRad))
  );
}

/** Earth to Sun distance (km) on a given day. */
export function sunDistanceKmOnDay(dayOfYear: number): number {
  const advance = ((dayOfYear - DAY_OF_MARCH_EQUINOX) / YEAR_DAYS) * 360;
  return sunOrbitAt(meanAnomalyDeg(advance)).radiusKm;
}

/** Uniform advance (degrees from the equinox) that reaches a given true longitude. */
function advanceForLonDeg(lonDeg: number): number {
  const trueAnom = (lonDeg + TRUE_ANOM_AT_EQUINOX) * DEG;
  const half = Math.atan(
    Math.sqrt((1 - ECCENTRICITY) / (1 + ECCENTRICITY)) * Math.tan(trueAnom / 2),
  );
  const wrappedMean = (2 * half - ECCENTRICITY * Math.sin(2 * half)) / DEG;
  const turns = Math.round((lonDeg + TRUE_ANOM_AT_EQUINOX - wrappedMean) / 360);
  return wrappedMean + turns * 360 - MEAN_ANOM_AT_EQUINOX;
}

/** Day of year for a Sun longitude expressed as a fraction of one turn. */
export function dayOfYearFromLonFraction(lonFraction: number): number {
  const days = (advanceForLonDeg(lonFraction * 360) / 360) * YEAR_DAYS;
  return posMod(DAY_OF_MARCH_EQUINOX - 1 + days, YEAR_DAYS) + 1;
}

/** Absolute days since orbit 0, day 1, independent of planetary rotation. */
export function absDaysFrom(orbit: number, dayOfYear: number): number {
  return orbit * YEAR_DAYS + (dayOfYear - 1);
}

/** Where the Sun is and how far off, at an absolute day count. One solve, both answers. */
export function sunStateAtAbsDays(absDays: number): { longitudeDeg: number; distanceKm: number } {
  const orbit = sunOrbitAt(meanAnomalyDeg(advanceAtAbsDays(absDays)));
  return { longitudeDeg: orbit.trueAnomDeg - TRUE_ANOM_AT_EQUINOX, distanceKm: orbit.radiusKm };
}

/** Continuous Sun longitude at an absolute day count. */
export function sunLongitudeAtAbsDays(absDays: number): number {
  return sunStateAtAbsDays(absDays).longitudeDeg;
}

/** Uniform advance (degrees from the equinox) at an absolute day count. */
function advanceAtAbsDays(absDays: number): number {
  return ((absDays + 1 - DAY_OF_MARCH_EQUINOX) / YEAR_DAYS) * 360;
}

/**
 * The Sun's MEAN longitude, the uniform sweep the true one runs ahead of and behind.
 * The Moon's perturbation arguments are defined against mean longitudes, so they must
 * not be handed the true one.
 */
export function meanSunLongitudeAtAbsDays(absDays: number): number {
  return advanceAtAbsDays(absDays) - (TRUE_ANOM_AT_EQUINOX - MEAN_ANOM_AT_EQUINOX);
}

/** absDays 0 is J2000, the epoch the Moon's angles are pinned to. */
const EPOCH_MS = Date.UTC(2000, 0, 1, 12);
const MS_PER_DAY = 86400000;

/** Real UTC instant for an absolute day count. */
export function dateFromAbsDays(absDays: number): Date {
  return new Date(EPOCH_MS + absDays * MS_PER_DAY);
}

/** Absolute day count for a real instant. */
export function absDaysFromDate(date: Date): number {
  return (date.getTime() - EPOCH_MS) / MS_PER_DAY;
}

/** Split an absolute day count into the orbit and day-of-year the app runs on. */
export function orbitAndDay(absDays: number): { orbit: number; dayOfYear: number } {
  const orbit = Math.floor(absDays / YEAR_DAYS);
  return { orbit, dayOfYear: absDays - orbit * YEAR_DAYS + 1 };
}
