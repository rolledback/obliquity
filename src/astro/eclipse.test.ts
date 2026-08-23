import { describe, expect, it } from 'vitest';
import {
  lunarEclipseAt,
  solarEclipseAt,
  solarEclipsePossible,
  solarShadowAxisPointKm,
} from './eclipse';
import { EARTH_RADIUS_KM, moonStateAt } from './moon';
import { REALISTIC } from './config';
import { earthMatrix } from './orientation';
import { RAD, matVec, norm, transpose } from './vec';
import type { Mat3, V3 } from './vec';

/** Geographic coordinates beneath an ecliptic-frame point. */
function subPoint(M: Mat3, p: V3): { lat: number; lon: number } {
  const f = matVec(transpose(M), p);
  const r = norm(f);
  return { lat: (Math.asin(f[2] / r) * RAD), lon: Math.atan2(f[1], f[0]) * RAD };
}

/** Group ascending times into events, splitting whenever there is a gap of > `gap` days. */
function groupEvents(times: number[], gap: number): number[][] {
  const groups: number[][] = [];
  for (const t of times) {
    const last = groups[groups.length - 1];
    if (!last || t - last[last.length - 1] > gap) groups.push([t]);
    else last.push(t);
  }
  return groups;
}

const SPAN_YEARS = 20;
const SPAN_DAYS = 365.25 * SPAN_YEARS;
const STEP = 0.04; // ~1 hour; an eclipse window lasts several hours

// Five tests below need a census of the same 20 years. Sweeping once and sharing the
// result keeps them separate, each failing on its own terms, without paying for the sweep
// five times: the orbit is fixed, so these are constants of the model, not of any test.
let solarTimesCache: number[] | null = null;
let lunarKindsCache: { t: number; kind: string }[] | null = null;

/** Times that pass the conservative global solar-eclipse filter. */
function solarEclipseTimes(): number[] {
  if (!solarTimesCache) {
    const hits: number[] = [];
    for (let t = 0; t < SPAN_DAYS; t += STEP) {
      if (solarEclipsePossible(moonStateAt(t))) hits.push(t);
    }
    solarTimesCache = hits;
  }
  return solarTimesCache;
}

/** Every sampled instant at which the Moon is in shadow at all, with the kind. */
function lunarKinds(): { t: number; kind: string }[] {
  if (!lunarKindsCache) {
    const hits: { t: number; kind: string }[] = [];
    for (let t = 0; t < SPAN_DAYS; t += STEP) {
      const kind = lunarEclipseAt(moonStateAt(t)).kind;
      if (kind !== 'none') hits.push({ t, kind });
    }
    lunarKindsCache = hits;
  }
  return lunarKindsCache;
}

/** Times at which the Moon is inside Earth's umbra (a partial or total lunar eclipse). */
function umbralLunarTimes(): number[] {
  return lunarKinds().filter((h) => h.kind === 'partial' || h.kind === 'total').map((h) => h.t);
}

describe('eclipse alignment', () => {
  it('only allows solar eclipses at new moon', () => {
    for (let t = 0; t < 2000; t += 0.05) {
      const m = moonStateAt(t);
      if (solarEclipsePossible(m)) {
        expect(m.elongationDeg).toBeLessThan(2);
        expect(m.illuminated).toBeLessThan(0.005);
      }
    }
  });

  it('only allows lunar eclipses at full moon', () => {
    for (let t = 0; t < 2000; t += 0.05) {
      const m = moonStateAt(t);
      if (lunarEclipseAt(m).kind !== 'none') {
        expect(m.elongationDeg).toBeGreaterThan(177);
        expect(m.illuminated).toBeGreaterThan(0.99);
      }
    }
  });

  it('requires the Moon to be near a node, not merely at syzygy', () => {
    // Most new moons pass well above or below the Sun, which is exactly why there is not
    // an eclipse every month. Count how many new moons actually produce one.
    let newMoons = 0;
    let eclipsing = 0;
    for (let t = 1; t < 365.25 * 10; t += 0.25) {
      const a = moonStateAt(t - 0.25).elongationDeg;
      const b = moonStateAt(t).elongationDeg;
      const c = moonStateAt(t + 0.25).elongationDeg;
      if (b < a && b < c) {
        newMoons++;
        // Search the hours around this new moon for an eclipse.
        let found = false;
        for (let s = t - 0.6; s <= t + 0.6; s += 0.02) {
          if (solarEclipsePossible(moonStateAt(s))) found = true;
        }
        if (found) eclipsing++;
      }
    }
    expect(newMoons).toBeGreaterThan(110);
    // Roughly a fifth of new moons fall close enough to a node.
    expect(eclipsing / newMoons).toBeGreaterThan(0.1);
    expect(eclipsing / newMoons).toBeLessThan(0.45);
  });
});

