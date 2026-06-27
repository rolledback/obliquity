// A simple, config-agnostic "seasons" signal derived from what the Sun actually
// does at a location, so it stays meaningful even for exotic rotations that break
// the normal calendar (perpetual summer, double seasons, no seasons, polar worlds).
//
// Step 1 - daily insolation: the average over one rotation of max(0, sin(altitude)),
// i.e. how much sunlight energy lands on flat ground that day (in units where the
// Sun straight overhead all day = 1). This has a closed form, depends only on the
// latitude and that day's solar declination, and is independent of how fast the
// planet spins, so it isolates the seasonal signal.
//
// Step 2 - thermal lag: real climate lags the Sun by about four weeks (the hottest
// part of summer comes after the solstice) because ground and oceans store heat.
// We model this with a first-order leaky integrator run around the climate's full
// repeating cycle until it settles. The result is a "felt warmth" curve whose peak
// trails the insolation peak by roughly a month.
//
// A steadily precessing axis can take several orbits to return to the same
// orientation, so the climate repeats over a multi-year cycle rather than a single
// year. Everything here works over that full cycle; for any periodic configuration
// the cycle is exactly one year and the result is identical to a single-year model.

import { declinationForDay, sunriseHourAngleRad } from './orientation';
import { accumulatedLonDeg, axisConfigKey, axisIsSecular, periodOrbits } from './config';
import { posMod, smoothstep, DEG } from './vec';
import type { RotationConfig } from './config';

const N_DAYS = 365;
// Thermal-lag time constant in days. ~30 produces the ~4-week lag real climates show.
const TAU_DAYS = 30;
// Below this peak-to-trough warmth, the climate counts as having no real seasons.
const MIN_SEASONAL_SWING = 0.015;

export interface SeasonCycle {
  /** Number of orbits the climate repeats over (1 for any periodic world). */
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

/**
 * Daily-mean of max(0, sin(solar altitude)) for a latitude and solar declination
 * (both in radians). Closed form: with hour angle H, sin(alt) = sinφ sinδ + cosφ
 * cosδ cosH; integrate the positive part over the day and divide by 2π. Works at the
 * poles and for any declination (including the large tilts of exotic configs).
 */
export function dailyInsolation(latRad: number, decRad: number): number {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinDec = Math.sin(decRad);
  const cosDec = Math.cos(decRad);
  const H0 = sunriseHourAngleRad(latRad, decRad); // 0 (polar night) .. PI (polar day)
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
    // Longitude accumulated across orbits drives the precessing axis, so each orbit's
    // declination genuinely differs; periodic worlds give the same value every orbit.
    const v = dailyInsolation(lat, declinationForDay(config, day, accumulatedLonDeg(orbit, day)) * DEG);
    insolation[i] = v;
    sum += v;
    if (v > insolMax) {
      insolMax = v;
      insolMaxIndex = i;
    }
  }

  // First-order lag around the cycle, settled to a steady repeating state.
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

  // Warm seasons: upward crossings of the mid-level over the whole cycle, per year. The
  // cycle repeats, so it is counted circularly (the first sample follows the last).
  const swing = wMax - wMin;
  const crossings = swing >= MIN_SEASONAL_SWING ? countUpcrossings(warmth, (wMin + wMax) / 2, true) : 0;

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

// Cache the (cheap but not free) cycle computation, keyed by the axis orientation and
// latitude only, so spinning the rotation-speed sliders does not bust it every frame.
// A secular formula world (axisIsSecular) genuinely differs every orbit, so its key also
// carries the orbit on display; periodic worlds ignore the orbit and keep one cached cycle.
const cache = new Map<string, SeasonCycle>();

export function seasonCycle(config: RotationConfig, latDeg: number, orbit = 0): SeasonCycle {
  const baseOrbit = axisIsSecular(config) ? Math.floor(orbit) : 0;
  const key = `${axisConfigKey(config)}|${latDeg.toFixed(3)}|${baseOrbit}`;
  let s = cache.get(key);
  if (!s) {
    if (cache.size > 48) cache.clear();
    s = computeSeasonCycle(config, latDeg, baseOrbit);
    cache.set(key, s);
  }
  return s;
}

/** A multi-year warmth window for the climate chart, spanning `years` absolute orbits
 * starting at `startOrbit`. Unlike seasonCycle (which is the world's natural repeat cycle),
 * this reads each year at its own elapsed orbit and integrates the thermal lag continuously
 * across the whole window, so a secular (drifting) world genuinely evolves year to year
 * while a periodic world simply repeats. */
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
  /** The world's true repeat period in orbits (1 = annual). */
  periodOrbits: number;
  /** True when the axis drifts so no two years ever match (formula worlds using year/t). */
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
  const secular = axisIsSecular(config);
  const period = periodOrbits(config);
  // A periodic world repeats every `period` orbits, so windows that start the same number of
  // orbits into the cycle are identical and can share a cache entry; a secular world differs
  // at every absolute orbit, so it must key on the true start.
  const keyStart = secular ? startOrbit : posMod(startOrbit, period);
  const key = `${axisConfigKey(config)}|${latDeg.toFixed(3)}|${keyStart}|${years}`;
  const cached = spanCache.get(key);
  if (cached) return cached;
  if (spanCache.size > 48) spanCache.clear();

  const lat = latDeg * DEG;
  const n = years * N_DAYS;
  const insolation = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const orbit = startOrbit + Math.floor(i / N_DAYS);
    const day = (i % N_DAYS) + 1;
    insolation[i] = dailyInsolation(lat, declinationForDay(config, day, accumulatedLonDeg(orbit, day)) * DEG);
  }

  // First-order thermal lag, integrated forward across the whole window. Seed it so the
  // displayed span starts already warmed up instead of from a cold mean.
  const warmth = new Float64Array(n);
  let prev: number;
  if (!secular) {
    // A periodic world has a known steady cycle: seed from the settled warmth of the day just
    // before the window start, so the forward integration reproduces that cycle exactly. (A
    // multi-orbit period must not be seeded from its first displayed year alone, which would
    // leave a cold-start artifact across the first months.)
    const cyc = seasonCycle(config, latDeg, 0);
    const prevIdx = posMod(posMod(startOrbit, period) * N_DAYS - 1, cyc.warmth.length);
    prev = cyc.warmth[prevIdx];
  } else {
    // A secular world has no repeating cycle; settle the lag on the window's first year so it
    // still starts warmed up rather than cold.
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
  // An open forward window does not repeat, so do not wrap the first sample to the last.
  const crossings = swing >= MIN_SEASONAL_SWING ? countUpcrossings(warmth, (wMin + wMax) / 2, false) : 0;

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
  // A secular world's cycle is the single year of the orbit on display; a periodic world
  // reuses its one multi-year cycle and the orbit just selects which year within it.
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

// Thresholds in insolation units, calibrated against real Earth latitudes: the
// equator (warmth ~0.30) stays lush year round; ~47°N dips to ~0.09 in winter (light
// frost); ~60°N reaches ~0.03 (snowy); the poles bottom out near 0 (deep snow).
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

/** Number of times a series rises through `mid` (one per warm season). A circular series
 * (the world's repeating cycle) wraps the first sample around to the last; an open window
 * (a forward span) does not, so its first sample has no predecessor to cross from. */
function countUpcrossings(series: Float64Array, mid: number, circular: boolean): number {
  const n = series.length;
  let count = 0;
  for (let i = circular ? 0 : 1; i < n; i++) {
    const prev = circular ? series[posMod(i - 1, n)] : series[i - 1];
    if (prev < mid && series[i] >= mid) count++;
  }
  return count;
}
