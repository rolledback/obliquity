import { YEAR_DAYS, absDaysFrom } from './calendar';
import type { RotationConfig } from './config';
import { earthMatrixAtLocalTime } from './daypath';
import {
  lunarDepth,
  lunarEclipseAt,
  solarEclipseAt,
  solarEclipsePossible,
} from './eclipse';
import { SUN_ANGULAR_RADIUS_DEG } from './moon';
import type { LunarEclipseKind, SolarEclipseKind } from './eclipse';
import { moonStateAt, moonTopocentric } from './moon';
import type { MoonState } from './moon';
import { sunDirEcliptic } from './orientation';
import { directionAltAz } from './sun';
import { DEG } from './vec';
import type { Mat3 } from './vec';

/** Eclipse families supported by the finder. */
export type EclipseType = 'solar' | 'lunar';

/** Valid classifications for an eclipse family. */
export type KindOf<T extends EclipseType> = T extends 'solar'
  ? Exclude<SolarEclipseKind, 'none'>
  : Exclude<LunarEclipseKind, 'none'>;

/** A visible eclipse hit with family-specific classification. */
export type EclipseHit<T extends EclipseType = EclipseType> = T extends EclipseType
  ? EclipseHitOf<T>
  : never;

interface EclipseHitOf<T extends EclipseType> {
  type: T;
  /** Sub-classification at greatest eclipse for this observer. */
  kind: KindOf<T>;
  /** Whole orbits elapsed at greatest eclipse. */
  orbit: number;
  /** Day of year at greatest eclipse. */
  dayOfYear: number;
  /** Local solar time at which it peaks for this observer, 0..24. */
  timeOfDay: number;
  /** Eclipse magnitude at that moment. */
  magnitude: number;
  /** Altitude of the eclipsed body at that moment, degrees. */
  altDeg: number;
  /** Absolute days from the epoch, for callers that want to keep searching past it. */
  absDays: number;
}

/** Orbit and day-of-year for an absolute day count. */
function splitAbsDays(absDays: number): { orbit: number; dayOfYear: number } {
  const orbit = Math.floor(absDays / YEAR_DAYS);
  return { orbit, dayOfYear: absDays - orbit * YEAR_DAYS + 1 };
}

// Refinement changes absolute time, so rederive the orientation date at every sample.
function orientationAtInstant(
  config: RotationConfig,
  absDays: number,
  lonDeg: number,
  hour: number,
) {
  const at = splitAbsDays(absDays);
  return earthMatrixAtLocalTime(config, at.orbit, at.dayOfYear, lonDeg, hour);
}

// Rank eclipse classifications across both families.
function eclipseDepthRank(
  type: EclipseType,
  kind: SolarEclipseKind | LunarEclipseKind,
): number {
  switch (kind) {
    case 'none':
      return 0;
    case 'penumbral': // lunar only
      return 1;
    case 'partial':
      return type === 'solar' ? 1 : 2;
    case 'annular': // solar only
      return 2;
    case 'total':
      return 3;
    default: {
      const exhaustive: never = kind;
      void exhaustive;
      return 0;
    }
  }
}

// Rank kind before magnitude because penumbral and umbral magnitudes use different scales.
function eclipseScore(
  type: EclipseType,
  kind: SolarEclipseKind | LunarEclipseKind,
  magnitude: number,
): number {
  return eclipseDepthRank(type, kind) * 1000 + Math.max(0, magnitude);
}

interface LocalPeak {
  timeOfDay: number;
  /** The magnitude worth reporting to the user. */
  magnitude: number;
  /** Ranking score, kind-first, used only to choose between moments. */
  score: number;
  altDeg: number;
  kind: SolarEclipseKind | LunarEclipseKind;
}

