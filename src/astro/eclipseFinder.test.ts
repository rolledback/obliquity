import { describe, expect, it } from 'vitest';
import { SYZYGY_STEP, findNextEclipse } from './eclipseFinder';
import { lunarEclipseAt, solarEclipseAt, solarEclipsePossible } from './eclipse';
import { moonStateAt, moonTopocentric } from './moon';
import { REALISTIC, cloneConfig } from './config';
import { YEAR_DAYS, absDaysFrom } from './calendar';
import { sunDirEcliptic } from './orientation';
import { earthMatrixAtLocalTime } from './daypath';
import { directionAltAz } from './sun';
import type { EclipseHit } from './eclipseFinder';
import type { RotationConfig } from './config';

const SEATTLE = { lat: 47.61, lon: -122.33 };

/** Rebuild the Earth orientation the finder is describing, to re-check its own answer. */
function orientationFor(hit: EclipseHit, config: RotationConfig, lonDeg: number) {
  return earthMatrixAtLocalTime(config, hit.orbit, hit.dayOfYear, lonDeg, hit.timeOfDay);
}

describe('finding solar eclipses', () => {
  it('finds one visible from Seattle and reports it honestly', () => {
    const hit = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 0, 1);
    expect(hit).not.toBeNull();
    expect(hit!.type).toBe('solar');
    expect(['partial', 'annular', 'total']).toContain(hit!.kind);

    // Re-evaluate independently at the reported moment: the eclipse must really be there.
    const moon = moonStateAt(absDaysFrom(hit!.orbit, hit!.dayOfYear));
    const M = orientationFor(hit!, REALISTIC, SEATTLE.lon);
    const check = solarEclipseAt(moon, M, SEATTLE.lat, SEATTLE.lon);
    expect(check.kind).toBe(hit!.kind);
    expect(check.magnitude).toBeCloseTo(hit!.magnitude, 6);

    // And the Sun must be above the horizon, or there would be nothing to watch.
    const sunAlt = directionAltAz(M, sunDirEcliptic(moon.sunLonDeg), SEATTLE.lat, SEATTLE.lon).altDeg;
    expect(sunAlt).toBeGreaterThan(0);
    expect(hit!.altDeg).toBeCloseTo(sunAlt, 6);
  });

  it('returns a later eclipse each time it is asked again', () => {
    let orbit = 0;
    let day = 1;
    let prev = -Infinity;
    for (let i = 0; i < 6; i++) {
      const hit = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, orbit, day);
      expect(hit).not.toBeNull();
      expect(hit!.absDays).toBeGreaterThan(prev);
      prev = hit!.absDays;
      orbit = hit!.orbit;
      day = hit!.dayOfYear;
    }
  });

  it('keeps the reported date and time in range', () => {
    let orbit = 0;
    let day = 1;
    for (let i = 0; i < 5; i++) {
      const hit = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, orbit, day)!;
      expect(hit.dayOfYear).toBeGreaterThanOrEqual(1);
      expect(hit.dayOfYear).toBeLessThan(YEAR_DAYS + 1);
      expect(hit.timeOfDay).toBeGreaterThanOrEqual(0);
      expect(hit.timeOfDay).toBeLessThan(24);
      expect(hit.orbit).toBeGreaterThanOrEqual(0);
      orbit = hit.orbit;
      day = hit.dayOfYear;
    }
  });

  it('skips a shallow eclipse when asked for deep ones', () => {
    // Start just before a genuinely shallow event, so the filter has to DO something. The
    // old version started at day one, where the very first hit already cleared the bar, so
    // deleting the minMagnitude check outright left it passing.
    const start = { orbit: 1, day: 10.75 }; // absolute day 375.0
    const any = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, start.orbit, start.day, {
      maxYears: 60,
    })!;
    expect(any.magnitude).toBeLessThan(0.5); // the shallow one is what is next

    const deep = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, start.orbit, start.day, {
      minMagnitude: 0.5,
      maxYears: 60,
    })!;
    expect(deep.absDays).toBeGreaterThan(any.absDays); // it had to walk past it
    expect(deep.magnitude).toBeGreaterThanOrEqual(0.5);
  });
});

