import { describe, expect, it } from 'vitest';
import { glitterStrength } from './skyview';

describe('the Sun glitter path on water', () => {
  it('goes out when the Sun sets', () => {
    // Reflected glitter must vanish with the Sun at the -3 degree setting threshold.
    for (const belowHorizon of [-3, -4, -10, -20, -45, -90]) {
      expect(glitterStrength(belowHorizon)).toBe(0);
    }
  });

  it('is brightest with the Sun low, and fades as it climbs', () => {
    // Low Sun produces a long, strong reflection path.
    const low = glitterStrength(8);
    expect(low).toBeGreaterThan(glitterStrength(30));
    expect(glitterStrength(30)).toBeGreaterThan(glitterStrength(60));
    expect(low).toBeGreaterThan(0.9);
  });

  it('dies away smoothly rather than switching off', () => {
    // Quarter-degree samples peak near 0.09; a hard cutoff at -3 degrees would jump 0.86.
    let previous = glitterStrength(-6);
    let worstJump = 0;
    for (let alt = -6; alt <= 90; alt += 0.25) {
      const v = glitterStrength(alt);
      worstJump = Math.max(worstJump, Math.abs(v - previous));
      previous = v;
    }
    expect(worstJump).toBeLessThan(0.15);
  });

  it('stays within bounds at every altitude', () => {
    for (let alt = -90; alt <= 90; alt += 0.5) {
      const v = glitterStrength(alt);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
