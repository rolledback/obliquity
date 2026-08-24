import { describe, expect, it } from 'vitest';
import { REALISTIC } from './config';
import { declinationForDay } from './orientation';
import { NOTABLE_DATES } from './presets';

describe('the named seasonal dates name the geometry they describe', () => {
  it('puts both equinoxes on the equator and both solstices at the extremes', () => {
    const dec = (name: string) =>
      declinationForDay(REALISTIC, NOTABLE_DATES.find((d) => d.name === name)!.dayOfYear);
    expect(Math.abs(dec('March equinox'))).toBeLessThan(1e-9);
    expect(Math.abs(dec('September equinox'))).toBeLessThan(1e-9);
    expect(dec('June solstice')).toBeCloseTo(REALISTIC.obliquityDeg, 6);
    expect(dec('December solstice')).toBeCloseTo(-REALISTIC.obliquityDeg, 6);
  });

  it('spaces them by the real, unequal season lengths', () => {
    // A quarter turn of longitude is not a quarter of a year: the orbit is an ellipse and
    // the Earth runs fastest near perihelion in January. A circular orbit gives 91.31 each.
    const days = NOTABLE_DATES.map((d) => d.dayOfYear);
    const gaps = [92.76, 93.65, 89.84];
    for (let i = 1; i < days.length; i++) {
      expect(days[i] - days[i - 1]).toBeCloseTo(gaps[i - 1], 1);
    }
  });
});
