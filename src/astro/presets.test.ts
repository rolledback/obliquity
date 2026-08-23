import { describe, expect, it } from 'vitest';
import { YEAR_DAYS } from './calendar';
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

  it('spaces them a quarter of a year apart', () => {
    const days = NOTABLE_DATES.map((d) => d.dayOfYear);
    for (let i = 1; i < days.length; i++) {
      expect(days[i] - days[i - 1]).toBeCloseTo(YEAR_DAYS / 4, 9);
    }
  });
});
