import { posMod } from './vec';

export const YEAR_DAYS = 365.25;

/** Whole-day chart grid, distinct from the 365.25-day physical year. */
export const CALENDAR_DAYS = 365;
export const YEAR_HOURS = YEAR_DAYS * 24;
// March equinox day, with Jan 1 as day 1.
const DAY_OF_MARCH_EQUINOX = 79;

/**
 * The Sun's geocentric ecliptic longitude (degrees) measured from the March equinox.
 * The result stays unwrapped to keep fractional precession continuous.
 */
export function sunLongitudeDeg(dayOfYear: number): number {
  return ((dayOfYear - DAY_OF_MARCH_EQUINOX) / YEAR_DAYS) * 360;
}

/** Day of year for a Sun longitude expressed as a fraction of one turn. */
export function dayOfYearFromLonFraction(lonFraction: number): number {
  return posMod(DAY_OF_MARCH_EQUINOX - 1 + lonFraction * YEAR_DAYS, YEAR_DAYS) + 1;
}

/** Absolute days since orbit 0, day 1, independent of planetary rotation. */
export function absDaysFrom(orbit: number, dayOfYear: number): number {
  return orbit * YEAR_DAYS + (dayOfYear - 1);
}

/** Continuous Sun longitude at an absolute day count. */
export function sunLongitudeAtAbsDays(absDays: number): number {
  return ((absDays + 1 - DAY_OF_MARCH_EQUINOX) / YEAR_DAYS) * 360;
}
