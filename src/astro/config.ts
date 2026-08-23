import { SITE_VARS, compileFormula, formulaIsSecular } from './formula';
import { sunLongitudeDeg } from './calendar';

export { YEAR_DAYS, YEAR_HOURS } from './calendar';
export { sunLongitudeDeg };

export type AxisMode =
  | 'fixed' // realistic: rotation axis is fixed in inertial space
  | 'leanToSun' // north pole always leans toward the Sun
  | 'leanFromSun' // north pole always leans away from the Sun
  | 'precession' // axis lean direction precesses around the year
  | 'obliquityWave' // obliquity oscillates through the year
  | 'rollWave' // axis lean direction nods back and forth (libration)
  | 'formula'; // tilt and lean are driven by user-written formulas

export const AXIS_MODE_LABELS: Record<AxisMode, string> = {
  fixed: 'Fixed in space (realistic)',
  leanToSun: 'Always lean toward Sun',
  leanFromSun: 'Always lean away from Sun',
  precession: 'Precession (spinning axis)',
  obliquityWave: 'Obliquity oscillation',
  rollWave: 'Axis nodding (libration)',
  formula: 'Formula (write your own)',
};

export interface RotationConfig {
  /** Base axial tilt: angle between the rotation axis and the ecliptic normal (degrees). */
  obliquityDeg: number;
  /** Base ecliptic longitude the north pole leans toward (degrees). Controls season phase. */
  axisLongitudeDeg: number;
  /** Sidereal rotation period in hours (time to spin 360 deg relative to the stars). */
  rotationPeriodHours: number;
  /** Spin direction. true = prograde (counterclockwise from ecliptic north). */
  prograde: boolean;
  /** How the axis orientation varies with orbital position. */
  axisMode: AxisMode;
  /** precession mode: how many full turns of the lean direction per year. */
  precessionTurnsPerYear: number;
  /** obliquityWave mode: amplitude of the obliquity oscillation (degrees). */
  obliquityAmplitudeDeg: number;
  /** rollWave mode: amplitude of the lean-direction nodding (degrees). */
  rollAmplitudeDeg: number;
  /** formula mode: expression for the axial tilt in degrees. */
  tiltFormula: string;
  /** formula mode: expression for the axis lean direction in degrees. */
  leanFormula: string;
  /** Spin-speed multiplier formula, independent of axisMode. */
  spinFormula: string;
  /** Observer latitude for formulas using `lat`, in degrees north. */
  siteLatDeg: number;
  /** Observer longitude for formulas using `site`, in degrees east. */
  siteLonDeg: number;
}

// Earth's true values, used for the fixed "realistic" reference.
const EARTH_OBLIQUITY_DEG = 23.4397;
export const EARTH_SIDEREAL_DAY_HOURS = 23.9344696;

export const REALISTIC: RotationConfig = {
  obliquityDeg: EARTH_OBLIQUITY_DEG,
  axisLongitudeDeg: 90,
  rotationPeriodHours: EARTH_SIDEREAL_DAY_HOURS,
  prograde: true,
  axisMode: 'fixed',
  precessionTurnsPerYear: 0,
  obliquityAmplitudeDeg: 0,
  rollAmplitudeDeg: 0,
  // Defaults reproduce realistic Earth, so switching to formula mode starts sane.
  tiltFormula: '23.4397',
  leanFormula: '90',
  spinFormula: '1',
  siteLatDeg: 0,
  siteLonDeg: 0,
};

export function defaultCustomConfig(): RotationConfig {
  return { ...REALISTIC };
}

export function cloneConfig(c: RotationConfig): RotationConfig {
  return { ...c };
}

// The 0.1-step precession slider needs at most 10 orbits.
const MAX_CYCLE_ORBITS = 12;

/**
 * Bounded orbit span for axis-cycle calculations.
 * Precession uses its repeat period when found within MAX_CYCLE_ORBITS.
 */
export function periodOrbits(config: RotationConfig): number {
  if (config.axisMode !== 'precession') return 1;
  const k = config.precessionTurnsPerYear;
  for (let p = 1; p <= MAX_CYCLE_ORBITS; p++) {
    if (Math.abs(k * p - Math.round(k * p)) < 1e-6) return p;
  }
  return MAX_CYCLE_ORBITS;
}

/** Whether an axis formula references an across-orbit variable. */
export function axisIsSecular(config: RotationConfig): boolean {
  if (config.axisMode !== 'formula') return false;
  return formulaIsSecular(config.tiltFormula) || formulaIsSecular(config.leanFormula);
}

/** Whether an axis formula references the observer's location. */
export function axisUsesSite(config: RotationConfig): boolean {
  if (config.axisMode !== 'formula') return false;
  return [config.tiltFormula, config.leanFormula].some(readsSite);
}

/** Whether a formula source mentions where the observer is standing. */
function readsSite(src: string): boolean {
  const { refs } = compileFormula(src);
  return SITE_VARS.some((v) => refs.has(v));
}

/** Cache key for spin rate, direction, and any location dependency. */
export function spinConfigKey(config: RotationConfig): string {
  return [
    config.rotationPeriodHours,
    config.prograde,
    config.spinFormula,
    // Location affects only formulas that reference it.
    readsSite(config.spinFormula) ? `${config.siteLatDeg},${config.siteLonDeg}` : '',
  ].join('\u0000');
}

/** Axis-orientation cache key, deliberately excluding spin fields. */
export function axisConfigKey(config: RotationConfig): string {
  // NUL avoids delimiter collisions with formula text.
  return [
    config.axisMode,
    config.obliquityDeg,
    config.axisLongitudeDeg,
    config.precessionTurnsPerYear,
    config.obliquityAmplitudeDeg,
    config.rollAmplitudeDeg,
    config.tiltFormula,
    config.leanFormula,
    // Location affects only formulas that reference it.
    axisUsesSite(config) ? `${config.siteLatDeg},${config.siteLonDeg}` : '',
  ].join('\u0000');
}

/** Unwrapped Sun longitude used to evolve axes across orbits. */
export function accumulatedLonDeg(orbit: number, dayOfYear: number): number {
  return orbit * 360 + sunLongitudeDeg(dayOfYear);
}