describe('finding lunar eclipses', () => {
  it('finds one with the Moon actually above the horizon', () => {
    const hit = findNextEclipse('lunar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 0, 1);
    expect(hit).not.toBeNull();
    expect(hit!.type).toBe('lunar');
    expect(['penumbral', 'partial', 'total']).toContain(hit!.kind);

    const moon = moonStateAt(absDaysFrom(hit!.orbit, hit!.dayOfYear));
    const M = orientationFor(hit!, REALISTIC, SEATTLE.lon);
    expect(lunarEclipseAt(moon).kind).toBe(hit!.kind);

    const topo = moonTopocentric(moon, M, SEATTLE.lat, SEATTLE.lon);
    const alt = directionAltAz(M, topo.dir, SEATTLE.lat, SEATTLE.lon).altDeg;
    expect(alt).toBeGreaterThan(0);
  });

  it('walks past a shallower lunar eclipse when asked for deep ones', () => {
    // Starting where the next event is a PARTIAL well under magnitude 1, so the threshold has
    // to reject something. Starting at day one, as this once did, put a total eclipse of
    // magnitude 1.65 first and the filter could be deleted without the test noticing.
    const start = { orbit: 1, day: 10.75 }; // absolute day 375.0
    const any = findNextEclipse('lunar', REALISTIC, SEATTLE.lat, SEATTLE.lon, start.orbit, start.day, {
      maxYears: 60,
    })!;
    expect(any.kind).toBe('partial');
    // Also pins kind-first ranking: an umbral magnitude is below 1 here, while a penumbral
    // moment of the same event scores above it on its own much wider scale. Ranking the
    // window by raw magnitude promotes that penumbral instant and this reads 'penumbral'.
    expect(any.magnitude).toBeLessThan(1);

    const deep = findNextEclipse('lunar', REALISTIC, SEATTLE.lat, SEATTLE.lon, start.orbit, start.day, {
      minMagnitude: 1.2,
      maxYears: 60,
    })!;
    expect(deep.absDays).toBeGreaterThan(any.absDays);
    expect(deep.magnitude).toBeGreaterThanOrEqual(1.2);
  });
});

describe('the rotation configuration changes what you can see', () => {
  it('leaves the local hour alone when only the day length changes', () => {
    // Rotation period changes absolute duration, not the local solar hour of conjunction.
    const fast: RotationConfig = { ...cloneConfig(REALISTIC), rotationPeriodHours: 8 };
    const a = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 0, 1)!;
    const b = findNextEclipse('solar', fast, SEATTLE.lat, SEATTLE.lon, 0, 1)!;
    expect(b.timeOfDay).toBeCloseTo(a.timeOfDay, 2);
    expect(b.absDays).toBeCloseTo(a.absDays, 2);
    expect(b.kind).toBe(a.kind);
  });

  it('mirrors the local hour about noon when the spin reverses', () => {
    // A retrograde world runs its Sun across the sky the other way, so the same physical
    // orientation is reached at the reflected point of its own day.
    const retro: RotationConfig = { ...cloneConfig(REALISTIC), prograde: false };
    const a = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 0, 1)!;
    const b = findNextEclipse('solar', retro, SEATTLE.lat, SEATTLE.lon, 0, 1)!;
    expect(b.absDays).toBeCloseTo(a.absDays, 2);
    expect(b.timeOfDay).toBeCloseTo(24 - a.timeOfDay, 1);
  });

  it('changes which solar eclipse reaches you when the axis is reshaped', () => {
    // Tilting the axis moves the observer somewhere else in three dimensions at the same
    // local hour, which changes the lunar parallax and therefore what they actually see.
    const sideways: RotationConfig = { ...cloneConfig(REALISTIC), obliquityDeg: 90 };
    const a = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 0, 1)!;
    const b = findNextEclipse('solar', sideways, SEATTLE.lat, SEATTLE.lon, 0, 1)!;
    const sameEvent = Math.abs(a.absDays - b.absDays) < 0.5;
    const sameDepth = Math.abs(a.magnitude - b.magnitude) < 0.01;
    expect(sameEvent && sameDepth).toBe(false);
    // Verify both against their own geometry so neither is an artefact of the search.
    for (const [hit, cfg] of [[a, REALISTIC], [b, sideways]] as const) {
      const moon = moonStateAt(absDaysFrom(hit.orbit, hit.dayOfYear));
      const M = orientationFor(hit, cfg, SEATTLE.lon);
      expect(solarEclipseAt(moon, M, SEATTLE.lat, SEATTLE.lon).kind).toBe(hit.kind);
    }
  });

  it('keeps a lunar eclipse the same event but seen from a different angle', () => {
    // These sampled worlds should find the same global event with different peak altitudes.
    const worlds: RotationConfig[] = [
      REALISTIC,
      { ...cloneConfig(REALISTIC), obliquityDeg: 90 },
      { ...cloneConfig(REALISTIC), obliquityDeg: 0 },
      { ...cloneConfig(REALISTIC), axisLongitudeDeg: 270 },
    ];
    const hits = worlds.map(
      (c) => findNextEclipse('lunar', c, SEATTLE.lat, SEATTLE.lon, 0, 1)!,
    );
    for (const h of hits) {
      expect(h.absDays).toBeCloseTo(hits[0].absDays, 3);
      expect(h.kind).toBe(hits[0].kind);
      expect(h.magnitude).toBeCloseTo(hits[0].magnitude, 6);
    }
    // The viewing altitude, by contrast, must genuinely differ between these worlds.
    const alts = hits.map((h) => h.altDeg);
    expect(Math.max(...alts) - Math.min(...alts)).toBeGreaterThan(5);
  });

  it('finds penumbral lunar eclipses, not just umbral ones', () => {
    // Penumbral events need their own nonzero magnitude scale.
    const kinds = new Set<string>();
    let orbit = 0;
    let day = 1;
    for (let i = 0; i < 30; i++) {
      const hit = findNextEclipse('lunar', REALISTIC, SEATTLE.lat, SEATTLE.lon, orbit, day);
      if (!hit) break;
      kinds.add(hit.kind);
      if (hit.kind === 'penumbral') expect(hit.magnitude).toBeGreaterThan(0);
      orbit = hit.orbit;
      day = hit.dayOfYear;
    }
    expect(kinds.has('penumbral')).toBe(true);
  });

  it('does not step over an eclipse that begins moments after the search starts', () => {
    // Looking one stride ahead could mistake a newly opening eclipse for the current one.
    const first = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 0, 1)!;
    // Approximate when the candidate window opens.
    let windowStart = first.absDays;
    while (windowStart > 0 && solarEclipsePossible(moonStateAt(windowStart - 0.002))) {
      windowStart -= 0.002;
    }
    for (const lead of [0.2, 0.02, 0.002]) {
      const hit = findNextEclipse(
        'solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 0, windowStart - lead + 1,
      )!;
      expect(hit).not.toBeNull();
      expect(Math.abs(hit.absDays - first.absDays)).toBeLessThan(0.5);
    }
    // Starting INSIDE the window must still advance to a genuinely later event.
    const inside = findNextEclipse(
      'solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 0, windowStart + 0.02 + 1,
    )!;
    expect(inside.absDays).toBeGreaterThan(first.absDays + 1);
  });

  it('still finds eclipses for a wildly reshaped world', () => {
    const sideways: RotationConfig = {
      ...cloneConfig(REALISTIC),
      obliquityDeg: 90,
      rotationPeriodHours: 40,
      prograde: false,
    };
    const solar = findNextEclipse('solar', sideways, SEATTLE.lat, SEATTLE.lon, 0, 1, {
      maxYears: 60,
    });
    const lunar = findNextEclipse('lunar', sideways, SEATTLE.lat, SEATTLE.lon, 0, 1, {
      maxYears: 60,
    });
    expect(solar).not.toBeNull();
    expect(lunar).not.toBeNull();
    // The eclipse itself is unchanged by the spin; only who sees it is.
    const moon = moonStateAt(absDaysFrom(lunar!.orbit, lunar!.dayOfYear));
    expect(lunarEclipseAt(moon).kind).toBe(lunar!.kind);
  });
});

