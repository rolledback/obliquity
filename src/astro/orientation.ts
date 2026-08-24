import { YEAR_DAYS } from './calendar';
import { sunLongitudeDeg } from './config';
import type { RotationConfig } from './config';
import { compileFormula, formulaVars } from './formula';
import { DEG, RAD, clamp, dot, matMulAll, posMod, rotY, rotZ } from './vec';
import type { Mat3, V3 } from './vec';

export interface AxisParams {
  obliquityDeg: number;
  axisLongitudeDeg: number;
}

/**
 * Effective axis at a Sun longitude. Pass an unwrapped `axisPhaseLonDeg` for
 * precession or formulas that evolve across orbits.
 */
export function axisParamsAt(
  config: RotationConfig,
  sunLonDeg: number,
  axisPhaseLonDeg: number = sunLonDeg,
): AxisParams {
  const base = config.axisLongitudeDeg;
  switch (config.axisMode) {
    case 'leanToSun':
      return { obliquityDeg: config.obliquityDeg, axisLongitudeDeg: sunLonDeg };
    case 'leanFromSun':
      return { obliquityDeg: config.obliquityDeg, axisLongitudeDeg: sunLonDeg + 180 };
    case 'precession':
      return {
        obliquityDeg: config.obliquityDeg,
        axisLongitudeDeg: base + config.precessionTurnsPerYear * axisPhaseLonDeg,
      };
    case 'obliquityWave':
      return {
        obliquityDeg:
          config.obliquityDeg + config.obliquityAmplitudeDeg * Math.sin(sunLonDeg * DEG),
        axisLongitudeDeg: base,
      };
    case 'rollWave':
      return {
        obliquityDeg: config.obliquityDeg,
        axisLongitudeDeg: base + config.rollAmplitudeDeg * Math.sin(sunLonDeg * DEG),
      };
    case 'formula': {
      // Both formulas receive within-orbit longitude and unwrapped axis phase.
      const vars = formulaVars(sunLonDeg, axisPhaseLonDeg, config.siteLatDeg, config.siteLonDeg);
      return {
        obliquityDeg: compileFormula(config.tiltFormula).fn(vars),
        axisLongitudeDeg: compileFormula(config.leanFormula).fn(vars),
      };
    }
    case 'fixed':
      return { obliquityDeg: config.obliquityDeg, axisLongitudeDeg: base };
    default: {
      // Exhaustiveness guard: adding a new AxisMode without a case above is a compile error.
      const _exhaustive: never = config.axisMode;
      void _exhaustive;
      return { obliquityDeg: config.obliquityDeg, axisLongitudeDeg: base };
    }
  }
}

/** Unit vector along the Earth's north pole in the ecliptic frame. */
export function northPole(obliquityDeg: number, axisLongitudeDeg: number): V3 {
  const e = obliquityDeg * DEG;
  const a = axisLongitudeDeg * DEG;
  return [Math.sin(e) * Math.cos(a), Math.sin(e) * Math.sin(a), Math.cos(e)];
}

/**
 * Above this daily pole movement the Sun reads as jumping rather than moving. The chord is
 * on the unit sphere, so 0.15 is about 8.6 degrees of pole travel in a day. Calibrated
 * against the shipped worlds, whose honest daily figures run from 0 for realistic Earth to
 * 0.086 for The Blender, which is deliberately the wildest thing here.
 */
export const SMOOTH_POLE_STEP = 0.15;

/**
 * Largest north-pole movement between CONSECUTIVE DAYS, over several orbits.
 * Days are the right unit because that is what the charts and the sky step through, and
 * several orbits are needed because a world driven by `year` can be calm in its first one
 * and wild later. Sampling the orbit at a fixed fine resolution instead can ALIAS: a lean
 * that happens to advance a whole turn between probes reads as perfectly still.
 */
