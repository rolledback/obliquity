import { describe, expect, it } from 'vitest';
import {
  REALISTIC,
  cloneConfig,
  defaultCustomConfig,
  periodOrbits,
  axisConfigKey,
  axisIsSecular,
  accumulatedLonDeg,
  sunLongitudeDeg,
  EARTH_SIDEREAL_DAY_HOURS,
} from './config';
import { FORMULA_EXAMPLES } from '../formulaExamples';
import {
  axisParamsAt,
  culminationAltitudesDeg,
  declinationForDay,
  earthMatrix,
  maxPoleStep,
  noonSpinDeg,
  northPole,
  sunDeclinationDeg,
  sunDirEcliptic,
  sunriseHourAngleRad,
} from './orientation';
import { sunAltAz, sunAltAzAt } from './sun';
import { computeDayPath, apparentSolarSpinSign, meanSunRaRateDegPerHour, solarDayHours, spinMultiplierAt, spinRateDegPerHour, spinReverses } from './daypath';
import { dailyInsolation, seasonCycle, warmthAt } from './season';
import { dot } from './vec';

const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

describe('sun longitude from date', () => {
  it('is 0 at the March equinox and advances 90deg per season', () => {
    expect(close(sunLongitudeDeg(79), 0, 1e-9)).toBe(true);
    expect(close(sunLongitudeDeg(79 + 365.25 / 4), 90, 1e-6)).toBe(true);
    expect(close(sunLongitudeDeg(79 + 365.25 / 2), 180, 1e-6)).toBe(true);
  });
});

describe('solar declination (realistic Earth)', () => {
  it('is ~0 at equinoxes and +/-obliquity at solstices', () => {
    const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(REALISTIC, 0);
    expect(close(sunDeclinationDeg(obliquityDeg, axisLongitudeDeg, 0), 0, 1e-9)).toBe(true);
    expect(close(sunDeclinationDeg(obliquityDeg, axisLongitudeDeg, 90), 23.4397, 1e-4)).toBe(true);
    expect(close(sunDeclinationDeg(obliquityDeg, axisLongitudeDeg, 270), -23.4397, 1e-4)).toBe(true);
  });
});

describe('north pole vector', () => {
  it('is a unit vector tilted by the obliquity from the ecliptic pole', () => {
    const n = northPole(23.4397, 90);
    expect(close(dot(n, n), 1, 1e-9)).toBe(true);
    // angle from ecliptic north (Z) equals the obliquity
    expect(close(Math.acos(n[2]) * (180 / Math.PI), 23.4397, 1e-4)).toBe(true);
  });
});

describe('noon altitude (sampled day path)', () => {
  const equinoxDay = 79;
  const juneSolsticeDay = 79 + 365.25 / 4;

  it('reaches 90deg at the equator on the equinox', () => {
    const { stats } = computeDayPath(REALISTIC, equinoxDay, 0, 0);
    expect(Math.abs(stats.peakAltDeg - 90) < 0.2).toBe(true);
    expect(Math.abs(stats.declinationDeg) < 1e-3).toBe(true);
  });

  it('equals 90 - |lat| at the equinox for a mid-latitude', () => {
    const { stats } = computeDayPath(REALISTIC, equinoxDay, 45, 0);
    expect(Math.abs(stats.peakAltDeg - 45) < 0.2).toBe(true);
  });

  it('equals 90 - |lat - dec| at the June solstice', () => {
    const { stats } = computeDayPath(REALISTIC, juneSolsticeDay, 45, 0);
    const expected = 90 - Math.abs(45 - 23.4397);
    expect(Math.abs(stats.peakAltDeg - expected) < 0.2).toBe(true);
  });
});

describe('sunrise / sunset azimuth and day length', () => {
  it('rises due east and sets due west at the equinox (prograde)', () => {
    const { stats } = computeDayPath(REALISTIC, 79, 40, 0);
    expect(stats.sunriseAzDeg).not.toBeNull();
    expect(stats.sunsetAzDeg).not.toBeNull();
    expect(Math.abs((stats.sunriseAzDeg as number) - 90) < 1).toBe(true);
    expect(Math.abs((stats.sunsetAzDeg as number) - 270) < 1).toBe(true);
  });

  it('gives ~12h of daylight at the equinox', () => {
    const { stats } = computeDayPath(REALISTIC, 79, 40, 0);
    expect(Math.abs(stats.daylightHours - 12) < 0.2).toBe(true);
  });

  it('realistic solar day is ~24 hours', () => {
    expect(Math.abs(solarDayHours(REALISTIC) - 24) < 0.01).toBe(true);
  });
});

describe('retrograde rotation', () => {
  it('makes the Sun rise in the west', () => {
    const retro = cloneConfig(REALISTIC);
    retro.prograde = false;
    const { stats } = computeDayPath(retro, 79, 40, 0);
    // sunrise now on the western side of the sky
    expect(Math.abs((stats.sunriseAzDeg as number) - 270) < 1).toBe(true);
  });
});

