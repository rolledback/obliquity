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
import { YEAR_HOURS, accumulatedLonDeg, axisConfigKey, periodOrbits, sunLongitudeDeg } from './config';
import type { RotationConfig } from './config';
import type { AxisParams } from './orientation';
import type { Mat3 } from './vec';
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

const TINY_RATE = 1e-6; // deg/hour below which spin and mean Sun RA are treated as locked

/**
 * Spin-formula multiplier at an orbital position.
 * Missing position and the empty or `1` formulas return the base multiplier 1.
 */
export function spinMultiplierAt(
  config: RotationConfig,
  sunLonDeg?: number,
  axisPhaseLonDeg?: number,
): number {
  const src = config.spinFormula;
  if (src === '' || src === '1' || sunLonDeg === undefined) return 1;
  return compileFormula(src).fn(
    formulaVars(sunLonDeg, axisPhaseLonDeg ?? sunLonDeg, config.siteLatDeg, config.siteLonDeg),
  );
}

/** Earth orientation at a date and local apparent solar time. */
export function earthMatrixAtLocalTime(
  config: RotationConfig,
  orbit: number,
  dayOfYear: number,
  lonDeg: number,
  timeOfDay: number,
): Mat3 {
  const accum = accumulatedLonDeg(orbit, dayOfYear);
  const axis = axisParamsAt(config, sunLongitudeDeg(dayOfYear), accum);
  return earthMatrix(
    axis.obliquityDeg,
    axis.axisLongitudeDeg,
    // Reuse the formula-derived axis.
    spinAtLocalTime(config, dayOfYear, lonDeg, timeOfDay, accum, axis),
  );
}

/** Signed spin rate relative to the stars (deg/hour); negative for retrograde. */
export function spinRateDegPerHour(
  config: RotationConfig,
  sunLonDeg?: number,
  axisPhaseLonDeg?: number,
): number {
  const sign = config.prograde ? 1 : -1;
  const base = (sign * 360) / config.rotationPeriodHours;
  // A 1e4 multiplier bounds overflow while already exceeding visible spin rates.
  const mult = spinMultiplierAt(config, sunLonDeg, axisPhaseLonDeg);
  const clamped = Math.max(-1e4, Math.min(1e4, mult));
  return base * clamped;
}

// Memoized because solarDayHours runs every animation frame.
const raRateCache = new Map<string, number>();
/**
 * Prime sample count avoids exact power-of-two resonance.
 * Frequencies above roughly 1000 cycles per orbit remain undersampled.
 */
const RA_WINDING_STEPS = 2039;

/**
 * Mean Sun right-ascension rate over the configured axis-cycle span.
 * Secular formulas are integrated only over orbit 0, so later-orbit rates can differ
 * and shift the local-noon anchor.
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
    const lon = (i / steps) * period * 360;
    const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(config, lon);
    const ra = raSunDeg(obliquityDeg, axisLongitudeDeg, lon);
    if (i > 0) {
      totalDeg += wrapSignedDeg(ra - prevRa);
    }
    prevRa = ra;
  }
  const rate = totalDeg / (period * YEAR_HOURS);
  if (raRateCache.size > 64) raRateCache.clear();
  raRateCache.set(key, rate);
  return rate;
}

/**
 * Hours for the Sun to return to one hour angle.
 * Returns Infinity when spin and mean Sun RA rates differ by less than TINY_RATE.
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
 * Sampling direction of the Sun's apparent daily motion.
 * Near lock it uses the configured prograde flag; otherwise it follows spin minus
 * the mean Sun RA rate.
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
 * Whether sampled apparent solar motion changes direction in the first four orbits.
 * This heuristic can miss a narrow or later reversal and is used only for a warning.
 */
export function spinReverses(config: RotationConfig): boolean {
  const orbits = 4;
  const N = 360 * orbits;
  let prevSign = 0;
  for (let i = 0; i <= N; i++) {
    const phase = (i / N) * orbits * 360;
    const sign = apparentSolarSpinSign(config, phase, phase);
    if (i > 0 && sign !== prevSign) return true;
    prevSign = sign;
  }
  return false;
}

/**
 * Spin angle at local apparent solar time, with 12:00 on the observer's meridian.
 * `axis` may supply already-computed axis parameters.
 */
export function spinAtLocalTime(
  config: RotationConfig,
  dayOfYear: number,
  lonDeg: number,
  timeOfDay: number,
  axisPhaseLonDeg?: number,
  /** The axis at this instant, when the caller has already worked it out. */
  axis?: AxisParams,
): number {
  const noon = noonSpinDeg(config, dayOfYear, lonDeg, axisPhaseLonDeg, axis);
  const sign = apparentSolarSpinSign(config, sunLongitudeDeg(dayOfYear), axisPhaseLonDeg);
  return noon + sign * 15 * (timeOfDay - 12);
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

  const { upperDeg: peakAltDeg, lowerDeg: minAltDeg } = culminationAltitudesDeg(lat, dec);

  // H0 ranges from 0 for polar night to PI for polar day.
  const H0 = sunriseHourAngleRad(lat, dec);
  const atPole = Math.abs(Math.cos(lat)) < 1e-9;
  const { fraction: daylightFraction, polar } = classifyDaylight(H0);
  let condition: DayCondition =
    polar === 'day' ? 'polar-day' : polar === 'night' ? 'polar-night' : 'normal';
  if (!Number.isFinite(dayLen)) condition = 'no-cycle';

  // At the horizon, cos(azimuth) = sin(dec) / cos(lat).
  let sunriseAzDeg: number | null = null;
  let sunsetAzDeg: number | null = null;
  const solarSign = apparentSolarSpinSign(config, sunLon, axisPhase);
  if (condition === 'normal' || condition === 'no-cycle') {
    if (!atPole) {
      const az0 = Math.acos(clamp(Math.sin(dec) / Math.cos(lat), -1, 1)) * RAD;
      // Reverse east and west for retrograde apparent motion.
      sunriseAzDeg = solarSign > 0 ? az0 : 360 - az0;
      sunsetAzDeg = solarSign > 0 ? 360 - az0 : az0;
    }
  }

  const daylightHours = Number.isFinite(dayLen) ? daylightFraction * dayLen : daylightFraction > 0 ? Infinity : 0;

  // Sweep chronologically from local midnight, with local noon at t=0.5.
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
