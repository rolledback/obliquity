// Simulation configuration: the rotation parameters the user can change.
// The orbit (ecliptic plane and year length) is intentionally fixed.

import { formulaIsSecular } from './formula';
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
  /**
   * Spin-speed multiplier as a formula of orbital position (1 = the base rotation period
   * above). Lets the spin speed up, slow, pause, or reverse through the year or across
   * orbits. "1" is an ordinary constant spin. Independent of axisMode, so it combines
   * with any axis behaviour.
   */
  spinFormula: string;
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
};

export function defaultCustomConfig(): RotationConfig {
  return { ...REALISTIC };
}

export function cloneConfig(c: RotationConfig): RotationConfig {
  return { ...c };
}

// Cap on how many orbits a repeating cycle may span. The 0.1-step precession slider
// never needs more than 10; the cap also bounds work for any odd manual value.
const MAX_CYCLE_ORBITS = 12;

/**
 * How many whole orbits the configuration takes to repeat. A precessing axis returns
 * to the same orientation after the smallest number of orbits that makes its total
 * turn a whole number; every other configuration repeats every single orbit. Capped at
 * MAX_CYCLE_ORBITS (the 0.1-step slider never needs more than 10; any odd manual value
 * falls back to the cap and is treated as quasi-periodic).
 */
export function periodOrbits(config: RotationConfig): number {
  if (config.axisMode !== 'precession') return 1;
  const k = config.precessionTurnsPerYear;
  for (let p = 1; p <= MAX_CYCLE_ORBITS; p++) {
    if (Math.abs(k * p - Math.round(k * p)) < 1e-6) return p;
  }
  return MAX_CYCLE_ORBITS;
}

/**
 * True when the axis genuinely evolves from one orbit to the next beyond its repeat
 * period, i.e. a formula-mode world whose tilt or lean reads year, t, or orbit. Such a
 * world is aperiodic, so the seasonal caches (year heatmap, climate curve, felt warmth)
 * must be rebuilt for the orbit on display instead of reusing orbit 0. Every other mode
 * is fully captured by periodOrbits and returns false.
 */
export function axisIsSecular(config: RotationConfig): boolean {
  if (config.axisMode !== 'formula') return false;
  return formulaIsSecular(config.tiltFormula) || formulaIsSecular(config.leanFormula);
}

/**
 * A cache key over only the axis-orientation fields. The Sun's declination, the season
 * cycle, and the mean right-ascension rate all depend on how the axis is oriented but
 * not on how fast or which way the planet spins, so keying on these fields alone keeps
 * those caches warm while the spin sliders move.
 */
export function axisConfigKey(config: RotationConfig): string {
  // Join with NUL, which cannot appear in the numeric fields or in a formula typed into a
  // text input, so a tilt/lean formula that happens to contain the old "|" delimiter can no
  // longer collide two genuinely different configs onto the same cache key.
  return [
    config.axisMode,
    config.obliquityDeg,
    config.axisLongitudeDeg,
    config.precessionTurnsPerYear,
    config.obliquityAmplitudeDeg,
    config.rollAmplitudeDeg,
    config.tiltFormula,
    config.leanFormula,
  ].join('\u0000');
}

/**
 * The Sun's ecliptic longitude accumulated across whole elapsed orbits. The Sun's
 * direction is periodic, but a steadily precessing axis is driven by this ever-growing
 * angle, which is what makes each orbit's seasons differ. Orbit 0 gives the ordinary
 * within-year longitude.
 */
export function accumulatedLonDeg(orbit: number, dayOfYear: number): number {
  return orbit * 360 + sunLongitudeDeg(dayOfYear);
}