describe('polar day and night at the North Pole', () => {
  it('is permanent daylight at the June solstice', () => {
    const { stats } = computeDayPath(REALISTIC, 79 + 365.25 / 4, 90, 0);
    expect(stats.condition).toBe('polar-day');
    expect(stats.peakAltDeg > 0 && stats.minAltDeg > 0).toBe(true);
  });

  it('is permanent night at the December solstice', () => {
    const { stats } = computeDayPath(REALISTIC, 79 + (3 * 365.25) / 4, 90, 0);
    expect(stats.condition).toBe('polar-night');
    expect(stats.peakAltDeg <= 0).toBe(true);
  });
});

describe('axis mode: always lean toward Sun', () => {
  it('keeps the subsolar point at a fixed northern latitude all year', () => {
    const cfg = cloneConfig(REALISTIC);
    cfg.axisMode = 'leanToSun';
    for (const day of [10, 100, 200, 300]) {
      const sunLon = sunLongitudeDeg(day);
      const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(cfg, sunLon);
      const dec = sunDeclinationDeg(obliquityDeg, axisLongitudeDeg, sunLon);
      expect(Math.abs(dec - 23.4397) < 1e-3).toBe(true);
    }
  });
});

describe('mean solar day across axis modes', () => {
  // Verified against a brute-force noon-crossing count over a full year. An axis that
  // tracks the Sun (or precesses) shifts the Sun's mean right ascension rate, so the
  // mean solar day is no longer the fixed-axis 24 h.
  const make = (mut: (c: ReturnType<typeof defaultCustomConfig>) => void) => {
    const c = defaultCustomConfig(); // sidereal-period, prograde base
    mut(c);
    return c;
  };
  const cases: [string, ReturnType<typeof defaultCustomConfig>, number][] = [
    ['fixed (realistic)', REALISTIC, 24.0],
    ['lean toward Sun = sidereal day', make((c) => (c.axisMode = 'leanToSun')), EARTH_SIDEREAL_DAY_HOURS],
    ['lean away from Sun = sidereal day', make((c) => (c.axisMode = 'leanFromSun')), EARTH_SIDEREAL_DAY_HOURS],
    ['precession +3 turns/yr', make((c) => { c.axisMode = 'precession'; c.precessionTurnsPerYear = 3; }), 23.8047],
    ['precession -1 turn/yr', make((c) => { c.axisMode = 'precession'; c.precessionTurnsPerYear = -1; }), 24.0659],
    ['precession +3.5 turns/yr (non-integer)', make((c) => { c.axisMode = 'precession'; c.precessionTurnsPerYear = 3.5; }), 23.7722],
    ['precession +0.3 turns/yr (non-integer)', make((c) => { c.axisMode = 'precession'; c.precessionTurnsPerYear = 0.3; }), 23.9799],
    ['Venus-like (obliquity 177.4, retrograde 120 h)', make((c) => { c.obliquityDeg = 177.4; c.rotationPeriodHours = 120; c.prograde = false; }), 121.6655],
    ['upside-down axis (obliquity 120)', make((c) => (c.obliquityDeg = 120)), 23.8694],
    ['obliquity wave crossing 90 (45..135) = sidereal day', make((c) => { c.axisMode = 'obliquityWave'; c.obliquityDeg = 90; c.obliquityAmplitudeDeg = 45; }), EARTH_SIDEREAL_DAY_HOURS],
  ];
  for (const [name, cfg, expected] of cases) {
    it(`${name}`, () => {
      expect(Math.abs(solarDayHours(cfg) - expected) < 0.01).toBe(true);
    });
  }
});

describe('mean Sun RA rate matches the actual yearly winding', () => {
  // The mean right-ascension rate must equal the net winding of the noon spin over a
  // full year (it is what the animation clock beats against). This is the strongest
  // self-consistency check on solarDayHours, and it covers the case a per-mode closed
  // form gets wrong: an obliquity that oscillates across 90 degrees, whose forward and
  // backward winding cancel so the Sun's RA has no net annual drift.
  const annualNoonSpinDriftDeg = (cfg: ReturnType<typeof defaultCustomConfig>) => {
    const steps = 4000;
    let prev = noonSpinDeg(cfg, 1, 0);
    let total = 0;
    for (let i = 1; i <= steps; i++) {
      const day = 1 + (i / steps) * 365.25;
      const cur = noonSpinDeg(cfg, day, 0);
      let d = cur - prev;
      d = (((d + 180) % 360) + 360) % 360 - 180;
      total += d;
      prev = cur;
    }
    return total;
  };
  const make = (mut: (c: ReturnType<typeof defaultCustomConfig>) => void) => {
    const c = defaultCustomConfig();
    mut(c);
    return c;
  };
  const cases: [string, ReturnType<typeof defaultCustomConfig>][] = [
    ['fixed', REALISTIC],
    ['leanToSun', make((c) => (c.axisMode = 'leanToSun'))],
    ['precession 2.5', make((c) => { c.axisMode = 'precession'; c.precessionTurnsPerYear = 2.5; })],
    ['obliquity 177.4', make((c) => (c.obliquityDeg = 177.4))],
    ['rollWave base 90 amp 45', make((c) => { c.axisMode = 'rollWave'; c.obliquityDeg = 90; c.rollAmplitudeDeg = 45; })],
    ['obliquityWave crossing 90 (cancels)', make((c) => { c.axisMode = 'obliquityWave'; c.obliquityDeg = 90; c.obliquityAmplitudeDeg = 45; })],
    ['obliquityWave 70 amp 45 (crosses 90)', make((c) => { c.axisMode = 'obliquityWave'; c.obliquityDeg = 70; c.obliquityAmplitudeDeg = 45; })],
  ];
  for (const [name, cfg] of cases) {
    it(`${name}`, () => {
      const formulaWindingDeg = meanSunRaRateDegPerHour(cfg) * (365.25 * 24);
      expect(Math.abs(formulaWindingDeg - annualNoonSpinDriftDeg(cfg)) < 1).toBe(true);
    });
  }
});