export function maxPoleStep(config: RotationConfig, orbits = 4): number {
  const days = Math.ceil(orbits * YEAR_DAYS);
  let maxStep = 0;
  let prev = poleOnDay(config, 0);
  for (let d = 1; d <= days; d += 1) {
    const next = poleOnDay(config, d);
    const step = Math.hypot(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
    if (step > maxStep) maxStep = step;
    prev = next;
  }
  return maxStep;
}

function poleOnDay(config: RotationConfig, dayIndex: number): V3 {
  const accumulated = (dayIndex / YEAR_DAYS) * 360;
  const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(
    config,
    posMod(accumulated, 360),
    accumulated,
  );
  return northPole(obliquityDeg, axisLongitudeDeg);
}

/**
 * Earth-fixed -> ecliptic rotation matrix.
 * M = Rz(axisLon) * Ry(obliquity) * Rz(spin).
 */
export function earthMatrix(
  obliquityDeg: number,
  axisLongitudeDeg: number,
  spinDeg: number,
): Mat3 {
  return matMulAll(
    rotZ(axisLongitudeDeg * DEG),
    rotY(obliquityDeg * DEG),
    rotZ(spinDeg * DEG),
  );
}

/**
 * Geocentric Sun direction (unit) in the ecliptic frame at the given longitude.
 * Ecliptic XY is the orbital plane and +Z is ecliptic north, so this is (cos L, sin L, 0).
 */
export function sunDirEcliptic(sunLonDeg: number): V3 {
  const l = sunLonDeg * DEG;
  return [Math.cos(l), Math.sin(l), 0];
}

/** Solar declination, the Sun's angle above the equatorial plane. */
export function sunDeclinationDeg(
  obliquityDeg: number,
  axisLongitudeDeg: number,
  sunLonDeg: number,
): number {
  const n = northPole(obliquityDeg, axisLongitudeDeg);
  const s = sunDirEcliptic(sunLonDeg);
  return Math.asin(clamp(dot(n, s), -1, 1)) * RAD;
}

/**
 * Half the daylight arc in radians, from 0 for polar night to PI for polar day.
 */
export function sunriseHourAngleRad(latRad: number, decRad: number): number {
  // FLOOR suppresses the measured 1.4e-15 degree equinox residue at a pole.
  const FLOOR = 1e-12;
  if (Math.abs(Math.cos(latRad)) < 1e-9) {
    return Math.sin(latRad) * Math.sin(decRad) > FLOOR ? Math.PI : 0;
  }
  return Math.acos(clamp(-Math.tan(latRad) * Math.tan(decRad), -1, 1));
}

/** Convert a sunrise hour angle into daylight fraction and polar classification. */
export function classifyDaylight(H0: number): {
  fraction: number;
  polar: 'day' | 'night' | null;
} {
  // EDGE stabilizes polar labels at the floating-point boundary.
  const EDGE = 1e-9;
  if (H0 >= Math.PI - EDGE) return { fraction: 1, polar: 'day' };
  if (H0 <= EDGE) return { fraction: 0, polar: 'night' };
  return { fraction: H0 / Math.PI, polar: null };
}

/** Upper and lower culmination altitudes for latitude and declination in radians. */
export function culminationAltitudesDeg(
  latRad: number,
  decRad: number,
): { upperDeg: number; lowerDeg: number } {
  const a = Math.sin(latRad) * Math.sin(decRad);
  const b = Math.cos(latRad) * Math.cos(decRad);
  return {
    upperDeg: Math.asin(clamp(a + b, -1, 1)) * RAD,
    lowerDeg: Math.asin(clamp(a - b, -1, 1)) * RAD,
  };
}

/** Declination for a date, optionally using an unwrapped across-orbit axis phase. */
export function declinationForDay(
  config: RotationConfig,
  dayOfYear: number,
  axisPhaseLonDeg?: number,
): number {
  const sunLon = sunLongitudeDeg(dayOfYear);
  const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(config, sunLon, axisPhaseLonDeg);
  return sunDeclinationDeg(obliquityDeg, axisLongitudeDeg, sunLon);
}

/**
 * Spin-independent Sun angle around the rotation axis.
 * Earth-fixed Sun longitude is `raSunDeg(...) - spin`.
 */
export function raSunDeg(
  obliquityDeg: number,
  axisLongitudeDeg: number,
  sunLonDeg: number,
): number {
  const d = (sunLonDeg - axisLongitudeDeg) * DEG;
  const e = obliquityDeg * DEG;
  return Math.atan2(Math.sin(d), Math.cos(e) * Math.cos(d)) * RAD;
}

/**
 * Spin angle at local solar noon. `axisPhaseLonDeg` may provide unwrapped phase,
 * and `axis` may provide already-computed axis parameters.
 */
export function noonSpinDeg(
  config: RotationConfig,
  dayOfYear: number,
  lonDeg: number,
  axisPhaseLonDeg?: number,
  /** The axis at this instant, when the caller has already worked it out. */
  axis?: AxisParams,
): number {
  const sunLon = sunLongitudeDeg(dayOfYear);
  const { obliquityDeg, axisLongitudeDeg } = axis ?? axisParamsAt(config, sunLon, axisPhaseLonDeg);
  return raSunDeg(obliquityDeg, axisLongitudeDeg, sunLon) - lonDeg;
}
