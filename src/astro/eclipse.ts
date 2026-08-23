import {
  AU_KM,
  EARTH_RADIUS_KM,
  MOON_RADIUS_KM,
  SUN_RADIUS_KM,
  moonTopocentric,
  observerOffsetKm,
  SUN_ANGULAR_RADIUS_DEG,
} from './moon';
import type { MoonState } from './moon';
import { sunDirEcliptic } from './orientation';
import { RAD, angleBetweenDeg, clamp, dot, norm, normalize, scale, sub } from './vec';
import type { Mat3, V3 } from './vec';

// The conventional 2% atmospheric allowance enlarges Earth's eclipse shadow.
const ATMOSPHERE_ENLARGEMENT = 1.02;

/** Solar eclipse classifications for a surface observer. */
export type SolarEclipseKind = 'none' | 'partial' | 'annular' | 'total';
/** Geocentric lunar eclipse classifications. */
export type LunarEclipseKind = 'none' | 'penumbral' | 'partial' | 'total';

/** Solar eclipse geometry for one surface observer. */
export interface SolarEclipse {
  kind: SolarEclipseKind;
  /** Fraction of the Sun's DIAMETER covered. >= 1 during totality. */
  magnitude: number;
  /** Fraction of the Sun's disc AREA covered, 0..1. This is what dims the daylight. */
  obscuration: number;
  /** Angular separation of the two centres, degrees. */
  separationDeg: number;
  /** Apparent radii, degrees; their ratio decides annular versus total. */
  sunRadiusDeg: number;
  moonRadiusDeg: number;
}

/** Geocentric lunar eclipse geometry. */
export interface LunarEclipse {
  kind: LunarEclipseKind;
  /** Umbral magnitude: fraction of the lunar diameter inside the umbra. */
  magnitude: number;
  /** Penumbral magnitude, useful for the faint shading before an umbral bite appears. */
  penumbralMagnitude: number;
  /** Umbral immersion, from 0 outside the umbra to 1 fully immersed. */
  immersion: number;
  /** Umbra radius at the Moon, in lunar radii. */
  umbraRadii: number;
  /** Offset of the Moon's centre from the shadow axis, in lunar radii. */
  missRadii: number;
}

const NO_SOLAR_ECLIPSE: SolarEclipse = {
  kind: 'none',
  magnitude: 0,
  obscuration: 0,
  separationDeg: 180,
  sunRadiusDeg: 0,
  moonRadiusDeg: 0,
};

const NO_LUNAR_ECLIPSE: LunarEclipse = {
  kind: 'none',
  magnitude: 0,
  penumbralMagnitude: 0,
  immersion: 0,
  umbraRadii: 0,
  missRadii: Infinity,
};

/** Reportable lunar depth, using penumbral magnitude when umbral magnitude is zero. */
export function lunarDepth(e: LunarEclipse): number {
  if (e.kind === 'none') return 0;
  return e.kind === 'penumbral' ? e.penumbralMagnitude : e.magnitude;
}

// Disc overlap as a fraction of the first disc's area.
function discOverlapFraction(R: number, r: number, d: number): number {
  if (d >= R + r) return 0;
  if (d <= Math.abs(R - r)) {
    const small = Math.min(R, r);
    return (small * small) / (R * R);
  }
  const d2 = d * d;
  const a =
    r * r * Math.acos(clamp((d2 + r * r - R * R) / (2 * d * r), -1, 1)) +
    R * R * Math.acos(clamp((d2 + R * R - r * r) / (2 * d * R), -1, 1)) -
    0.5 * Math.sqrt(Math.max(0, (-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)));
  return clamp(a / (Math.PI * R * R), 0, 1);
}

/** Solar eclipse seen from one surface location at one instant. */
export function solarEclipseAt(
  moon: MoonState,
  M: Mat3,
  latDeg: number,
  lonDeg: number,
): SolarEclipse {
  const observer = observerOffsetKm(M, latDeg, lonDeg);
  const sunTopo = sub(scale(sunDirEcliptic(moon.sunLonDeg), AU_KM), observer);
  const moonTopo = moonTopocentric(moon, M, latDeg, lonDeg);

  const separationDeg = angleBetweenDeg(sunTopo, moonTopo.dir);
  const sunRadiusDeg = Math.asin(clamp(SUN_RADIUS_KM / norm(sunTopo), -1, 1)) * RAD;
  const moonRadiusDeg = moonTopo.angularRadiusDeg;

  if (separationDeg >= sunRadiusDeg + moonRadiusDeg) {
    return { ...NO_SOLAR_ECLIPSE, separationDeg, sunRadiusDeg, moonRadiusDeg };
  }

  let kind: SolarEclipseKind;
  let magnitude: number;
  if (separationDeg <= moonRadiusDeg - sunRadiusDeg) {
    kind = 'total';
    magnitude = moonRadiusDeg / sunRadiusDeg;
  } else if (separationDeg <= sunRadiusDeg - moonRadiusDeg) {
    kind = 'annular';
    magnitude = moonRadiusDeg / sunRadiusDeg;
  } else {
    kind = 'partial';
    magnitude = (sunRadiusDeg + moonRadiusDeg - separationDeg) / (2 * sunRadiusDeg);
  }

  return {
    kind,
    magnitude,
    obscuration: discOverlapFraction(sunRadiusDeg, moonRadiusDeg, separationDeg),
    separationDeg,
    sunRadiusDeg,
    moonRadiusDeg,
  };
}