describe('precession axis stays continuous across the equinox seam', () => {
  // A non-integer precession rate is not periodic with the year, but the simulated
  // year must not snap mid-year: declination and the noon spin should be continuous
  // through the equinox (day 79), where the ecliptic longitude passes through zero.
  it('declination does not jump for fractional turns/yr', () => {
    const cfg = defaultCustomConfig();
    cfg.axisMode = 'precession';
    cfg.precessionTurnsPerYear = 3.5;
    cfg.axisLongitudeDeg = 0; // base where a wrapped longitude would flip the sign
    const before = declinationForDay(cfg, 78.9);
    const after = declinationForDay(cfg, 79.1);
    expect(Math.abs(before - after) < 1).toBe(true);
  });
  it('noon spin does not snap for fractional turns/yr', () => {
    const cfg = defaultCustomConfig();
    cfg.axisMode = 'precession';
    cfg.precessionTurnsPerYear = 2.2;
    const a = noonSpinDeg(cfg, 78.9, 30);
    const b = noonSpinDeg(cfg, 79.1, 30);
    const delta = ((a - b + 540) % 360) - 180; // shortest angular gap
    expect(Math.abs(delta) < 2).toBe(true);
  });
});

describe('alt/az direct vs day-path consistency', () => {
  it('sunAltAzAt matches a direct matrix computation', () => {
    const sunLon = sunLongitudeDeg(120);
    const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(REALISTIC, sunLon);
    const M = earthMatrix(obliquityDeg, axisLongitudeDeg, 137);
    const direct = sunAltAz(M, sunDirEcliptic(sunLon), 33, 18);
    const helper = sunAltAzAt(REALISTIC, 120, 137, 33, 18);
    expect(close(direct.altDeg, helper.altDeg, 1e-9)).toBe(true);
    expect(close(direct.azDeg, helper.azDeg, 1e-9)).toBe(true);
  });
});

describe('local solar noon anchoring (noonSpinDeg)', () => {
  // At the noon spin angle the Sun should be on the observer's meridian: its
  // altitude equals the analytic peak, so the simulator's 12:00 = Sun highest.
  const cases = [
    { day: 79, lat: 0, lon: 0 },
    { day: 172, lat: 47.61, lon: -122.33 },
    { day: 172, lat: -33.87, lon: 151.21 },
    { day: 311, lat: 51.5, lon: -0.13 },
  ];
  for (const { day, lat, lon } of cases) {
    it(`Sun is at its peak at noon for day ${day}, lat ${lat}`, () => {
      const spin = noonSpinDeg(REALISTIC, day, lon);
      const { altDeg } = sunAltAzAt(REALISTIC, day, spin, lat, lon);
      const sunLon = sunLongitudeDeg(day);
      const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(REALISTIC, sunLon);
      const dec = sunDeclinationDeg(obliquityDeg, axisLongitudeDeg, sunLon);
      const peak = 90 - Math.abs(lat - dec);
      expect(Math.abs(altDeg - peak) < 1e-6).toBe(true);
    });
  }

  it('anchors noon even for a tilted, custom-day-length world', () => {
    const cfg = defaultCustomConfig();
    cfg.obliquityDeg = 45;
    cfg.rotationPeriodHours = 7;
    const day = 230;
    const lat = 20;
    const lon = 60;
    const spin = noonSpinDeg(cfg, day, lon);
    const { altDeg } = sunAltAzAt(cfg, day, spin, lat, lon);
    const sunLon = sunLongitudeDeg(day);
    const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(cfg, sunLon);
    const dec = sunDeclinationDeg(obliquityDeg, axisLongitudeDeg, sunLon);
    const peak = 90 - Math.abs(lat - dec);
    expect(Math.abs(altDeg - peak) < 1e-6).toBe(true);
  });
});