describe('search behaviour', () => {
  it('searches backwards as well as forwards', () => {
    const forward = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 5, 100)!;
    const back = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 5, 100, {
      backwards: true,
    })!;
    expect(forward.absDays).toBeGreaterThan(absDaysFrom(5, 100));
    expect(back.absDays).toBeLessThan(absDaysFrom(5, 100));
  });

  it('never walks before the epoch', () => {
    const back = findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, 0, 2, {
      backwards: true,
    });
    // There is almost no time before day 2 of orbit 0, so this must give up cleanly.
    if (back) expect(back.absDays).toBeGreaterThanOrEqual(0);
  });

  it('answers fast enough to sit behind a button', () => {
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) {
      findNextEclipse('solar', REALISTIC, SEATTLE.lat, SEATTLE.lon, i * 3, 1);
      findNextEclipse('lunar', REALISTIC, SEATTLE.lat, SEATTLE.lon, i * 3, 1);
    }
    const perCall = (performance.now() - t0) / 10;
    expect(perCall).toBeLessThan(400);
  });
});

describe('finding the peak when the ridge is steep', () => {
  it('finds a total near the pole that a flat search reported as partial', () => {
    // The ridge scales as 1/cos(latitude); this 80-degree event must exceed 1.03.
    const hit = findNextEclipse('solar', REALISTIC, 80, 0, 26, 222.731761, {
      kinds: ['total'],
      maxYears: 2,
    });
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('total');
    expect(hit!.magnitude).toBeGreaterThan(1.03);

    // Filtering must select rather than alter the peak.
    const same = findNextEclipse('solar', REALISTIC, 80, 0, 26, 222.731761, { maxYears: 2 });
    expect(same!.kind).toBe('total');
    expect(same!.magnitude).toBeCloseTo(hit!.magnitude, 6);
  });

  it('reports an equator eclipse consistent with a direct reading at that instant', () => {
    const hit = findNextEclipse('solar', REALISTIC, 0, 0, 0, 1, { maxYears: 10 })!;
    const moon = moonStateAt(hit.absDays);
    const M = orientationFor(hit, REALISTIC, 0);
    expect(solarEclipseAt(moon, M, 0, 0).kind).toBe(hit.kind);
    expect(solarEclipseAt(moon, M, 0, 0).magnitude).toBeCloseTo(hit.magnitude, 6);
  });
});

describe('the stride does not step over brief events', () => {
  it('walks near syzygy more finely than the briefest event lasts', () => {
    // The briefest solar event in a 600-year survey, 10.94 minutes, where the penumbra only
    // clips the limb. It is the ONLY one of 1251 under 14.4 minutes, and the stride's floor
    // has to be under it or the walk steps clean over the event, as the old floor did.
    const FINE = 0.0001;
    let start = -1;
    let duration = 0;
    for (let t = 90161.75; t < 90161.95; t += FINE) {
      const inside = solarEclipsePossible(moonStateAt(t));
      if (inside && start < 0) start = t;
      else if (!inside && start >= 0) {
        duration = t - start;
        break;
      }
    }
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeLessThan(0.01); // the old floor really was too coarse for it
    expect(SYZYGY_STEP).toBeLessThan(duration);
  });
});
