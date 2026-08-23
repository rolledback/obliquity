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
 * Largest adjacent north-pole step over one sampled orbit, including the seam
 * into the next orbit. Used only as a discontinuity warning.
 */
export function maxPoleStep(config: RotationConfig): number {
  const N = 1440; // Quarter-degree orbital resolution.
  const poles: V3[] = new Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * 360;
    const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(config, posMod(u, 360), u);
    poles[i] = northPole(obliquityDeg, axisLongitudeDeg);
  }
  let maxStep = 0;
  for (let i = 0; i < N; i++) {
    const a = poles[i];
    const b = poles[i + 1];
    const step = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (step > maxStep) maxStep = step;
  }
  return maxStep;
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