// Sweep local orientations for this fixed lunar instant.
function bestLocalView(
  type: EclipseType,
  moon: MoonState,
  config: RotationConfig,
  orbit: number,
  dayOfYear: number,
  latDeg: number,
  lonDeg: number,
  steps = 288, // every 5 local minutes
): LocalPeak {
  // Negative sentinel lets a zero-magnitude graze beat no eclipse.
  let best: LocalPeak = { timeOfDay: 12, magnitude: 0, score: -1, altDeg: -90, kind: 'none' };
  for (let i = 0; i < steps; i++) {
    const timeOfDay = (i / steps) * 24;
    const M = earthMatrixAtLocalTime(config, orbit, dayOfYear, lonDeg, timeOfDay);
    if (type === 'solar') {
      const view = solarView(moon, M, timeOfDay, latDeg, lonDeg);
      if (view.score > best.score) best = view;
    } else {
      const e = lunarEclipseAt(moon);
      if (e.kind === 'none') continue;
      // Lunar geometry is global; choose the orientation with highest Moon altitude.
      const topo = moonTopocentric(moon, M, latDeg, lonDeg);
      const alt = directionAltAz(M, topo.dir, latDeg, lonDeg).altDeg;
      if (alt <= MIN_VISIBLE_ALT_DEG) continue;
      if (alt > best.altDeg) {
        best = {
          timeOfDay,
          magnitude: lunarDepth(e),
          score: eclipseScore('lunar', e.kind, lunarDepth(e)),
          altDeg: alt,
          kind: e.kind,
        };
      }
    }
  }
  return best;
}

// Evaluate one topocentric solar view, including visibility.
function solarView(
  moon: MoonState,
  M: Mat3,
  timeOfDay: number,
  latDeg: number,
  lonDeg: number,
): LocalPeak {
  const miss = (altDeg: number): LocalPeak => ({
    timeOfDay,
    magnitude: 0,
    score: -1,
    altDeg,
    kind: 'none',
  });
  const e = solarEclipseAt(moon, M, latDeg, lonDeg);
  if (e.kind === 'none') return miss(-90);
  const alt = directionAltAz(M, sunDirEcliptic(moon.sunLonDeg), latDeg, lonDeg).altDeg;
  if (alt <= MIN_VISIBLE_ALT_DEG) return miss(alt);
  return {
    timeOfDay,
    magnitude: e.magnitude,
    score: eclipseScore('solar', e.kind, e.magnitude),
    altDeg: alt,
    kind: e.kind,
  };
}

/** Evaluate a solar view from absolute time and local hour. */
function solarViewAt(
  config: RotationConfig,
  absDays: number,
  hour: number,
  latDeg: number,
  lonDeg: number,
): LocalPeak {
  return solarView(
    moonStateAt(absDays),
    orientationAtInstant(config, absDays, lonDeg, hour),
    hour,
    latDeg,
    lonDeg,
  );
}

// Refine a coarse solar peak across absolute time and local hour.
function refineSolarPeak(
  config: RotationConfig,
  absDays: number,
  coarse: LocalPeak,
  latDeg: number,
  lonDeg: number,
): { absDays: number; peak: LocalPeak } {
  let bestAbs = absDays;
  let best = coarse;
  // Peak-ridge slope scales as 1/cos(latitude): 24 h/day at 0 degrees, 138 at 80.
  let absRadius = 0.06; // days
  const cosLat = Math.max(MIN_COS_LAT, Math.abs(Math.cos(latDeg * DEG)));
  let hourRadius = absRadius * (24 / cosLat);

  for (let round = 0; round < 12; round++) {
    let improved = false;
    for (let i = -2; i <= 2; i++) {
      // Extra local-hour steps resolve the steep ridge at high latitudes.
      for (let j = -RIDGE_STEPS; j <= RIDGE_STEPS; j++) {
        if (i === 0 && j === 0) continue;
        const t = bestAbs + (i / 2) * absRadius;
        if (t < 0) continue;
        const h = best.timeOfDay + (j / RIDGE_STEPS) * hourRadius;
        if (h < 0 || h >= 24) continue;
        const view = solarViewAt(config, t, h, latDeg, lonDeg);
        if (view.score > best.score) {
          best = view;
          bestAbs = t;
          improved = true;
        }
      }
    }
    absRadius /= 1.9;
    hourRadius /= 1.9;
    if (!improved && round > 8) break;
  }
  return { absDays: bestAbs, peak: best };
}

/** Eclipse search filters and direction. */
export interface FindOptions<T extends EclipseType = EclipseType> {
  /** Accepted classifications. */
  kinds?: readonly KindOf<T>[];
  /** Ignore eclipses fainter than this magnitude, so the finder skips grazing events. */
  minMagnitude?: number;
  /** How far ahead to look before giving up. */
  maxYears?: number;
  /** Search backwards instead of forwards. */
  backwards?: boolean;
}

