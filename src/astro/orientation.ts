// Earth orientation: how the rotation axis is oriented in the ecliptic frame, and
// the full earth-fixed -> ecliptic rotation matrix including spin.
//
// Frame convention (ecliptic / world):
//   - Sun-centered, ecliptic plane = XY, Z = ecliptic north pole.
//   - Sun direction (geocentric, unit) at longitude L = (cos L, sin L, 0).
//
// North pole direction for obliquity E and lean longitude A:
//   n = (sin E cos A, sin E sin A, cos E)
// Realistic Earth uses A = 90 deg so the north pole leans toward the Sun at the
// June solstice (L = 90), producing northern summer.

import { sunLongitudeDeg } from './config';
import type { RotationConfig } from './config';
import { compileFormula, formulaVars } from './formula';
import { DEG, RAD, clamp, dot, matMulAll, posMod, rotY, rotZ } from './vec';
import type { Mat3, V3 } from './vec';

interface AxisParams {
  obliquityDeg: number;
  axisLongitudeDeg: number;
}

/**
 * Effective axis parameters at a given orbital position. For modes that depend on
 * where the Earth is in its orbit, this varies with the Sun's longitude.
 *
 * `sunLonDeg` is the Sun's longitude this orbit (it drives the Sun-relative modes).
 * `axisPhaseLonDeg` is the longitude that drives the axis's own secular evolution; for
 * a steadily precessing axis it is the longitude ACCUMULATED across orbits, so the
 * lean direction keeps turning lap after lap instead of resetting each year. It
 * defaults to `sunLonDeg`, which makes every orbit identical (the periodic model) and
 * matches the result for any non-precessing or whole-number-precession configuration.
 */
export function axisParamsAt(
  config: RotationConfig,
  sunLonDeg: number,
  axisPhaseLonDeg: number = sunLonDeg,
): AxisParams {
  const base = config.axisLongitudeDeg;
  switch (config.axisMode) {
    case 'leanToSun':
      // Lean direction tracks the Sun: perpetual northern summer.
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
      // Tilt and lean come straight from the user's expressions. Both formulas see the
      // same variables, derived from the within-orbit Sun longitude and the accumulated
      // axis phase, so a formula that uses `year`/`t` keeps evolving lap after lap.
      const vars = formulaVars(sunLonDeg, axisPhaseLonDeg);
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
 * The largest sudden jump in the north-pole direction over one orbit: the maximum change
 * in the unit pole vector between densely sampled adjacent points, following the actual
 * trajectory the simulation walks. Near zero means the axis glides smoothly (so the Sun
 * does too); a large value means the formula teleports the pole somewhere in the year.
 *
 * The samples advance a continuous phase u across one orbit and into the seam of the next
 * (sunLon wraps with posMod while the accumulated axisPhase keeps climbing), so a secular
 * formula whose year keeps rising is correctly seen as smooth, while a periodic formula
 * that fails to close on a whole turn at the year boundary is correctly seen to jump. It
 * is a pure property of the formula, so it stays consistent with the charts that evaluate
 * arbitrary phases. Used only to warn, never to block.
 */
export function maxPoleStep(config: RotationConfig): number {
  const N = 1440; // quarter-degree resolution around the orbit
  const poles: V3[] = new Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * 360; // accumulated longitude: 0 .. 360 (the seam at i = N)
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
 * Maps earth-fixed +Z (north pole) to the lean direction, then spins the prime
 * meridian about that axis by `spinDeg`.
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

/** Geocentric Sun direction (unit) in the ecliptic frame at the given longitude. */
export function sunDirEcliptic(sunLonDeg: number): V3 {
  const l = sunLonDeg * DEG;
  return [Math.cos(l), Math.sin(l), 0];
}

/**
 * Solar declination: the angle of the Sun above the Earth's equatorial plane.
 * sin(dec) = n . sunDir. Determines how high the Sun can climb at local noon.
 */
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
 * Sunrise hour angle (radians): half the angular length of the daylight arc. Returns 0 on
 * a polar-night day (the Sun never rises) and PI on a polar-day day (it never sets); in
 * between it is acos(-tan(lat) tan(dec)). This is the one place the daylight geometry
 * lives, so the day chart, the year heatmap, and the insolation model all agree.
 */
export function sunriseHourAngleRad(latRad: number, decRad: number): number {
  // At a pole the Sun's altitude is constant all day and equals the declination, so there
  // is daylight only when the Sun is strictly above the horizon (sin(lat) and sin(dec) the
  // same sign). Exactly on the horizon (dec = 0) counts as no daylight, i.e. polar night.
  if (Math.abs(Math.cos(latRad)) < 1e-9) {
    return Math.sin(latRad) * Math.sin(decRad) > 0 ? Math.PI : 0;
  }
  return Math.acos(clamp(-Math.tan(latRad) * Math.tan(decRad), -1, 1));
}

/**
 * Turn a sunrise hour angle into a daylight fraction (0..1) and a polar classification, so
 * the day chart and the year heatmap read the same H0 the same way. `polar` is 'day' when
 * the Sun never sets, 'night' when it never rises, and null for an ordinary day.
 */
export function classifyDaylight(H0: number): {
  fraction: number;
  polar: 'day' | 'night' | null;
} {
  if (H0 >= Math.PI) return { fraction: 1, polar: 'day' };
  if (H0 <= 0) return { fraction: 0, polar: 'night' };
  return { fraction: H0 / Math.PI, polar: null };
}

/**
 * The Sun's altitude (degrees) at upper culmination (local noon) and lower culmination
 * (local midnight) for a latitude and solar declination, both in radians.
 */
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

/**
 * Convenience: declination directly from a config and day-of-year. `axisPhaseLonDeg`
 * optionally supplies the accumulated-across-orbits longitude that drives a precessing
 * axis; when omitted the within-year longitude is used, i.e. every orbit is identical.
 */
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
 * The Sun's azimuthal angle around the rotation axis, in the earth-fixed frame
 * (its "right ascension" measured from the prime meridian's reference). With the
 * earth matrix M = Rz(A) Ry(E) Rz(spin), the Sun's earth-fixed longitude works out
 * to `raSunDeg(...) - spin`, so this is the spin-independent part.
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
 * Spin angle (degrees) at which the given observer longitude is at local solar
 * noon (the Sun crosses the observer's meridian). Derived from
 * `sunEarthFixedLongitude = raSunDeg - spin`, set equal to the observer longitude.
 * `axisPhaseLonDeg` optionally supplies the accumulated-across-orbits longitude for a
 * precessing axis; omitting it keeps the periodic (every orbit identical) behaviour.
 */
export function noonSpinDeg(
  config: RotationConfig,
  dayOfYear: number,
  lonDeg: number,
  axisPhaseLonDeg?: number,
): number {
  const sunLon = sunLongitudeDeg(dayOfYear);
  const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(config, sunLon, axisPhaseLonDeg);
  return raSunDeg(obliquityDeg, axisLongitudeDeg, sunLon) - lonDeg;
}
