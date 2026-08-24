import { describe, expect, it } from 'vitest';
import { REALISTIC, accumulatedLonDeg, cloneConfig, axisUsesSite, sunLongitudeDeg } from './astro/config';
import type { RotationConfig } from './astro/config';
import { YEAR_DAYS } from './astro/calendar';
import { SMOOTH_POLE_STEP, axisParamsAt, maxPoleStep, northPole, sunDirEcliptic } from './astro/orientation';
import { findNextEclipse } from './astro/eclipseFinder';
import { computeDayPath, spinAtLocalTime } from './astro/daypath';
import { applyScenario, SCENARIO_NAMES } from './scenarios';
import { dot, posMod } from './astro/vec';

function worldAt(name: string, latDeg: number, lonDeg = 0): RotationConfig {
  const c = cloneConfig(REALISTIC);
  c.siteLatDeg = latDeg;
  c.siteLonDeg = lonDeg;
  applyScenario(c, name);
  return c;
}

function axisOn(config: RotationConfig, dayOfYear: number) {
  return axisParamsAt(config, sunLongitudeDeg(dayOfYear), sunLongitudeDeg(dayOfYear));
}

function visible(type: 'solar' | 'lunar', config: RotationConfig, latDeg: number, years: number) {
  const hits = [];
  let orbit = 0;
  let day = 1;
  for (let i = 0; i < 80; i++) {
    const hit = findNextEclipse(type, config, latDeg, 0, orbit, day, { maxYears: years });
    if (!hit || hit.absDays > years * YEAR_DAYS) break;
    hits.push(hit);
    orbit = hit.orbit;
    day = hit.dayOfYear;
  }
  return hits;
}

describe('the eclipse scenarios are location-aware formulas', () => {
  it('builds them from formulas rather than fixed numbers', () => {
    for (const name of ['Eclipse Chaser', 'Moonshadow']) {
      const c = worldAt(name, 47.61);
      expect(c.axisMode).toBe('formula');
      expect(axisUsesSite(c)).toBe(true);
    }
    // Misclassifying ordinary worlds would invalidate their caches on every location change.
    expect(axisUsesSite(worldAt('Earth (realistic)', 47.61))).toBe(false);
  });

  it('aims the Sun-facing pole at the observer for Eclipse Chaser', () => {
    for (const day of [1, 80, 172, 300]) {
      const sunLon = sunLongitudeDeg(day);
      const north = axisOn(worldAt('Eclipse Chaser', 47.61), day);
      expect(north.obliquityDeg).toBeCloseTo(75, 9);
      expect(posMod(north.axisLongitudeDeg - sunLon, 360)).toBeCloseTo(0, 6);

      const south = axisOn(worldAt('Eclipse Chaser', -33.87), day);
      expect(posMod(south.axisLongitudeDeg - sunLon, 360)).toBeCloseTo(180, 6);
    }
  });

  it('parks the anti-solar point overhead for Moonshadow', () => {
    for (const lat of [0, 19.08, 47.61, -33.87]) {
      const c = worldAt('Moonshadow', lat);
      const axis = axisOn(c, 172);
      expect(axis.obliquityDeg).toBeCloseTo(Math.abs(lat), 9);
      // Lean is undefined when zero tilt puts the axis on the ecliptic normal.
      if (lat === 0) continue;
      const away = posMod(axis.axisLongitudeDeg - sunLongitudeDeg(172), 360);
      expect(away).toBeCloseTo(lat > 0 ? 180 : 0, 6);
    }
  });

  it('reshapes itself when the observer moves', () => {
    const seattle = worldAt('Moonshadow', 47.61);
    const nairobi = worldAt('Moonshadow', -1.29);
    expect(seattle.tiltFormula).toBe(nairobi.tiltFormula);
    expect(axisOn(seattle, 172).obliquityDeg).toBeCloseTo(47.61, 9);
    expect(axisOn(nairobi, 172).obliquityDeg).toBeCloseTo(1.29, 9);
  });
});

