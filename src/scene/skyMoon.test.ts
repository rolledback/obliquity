import { describe, expect, it } from 'vitest';
import { DISC_PX, buildSurfaceLookup, discCoords, discToMapPixel, fullySet, unlitFaceAlpha } from './skyMoon';
import { drawnRadiusDeg } from './skyGeometry';

// Visible-disc unit vector, with u right, v up, and w toward the observer.
const on = (u: number, v: number): [number, number, number] => [
  u,
  v,
  Math.sqrt(Math.max(0, 1 - u * u - v * v)),
];

describe('mapping the Moon disc onto its surface map', () => {
  const W = 1024;
  const H = 512;
  const at = (u: number, v: number) => discToMapPixel(...on(u, v), W, H);

  it('puts the centre of the disc at the centre of the map', () => {
    expect(at(0, 0)).toEqual([W / 2, H / 2]);
  });

  it('spans exactly the near hemisphere from limb to limb', () => {
    expect(at(1, 0)[0]).toBe(Math.round(W * 0.75));
    expect(at(-1, 0)[0]).toBe(Math.round(W * 0.25));
  });

  it('runs latitude up the disc, with the poles at the map edges', () => {
    expect(at(0, 1)[1]).toBe(0); // top of the disc is the north pole, the top row
    expect(at(0, -1)[1]).toBe(H - 1); // bottom is the south pole
    // Check containment independently of the implementation's index expression.
    const v = 0.5;
    const latFrac = Math.asin(v) / Math.PI; // 1/6 of a turn above the equator
    const row = at(0, v)[1];
    expect(0.5 - (row + 1) / H).toBeLessThanOrEqual(latFrac);
    expect(latFrac).toBeLessThan(0.5 - row / H);
  });

  it('always returns the texel that contains the sampled point', () => {
    for (let u = -0.95; u <= 0.95; u += 0.017) {
      for (let v = -0.95; v <= 0.95; v += 0.019) {
        if (u * u + v * v > 0.9) continue;
        const w = Math.sqrt(Math.max(0, 1 - u * u - v * v));
        const [x, y] = discToMapPixel(u, v, w, W, H);
        const lonFrac = Math.atan2(u, w) / (Math.PI * 2);
        const latFrac = Math.asin(v) / Math.PI;
        expect(x / W).toBeLessThanOrEqual(0.5 + lonFrac);
        expect(0.5 + lonFrac).toBeLessThan((x + 1) / W);
        expect(y / H).toBeLessThanOrEqual(0.5 - latFrac);
        expect(0.5 - latFrac).toBeLessThan((y + 1) / H);
      }
    }
  });

  it('moves monotonically across the disc', () => {
    let prev = -1;
    for (let u = -0.99; u <= 0.99; u += 0.05) {
      const x = discToMapPixel(...on(u, 0), W, H)[0];
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
  });

  it('never indexes outside the map', () => {
    for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7]]) {
      const [x, y] = discToMapPixel(...on(u, v), W, H);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(W);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(H);
    }
  });
});