describe('eclipse frequency', () => {
  it('produces a realistic number of solar eclipses per year', () => {
    const events = groupEvents(solarEclipseTimes(), 5);
    const perYear = events.length / SPAN_YEARS;
    // Reality averages about 2.4 solar eclipses a year, never fewer than 2 nor more than 5.
    expect(perYear).toBeGreaterThan(1.7);
    expect(perYear).toBeLessThan(3.2);
  });

  it('produces a realistic number of umbral lunar eclipses per year', () => {
    const events = groupEvents(umbralLunarTimes(), 5);
    const perYear = events.length / SPAN_YEARS;
    // Reality averages about 1.5 partial-or-total lunar eclipses a year.
    expect(perYear).toBeGreaterThan(0.9);
    expect(perYear).toBeLessThan(2.6);
  });

  it('clusters eclipses into seasons about 173 days apart', () => {
    const events = groupEvents(solarEclipseTimes(), 5).map((g) => g[0]);
    // A season may contain two eclipses a month apart; split on gaps beyond that.
    const seasons = groupEvents(events, 60).map((g) => g[0]);
    const gaps: number[] = [];
    for (let i = 1; i < seasons.length; i++) gaps.push(seasons[i] - seasons[i - 1]);
    expect(gaps.length).toBeGreaterThan(20);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // The eclipse year is 346.6 days, so seasons fall half that apart.
    expect(mean).toBeGreaterThan(160);
    expect(mean).toBeLessThan(186);
  });

  it('yields both total and annular solar eclipses', () => {
    const M = earthMatrix(REALISTIC.obliquityDeg, REALISTIC.axisLongitudeDeg, 0);
    const kinds = new Set<string>();
    for (const t of solarEclipseTimes()) {
      const m = moonStateAt(t);
      const p = solarShadowAxisPointKm(m);
      // On the shadow axis, apparent disc size decides total versus annular.
      if (p) {
        const { lat, lon } = subPoint(M, p);
        kinds.add(solarEclipseAt(m, M, lat, lon).kind);
      } else {
        // This fallback point does not attempt to locate the event maximum.
        kinds.add(solarEclipseAt(m, M, 0, 0).kind);
      }
    }
    expect(kinds.has('total')).toBe(true);
    expect(kinds.has('annular')).toBe(true);
  });

  it('yields total lunar eclipses', () => {
    const kinds = new Set(lunarKinds().map((h) => h.kind));
    expect(kinds.has('total')).toBe(true);
    expect(kinds.has('penumbral')).toBe(true);
  });
});