describe('seasonal warmth signal', () => {
  const DEG = Math.PI / 180;
  const close = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol;

  it('daily insolation matches the closed form at the equator equinox', () => {
    // lat 0, dec 0: mean of max(0,sin alt) over the day = 1/pi.
    expect(close(dailyInsolation(0, 0), 1 / Math.PI)).toBe(true);
  });

  it('is zero in polar night and equals sin(lat)sin(dec) in polar day', () => {
    expect(dailyInsolation(80 * DEG, -30 * DEG)).toBe(0); // Sun never rises
    // Sun never sets: the day-long mean is the (constant) sin of the altitude.
    expect(close(dailyInsolation(80 * DEG, 30 * DEG), Math.sin(80 * DEG) * Math.sin(30 * DEG))).toBe(true);
  });

  it('gives realistic Earth a single warm season that lags the Sun by weeks', () => {
    const s = seasonCycle(REALISTIC, 47.6);
    expect(s.warmSeasonsPerYear).toBe(1);
    expect(s.warmthMax > s.warmthMin).toBe(true);
    expect(s.warmthMin > 0.05 && s.warmthMin < 0.12).toBe(true);
    expect(s.warmthMax > 0.32 && s.warmthMax < 0.38).toBe(true);
    // Peak warmth trails peak sunlight (thermal lag), by a few weeks.
    const lag = ((s.warmthMaxIndex - s.insolationMaxIndex) % 365 + 365) % 365;
    expect(lag > 15 && lag < 45).toBe(true);
  });

  it('reports no seasons when the axis has no tilt', () => {
    const cfg = defaultCustomConfig();
    cfg.obliquityDeg = 0;
    expect(seasonCycle(cfg, 45).warmSeasonsPerYear).toBe(0);
  });

  it('reports two warm seasons for a once-per-year precessing axis', () => {
    // Seasonal cycles = |precessionTurnsPerYear - 1|; -1 turn/yr gives two summers.
    const cfg = defaultCustomConfig();
    cfg.axisMode = 'precession';
    cfg.precessionTurnsPerYear = -1;
    expect(seasonCycle(cfg, 45).warmSeasonsPerYear).toBe(2);
  });

  it('pins a flat, warm climate when the axis always leans toward the Sun', () => {
    const cfg = defaultCustomConfig();
    cfg.axisMode = 'leanToSun';
    const s = seasonCycle(cfg, 45);
    expect(s.warmSeasonsPerYear).toBe(0);
    expect(s.warmthMax - s.warmthMin < 0.01).toBe(true); // perpetual summer
  });
});