describe('the unlit face across an eclipse edge', () => {
  it('runs continuously from earthshine to silhouette', () => {
    let worstStep = 0;
    let previous = unlitFaceAlpha(0);
    for (let obscuration = 0; obscuration <= 1; obscuration += 0.001) {
      const alpha = unlitFaceAlpha(obscuration);
      worstStep = Math.max(worstStep, Math.abs(alpha - previous));
      previous = alpha;
      expect(alpha).toBeGreaterThanOrEqual(0.35 - 1e-12);
      expect(alpha).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(worstStep).toBeLessThan(0.02);
  });

  it('anchors both ends, so nothing else has to change', () => {
    // Daytime earthshine is translucent, but a solar silhouette is opaque.
    expect(unlitFaceAlpha(0)).toBeCloseTo(0.35, 12);
    expect(unlitFaceAlpha(1)).toBeCloseTo(1, 12);
    expect(unlitFaceAlpha(0.5)).toBeCloseTo(1, 12); // fully opaque well before totality
  });

  it('rises monotonically, so the Moon never brightens as it covers more Sun', () => {
    let previous = -Infinity;
    for (let obscuration = 0; obscuration <= 1; obscuration += 0.005) {
      const alpha = unlitFaceAlpha(obscuration);
      expect(alpha).toBeGreaterThanOrEqual(previous);
      previous = alpha;
    }
  });
});

describe('the precomputed surface lookup', () => {
  it('gives exactly what computing it per pixel would have', () => {
    // Still exhaustive over all 16,384 cells, but the mismatch is COLLECTED and asserted
    // once. One expect() per pixel cost 536 ms, essentially all of it Vitest assertion
    // overhead rather than arithmetic.
    const W = 512;
    const H = 256;
    const lookup = buildSurfaceLookup(W, H);
    expect(lookup.length).toBe(DISC_PX * DISC_PX);

    let inside = 0;
    let outside = 0;
    let firstBad: string | null = null;
    for (let py = 0; py < DISC_PX; py++) {
      for (let px = 0; px < DISC_PX; px++) {
        const { u, v } = discCoords(px, py);
        const rr = u * u + v * v;
        const got = lookup[py * DISC_PX + px];
        if (rr > 1) {
          outside++;
          if (got !== -1 && !firstBad) firstBad = `(${px},${py}) outside the disc gave ${got}, want -1`;
          continue;
        }
        inside++;
        const w = Math.sqrt(Math.max(0, 1 - rr));
        const [mx, my] = discToMapPixel(u, v, w, W, H);
        const want = (my * W + mx) * 4;
        if (got !== want && !firstBad) firstBad = `(${px},${py}) gave ${got}, want ${want}`;
      }
    }
    expect(firstBad).toBeNull();
    expect(inside).toBeGreaterThan(0.7 * DISC_PX * DISC_PX);
    expect(outside).toBeGreaterThan(0);
  });

  it('never points outside the map it was built for', () => {
    for (const [W, H] of [[512, 256], [64, 32], [2048, 1024]]) {
      const lookup = buildSurfaceLookup(W, H);
      const limit = (W * H - 1) * 4;
      let firstBad: string | null = null;
      let checked = 0;
      for (const offset of lookup) {
        if (offset < 0) continue;
        checked++;
        if ((offset > limit || offset % 4 !== 0) && !firstBad) {
          firstBad = `${W}x${H}: offset ${offset} outside 0..${limit} or off a pixel boundary`;
        }
      }
      expect(firstBad).toBeNull();
      expect(checked).toBeGreaterThan(0);
    }
  });
});

describe('the Moon is an opaque rock when the sky is dark', () => {
  it('draws the unlit face solid at night, so stars cannot shine through it', () => {
    // Alpha must fully block the star field behind the transparent sprite.
    expect(unlitFaceAlpha(0, 0)).toBeCloseTo(1, 12);
    expect(unlitFaceAlpha(0.5, 0)).toBeCloseTo(1, 12);
  });

  it('keeps the daytime translucency, where an unlit limb really is invisible', () => {
    expect(unlitFaceAlpha(0, 1)).toBeCloseTo(0.35, 12);
  });

  it('is continuous and monotonic in the sky brightness, so dusk does not snap', () => {
    let worst = 0;
    let previous = unlitFaceAlpha(0, 0);
    for (let day = 0; day <= 1; day += 0.001) {
      const alpha = unlitFaceAlpha(0, day);
      worst = Math.max(worst, Math.abs(alpha - previous));
      expect(alpha).toBeLessThanOrEqual(previous + 1e-12); // brighter sky, never more opaque
      previous = alpha;
      expect(alpha).toBeGreaterThanOrEqual(0.35 - 1e-12);
      expect(alpha).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('is solid across the Sun whatever the sky is doing', () => {
    for (const day of [0, 0.25, 0.5, 0.75, 1]) {
      expect(unlitFaceAlpha(1, day)).toBeCloseTo(1, 12);
    }
  });
});

describe('the Moon sets behind the horizon rather than vanishing', () => {
  // The drawn disc is exaggerated, so a Moon whose CENTRE is just below the horizon still
  // has most of itself showing and the ground should hide the rest. Culling on the true
  // radius made it pop out of existence instead. Nothing pinned that: swapping the drawn
  // radius for the true one left every test in this file passing.
  const RADIUS = 0.259; // the Moon's real angular radius, degrees

  it('keeps drawing a Moon whose centre has just set', () => {
    expect(fullySet(0, RADIUS)).toBe(false);
    expect(fullySet(-0.5, RADIUS)).toBe(false);
    expect(fullySet(-1.5, RADIUS)).toBe(false);
  });

  it('drops it only once the whole drawn disc is down', () => {
    const gone = -drawnRadiusDeg(RADIUS) - 1;
    expect(fullySet(gone - 0.01, RADIUS)).toBe(true);
    // And that threshold has to be the ENLARGED disc, well past the true one.
    expect(gone).toBeLessThan(-RADIUS - 1);
  });
});
