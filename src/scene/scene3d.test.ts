import { describe, expect, it } from 'vitest';
import { DIAGRAM_SCALE, EARTH_RADIUS, TRUE_SCALE } from './scene3d';
import { AU_KM, EARTH_RADIUS_KM, MOON_RADIUS_KM, SEMI_MAJOR_AXIS_KM, SUN_RADIUS_KM } from '../astro/moon';

// A sphere's tangent edge gives asin(R / d), not atan(R / d).
const angularDiameterDeg = (radius: number, distance: number) =>
  (2 * Math.asin(radius / distance) * 180) / Math.PI;

const MOON_RADIUS = EARTH_RADIUS * (MOON_RADIUS_KM / EARTH_RADIUS_KM);

describe('the true-scale orbit layout', () => {
  it('reproduces the real angular sizes of the Sun and Moon', () => {
    // The layout is geocentric; surface observers see a slightly larger Moon.
    const sun = angularDiameterDeg(TRUE_SCALE.sunRadius, TRUE_SCALE.orbitRadius);
    const moon = angularDiameterDeg(MOON_RADIUS, TRUE_SCALE.moonOrbitRadius);
    expect(sun).toBeCloseTo(angularDiameterDeg(SUN_RADIUS_KM, AU_KM), 9);
    expect(moon).toBeCloseTo(angularDiameterDeg(MOON_RADIUS_KM, SEMI_MAJOR_AXIS_KM), 9);
    expect(sun).toBeCloseTo(0.532906, 6);
    expect(moon).toBeCloseTo(0.517929, 6);
  });

  it('makes the two discs very nearly the same size, which is why eclipses work', () => {
    const sun = angularDiameterDeg(TRUE_SCALE.sunRadius, TRUE_SCALE.orbitRadius);
    const moon = angularDiameterDeg(MOON_RADIUS, TRUE_SCALE.moonOrbitRadius);
    expect(Math.abs(sun - moon) / sun).toBeLessThan(0.03);
  });

  it('places everything at its real distance in Earth radii', () => {
    expect(TRUE_SCALE.moonOrbitRadius / EARTH_RADIUS).toBeCloseTo(SEMI_MAJOR_AXIS_KM / EARTH_RADIUS_KM, 9);
    expect(TRUE_SCALE.moonOrbitRadius / EARTH_RADIUS).toBeCloseTo(60.336, 3);
    expect(TRUE_SCALE.orbitRadius / EARTH_RADIUS).toBeCloseTo(AU_KM / EARTH_RADIUS_KM, 6);
    expect(TRUE_SCALE.sunRadius / EARTH_RADIUS).toBeCloseTo(SUN_RADIUS_KM / EARTH_RADIUS_KM, 9);
  });

  it('keeps the star sphere outside everything else in both layouts', () => {
    for (const profile of [DIAGRAM_SCALE, TRUE_SCALE]) {
      expect(profile.starRadius).toBeGreaterThan(profile.orbitRadius + profile.sunRadius);
      expect(profile.starRadius).toBeGreaterThan(profile.moonOrbitRadius);
    }
  });

  it('exaggerates in the diagram layout, and only in the ways claimed', () => {
    expect(DIAGRAM_SCALE.sunRadius / DIAGRAM_SCALE.orbitRadius).toBeGreaterThan(
      TRUE_SCALE.sunRadius / TRUE_SCALE.orbitRadius,
    );
    expect(DIAGRAM_SCALE.moonOrbitRadius).toBeLessThan(TRUE_SCALE.moonOrbitRadius);
    expect(EARTH_RADIUS).toBe(2.2);
  });
});