// Conservative elongation-rate bound for safe adaptive strides, degrees per day.
const MAX_ELONGATION_RATE = 15;

/** How close to syzygy is worth examining in detail, in degrees of elongation. */
const SYZYGY_WINDOW_DEG = 2;

// Angular distance from new moon for solar, or full moon for lunar.
function syzygyGapDeg(type: EclipseType, moon: MoonState): number {
  return type === 'solar' ? moon.elongationDeg : 180 - moon.elongationDeg;
}

// Generous size-only totality filter; surface parallax can enlarge the Moon about 1.7%.
function couldBeTotalSomewhere(moon: MoonState): boolean {
  return moon.angularRadiusDeg * 1.02 >= SUN_ANGULAR_RADIUS_DEG;
}

/** True when a global eclipse candidate exists, ignoring the observer. */
function isCandidate(type: EclipseType, moon: MoonState): boolean {
  return type === 'solar'
    ? solarEclipsePossible(moon)
    : lunarEclipseAt(moon).kind !== 'none';
}

// Suppress floating residue when a degenerate rotation parks a body on the horizon.
const MIN_VISIBLE_ALT_DEG = 1e-6;

// Cap 1/cos(latitude) at 10 as the daily circle collapses near the poles.
const MIN_COS_LAT = 0.1;

/** Steps either side of centre along the local-hour axis, where the ridge runs. */
const RIDGE_STEPS = 6;

/** Coarse walk step, in days, used to bound a candidate window. */
const WINDOW_STEP = 0.01;

/** 2.88-minute stride; 14.4 minutes skipped a 6.34-minute graze in a 600-year survey. */
export const SYZYGY_STEP = 0.002;

// Solar-event instants offered to topocentric refinement.
const WINDOW_SAMPLES = 12;

// Number of coarse candidates refined in two dimensions.
const REFINE_CANDIDATES = 4;

// Coarse local-hour samples before refinement.
const COARSE_LOCAL_STEPS = 96;

/** The best view this observer gets of the eclipse at one absolute instant. */
function viewAt(
  type: EclipseType,
  config: RotationConfig,
  absDays: number,
  latDeg: number,
  lonDeg: number,
  steps?: number,
): LocalPeak {
  const at = splitAbsDays(absDays);
  return bestLocalView(
    type,
    moonStateAt(absDays),
    config,
    at.orbit,
    at.dayOfYear,
    latDeg,
    lonDeg,
    steps,
  );
}

/** Coarse absolute-time window containing one global eclipse candidate. */
function eventWindow(type: EclipseType, at: number): { start: number; end: number } {
  let start = at;
  while (start - WINDOW_STEP >= 0 && isCandidate(type, moonStateAt(start - WINDOW_STEP))) {
    start -= WINDOW_STEP;
  }
  let end = at;
  while (isCandidate(type, moonStateAt(end + WINDOW_STEP))) end += WINDOW_STEP;
  return { start, end };
}

// Find the geocentric maximum within one candidate window.
function greatestEclipseAt(type: EclipseType, window: { start: number; end: number }): number {
  // Solar uses minimum syzygy gap; lunar maximises its family-specific depth.
  const score = (t: number) => {
    const moon = moonStateAt(t);
    if (type === 'solar') return -syzygyGapDeg(type, moon);
    // Preserve kind-first ranking across penumbral and umbral scales.
    const e = lunarEclipseAt(moon);
    return eclipseScore('lunar', e.kind, lunarDepth(e));
  };
  const STEPS = 48;
  let best = window.start;
  let bestScore = -Infinity;
  for (let i = 0; i <= STEPS; i++) {
    const t = window.start + ((window.end - window.start) * i) / STEPS;
    const v = score(t);
    if (v > bestScore) {
      bestScore = v;
      best = t;
    }
  }
  // Narrow around the coarse winner.
  let radius = (window.end - window.start) / STEPS;
  for (let round = 0; round < 24; round++) {
    for (const t of [best - radius, best + radius]) {
      if (t < 0) continue;
      const v = score(t);
      if (v > bestScore) {
        bestScore = v;
        best = t;
      }
    }
    radius /= 1.7;
  }
  return best;
}

