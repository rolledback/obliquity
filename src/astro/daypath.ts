// Sample the Sun's path across the sky over one day for a location and date, and
// derive summary statistics.
//
// The orbital position (and therefore the Sun's declination) is held fixed for the
// day, which is the standard assumption for a sun-path diagram. The rotation speed
// does not change the shape of the path, only how many hours it takes to trace it;
// that is captured by `solarDayHours` feeding into the daylight-hours figure.

import { sunAltAz } from './sun';
import {
  axisParamsAt,
  classifyDaylight,
  culminationAltitudesDeg,
  earthMatrix,
  noonSpinDeg,
  raSunDeg,
  sunDeclinationDeg,
  sunDirEcliptic,
  sunriseHourAngleRad,
} from './orientation';
import { compileFormula, formulaVars } from './formula';
import { YEAR_HOURS, axisConfigKey, periodOrbits, sunLongitudeDeg } from './config';
import type { RotationConfig } from './config';
import { DEG, RAD, clamp, wrapSignedDeg } from './vec';

export interface DaySample {
  /** Fraction through the day in chronological order, 0..1. */
  t: number;
  altDeg: number;
  azDeg: number;
}

export type DayCondition = 'normal' | 'polar-day' | 'polar-night' | 'no-cycle';

export interface DayStats {
  declinationDeg: number;
  peakAltDeg: number;
  minAltDeg: number;
  daylightHours: number;
  solarDayHours: number;
  sunriseAzDeg: number | null;
  sunsetAzDeg: number | null;
  condition: DayCondition;
}

export interface DayPath {
  samples: DaySample[];
  stats: DayStats;
}

const TINY_RATE = 1e-6; // deg/hr below which spin and orbit are effectively locked

/**
 * The spin-speed multiplier from the spin formula at an orbital position; 1 means the
 * plain base period. The Sun-path shape is set by the axis, so a varying spin only
 * changes how long a day lasts and which way the Sun appears to cross the sky; sampling
 * the multiplier once per day (the orbital position barely moves within a day) keeps that
 * exact. The trivial "1" formula short-circuits with no compile cost, and omitting the
 * position also reports the base spin (multiplier 1), so a position-free query is honest.
 */
export function spinMultiplierAt(
  config: RotationConfig,
  sunLonDeg?: number,
  axisPhaseLonDeg?: number,
): number {
  const src = config.spinFormula;
  if (src === '' || src === '1' || sunLonDeg === undefined) return 1;
  return compileFormula(src).fn(formulaVars(sunLonDeg, axisPhaseLonDeg ?? sunLonDeg));
}

/** Signed spin rate relative to the stars (deg/hour); negative for retrograde. */
export function spinRateDegPerHour(
  config: RotationConfig,
  sunLonDeg?: number,
  axisPhaseLonDeg?: number,
): number {
  const sign = config.prograde ? 1 : -1;
  const base = (sign * 360) / config.rotationPeriodHours;
  // Clamp the multiplier so an absurd formula value cannot overflow the rate to Infinity
  // (which would freeze the clock instead of spinning fast). 1e4x normal is already a blur.
  const mult = spinMultiplierAt(config, sunLonDeg, axisPhaseLonDeg);
  const clamped = Math.max(-1e4, Math.min(1e4, mult));
  return base * clamped;
}

// The mean right-ascension winding is integrated once per distinct axis configuration
// and memoised, since solarDayHours runs on every animation frame.
const raRateCache = new Map<string, number>();
const RA_WINDING_STEPS = 2048;