describe('accumulating precession across orbits', () => {
  const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

  // Declination at an accumulated ecliptic longitude (axis phase = longitude), the
  // quantity that drives a steadily precessing axis lap after lap.
  const decAtLambda = (cfg: ReturnType<typeof defaultCustomConfig>, lambda: number) => {
    const { obliquityDeg, axisLongitudeDeg } = axisParamsAt(cfg, lambda, lambda);
    return sunDeclinationDeg(obliquityDeg, axisLongitudeDeg, lambda);
  };
  const precession = (k: number) => {
    const c = defaultCustomConfig();
    c.axisMode = 'precession';
    c.precessionTurnsPerYear = k;
    c.obliquityDeg = 35;
    return c;
  };

  it('detects the multi-year repeat period from the precession rate', () => {
    expect(periodOrbits(REALISTIC)).toBe(1);
    expect(periodOrbits(precession(4))).toBe(1); // whole turns repeat every orbit
    expect(periodOrbits(precession(3.5))).toBe(2);
    expect(periodOrbits(precession(2.2))).toBe(5);
    expect(periodOrbits(precession(0.3))).toBe(10);
  });

  it('makes consecutive orbits genuinely differ but repeat after the period', () => {
    const cfg = precession(3.5); // period 2 orbits
    const o0 = decAtLambda(cfg, 100);
    const o1 = decAtLambda(cfg, 100 + 360);
    const o2 = decAtLambda(cfg, 100 + 720);
    expect(Math.abs(o0 - o1) > 10).toBe(true); // a different season the next lap
    expect(close(o0, o2, 1e-6)).toBe(true); // back to the start after 2 orbits
  });

  it('leaves the accumulated axis continuous across the year boundary (no snap)', () => {
    const cfg = precession(3.5);
    // Two instants a sliver of longitude apart, straddling an orbit boundary: the
    // change must be proportional to the tiny step (a real reset would jump ~180deg).
    expect(close(decAtLambda(cfg, 360 - 1e-3), decAtLambda(cfg, 360 + 1e-3), 0.05)).toBe(true);
  });

  it('keeps every periodic world identical orbit to orbit', () => {
    for (const cfg of [REALISTIC, precession(4)]) {
      expect(close(decAtLambda(cfg, 100), decAtLambda(cfg, 100 + 360), 1e-6)).toBe(true);
    }
  });

  it('defaults to the periodic result when no accumulated phase is given', () => {
    const cfg = precession(3.5);
    for (const day of [10, 120, 250, 364]) {
      const sunLon = sunLongitudeDeg(day);
      expect(close(declinationForDay(cfg, day), declinationForDay(cfg, day, sunLon), 1e-12)).toBe(true);
    }
  });

  it('builds a season cycle spanning the full repeat period', () => {
    const cyc = seasonCycle(precession(3.5), 45);
    expect(cyc.periodOrbits).toBe(2);
    expect(cyc.warmth.length).toBe(2 * 365);
    // 3.5 turns/yr gives |k-1| = 2.5 seasonal cycles per year.
    expect(Math.abs(cyc.warmSeasonsPerYear - 2.5) < 0.2).toBe(true);
  });

  it('averages the mean Sun RA rate over the full cycle, not a single orbit', () => {
    // For a non-whole-number precession rate the RA winding over one orbit depends on
    // which arc it covers, so a single-orbit average is wrong. The correct cycle mean
    // equals the closed form sign(cos E)*(1-k)*orbitRate. (A one-orbit integral passes
    // only for whole- and half-integer k, which is why the rendered-spin test below
    // also exercises a non-half-integer rate.)
    const orbitRate = 360 / (365.25 * 24);
    for (const k of [1.2, 2.2, 0.3, -1.7]) {
      const cfg = precession(k); // obliquity 35 (cos E > 0)
      const expected = (1 - k) * orbitRate;
      expect(Math.abs(meanSunRaRateDegPerHour(cfg) - expected) < 1e-5).toBe(true);
    }
  });

  it('renders the mean spin at the set sidereal rate even with accumulation', () => {
    // Simulate the clock the way state.advanceTime / currentSpinDeg do, over exactly
    // one full repeat cycle, and confirm the planet's mean rendered spin equals the set
    // rate. Includes a non-half-integer rate (2.2), which a single-orbit mean gets wrong.
    for (const k of [3.5, 2.2, 0.3]) {
      const cfg = precession(k);
      const lon = 0;
      const sign = apparentSolarSpinSign(cfg);
      const solarDay = solarDayHours(cfg);
      const spinSet = spinRateDegPerHour(cfg);
      let day = 1;
      let orbit = 0;
      let timeOfDay = 12;
      const renderedSpin = (d: number, o: number, t: number) => {
        const axisPhase = o * 360 + sunLongitudeDeg(d);
        return noonSpinDeg(cfg, d, lon, axisPhase) + sign * 15 * (t - 12);
      };
      let prev = renderedSpin(day, orbit, timeOfDay);
      let totalSpin = 0;
      const stepH = 3; // absolute hours per step
      const steps = Math.round((periodOrbits(cfg) * 365.25 * 24) / stepH); // exactly one cycle
      for (let i = 0; i < steps; i++) {
        const rawDay = day + stepH / 24;
        orbit += Math.floor((rawDay - 1) / 365.25);
        day = ((rawDay - 1) % 365.25 + 365.25) % 365.25 + 1;
        timeOfDay = ((timeOfDay + (stepH / solarDay) * 24) % 24 + 24) % 24;
        const cur = renderedSpin(day, orbit, timeOfDay);
        let d = cur - prev;
        d = ((d + 180) % 360 + 360) % 360 - 180;
        totalSpin += d;
        prev = cur;
      }
      const meanRate = totalSpin / (steps * stepH);
      // Drift per year must be tiny (the old one-orbit model leaked ~3.6 deg/yr here).
      expect(Math.abs(meanRate - spinSet) * 365.25 * 24 < 0.1).toBe(true);
    }
  });
});

describe('formula mode axis parameters', () => {
  const formulaConfig = (tiltFormula: string, leanFormula: string) => {
    const c = cloneConfig(REALISTIC);
    c.axisMode = 'formula';
    c.tiltFormula = tiltFormula;
    c.leanFormula = leanFormula;
    return c;
  };

  it('reproduces the realistic axis when the default formulas are used', () => {
    const c = formulaConfig('23.4397', '90');
    for (const sunLon of [0, 45, 123, 270, 359]) {
      const p = axisParamsAt(c, sunLon);
      expect(close(p.obliquityDeg, 23.4397)).toBe(true);
      expect(close(p.axisLongitudeDeg, 90)).toBe(true);
    }
  });

  it('evaluates tilt and lean formulas against the orbital phase', () => {
    const c = formulaConfig('30 + 10*wave(phase)', '90 + 80*wave(2*phase)');
    // phase = sunLon/360, so sunLon 0 -> phase 0, sunLon 90 -> phase 0.25.
    const atEquinox = axisParamsAt(c, 0);
    expect(close(atEquinox.obliquityDeg, 30)).toBe(true); // wave(0) = 0
    expect(close(atEquinox.axisLongitudeDeg, 90)).toBe(true); // wave(0) = 0

    const atSummer = axisParamsAt(c, 90);
    expect(close(atSummer.obliquityDeg, 40)).toBe(true); // wave(0.25) = 1
    expect(close(atSummer.axisLongitudeDeg, 90)).toBe(true); // wave(0.5) = 0
  });

  it('keeps declination finite and smooth across a full year', () => {
    const c = formulaConfig('45 + 30*wave(phase)', '90 + 70*wave(phase)');
    let prev = declinationForDay(c, 1);
    for (let day = 1; day <= 366; day += 1) {
      const dec = declinationForDay(c, day);
      expect(Number.isFinite(dec)).toBe(true);
      expect(Math.abs(dec) <= 90).toBe(true);
      // No teleporting: day-to-day declination change stays bounded.
      expect(Math.abs(dec - prev) < 5).toBe(true);
      prev = dec;
    }
  });

  it('uses the accumulated axis phase so year-driven formulas evolve across orbits', () => {
    const c = formulaConfig('10 + 5*year', '90');
    // axisParamsAt receives the accumulated phase; orbit 0 vs orbit 3 at the same day differ.
    const day = 100;
    const sunLon = sunLongitudeDeg(day);
    const orbit0 = axisParamsAt(c, sunLon, 0 * 360 + sunLon);
    const orbit3 = axisParamsAt(c, sunLon, 3 * 360 + sunLon);
    expect(orbit3.obliquityDeg).toBeGreaterThan(orbit0.obliquityDeg);
  });

  it('includes both formula strings in the axis cache key', () => {
    const base = formulaConfig('23.4397', '90');
    const tiltChanged = cloneConfig(base);
    tiltChanged.tiltFormula = '30';
    const leanChanged = cloneConfig(base);
    leanChanged.leanFormula = '120';
    expect(axisConfigKey(base)).not.toBe(axisConfigKey(tiltChanged));
    expect(axisConfigKey(base)).not.toBe(axisConfigKey(leanChanged));
  });
});

