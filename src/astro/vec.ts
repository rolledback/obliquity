// Minimal dependency-free 3D vector and 3x3 matrix helpers.
// Kept independent of Three.js so the astronomy math can be unit tested in Node.

export type V3 = readonly [number, number, number];
// Row-major 3x3 matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22].
export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/**
 * Unit vector for a geographic latitude/longitude (degrees) in the earth-fixed frame
 * (X through lon 0 on the equator, Z through the north pole). This is the local zenith.
 */
export function geographicUnit(latDeg: number, lonDeg: number): V3 {
  const phi = latDeg * DEG;
  const lam = lonDeg * DEG;
  const cphi = Math.cos(phi);
  return [cphi * Math.cos(lam), cphi * Math.sin(lam), Math.sin(phi)];
}

export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Rotation about the Y axis by angle (radians).
export function rotY(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

// Rotation about the Z axis by angle (radians).
export function rotZ(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function matMul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9) as number[];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3 + 0] * b[0 * 3 + c] +
        a[r * 3 + 1] * b[1 * 3 + c] +
        a[r * 3 + 2] * b[2 * 3 + c];
    }
  }
  return out as unknown as Mat3;
}

export function matMulAll(...mats: Mat3[]): Mat3 {
  return mats.reduce((acc, m) => matMul(acc, m));
}

export function matVec(m: Mat3, v: V3): V3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// Transpose, which for an orthonormal rotation matrix is also its inverse.
export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Positive modulo: result is always in [0, n), unlike the % operator for negative x. */
export function posMod(x: number, n: number): number {
  return ((x % n) + n) % n;
}

/** Shortest signed angular difference of a degree value, mapped into [-180, 180). */
export function wrapSignedDeg(deg: number): number {
  return posMod(deg + 180, 360) - 180;
}

/** Smooth cubic ramp from 0 to 1 as x goes from edge0 to edge1. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