/**
 * Mean rate (deg/hour) at which the Sun's right ascension advances, averaged over the
 * configuration's full repeat cycle. It is the net winding of the Sun's right ascension
 * across the whole cycle divided by the cycle length. A fixed axis winds it once per
 * year (the usual sidereal-versus-solar gap); an axis that tracks the Sun pins it to
 * zero; a precessing axis shifts it by its turns per year; an obliquity past 90 degrees
 * reverses it; and an obliquity that oscillates across 90 degrees through the year
 * partly cancels it. Integrating the actual path captures every case uniformly.
 *
 * The integration spans the whole cycle, not a single orbit, because the right
 * ascension's winding over one orbit of a non-whole-number precession depends on which
 * arc that orbit covers; only the cycle average gives a mean solar day that keeps the
 * rendered spin matching the set sidereal rate over the long run.
 *
 * Formula mode reports a period of one orbit, so a secular formula (one reading year, t,
 * or orbit) is integrated over its first orbit only. That is exact for periodic phase/lon
 * formulas; for a secular formula whose lean drifts or whose tilt crosses 90 degrees over
 * the years, the true winding changes from orbit to orbit, so local solar noon can drift
 * slowly across many simulated years. The result stays finite and smooth. The built-in
 * Maelstrom example is mildly secular (its lean drifts and its tilt crosses 90), giving a
 * cosmetic clock drift of roughly a quarter solar-hour per simulated year; the Sun's
 * actual position for any given day and spin stays exact. This is a known limit of the
 * single-clock model for wildly secular hand-written formulas.
 */
export function meanSunRaRateDegPerHour(config: RotationConfig): number {
  const key = axisConfigKey(config);
  const cached = raRateCache.get(key);
  if (cached !== undefined) return cached;

  const period = periodOrbits(config);
  const steps = RA_WINDING_STEPS * period;
  let prevRa = 0;
  let totalDeg = 0;
  for (let i = 0; i <= steps; i++) {
    const lon = (i / steps) * period * 360; // the full cycle, continuous
    const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(config, lon);
    const ra = raSunDeg(obliquityDeg, axisLongitudeDeg, lon);
    if (i > 0) {
      totalDeg += wrapSignedDeg(ra - prevRa); // shortest step, so the sum unwraps
    }
    prevRa = ra;
  }
  const rate = totalDeg / (period * YEAR_HOURS);
  if (raRateCache.size > 64) raRateCache.clear();
  raRateCache.set(key, rate);
  return rate;
}

/**
 * Length of the solar day (Sun returning to the same hour angle), in hours. Emerges
 * from the spin beating against the Sun's mean right ascension rate. Infinite when the
 * spin exactly matches that rate (a tidally-locked configuration). With a spin formula
 * the rate varies through the year, so pass the orbital position for that day; omitting
 * it assumes the base (multiplier 1) spin.
 */
export function solarDayHours(
  config: RotationConfig,
  sunLonDeg?: number,
  axisPhaseLonDeg?: number,
): number {
  const rel = spinRateDegPerHour(config, sunLonDeg, axisPhaseLonDeg) - meanSunRaRateDegPerHour(config);
  return Math.abs(rel) < TINY_RATE ? Infinity : 360 / Math.abs(rel);
}

/**
 * Sign of the Sun's apparent daily motion: +1 when it rises in the east like a normal
 * prograde day, -1 when it rises in the west. This follows the spin measured against
 * the Sun's mean RA rate, not the raw spin, so a planet spinning prograde but slower
 * than its orbit sees the Sun drift backwards. For every ordinary day length the spin
 * dominates, so this matches the prograde flag; a spin formula that dips below the orbit
 * rate (or reverses) flips it, so pass the orbital position for the day in question.
 */
export function apparentSolarSpinSign(
  config: RotationConfig,
  sunLonDeg?: number,
  axisPhaseLonDeg?: number,
): number {
  const rel = spinRateDegPerHour(config, sunLonDeg, axisPhaseLonDeg) - meanSunRaRateDegPerHour(config);
  if (Math.abs(rel) < TINY_RATE) return config.prograde ? 1 : -1;
  return rel >= 0 ? 1 : -1;
}

/**
 * Whether the apparent spin direction flips somewhere over the next few orbits, i.e. a
 * spin formula carries the planet through a standstill and reverses. The reversal itself
 * is physically fine and the per-day sky charts stay correct, but the continuous orbit-view
 * spin jumps at the instant of reversal (local solar time is singular when the spin is
 * zero), so the UI warns about it. A constant or non-zero-crossing spin never flips and
 * returns false. This is a dense-sampling heuristic over the first few orbits (a needle-thin
 * or far-future reversal between samples can be missed), which is fine for a soft warning.
 */
