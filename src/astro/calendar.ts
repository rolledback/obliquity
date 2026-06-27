// Fundamental calendar constants and the day-of-year <-> Sun-longitude mapping.
// Kept in one dependency-light module (only the pure posMod helper) so the config and
// the formula DSL share a single source of truth instead of re-declaring 365.25 and the
// equinox day, and so neither has to import the other (which would form a cycle).

import { posMod } from './vec';

export const YEAR_DAYS = 365.25;
export const YEAR_HOURS = YEAR_DAYS * 24;
// Day-of-year (Jan 1 = day 1) on which the Sun crosses the vernal point.
const DAY_OF_MARCH_EQUINOX = 79;

/**
 * The Sun's geocentric ecliptic longitude (degrees) measured from the March equinox.
 * Returned continuous (not wrapped to [0,360)). Every consumer uses this either inside
 * trigonometric functions, where wrapping makes no difference, or as a precession
 * phase, where wrapping is actively harmful: an axis precessing a non-integer number
 * of turns per year would snap its lean direction at the equinox if the longitude
 * jumped from 360 back to 0. Keeping it continuous removes that artifact.
 */
export function sunLongitudeDeg(dayOfYear: number): number {
  return ((dayOfYear - DAY_OF_MARCH_EQUINOX) / YEAR_DAYS) * 360;
}

/**
 * Inverse of sunLongitudeDeg folded into a single year: the day-of-year (1..~365) for a
 * Sun longitude expressed as a fraction of a full turn (lon / 360). Used to expose `day`
 * to the formula DSL.
 */
export function dayOfYearFromLonFraction(lonFraction: number): number {
  return posMod(DAY_OF_MARCH_EQUINOX - 1 + lonFraction * YEAR_DAYS, YEAR_DAYS) + 1;
}