/** Geocentric lunar eclipse at one instant. */
export function lunarEclipseAt(moon: MoonState): LunarEclipse {
  // The shadow points directly away from the Sun.
  const axis = scale(sunDirEcliptic(moon.sunLonDeg), -1);
  const along = dot(moon.posKm, axis);
  if (along <= 0) return NO_LUNAR_ECLIPSE; // Moon is on the sunlit side of the Earth

  const missKm = norm(sub(moon.posKm, scale(axis, along)));

  const umbraKm =
    (EARTH_RADIUS_KM - (along * (SUN_RADIUS_KM - EARTH_RADIUS_KM)) / AU_KM) *
    ATMOSPHERE_ENLARGEMENT;
  const penumbraKm =
    (EARTH_RADIUS_KM + (along * (SUN_RADIUS_KM + EARTH_RADIUS_KM)) / AU_KM) *
    ATMOSPHERE_ENLARGEMENT;

  const magnitude = (umbraKm + MOON_RADIUS_KM - missKm) / (2 * MOON_RADIUS_KM);
  const penumbralMagnitude = (penumbraKm + MOON_RADIUS_KM - missKm) / (2 * MOON_RADIUS_KM);

  let kind: LunarEclipseKind = 'none';
  if (missKm + MOON_RADIUS_KM <= umbraKm) kind = 'total';
  else if (missKm < umbraKm + MOON_RADIUS_KM) kind = 'partial';
  else if (missKm < penumbraKm + MOON_RADIUS_KM) kind = 'penumbral';

  return {
    kind,
    magnitude: Math.max(0, magnitude),
    penumbralMagnitude: Math.max(0, penumbralMagnitude),
    immersion: clamp(magnitude, 0, 1),
    umbraRadii: umbraKm / MOON_RADIUS_KM,
    missRadii: missKm / MOON_RADIUS_KM,
  };
}

function shadowAxisDir(moon: MoonState): V3 {
  return normalize(sub(moon.posKm, scale(sunDirEcliptic(moon.sunLonDeg), AU_KM)));
}

/** Moon-shadow axis intersection with Earth in the ecliptic frame, or null. */
export function solarShadowAxisPointKm(moon: MoonState): V3 | null {
  const dir = shadowAxisDir(moon);
  const b = 2 * dot(moon.posKm, dir);
  const c = dot(moon.posKm, moon.posKm) - EARTH_RADIUS_KM * EARTH_RADIUS_KM;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const t = Math.min((-b - root) / 2, (-b + root) / 2);
  if (t <= 0) return null;
  return [
    moon.posKm[0] + dir[0] * t,
    moon.posKm[1] + dir[1] * t,
    moon.posKm[2] + dir[2] * t,
  ];
}

/**
 * Display centre for a candidate solar shadow patch, including penumbral limb grazes.
 * In a 20-year sample, 17 of 46 eclipses had no shadow-axis intersection.
 */
export function solarShadowCentreKm(moon: MoonState): V3 | null {
  const hit = solarShadowAxisPointKm(moon);
  if (hit) return hit;
  if (!solarEclipsePossible(moon)) return null;

  const dir = shadowAxisDir(moon);
  const t = -dot(moon.posKm, dir);
  if (t <= 0) return null; // the planet is behind the Moon, so nothing is cast on it
  const closest: V3 = [
    moon.posKm[0] + dir[0] * t,
    moon.posKm[1] + dir[1] * t,
    moon.posKm[2] + dir[2] * t,
  ];
  return scale(normalize(closest), EARTH_RADIUS_KM);
}

/**
 * Conservative geocentric solar-eclipse filter padded by horizontal parallax.
 * A 20-year sample had 2191 candidates for 2183 exact hits, with no false negatives.
 */
export function solarEclipsePossible(moon: MoonState): boolean {
  const sunDir = sunDirEcliptic(moon.sunLonDeg);
  const separationDeg = angleBetweenDeg(moon.dir, sunDir);
  const sunRadiusDeg = SUN_ANGULAR_RADIUS_DEG;
  const parallaxDeg = Math.asin(clamp(EARTH_RADIUS_KM / moon.distanceKm, -1, 1)) * RAD;
  return separationDeg < sunRadiusDeg + moon.angularRadiusDeg + parallaxDeg;
}
