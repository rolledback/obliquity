import { CALENDAR_DAYS } from './calendar';
import { declinationForDay, sunriseHourAngleRad } from './orientation';
import { accumulatedLonDeg, axisConfigKey, axisIsSecular, periodOrbits } from './config';
import { posMod, smoothstep, DEG } from './vec';
import type { RotationConfig } from './config';

const N_DAYS = CALENDAR_DAYS;
// A 30-day time constant produces roughly four weeks of seasonal lag.
const TAU_DAYS = 30;
// Below this peak-to-trough warmth, the climate counts as having no real seasons.
const MIN_SEASONAL_SWING = 0.015;

export interface SeasonCycle {
  /** Number of orbits in the climate repeat cycle. */
  periodOrbits: number;
  /** Daily-mean insolation proxy for each day of the cycle (length = periodOrbits*365). */
  insolation: Float64Array;
  /** Thermal-lagged "felt warmth" over the cycle, same length and units. */
  warmth: Float64Array;
  insolationMaxIndex: number;
  warmthMin: number;
  warmthMax: number;
  warmthMinIndex: number;
  warmthMaxIndex: number;
  /** Distinct warm seasons per year, averaged over the cycle. */
  warmSeasonsPerYear: number;
}

/** Daily mean of max(0, sin(solar altitude)) for latitude and declination in radians. */
export function dailyInsolation(latRad: number, decRad: number): number {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinDec = Math.sin(decRad);
  const cosDec = Math.cos(decRad);
  const H0 = sunriseHourAngleRad(latRad, decRad);
  const v = (H0 * sinLat * sinDec + cosLat * cosDec * Math.sin(H0)) / Math.PI;
  return v < 0 ? 0 : v;
}

function computeSeasonCycle(config: RotationConfig, latDeg: number, baseOrbit: number): SeasonCycle {
  const lat = latDeg * DEG;
  const period = periodOrbits(config);
  const n = period * N_DAYS;
  const insolation = new Float64Array(n);
  let sum = 0;
  let insolMaxIndex = 0;
  let insolMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const orbit = baseOrbit + Math.floor(i / N_DAYS);
    const day = (i % N_DAYS) + 1;
    // Unwrapped longitude preserves cross-orbit axis evolution.
    const v = dailyInsolation(lat, declinationForDay(config, day, accumulatedLonDeg(orbit, day)) * DEG);
    insolation[i] = v;
    sum += v;
    if (v > insolMax) {
      insolMax = v;
      insolMaxIndex = i;
    }
  }

  // Settle the first-order lag into a repeating state.
  const warmth = new Float64Array(n).fill(sum / n);
  for (let pass = 0; pass < 8; pass++) {
    let prev = warmth[n - 1];
    for (let i = 0; i < n; i++) {
      prev = prev + (insolation[i] - prev) / TAU_DAYS;
      warmth[i] = prev;
    }
  }

  let wMin = Infinity;
  let wMax = -Infinity;
  let wMinIndex = 0;
  let wMaxIndex = 0;
  for (let i = 0; i < n; i++) {
    if (warmth[i] < wMin) {
      wMin = warmth[i];
      wMinIndex = i;
    }
    if (warmth[i] > wMax) {
      wMax = warmth[i];
      wMaxIndex = i;
    }
  }

  // Each upward mid-level crossing starts a warm season.
  const swing = wMax - wMin;
  const crossings =
    swing >= MIN_SEASONAL_SWING
      ? countUpcrossings(warmth, (wMin + wMax) / 2, warmth[warmth.length - 1])
      : 0;

  return {
    periodOrbits: period,
    insolation,
    warmth,
    insolationMaxIndex: insolMaxIndex,
    warmthMin: wMin,
    warmthMax: wMax,
    warmthMinIndex: wMinIndex,
    warmthMaxIndex: wMaxIndex,
    warmSeasonsPerYear: crossings / period,
  };
}

// Key by axis and latitude; across-orbit formulas also key by displayed orbit.
const cache = new Map<string, SeasonCycle>();

/**
 * Snap latitude to the cache-key precision.
 * Three decimals is about 111 m, below the model's seasonal resolution.
 */
function snapLat(latDeg: number): number {
  return Math.round(latDeg * 1000) / 1000;
}

export function seasonCycle(config: RotationConfig, latDeg: number, orbit = 0): SeasonCycle {
  const lat = snapLat(latDeg);
  const baseOrbit = axisIsSecular(config) ? Math.floor(orbit) : 0;
  const key = `${axisConfigKey(config)}|${lat}|${baseOrbit}`;
  let s = cache.get(key);
  if (!s) {
    if (cache.size > 48) cache.clear();
    s = computeSeasonCycle(config, lat, baseOrbit);
    cache.set(key, s);
  }
  return s;
}

/**
 * Climate window over `years` absolute orbits from `startOrbit`, with continuous lag.
 */
export interface SeasonSpan {
  /** Daily-mean insolation for each day across the window (length = years * 365). */
  insolation: Float64Array;
  /** Thermal-lagged warmth for each day across the window (same length). */
  warmth: Float64Array;
  years: number;
  startOrbit: number;
  warmthMin: number;
  warmthMax: number;
  warmthMinIndex: number;
  warmthMaxIndex: number;
  insolationMaxIndex: number;
  /** Axis-cycle span reported by periodOrbits (1 = annual). */
  periodOrbits: number;
  /** Whether an axis formula references year, t, or orbit. */
  secular: boolean;
  /** Distinct warm seasons per year, averaged across the window. */
  warmSeasonsPerYear: number;
}