export function spinReverses(config: RotationConfig): boolean {
  const orbits = 4; // covers periodic spins and near-term secular (year/t) ones
  const N = 360 * orbits;
  let prevSign = 0;
  for (let i = 0; i <= N; i++) {
    const phase = (i / N) * orbits * 360; // accumulated longitude so year/t evolve
    const sign = apparentSolarSpinSign(config, phase, phase);
    if (i > 0 && sign !== prevSign) return true;
    prevSign = sign;
  }
  return false;
}

export function computeDayPath(
  config: RotationConfig,
  dayOfYear: number,
  latDeg: number,
  lonDeg: number,
  steps = 480,
  axisPhaseLonDeg?: number,
): DayPath {
  const sunLon = sunLongitudeDeg(dayOfYear);
  const axisPhase = axisPhaseLonDeg ?? sunLon;
  const axis = axisParamsAt(config, sunLon, axisPhase);
  const decDeg = sunDeclinationDeg(axis.obliquityDeg, axis.axisLongitudeDeg, sunLon);

  const lat = latDeg * DEG;
  const dec = decDeg * DEG;
  const dayLen = solarDayHours(config, sunLon, axisPhase);

  // Upper and lower culmination altitudes (exact).
  const { upperDeg: peakAltDeg, lowerDeg: minAltDeg } = culminationAltitudesDeg(lat, dec);

  // Daylight fraction from the sunrise hour angle: 0 = polar night, PI = polar day.
  const H0 = sunriseHourAngleRad(lat, dec);
  const atPole = Math.abs(Math.cos(lat)) < 1e-9;
  const { fraction: daylightFraction, polar } = classifyDaylight(H0);
  let condition: DayCondition =
    polar === 'day' ? 'polar-day' : polar === 'night' ? 'polar-night' : 'normal';
  if (!Number.isFinite(dayLen)) condition = 'no-cycle';

  // Sunrise/sunset azimuth (exact). cos(Az) = sin(dec)/cos(lat) at the horizon.
  let sunriseAzDeg: number | null = null;
  let sunsetAzDeg: number | null = null;
  const solarSign = apparentSolarSpinSign(config, sunLon, axisPhase);
  if (condition === 'normal' || condition === 'no-cycle') {
    if (!atPole) {
      const az0 = Math.acos(clamp(Math.sin(dec) / Math.cos(lat), -1, 1)) * RAD;
      // Sun rising in the east (azimuth 0..180) when its apparent motion is prograde;
      // reversed when it appears to move backwards across the sky.
      sunriseAzDeg = solarSign > 0 ? az0 : 360 - az0;
      sunsetAzDeg = solarSign > 0 ? 360 - az0 : az0;
    }
  }

  const daylightHours = Number.isFinite(dayLen) ? daylightFraction * dayLen : daylightFraction > 0 ? Infinity : 0;

  // Sample the drawn path. Sweep one full rotation in chronological order, phased
  // so the sample fraction equals local solar time / 24: t=0 is local midnight,
  // t=0.5 is local solar noon. The Sun direction is held fixed for the day.
  const dir = solarSign;
  const noonSpin = noonSpinDeg(config, dayOfYear, lonDeg, axisPhase);
  const M0 = sunDirEcliptic(sunLon);
  const samples: DaySample[] = [];
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const spinDeg = noonSpin + dir * (frac * 360 - 180);
    const M = earthMatrix(axis.obliquityDeg, axis.axisLongitudeDeg, spinDeg);
    const { altDeg, azDeg } = sunAltAz(M, M0, latDeg, lonDeg);
    samples.push({ t: frac, altDeg, azDeg });
  }

  return {
    samples,
    stats: {
      declinationDeg: decDeg,
      peakAltDeg,
      minAltDeg,
      daylightHours,
      solarDayHours: dayLen,
      sunriseAzDeg,
      sunsetAzDeg,
      condition,
    },
  };
}
