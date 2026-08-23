import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { dirFromAltAz, discScale, drawnRadiusDeg, screenAngleAt, tangentToward } from './skyGeometry';

// Wrap to (-180, 180] degrees.
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const deg = (r: number) => (r * 180) / Math.PI;

describe('directions on the sky sphere', () => {
  it('gives a tangent that is perpendicular to where you are looking', () => {
    const from = dirFromAltAz(37, 145);
    for (const [alt, az] of [[10, 20], [80, 200], [-30, 300], [37, 146]]) {
      const t = tangentToward(from, dirFromAltAz(alt, az));
      expect(t.length()).toBeCloseTo(1, 12);
      expect(t.dot(from)).toBeCloseTo(0, 12);
    }
  });

  it('survives a target that coincides with the point itself', () => {
    // Coincident directions at new Moon must not produce NaNs.
    const from = dirFromAltAz(20, 90);
    const t = tangentToward(from, from.clone());
    expect(Number.isFinite(t.x + t.y + t.z)).toBe(true);
    expect(t.length()).toBeCloseTo(1, 12);
  });

  it('puts the lit limb along the Sun as the sprite is actually drawn', () => {
    // Compare with an independent projection because the camera-space shortcut can miss by 45 degrees.
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
    const R = 450;
    let checked = 0;
    for (const [cAlt, cAz] of [[20, 180], [0, 0], [45, 90]]) {
      camera.position.set(0, 0, 0);
      camera.lookAt(dirFromAltAz(cAlt, cAz).multiplyScalar(10));
      camera.updateMatrixWorld();

      for (const [mAlt, mAz] of [[20, 180], [30, 200], [40, 220], [15, 235], [0, 0], [45, 90]]) {
        for (const [sAlt, sAz] of [[45, 150], [10, 300], [70, 40]]) {
          const moonDir = dirFromAltAz(mAlt, mAz);
          const sunDir = dirFromAltAz(sAlt, sAz);
          const moonNdc = moonDir.clone().multiplyScalar(R).project(camera);
          // Compare only visible directions.
          if (Math.abs(moonNdc.x) > 1 || Math.abs(moonNdc.y) > 1 || moonNdc.z > 1) continue;
          const sunNdc = sunDir.clone().multiplyScalar(R).project(camera);
          if (sunNdc.z > 1) continue;

          const sunOnScreen = Math.atan2(
            sunNdc.y - moonNdc.y,
            (sunNdc.x - moonNdc.x) * camera.aspect,
          );
          const drawn = screenAngleAt(camera, moonDir, sunDir);
          expect(wrapDeg(deg(drawn) - deg(sunOnScreen))).toBeCloseTo(0, 4);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(8);
  });

  it('would catch the shortcut that used to be wrong', () => {
    // Dropping camera-space z agrees at frame centre but fails badly off-axis.
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
    camera.position.set(0, 0, 0);
    camera.lookAt(dirFromAltAz(20, 180).multiplyScalar(10));
    camera.updateMatrixWorld();
    const rot = new THREE.Matrix3().setFromMatrix4(camera.matrixWorldInverse);
    const R = 450;
    const sunDir = dirFromAltAz(45, 150);

    const compare = (mAlt: number, mAz: number) => {
      const moonDir = dirFromAltAz(mAlt, mAz);
      const along = tangentToward(moonDir, sunDir);
      const shortcut = (() => {
        const c = along.clone().applyMatrix3(rot);
        return deg(Math.atan2(c.y, c.x));
      })();
      const actual = deg(screenAngleAt(camera, moonDir, sunDir));
      const here = moonDir.clone().multiplyScalar(R).project(camera);
      const there = moonDir.clone().addScaledVector(along, 1e-3).normalize()
        .multiplyScalar(R).project(camera);
      const projected = deg(Math.atan2(there.y - here.y, (there.x - here.x) * camera.aspect));
      expect(Math.abs(wrapDeg(actual - projected))).toBeLessThan(0.01);
      return Math.abs(wrapDeg(shortcut - projected));
    };
    expect(compare(20, 180)).toBeLessThan(0.01); // dead centre: indistinguishable
    expect(compare(40, 220)).toBeGreaterThan(10); // measured about 15 degrees out
    expect(compare(5, 250)).toBeGreaterThan(30); // measured about 45 degrees out
  });

  it('points a tangent the way you would expect on the sky', () => {
    const from = dirFromAltAz(0, 180);
    const t = tangentToward(from, dirFromAltAz(90, 0));
    expect(t.y).toBeCloseTo(1, 9);
    const along = tangentToward(from, dirFromAltAz(0, 200));
    expect(along.y).toBeCloseTo(0, 9);
  });
});

describe('how big a body is actually drawn', () => {
  it('agrees between the size drawn and the size reported', () => {
    // Sprite scale and culling radius must describe the same enlarged disc.
    const shell = 450;
    for (const trueRadiusDeg of [0.25, 0.2666, 0.28, 0.5]) {
      const worldDiameter = discScale(trueRadiusDeg, shell);
      // Linear scale differs from the exact tangent by under 0.5% at tested sizes.
      const subtendedDeg = deg(Math.atan(worldDiameter / 2 / shell));
      const claimed = drawnRadiusDeg(trueRadiusDeg);
      expect(Math.abs(subtendedDeg - claimed) / claimed).toBeLessThan(0.005);
    }
  });

  it('reports a disc bigger than life, which is why the horizon test needs it', () => {
    // The enlarged disc remains visible after its centre sets.
    const moonRadiusDeg = 0.2589;
    expect(drawnRadiusDeg(moonRadiusDeg)).toBeGreaterThan(moonRadiusDeg);
    expect(drawnRadiusDeg(moonRadiusDeg)).toBeGreaterThan(1);
  });
});