describe('secular formulas evolve the seasonal aggregates across orbits', () => {
  const formulaConfig = (tiltFormula: string, leanFormula: string) => {
    const c = cloneConfig(REALISTIC);
    c.axisMode = 'formula';
    c.tiltFormula = tiltFormula;
    c.leanFormula = leanFormula;
    return c;
  };

  it('axisIsSecular only flags formulas that read year, t, or orbit', () => {
    expect(axisIsSecular(formulaConfig('30 + 10*wave(phase)', '90'))).toBe(false);
    expect(axisIsSecular(formulaConfig('8 + 28*sat(year/6)', '90'))).toBe(true);
    expect(axisIsSecular(formulaConfig('23.4', '90 + 5*t'))).toBe(true);
    expect(axisIsSecular(formulaConfig('20 + orbit', '90'))).toBe(true);
    expect(axisIsSecular(REALISTIC)).toBe(false); // not formula mode
  });

  it('a secular tilt deepens the climate cycle from one orbit to the next', () => {
    // Slow Awakening: tilt climbs 8 -> 36 across six orbits, so the warmth swing grows.
    const c = formulaConfig('8 + 28*sat(year/6)', '90');
    const lat = 47.61;
    const swing = (orbit: number) => {
      const cyc = seasonCycle(c, lat, orbit);
      return cyc.warmthMax - cyc.warmthMin;
    };
    expect(swing(5)).toBeGreaterThan(swing(0) * 1.5);
  });

  it('a phase-only formula gives the same cycle on every orbit', () => {
    const c = formulaConfig('30 + 18*wave(phase)', '90 + 80*wave(2*phase)');
    const lat = 47.61;
    const a = seasonCycle(c, lat, 0);
    const b = seasonCycle(c, lat, 5);
    expect(close(a.warmthMax, b.warmthMax)).toBe(true);
    expect(close(a.warmthMin, b.warmthMin)).toBe(true);
  });

  it('warmthAt tracks the current orbit for a secular world', () => {
    const c = formulaConfig('8 + 28*sat(year/6)', '90');
    const lat = 47.61;
    // Peak-summer felt warmth should rise as the tilt awakens over the orbits.
    const warmEarly = warmthAt(c, lat, 0, 172);
    const warmLate = warmthAt(c, lat, 5, 172);
    expect(warmLate).toBeGreaterThan(warmEarly);
  });

  it('maxPoleStep stays tiny for the smooth examples and spikes for a teleport', () => {
    // Every shipped example glides; raw degree jumps that are whole turns (Wandering
    // Pole, 1080 = 3*360) are continuous in the pole vector.
    for (const ex of [
      ['28 + 22*wave(phase)', '90'],
      ['30 + 18*wave(phase)', '90 + 80*wave(2*phase)'],
      ['40 + 12*wave(phase)', '90 + 1080*phase'],
      ['8 + 28*sat(year/6)', '90'],
      ['65 + 30*wave(phase)', '90 + 70*wave(phase)'],
    ]) {
      expect(maxPoleStep(formulaConfig(ex[0], ex[1]))).toBeLessThan(0.05);
    }
    // A lean that does not close on a whole turn teleports the pole at the year wrap.
    expect(maxPoleStep(formulaConfig('40', '90 + 1000*phase'))).toBeGreaterThan(0.2);
    // A tilt that snaps from 30 back to 0 at the wrap also jumps.
    expect(maxPoleStep(formulaConfig('30*phase', '90'))).toBeGreaterThan(0.2);
  });

  it('the shipped Maelstrom example is smooth, aperiodic, and wildly varied', () => {
    const ex = FORMULA_EXAMPLES.find((e) => e.name === 'Maelstrom');
    expect(ex).toBeTruthy();
    const c = formulaConfig(ex!.tiltFormula, ex!.leanFormula);
    // Smooth: no Sun teleport (stays under the UI warning threshold).
    expect(maxPoleStep(c)).toBeLessThan(0.05);
    // Aperiodic: it reads year, so each orbit genuinely differs.
    expect(axisIsSecular(c)).toBe(true);
    // No two years the same: somewhere in the year the declination differs a lot between
    // orbits (a single day can coincide by chance, so compare the whole-year signature).
    const decAt = (orbit: number, day: number) => declinationForDay(c, day, accumulatedLonDeg(orbit, day));
    const yearMaxDiff = (o1: number, o2: number) => {
      let m = 0;
      for (let d = 1; d <= 365; d += 5) m = Math.max(m, Math.abs(decAt(o1, d) - decAt(o2, d)));
      return m;
    };
    expect(yearMaxDiff(0, 7)).toBeGreaterThan(15);
    expect(yearMaxDiff(3, 20)).toBeGreaterThan(15);
    // Truly aperiodic: the rational version repeated every 9000 years, but the irrational
    // (sqrt2/sqrt3) frequencies break any finite period, so even year 9000 differs from year 0.
    expect(yearMaxDiff(0, 9000)).toBeGreaterThan(15);
    // Wildly varied: declination reaches far toward both poles somewhere in 40 orbits.
    let dMin = 90;
    let dMax = -90;
    for (let o = 0; o < 40; o++) {
      for (let d = 1; d <= 365; d += 7) {
        const dec = decAt(o, d);
        dMin = Math.min(dMin, dec);
        dMax = Math.max(dMax, dec);
      }
    }
    expect(dMax).toBeGreaterThan(70);
    expect(dMin).toBeLessThan(-70);
  });

  it('the shipped Fractal Coastline example is smooth, self-similar, and aperiodic', () => {
    const ex = FORMULA_EXAMPLES.find((e) => e.name === 'Fractal Coastline');
    expect(ex).toBeTruthy();
    const c = formulaConfig(ex!.tiltFormula, ex!.leanFormula);
    // Smooth: the stacked octaves are a finite (truncated Weierstrass) sum, so the pole
    // never teleports despite the fine structure.
    expect(maxPoleStep(c)).toBeLessThan(0.05);
    // Aperiodic: two slow out-of-step year drifts keep orbits from repeating.
    expect(axisIsSecular(c)).toBe(true);
    const decAt = (orbit: number, day: number) => declinationForDay(c, day, accumulatedLonDeg(orbit, day));
    const yearMaxDiff = (o1: number, o2: number) => {
      let m = 0;
      for (let d = 1; d <= 365; d += 5) m = Math.max(m, Math.abs(decAt(o1, d) - decAt(o2, d)));
      return m;
    };
    expect(yearMaxDiff(3, 20)).toBeGreaterThan(10);
    // Self-similar fine structure: the yearly declination curve turns many more times
    // than a plain tilted world (which has exactly two: one solstice each way). Count
    // the sign changes of the day-to-day difference over one orbit.
    const turns = (orbit: number) => {
      let count = 0;
      let prev = decAt(orbit, 2) - decAt(orbit, 1);
      for (let d = 2; d < 365; d++) {
        const diff = decAt(orbit, d + 1) - decAt(orbit, d);
        if (diff !== 0 && prev !== 0 && Math.sign(diff) !== Math.sign(prev)) count++;
        if (diff !== 0) prev = diff;
      }
      return count;
    };
    expect(turns(0)).toBeGreaterThan(6);
    // Wildly varied: the declination still sweeps far toward both poles.
    let dMin = 90;
    let dMax = -90;
    for (let o = 0; o < 30; o++) {
      for (let d = 1; d <= 365; d += 7) {
        const dec = decAt(o, d);
        dMin = Math.min(dMin, dec);
        dMax = Math.max(dMax, dec);
      }
    }
    expect(dMax).toBeGreaterThan(55);
    expect(dMin).toBeLessThan(-50);
  });
});

