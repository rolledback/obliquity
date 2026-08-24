import { describe, expect, it } from 'vitest';
import {
  ANOMALISTIC_MONTH_DAYS,
  DRACONIC_MONTH_DAYS,
  MOON_RADIUS_KM,
  SIDEREAL_MONTH_DAYS,
  moonPositionKm,
  moonStateAt,
  phaseGlyph,
} from './moon';
import { YEAR_DAYS } from './calendar';
import { RAD, norm } from './vec';

/** Ecliptic latitude of the Moon in degrees at an absolute day. */
function eclipticLatDeg(absDays: number): number {
  const p = moonPositionKm(absDays);
  return Math.asin(p[2] / norm(p)) * RAD;
}

/** Ecliptic longitude of the Moon in degrees (0..360) at an absolute day. */
function eclipticLonDeg(absDays: number): number {
  const p = moonPositionKm(absDays);
  return ((Math.atan2(p[1], p[0]) * RAD) % 360 + 360) % 360;
}

/** Refine a sign change of `f` between a and b to a root, by bisection. */
function bisect(f: (t: number) => number, a: number, b: number): number {
  let lo = a;
  let hi = b;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(f(mid)) === Math.sign(f(lo))) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe('lunar orbit geometry', () => {
  it('keeps the Moon within the expected distance range', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let t = 0; t < 2000; t += 0.05) {
      const d = norm(moonPositionKm(t));
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    // Perturbed orbit, so this brackets the REAL Moon (356500 to 406700 km).
    // A pure Kepler ellipse never comes nearer than 363296 and fails the first bound.
    expect(min).toBeGreaterThan(355000);
    expect(min).toBeLessThan(358000);
    expect(max).toBeGreaterThan(404000);
    expect(max).toBeLessThan(408000);
  });

  it('stays within the orbital inclination of the ecliptic', () => {
    let maxAbsLat = 0;
    for (let t = 0; t < 4000; t += 0.05) {
      maxAbsLat = Math.max(maxAbsLat, Math.abs(eclipticLatDeg(t)));
    }
    // The orbit is inclined 5.145 deg, and the model has no other latitude terms.
    expect(maxAbsLat).toBeGreaterThan(5.0);
    expect(maxAbsLat).toBeLessThan(5.2);
  });

  it('returns to the same ecliptic longitude after one sidereal month', () => {
    for (const t0 of [0, 100.5, 900.25]) {
      const a = eclipticLonDeg(t0);
      const b = eclipticLonDeg(t0 + SIDEREAL_MONTH_DAYS);
      // Within a couple of degrees: the node and apse have crept slightly in a month.
      const diff = Math.abs(((b - a + 540) % 360) - 180);
      expect(diff).toBeLessThan(2.5);
    }
  });
});

describe('derived precession rates', () => {
  // Measure precession from positions because the model derives it from the three months.

  it('regresses the line of nodes once per ~18.6 years', () => {
    // Track the ecliptic longitude at successive ascending-node crossings.
    const crossings: { t: number; lon: number }[] = [];
    let prev = eclipticLatDeg(0);
    for (let t = 0.1; t < 365.25 * 12; t += 0.1) {
      const cur = eclipticLatDeg(t);
      if (prev < 0 && cur >= 0) {
        const root = bisect(eclipticLatDeg, t - 0.1, t);
        crossings.push({ t: root, lon: eclipticLonDeg(root) });
      }
      prev = cur;
    }
    expect(crossings.length).toBeGreaterThan(150);

    // Unwrap the node longitude and fit its drift per day.
    let unwrapped = crossings[0].lon;
    let total = 0;
    for (let i = 1; i < crossings.length; i++) {
      const step = ((crossings[i].lon - unwrapped + 540) % 360) - 180;
      unwrapped += step;
      total += step;
    }
    const span = crossings[crossings.length - 1].t - crossings[0].t;
    const degPerDay = total / span;
    expect(degPerDay).toBeLessThan(0); // retrograde: the nodes regress
    const periodYears = 360 / Math.abs(degPerDay) / 365.25;
    expect(periodYears).toBeGreaterThan(18.2);
    expect(periodYears).toBeLessThan(19.0);
  });

  it('advances the line of apsides once per ~8.85 years', () => {
    // Perigee passages: local minima of the distance.
    const perigees: { t: number; lon: number }[] = [];
    for (let t = 1; t < 365.25 * 12; t += 0.5) {
      const a = norm(moonPositionKm(t - 0.5));
      const b = norm(moonPositionKm(t));
      const c = norm(moonPositionKm(t + 0.5));
      if (b < a && b < c) perigees.push({ t, lon: eclipticLonDeg(t) });
    }
    expect(perigees.length).toBeGreaterThan(140);

    let unwrapped = perigees[0].lon;
    let total = 0;
    for (let i = 1; i < perigees.length; i++) {
      const step = ((perigees[i].lon - unwrapped + 540) % 360) - 180;
      unwrapped += step;
      total += step;
    }
    const span = perigees[perigees.length - 1].t - perigees[0].t;
    const degPerDay = total / span;
    expect(degPerDay).toBeGreaterThan(0); // prograde: the apse advances
    const periodYears = 360 / degPerDay / 365.25;
    expect(periodYears).toBeGreaterThan(8.4);
    expect(periodYears).toBeLessThan(9.3);
  });

  it('has the three months ordered as the real Moon does', () => {
    expect(DRACONIC_MONTH_DAYS).toBeLessThan(SIDEREAL_MONTH_DAYS);
    expect(SIDEREAL_MONTH_DAYS).toBeLessThan(ANOMALISTIC_MONTH_DAYS);
  });
});