const spanCache = new Map<string, SeasonSpan>();

export function seasonSpan(
  config: RotationConfig,
  latDeg: number,
  startOrbit: number,
  years: number,
): SeasonSpan {
  years = Math.max(1, Math.round(years));
  startOrbit = Math.round(startOrbit);
  // Compute from the same snapped latitude used by the cache key.
  const latSnapped = snapLat(latDeg);
  const secular = axisIsSecular(config);
  const period = periodOrbits(config);
  // Periodic windows share a cycle-relative key; across-orbit formulas use absolute start.
  const keyStart = secular ? startOrbit : posMod(startOrbit, period);
  const key = `${axisConfigKey(config)}|${latSnapped}|${keyStart}|${years}`;
  const cached = spanCache.get(key);
  if (cached) return cached;
  if (spanCache.size > 48) spanCache.clear();

  const lat = latSnapped * DEG;
  const n = years * N_DAYS;
  const insolation = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const orbit = startOrbit + Math.floor(i / N_DAYS);
    const day = (i % N_DAYS) + 1;
    insolation[i] = dailyInsolation(lat, declinationForDay(config, day, accumulatedLonDeg(orbit, day)) * DEG);
  }

  // Seed the lag so the displayed span does not start cold.
  const warmth = new Float64Array(n);
  let prev: number;
  if (!secular) {
    // Seed from the preceding day in the settled repeat cycle.
    const cyc = seasonCycle(config, latSnapped, 0);
    const prevIdx = posMod(posMod(startOrbit, period) * N_DAYS - 1, cyc.warmth.length);
    prev = cyc.warmth[prevIdx];
  } else {
    // Settle across the first year when no repeat cycle is assumed.
    let seed = 0;
    for (let i = 0; i < N_DAYS; i++) seed += insolation[i];
    seed /= N_DAYS;
    for (let pass = 0; pass < 8; pass++) {
      let p = seed;
      for (let i = 0; i < N_DAYS; i++) p += (insolation[i] - p) / TAU_DAYS;
      seed = p;
    }
    prev = seed;
  }
  const seed = prev;
  for (let i = 0; i < n; i++) {
    prev += (insolation[i] - prev) / TAU_DAYS;
    warmth[i] = prev;
  }

  let wMin = Infinity, wMax = -Infinity, wMinI = 0, wMaxI = 0, iMax = -Infinity, iMaxI = 0;
  for (let i = 0; i < n; i++) {
    if (warmth[i] < wMin) { wMin = warmth[i]; wMinI = i; }
    if (warmth[i] > wMax) { wMax = warmth[i]; wMaxI = i; }
    if (insolation[i] > iMax) { iMax = insolation[i]; iMaxI = i; }
  }
  const swing = wMax - wMin;
  // Use the seed, not the window's final sample, as the first predecessor.
  const crossings =
    swing >= MIN_SEASONAL_SWING ? countUpcrossings(warmth, (wMin + wMax) / 2, seed) : 0;

  const span: SeasonSpan = {
    insolation,
    warmth,
    years,
    startOrbit,
    warmthMin: wMin,
    warmthMax: wMax,
    warmthMinIndex: wMinI,
    warmthMaxIndex: wMaxI,
    insolationMaxIndex: iMaxI,
    periodOrbits: period,
    secular,
    warmSeasonsPerYear: crossings / years,
  };
  spanCache.set(key, span);
  return span;
}

/** Thermal-lagged warmth at a given orbit and day-of-year, wrapped into the cycle. */
export function warmthAt(
  config: RotationConfig,
  latDeg: number,
  orbit: number,
  dayOfYear: number,
): number {
  // Across-orbit formulas use the displayed year; periodic worlds select within the cycle.
  const secular = axisIsSecular(config);
  const cyc = seasonCycle(config, latDeg, orbit);
  const n = cyc.warmth.length;
  const orbitInCycle = secular ? 0 : posMod(Math.round(orbit), cyc.periodOrbits);
  const idx = posMod(orbitInCycle * N_DAYS + (Math.round(dayOfYear) - 1), n);
  return cyc.warmth[idx];
}

export interface GroundAppearance {
  /** 0 = lush green, 1 = dry/golden dormant grass. */
  dryness: number;
  /** 0 = bare ground, 1 = full snow cover. */
  snow: number;
}

// Calibrated warmth: equator about 0.30, 47 N winter about 0.09, 60 N about 0.03.
const DRY_LUSH = 0.22; // at/above this warmth the grass is fully green
const DRY_FULL = 0.1; // at/below this the grass is fully golden/dormant
const SNOW_START = 0.1; // snow begins to dust the ground
const SNOW_FULL = 0.04; // full snow cover

/** Map a warmth value to how the ground should look (grass colour and snow cover). */
export function groundAppearance(warmth: number): GroundAppearance {
  return {
    dryness: 1 - smoothstep(DRY_FULL, DRY_LUSH, warmth),
    snow: 1 - smoothstep(SNOW_FULL, SNOW_START, warmth),
  };
}

/**
 * Number of times a series rises through `mid` (one per warm season).
 * `before` is the value immediately preceding the first sample.
 */
function countUpcrossings(series: Float64Array, mid: number, before: number): number {
  let count = 0;
  let prev = before;
  for (let i = 0; i < series.length; i++) {
    if (prev < mid && series[i] >= mid) count++;
    prev = series[i];
  }
  return count;
}