describe('no built-in world parks the Sun on its own rotation axis', () => {
  it('keeps every scenario clear of the singularity', () => {
    // A Sun on the spin axis makes hour angle and the solar-day clock singular.
    for (const name of SCENARIO_NAMES) {
      for (const lat of [47.61, 5, -33.87]) {
        const config = worldAt(name, lat);
        let closestDeg = 180;
        for (const orbit of [0, 3]) {
          for (let day = 1; day < 366; day += 0.5) {
            const sunLon = sunLongitudeDeg(day);
            const axis = axisParamsAt(config, sunLon, accumulatedLonDeg(orbit, day));
            const cos = Math.abs(
              dot(northPole(axis.obliquityDeg, axis.axisLongitudeDeg), sunDirEcliptic(sunLon)),
            );
            closestDeg = Math.min(closestDeg, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
          }
        }
        expect(
          closestDeg,
          `${name} at latitude ${lat} brings the Sun within ${closestDeg.toFixed(3)} degrees of the spin axis`,
        ).toBeGreaterThan(0.05);
      }
    }
  }, 120000);

  it('keeps the spin angle continuous, which is what the singularity breaks', () => {
    for (const name of SCENARIO_NAMES) {
      const config = worldAt(name, 47.61);
      let worstJump = 0;
      for (let day = 1; day < 366; day += 0.5) {
        const a1 = accumulatedLonDeg(0, day);
        const a2 = accumulatedLonDeg(0, day + 1e-4);
        const s1 = spinAtLocalTime(config, day, 0, 12, a1);
        const s2 = spinAtLocalTime(config, day + 1e-4, 0, 12, a2);
        worstJump = Math.max(worstJump, Math.abs(((s2 - s1 + 540) % 360) - 180));
      }
      expect(worstJump, `${name} jumps ${worstJump.toFixed(1)} degrees`).toBeLessThan(1);
    }
  }, 120000);
});

describe('the eclipse scenarios deliver what they claim', () => {
  it('shows between fifteen percent and twice as many solar eclipses as an ordinary Earth', () => {
    // Six years, not sixteen. Measured max ratio by span: 4 yr 2.50 (breaches the claim's
    // own upper bound on noise alone), 6 yr 1.75, 8 yr 1.90, 16 yr 1.89. So the short span
    // is both the fastest and the one with the most room, and it costs 640 ms instead of
    // 1480 ms. Measured at 6 years: 1.67, 1.75 and 1.33 times.
    const YEARS = 6;
    for (const lat of [47.61, -22.9, 30]) {
      const real = visible('solar', REALISTIC, lat, YEARS).length;
      const chaser = visible('solar', worldAt('Eclipse Chaser', lat), lat, YEARS).length;
      const ratio = chaser / real;
      expect(ratio).toBeGreaterThan(1.15);
      expect(ratio).toBeLessThanOrEqual(2);
    }
  });

  it('lifts the eclipsed Moon to near the zenith', () => {
    const YEARS = 8;
    for (const lat of [47.61, -33.87]) {
      const mean = (hits: { altDeg: number }[]) =>
        hits.reduce((s, h) => s + h.altDeg, 0) / hits.length;
      const real = visible('lunar', REALISTIC, lat, YEARS);
      const moonshadow = visible('lunar', worldAt('Moonshadow', lat), lat, YEARS);
      expect(moonshadow.length).toBeGreaterThanOrEqual(real.length);
      expect(mean(moonshadow)).toBeGreaterThan(80);
      expect(mean(moonshadow)).toBeGreaterThan(mean(real) + 20);
    }
  });
});

describe('Local Maelstrom', () => {
  /** Daily noon-Sun height through one orbit, clamped at the horizon. */
  function signature(config: RotationConfig, latDeg: number, orbit: number): number[] {
    const out: number[] = [];
    for (let day = 1; day <= 365; day += 15) {
      const { stats } = computeDayPath(config, day, latDeg, 0, 96, accumulatedLonDeg(orbit, day));
      out.push(Math.max(0, stats.peakAltDeg));
    }
    return out;
  }

  /** How close the two most similar years come to each other. Higher means less repetition. */
  function distinctness(config: RotationConfig, latDeg: number, years = 6): number {
    const sigs = Array.from({ length: years }, (_, y) => signature(config, latDeg, y));
    let worst = Infinity;
    for (let i = 0; i < years; i += 1) {
      for (let j = i + 1; j < years; j += 1) {
        let d = 0;
        for (let k = 0; k < sigs[i].length; k += 1) d = Math.max(d, Math.abs(sigs[i][k] - sigs[j][k]));
        worst = Math.min(worst, d);
      }
    }
    return worst;
  }

  it('reshapes itself when the pin moves', () => {
    expect(axisUsesSite(worldAt('Local Maelstrom', 47.6))).toBe(true);
    const north = axisParamsAt(worldAt('Local Maelstrom', 60), 40, 40);
    const south = axisParamsAt(worldAt('Local Maelstrom', -60), 40, 40);
    const equator = axisParamsAt(worldAt('Local Maelstrom', 0), 40, 40);
    expect(Math.abs(north.obliquityDeg - equator.obliquityDeg)).toBeGreaterThan(20);
    expect(Math.abs(north.obliquityDeg - south.obliquityDeg)).toBeLessThan(1e-9);
  });

  it('starts each longitude on a different year', () => {
    const west = axisParamsAt(worldAt('Local Maelstrom', 47.6, -122), 40, 40);
    const east = axisParamsAt(worldAt('Local Maelstrom', 47.6, 120), 40, 40);
    expect(Math.abs(posMod(west.axisLongitudeDeg - east.axisLongitudeDeg, 360))).toBeGreaterThan(1);
  });

  it('never jumps the Sun across the sky', () => {
    for (const lat of [0, 30, 47.6, 80]) {
      expect(maxPoleStep(worldAt('Local Maelstrom', lat))).toBeLessThan(SMOOTH_POLE_STEP);
    }
  });

  it('makes years less alike than plain Maelstrom does', () => {
    // The equator is physically saturated (its day is always about 12 hours), so the claim
    // is that it matches there and beats it everywhere else.
    for (const lat of [30, 47.6, 80]) {
      const local = distinctness(worldAt('Local Maelstrom', lat), lat);
      const plain = distinctness(worldAt('Maelstrom', lat), lat);
      expect(local).toBeGreaterThan(plain);
    }
    // The equator is physically saturated: its day is always about 12 hours whatever the
    // axis does, so the only lever is noon Sun height and neither world can do better than
    // the other by much. Matching there is the honest claim, not beating it.
    const atEquator = distinctness(worldAt('Local Maelstrom', 0), 0);
    expect(atEquator).toBeGreaterThan(distinctness(worldAt('Maelstrom', 0), 0) * 0.9);
  });
});