describe('phase', () => {
  it('produces a synodic month of about 29.53 days', () => {
    // New moons are minima of the elongation; find successive ones and average the gap.
    const news: number[] = [];
    for (let t = 1; t < 3000; t += 0.25) {
      const a = moonStateAt(t - 0.25).elongationDeg;
      const b = moonStateAt(t).elongationDeg;
      const c = moonStateAt(t + 0.25).elongationDeg;
      if (b < a && b < c) news.push(t);
    }
    expect(news.length).toBeGreaterThan(90);
    const mean = (news[news.length - 1] - news[0]) / (news.length - 1);
    // Emerges from the sidereal month beating against the fixed one-year orbit.
    expect(mean).toBeGreaterThan(29.4);
    expect(mean).toBeLessThan(29.7);
  });

  it('is full when opposite the Sun and new when in line with it', () => {
    // The orbit is inclined, so the Moon rarely reaches a full 180 degrees of elongation.
    // Take the widest and narrowest it actually gets, and check the lit fraction there.
    let widest = { elong: -1, lit: 0 };
    let narrowest = { elong: 999, lit: 0 };
    for (let t = 0; t < 400; t += 0.01) {
      const m = moonStateAt(t);
      if (m.elongationDeg > widest.elong) widest = { elong: m.elongationDeg, lit: m.illuminated };
      if (m.elongationDeg < narrowest.elong) narrowest = { elong: m.elongationDeg, lit: m.illuminated };
    }
    expect(widest.elong).toBeGreaterThan(175);
    expect(widest.lit).toBeGreaterThan(0.998);
    expect(narrowest.elong).toBeLessThan(5);
    expect(narrowest.lit).toBeLessThan(0.002);
  });

  it('ties the illuminated fraction to the phase angle', () => {
    for (let t = 0; t < 200; t += 0.7) {
      const m = moonStateAt(t);
      const expected = (1 + Math.cos((m.phaseAngleDeg * Math.PI) / 180)) / 2;
      expect(m.illuminated).toBeCloseTo(expected, 12);
      // Phase angle and elongation are near-supplementary (the Sun is far away).
      expect(m.phaseAngleDeg + m.elongationDeg).toBeGreaterThan(179);
      expect(m.phaseAngleDeg + m.elongationDeg).toBeLessThan(181);
    }
  });

  it('waxes from new to full and wanes from full to new', () => {
    // Sample both rising and falling illumination over two synodic months.
    let prev = moonStateAt(0);
    let grew = 0;
    let shrank = 0;
    for (let t = 0.5; t < 60; t += 0.5) {
      const cur = moonStateAt(t);
      const rising = cur.illuminated > prev.illuminated;
      // Skip the turning points where the direction legitimately flips mid-step.
      if (Math.abs(cur.illuminated - prev.illuminated) > 0.01) {
        if (rising) {
          expect(cur.waxing).toBe(true);
          grew++;
        } else {
          expect(cur.waxing).toBe(false);
          shrank++;
        }
      }
      prev = cur;
    }
    expect(grew).toBeGreaterThan(10);
    expect(shrank).toBeGreaterThan(10);
  });

  it('picks the right glyph for each phase', () => {
    // Test the displayed glyphs in waxing and waning order.
    expect(phaseGlyph(0.0, true)).toBe('\u{1F311}'); // new
    expect(phaseGlyph(1.0, false)).toBe('\u{1F315}'); // full
    expect(phaseGlyph(0.5, true)).toBe('\u{1F313}'); // first quarter
    expect(phaseGlyph(0.5, false)).toBe('\u{1F317}'); // last quarter
    expect(phaseGlyph(0.25, true)).toBe('\u{1F312}');
    expect(phaseGlyph(0.25, false)).toBe('\u{1F318}');
    expect(phaseGlyph(0.8, true)).toBe('\u{1F314}');
    expect(phaseGlyph(0.8, false)).toBe('\u{1F316}');
    // Every phase must map to a distinct glyph.
    const seen = new Set([
      phaseGlyph(0, true), phaseGlyph(0.25, true), phaseGlyph(0.5, true), phaseGlyph(0.8, true),
      phaseGlyph(1, true), phaseGlyph(0.8, false), phaseGlyph(0.5, false), phaseGlyph(0.25, false),
    ]);
    expect(seen.size).toBe(8);
  });
});

describe('apparent size', () => {
  it('spans roughly half a degree, larger at perigee', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let t = 0; t < 500; t += 0.05) {
      const d = moonStateAt(t).angularRadiusDeg * 2;
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    expect(min).toBeGreaterThan(0.46);
    expect(max).toBeLessThan(0.56);
    expect(max).toBeGreaterThan(min);
  });

  it('uses a physically sane radius and year length', () => {
    expect(MOON_RADIUS_KM).toBeCloseTo(1737.4, 5);
    expect(YEAR_DAYS).toBeCloseTo(365.25, 5);
  });
});