/** Find the next visible eclipse using geocentric candidates and topocentric refinement. */
export function findNextEclipse<T extends EclipseType>(
  type: T,
  config: RotationConfig,
  latDeg: number,
  lonDeg: number,
  orbit: number,
  dayOfYear: number,
  options: FindOptions<T> = {},
): EclipseHit<T> | null {
  const { kinds, minMagnitude = 0, maxYears = 20, backwards = false } = options;
  const dir = backwards ? -1 : 1;
  const start = absDaysFrom(orbit, dayOfYear);
  const limit = maxYears * YEAR_DAYS;
  // A size prefilter makes total-only searches avoid most annular events.
  const totalOnly = type === 'solar' && kinds != null && kinds.every((k) => k === 'total');

  let t = start;
  // Skip only a candidate active at the start, not one opening within the next stride.
  if (isCandidate(type, moonStateAt(t))) {
    const w = eventWindow(type, t);
    t = (backwards ? w.start - WINDOW_STEP : w.end + WINDOW_STEP) + 0;
  }

  while (t >= 0 && Math.abs(t - start) <= limit) {
    const moon = moonStateAt(t);
    if (isCandidate(type, moon)) {
      const window = eventWindow(type, t);
      const peakAbs = greatestEclipseAt(type, window);
      const hit =
        !totalOnly || couldBeTotalSomewhere(moonStateAt(peakAbs))
          ? examine(type, config, window, peakAbs, latDeg, lonDeg, kinds, minMagnitude)
          : null;
      if (hit) return hit;
      t = backwards ? window.start - WINDOW_STEP : window.end + WINDOW_STEP;
      continue;
    }

    // Bound strides outside the syzygy window; use the surveyed floor inside it.
    const gap = syzygyGapDeg(type, moon) - SYZYGY_WINDOW_DEG;
    const jump = gap > 0 ? Math.max(SYZYGY_STEP, gap / MAX_ELONGATION_RATE) : SYZYGY_STEP;
    t += dir * jump;
  }
  return null;
}

// Refine before filtering, or a coarse partial can hide the requested total or annular peak.
function examine<T extends EclipseType>(
  type: T,
  config: RotationConfig,
  window: { start: number; end: number },
  peakAbs: number,
  latDeg: number,
  lonDeg: number,
  kinds: readonly (SolarEclipseKind | LunarEclipseKind)[] | undefined,
  minMagnitude: number,
): EclipseHit<T> | null {
  let absDays = peakAbs;
  let peak = viewAt(type, config, peakAbs, latDeg, lonDeg);

  if (type === 'solar') {
    // Sample the full event because an observer's peak can lie far from the global peak.
    const seen: { absDays: number; peak: LocalPeak }[] = [];
    if (peak.kind !== 'none') seen.push({ absDays: peakAbs, peak });
    for (let i = 0; i <= WINDOW_SAMPLES; i++) {
      const t = window.start + ((window.end - window.start) * i) / WINDOW_SAMPLES;
      const view = viewAt(type, config, t, latDeg, lonDeg, COARSE_LOCAL_STEPS);
      if (view.kind !== 'none') seen.push({ absDays: t, peak: view });
    }
    if (seen.length === 0) return null;

    // Refine several starts because coarse ranking is unreliable along the diagonal ridge.
    seen.sort((a, b) => b.peak.score - a.peak.score);
    let best: { absDays: number; peak: LocalPeak } | null = null;
    for (const start of seen.slice(0, REFINE_CANDIDATES)) {
      const refined = refineSolarPeak(config, start.absDays, start.peak, latDeg, lonDeg);
      if (!best || refined.peak.score > best.peak.score) best = refined;
    }
    if (!best) return null;
    absDays = best.absDays;
    peak = best.peak;
  }
  if (peak.kind === 'none') return null;

  if (kinds && !kinds.includes(peak.kind)) return null;
  if (peak.magnitude < minMagnitude) return null;

  const split = splitAbsDays(absDays);
  // Evaluation preserves type-kind correlation, which the generic conditional cannot prove.
  return {
    type,
    kind: peak.kind,
    orbit: split.orbit,
    dayOfYear: split.dayOfYear,
    timeOfDay: peak.timeOfDay,
    magnitude: peak.magnitude,
    altDeg: peak.altDeg,
    absDays,
  } as EclipseHit<T>;
}