describe('spin formula drives the rotation speed', () => {
  const spinConfig = (spinFormula: string) => {
    const c = cloneConfig(REALISTIC);
    c.spinFormula = spinFormula;
    return c;
  };
  const lonAtPhase = (phase: number) => phase * 360; // sunLon for a given fraction of orbit

  it('the default "1" formula is an ordinary constant spin', () => {
    expect(spinMultiplierAt(REALISTIC, 0)).toBe(1);
    expect(spinMultiplierAt(REALISTIC, 123)).toBe(1);
    // solarDayHours is unchanged from the plain base rate.
    expect(close(solarDayHours(REALISTIC), solarDayHours(REALISTIC, 90), 1e-9)).toBe(true);
  });

  it('evaluates the multiplier against the orbital phase', () => {
    const c = spinConfig('cwave(phase)');
    expect(close(spinMultiplierAt(c, lonAtPhase(0)), 1)).toBe(true); // cos(0)
    expect(close(spinMultiplierAt(c, lonAtPhase(0.25)), 0, 1e-9)).toBe(true); // cos(pi/2)
    expect(close(spinMultiplierAt(c, lonAtPhase(0.5)), -1)).toBe(true); // cos(pi)
  });

  it('scales the sidereal spin rate by the multiplier', () => {
    const c = spinConfig('0.5');
    expect(close(spinRateDegPerHour(c, 0), spinRateDegPerHour(REALISTIC, 0) * 0.5)).toBe(true);
  });

  it('makes the solar day vary through the year and reverse the Sun when the spin flips', () => {
    const c = spinConfig('cwave(phase)');
    // Near phase 0 the spin is full and prograde, so the Sun rises in the east (+1).
    expect(apparentSolarSpinSign(c, lonAtPhase(0.02), lonAtPhase(0.02))).toBe(1);
    // Past the standstill the multiplier is negative, so the apparent motion reverses.
    expect(apparentSolarSpinSign(c, lonAtPhase(0.5), lonAtPhase(0.5))).toBe(-1);
    // A day near the standstill (multiplier ~ 0) lasts far longer than a brisk day.
    const briskDay = solarDayHours(c, lonAtPhase(0.0), lonAtPhase(0.0));
    const slowDay = solarDayHours(c, lonAtPhase(0.24), lonAtPhase(0.24));
    expect(slowDay).toBeGreaterThan(briskDay * 2);
  });

  it('keeps the spin formula out of the axis cache key (it does not move the pole)', () => {
    const a = spinConfig('1');
    const b = spinConfig('cwave(phase)');
    expect(axisConfigKey(a)).toBe(axisConfigKey(b));
  });

  it('detects a zero-crossing (reversing) spin but not a positive one', () => {
    expect(spinReverses(spinConfig('cwave(phase)'))).toBe(true); // dips to -1
    expect(spinReverses(spinConfig('0.55 + 0.45*cwave(phase)'))).toBe(false); // min 0.1
    expect(spinReverses(spinConfig('0.4 + 0.3*wave(2*phase)'))).toBe(false); // min 0.1
    expect(spinReverses(REALISTIC)).toBe(false); // constant spin
    const retro = cloneConfig(REALISTIC);
    retro.prograde = false;
    expect(spinReverses(retro)).toBe(false); // constant retrograde does not flip
  });

  it('reports the base spin (multiplier 1) when no orbital position is given', () => {
    expect(spinMultiplierAt(spinConfig('cwave(phase)'))).toBe(1);
    expect(spinMultiplierAt(spinConfig('0.4 + 0.3*wave(2*phase)'))).toBe(1);
  });

  it('clamps an absurd multiplier so the rate and solar day stay finite', () => {
    const c = spinConfig('1e308');
    const rate = spinRateDegPerHour(c, 90, 90);
    expect(Number.isFinite(rate)).toBe(true);
    const day = solarDayHours(c, 90, 90);
    expect(Number.isFinite(day)).toBe(true);
    expect(day).toBeGreaterThan(0);
  });
});

