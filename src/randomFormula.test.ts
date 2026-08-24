import { describe, expect, it } from 'vitest';
import { randomFormulaPair } from './randomFormula';
import { REALISTIC, accumulatedLonDeg, cloneConfig } from './astro/config';
import { compileFormula } from './astro/formula';
import { SMOOTH_POLE_STEP, declinationForDay, maxPoleStep } from './astro/orientation';
import { applyScenario } from './scenarios';

/** Deterministic generator so a failure can be reproduced exactly. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function configFor(tiltFormula: string, leanFormula: string) {
  const config = cloneConfig(REALISTIC);
  config.axisMode = 'formula';
  config.tiltFormula = tiltFormula;
  config.leanFormula = leanFormula;
  return config;
}

describe('random formula worlds', () => {
  const rolls = Array.from({ length: 120 }, (_, i) => randomFormulaPair(seeded(i + 1)));

  it('always compiles', () => {
    for (const roll of rolls) {
      expect(compileFormula(roll.tiltFormula).error).toBeNull();
      expect(compileFormula(roll.leanFormula).error).toBeNull();
    }
  });

  it('never jumps the Sun across the sky', () => {
    for (const roll of rolls) {
      const step = maxPoleStep(configFor(roll.tiltFormula, roll.leanFormula));
      expect(Number.isFinite(step)).toBe(true);
      expect(step).toBeLessThanOrEqual(SMOOTH_POLE_STEP);
    }
  });

  it('is always worth looking at', () => {
    for (const roll of rolls) {
      const config = configFor(roll.tiltFormula, roll.leanFormula);
      let lo = Infinity;
      let hi = -Infinity;
      for (let orbit = 0; orbit < 3; orbit += 1) {
        for (let day = 1; day <= 365; day += 11) {
          const dec = declinationForDay(config, day, accumulatedLonDeg(orbit, day));
          expect(Number.isFinite(dec)).toBe(true);
          lo = Math.min(lo, dec);
          hi = Math.max(hi, dec);
        }
      }
      expect(hi - lo).toBeGreaterThanOrEqual(30);
    }
  });

  it('rolls a different world each time', () => {
    const seen = new Set(rolls.map((r) => `${r.tiltFormula}|${r.leanFormula}`));
    expect(seen.size).toBeGreaterThan(110);
  });

  it('never changes the length of the day', () => {
    for (const roll of rolls) {
      const config = cloneConfig(REALISTIC);
      config.siteLatDeg = 47.6;
      config.siteLonDeg = -122.3;
      applyScenario(config, 'Random Formula');
      expect(config.rotationPeriodHours).toBe(REALISTIC.rotationPeriodHours);
      expect(config.prograde).toBe(REALISTIC.prograde);
      expect(config.spinFormula).toBe(REALISTIC.spinFormula);
      expect(roll.tiltFormula).not.toContain('spin');
    }
  });

  it('gives the scenario a fresh world on every selection', () => {
    const shapes = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const config = cloneConfig(REALISTIC);
      applyScenario(config, 'Random Formula');
      expect(config.axisMode).toBe('formula');
      shapes.add(`${config.tiltFormula}|${config.leanFormula}`);
    }
    expect(shapes.size).toBeGreaterThan(8);
  });
});

describe('the smoothness gate measures what it claims', () => {
  it('catches a world that hides between fixed orbital probes', () => {
    // A lean advancing a whole turn per probe reads as perfectly still to any fixed-
    // resolution orbital sample, while the pole really swings tens of degrees a day.
    const config = configFor('90', '518400*phase');
    expect(maxPoleStep(config)).toBeGreaterThan(SMOOTH_POLE_STEP);
  });

  it('looks beyond the first orbit', () => {
    // Calm through orbit zero and violent later, so a one-orbit check really would pass it.
    const config = configFor('23.4397', '90 + 3000*year*year');
    expect(maxPoleStep(config, 1)).toBeLessThanOrEqual(SMOOTH_POLE_STEP);
    expect(maxPoleStep(config)).toBeGreaterThan(SMOOTH_POLE_STEP);
  });

  it('holds the fallback world to the same bar', () => {
    const fallback = randomFormulaPair(() => Number.NaN);
    expect(compileFormula(fallback.tiltFormula).error).toBeNull();
    expect(compileFormula(fallback.leanFormula).error).toBeNull();
    expect(
      maxPoleStep(configFor(fallback.tiltFormula, fallback.leanFormula)),
    ).toBeLessThanOrEqual(SMOOTH_POLE_STEP);
  });
});