describe('solar eclipse locality', () => {
  const M = earthMatrix(REALISTIC.obliquityDeg, REALISTIC.axisLongitudeDeg, 0);

  it('lands the shadow on the surface of the Earth when it hits at all', () => {
    let hits = 0;
    for (let t = 0; t < 365.25 * 6; t += 0.02) {
      const p = solarShadowAxisPointKm(moonStateAt(t));
      if (!p) continue;
      hits++;
      // The intersection must lie on the globe, not inside or beyond it.
      expect(norm(p)).toBeCloseTo(EARTH_RADIUS_KM, 3);
    }
    expect(hits).toBeGreaterThan(50);
  });

  it('is seen differently from different places at the same instant', () => {
    // Stand exactly under the shadow axis to see totality, then check the far side of
    // the world sees nothing at all. This parallax is what makes eclipse tracks narrow.
    let found = false;
    for (let t = 0; t < 365.25 * 12 && !found; t += 0.02) {
      const m = moonStateAt(t);
      if (!solarEclipsePossible(m)) continue;
      const p = solarShadowAxisPointKm(m);
      if (!p) continue;
      const { lat, lon } = subPoint(M, p);
      if (solarEclipseAt(m, M, lat, lon).kind !== 'total') continue;
      const anti = solarEclipseAt(m, M, -lat, lon > 0 ? lon - 180 : lon + 180);
      expect(anti.kind).toBe('none');
      found = true;
    }
    expect(found).toBe(true);
  });

  it('reports obscuration below magnitude for a partial eclipse', () => {
    // Area covered always lags diameter covered, which is why a deep partial eclipse
    // still leaves the day surprisingly bright.
    let checked = 0;
    for (let t = 0; t < 365.25 * 6 && checked < 25; t += 0.02) {
      const m = moonStateAt(t);
      if (!solarEclipsePossible(m)) continue;
      for (let lat = -60; lat <= 60; lat += 15) {
        const e = solarEclipseAt(m, M, lat, 0);
        if (e.kind === 'partial' && e.magnitude > 0.2 && e.magnitude < 0.8) {
          expect(e.obscuration).toBeLessThan(e.magnitude);
          expect(e.obscuration).toBeGreaterThan(0);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('fully obscures the Sun during totality and leaves a ring when annular', () => {
    let total: ReturnType<typeof solarEclipseAt> | null = null;
    let annular: ReturnType<typeof solarEclipseAt> | null = null;
    for (let t = 0; t < 365.25 * 12 && (!total || !annular); t += 0.02) {
      const m = moonStateAt(t);
      if (!solarEclipsePossible(m)) continue;
      const p = solarShadowAxisPointKm(m);
      if (!p) continue;
      const { lat, lon } = subPoint(M, p);
      const e = solarEclipseAt(m, M, lat, lon);
      if (e.kind === 'total' && !total) total = e;
      if (e.kind === 'annular' && !annular) annular = e;
    }
    expect(total).not.toBeNull();
    expect(annular).not.toBeNull();
    expect(total!.obscuration).toBeCloseTo(1, 6);
    expect(total!.magnitude).toBeGreaterThanOrEqual(1);
    // An annular eclipse never reaches full obscuration: the ring always shows.
    expect(annular!.obscuration).toBeLessThan(1);
    expect(annular!.obscuration).toBeGreaterThan(0.7);
    expect(annular!.magnitude).toBeLessThan(1);
  });
});

describe('eclipses are independent of the rotation configuration', () => {
  it('moves a solar eclipse to different longitudes when the spin changes', () => {
    // Same instant, same place, different orientation: the eclipse is seen by a
    // different part of the world. Confirms the spin genuinely carries you into shadow.
    let differing = 0;
    for (const t of solarEclipseTimes()) {
      const m = moonStateAt(t);
      const M1 = earthMatrix(REALISTIC.obliquityDeg, REALISTIC.axisLongitudeDeg, 0);
      const M2 = earthMatrix(REALISTIC.obliquityDeg, REALISTIC.axisLongitudeDeg, 90);
      const a = solarEclipseAt(m, M1, 20, 0).kind;
      const b = solarEclipseAt(m, M2, 20, 0).kind;
      if (a !== b) differing++;
    }
    expect(differing).toBeGreaterThan(0);
  });
});
