import * as THREE from 'three';
import { smoothstep, DEG } from '../astro/vec';

/** Sky dome radius in world units. */
export const DOME_RADIUS = 500;

// Shell order controls depth occlusion; label depth testing is disabled.
export const GRID_RADIUS = DOME_RADIUS * 0.86;
export const SUN_RADIUS = DOME_RADIUS * 0.92;
// The Moon sits inside the Sun so it can eclipse it.
export const MOON_SHELL_RADIUS = DOME_RADIUS * 0.9;
export const STARS_RADIUS = DOME_RADIUS * 0.95;
export const LABEL_RADIUS = DOME_RADIUS * 0.8;

/** Separation beyond which the Moon is drawn at its exact position, degrees. */
const MAGNIFY_FADE_DEG = 6;

/** Direction unit vector in the local sky frame for an altitude/azimuth in degrees. */
export function dirFromAltAz(altDeg: number, azDeg: number): THREE.Vector3 {
  const a = altDeg * DEG;
  const z = azDeg * DEG;
  return new THREE.Vector3(
    Math.cos(a) * Math.sin(z),
    Math.sin(a),
    -Math.cos(a) * Math.cos(z),
  );
}

/** Sprite scale on a shell of the given radius for a disc of some angular radius. */
export function discScale(radiusDeg: number, shellRadius: number): number {
  return shellRadius * 2 * radiusDeg * DEG * DISC_EXAGGERATION;
}

/** Enlarged angular radius used for drawing and whole-disc horizon culling. */
export function drawnRadiusDeg(radiusDeg: number): number {
  return radiusDeg * DISC_EXAGGERATION;
}

/** Unit tangent at `from` along the great circle toward `to`. */
export function tangentToward(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
  const t = to.clone().addScaledVector(from, -from.dot(to));
  return t.lengthSq() < 1e-12 ? new THREE.Vector3(1, 0, 0) : t.normalize();
}

/**
 * Project the direction toward `target` through the camera to get its screen angle at `at`.
 * Rotating into camera space and dropping z is wrong off-axis: 3 degrees at 21, 15 at 40,
 * and 45 at 70.
 */
export function screenAngleAt(
  camera: THREE.PerspectiveCamera,
  at: THREE.Vector3,
  target: THREE.Vector3,
): number {
  const SHELL = 1; // any radius does: the angle is a direction, not a distance
  const along = tangentToward(at, target);
  const here = at.clone().multiplyScalar(SHELL).project(camera);
  const there = at
    .clone()
    .addScaledVector(along, 1e-3)
    .normalize()
    .multiplyScalar(SHELL)
    .project(camera);
  // Undo NDC's aspect-ratio squeeze to measure the angle in sprite pixel space.
  const { aspect } = camera;
  return Math.atan2(there.y - here.y, (there.x - here.x) * aspect);
}

// Eightfold discs remain readable; magnifying their separation preserves eclipse overlap.
// Fade-in gives 7.86x separation at 0.5 degrees, about 2% width overlap at true contact.
const DISC_EXAGGERATION = 8;

/** Magnify the Moon's solar offset with the discs, fading to its true position by 6 degrees. */
export function eclipseMagnifiedDir(sunDir: THREE.Vector3, moonDir: THREE.Vector3): THREE.Vector3 {
  const cos = Math.min(1, Math.max(-1, sunDir.dot(moonDir)));
  const sepDeg = Math.acos(cos) / DEG;
  if (sepDeg > MAGNIFY_FADE_DEG || sepDeg < 1e-6) return moonDir.clone();
  const factor = 1 + (DISC_EXAGGERATION - 1) * (1 - smoothstep(0, MAGNIFY_FADE_DEG, sepDeg));
  const axis = new THREE.Vector3().crossVectors(sunDir, moonDir);
  if (axis.lengthSq() < 1e-12) return moonDir.clone();
  axis.normalize();
  return sunDir
    .clone()
    .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, sepDeg * DEG * factor));
}