describe('shared solar-geometry helpers', () => {
  const D = Math.PI / 180;

  it('sunriseHourAngleRad: equator and equinox give a 12-hour day', () => {
    expect(close(sunriseHourAngleRad(0, 0), Math.PI / 2)).toBe(true);
    expect(close(sunriseHourAngleRad(45 * D, 0), Math.PI / 2)).toBe(true);
  });

  it('sunriseHourAngleRad: at a pole the Sun is up only when the declination is on its side', () => {
    // Sun strictly above the horizon (dec same sign as the pole) is polar day.
    expect(sunriseHourAngleRad(90 * D, 10 * D)).toBe(Math.PI);
    expect(sunriseHourAngleRad(-90 * D, -10 * D)).toBe(Math.PI);
    // Sun strictly below is polar night.
    expect(sunriseHourAngleRad(90 * D, -10 * D)).toBe(0);
    // Exactly on the horizon (dec = 0) counts as no daylight, not midnight Sun.
    expect(sunriseHourAngleRad(90 * D, 0)).toBe(0);
    expect(sunriseHourAngleRad(-90 * D, 0)).toBe(0);
  });

  it('sunriseHourAngleRad: high latitude near solstice is polar day or night', () => {
    expect(sunriseHourAngleRad(80 * D, 23.44 * D)).toBe(Math.PI); // arctic summer
    expect(sunriseHourAngleRad(80 * D, -23.44 * D)).toBe(0); // arctic winter
  });

  it('culminationAltitudesDeg: noon and midnight Sun heights', () => {
    // Equator at equinox: Sun overhead at noon, straight down at midnight.
    const eq = culminationAltitudesDeg(0, 0);
    expect(close(eq.upperDeg, 90)).toBe(true);
    expect(close(eq.lowerDeg, -90)).toBe(true);
    // 45N at the June solstice: noon Sun = 90 - (lat - dec) = 68.44.
    const mid = culminationAltitudesDeg(45 * D, 23.44 * D);
    expect(close(mid.upperDeg, 90 - (45 - 23.44))).toBe(true);
  });
});
