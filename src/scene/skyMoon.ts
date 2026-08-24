import * as THREE from 'three';
import { clamp, smoothstep } from '../astro/vec';
import {
  MOON_SHELL_RADIUS,
  dirFromAltAz,
  discScale,
  drawnRadiusDeg,
  eclipseMagnifiedDir,
  screenAngleAt,
} from './skyGeometry';

/** Everything the sky view needs to draw the Moon. */
export interface SkyMoonState {
  altDeg: number;
  azDeg: number;
  /** Lit fraction of the disc, 0..1, which sets the phase shape. */
  illuminated: number;
  /** Apparent radius of the disc in degrees, as seen from the observer. */
  radiusDeg: number;
  /** True only when Earth's umbra cuts the disc; penumbral dimming draws no bite. */
  umbralBite: boolean;
  /** Umbra radius and axis offset in lunar radii, for drawing a partial eclipse's bite. */
  umbraRadii: number;
  missRadii: number;
  /** Direction of the shadow's centre (the anti-solar point) for orienting that bite. */
  antiSunAltDeg: number;
  antiSunAzDeg: number;
  /** Lunar north, which fixes the tidally locked face while the terminator moves. */
  northAltDeg: number;
  northAzDeg: number;
}

const HALF_PI = Math.PI / 2;

/** Maximum cached phase textures. */
const PHASE_CACHE_LIMIT = 32;

/** Side of the square the Moon's disc is drawn into, in pixels. */
export const DISC_PX = 128;
/** Radius of the disc within that square, leaving a couple of pixels for the soft rim. */
export const DISC_R = DISC_PX / 2 - 2;

/** Disc coordinates of a pixel: u to the right, v up, both in radii from the centre. */
export function discCoords(px: number, py: number): { u: number; v: number } {
  return {
    u: (px - DISC_PX / 2 + 0.5) / DISC_R,
    v: -(py - DISC_PX / 2 + 0.5) / DISC_R, // canvas y runs downward
  };
}

/** Surface-map byte offset for each disc pixel, or -1 outside the disc. */
export function buildSurfaceLookup(mapWidth: number, mapHeight: number): Int32Array {
  const lookup = new Int32Array(DISC_PX * DISC_PX);
  for (let py = 0; py < DISC_PX; py++) {
    for (let px = 0; px < DISC_PX; px++) {
      const { u, v } = discCoords(px, py);
      const rr = u * u + v * v;
      if (rr > 1) {
        lookup[py * DISC_PX + px] = -1;
        continue;
      }
      const w = Math.sqrt(Math.max(0, 1 - rr));
      const [mx, my] = discToMapPixel(u, v, w, mapWidth, mapHeight);
      lookup[py * DISC_PX + px] = (my * mapWidth + mx) * 4;
    }
  }
  return lookup;
}

// Daytime earthshine alpha before eclipse darkening.
const EARTHSHINE_ALPHA = 0.35;

// Complete the earthshine-to-silhouette ramp within 6% obscuration.
const SILHOUETTE_OBSCURATION = 0.06;

/**
 * Alpha for the Moon's unlit face. It is opaque at night to cover stars, translucent by day
 * to simulate bright foreground sky, and opaque across the Sun. Both transitions are smooth.
 */
export function unlitFaceAlpha(solarObscuration: number, dayFactor = 1): number {
  const sky = 1 - (1 - EARTHSHINE_ALPHA) * clamp(dayFactor, 0, 1);
  return sky + (1 - sky) * smoothstep(0, SILHOUETTE_OBSCURATION, solarObscuration);
}

/** A little slack below the drawn disc, so it is never culled while still on screen. */
const HORIZON_MARGIN_DEG = 1;

/**
 * Has the whole DRAWN disc set? The disc is exaggerated, so culling on the true radius
 * snatches the Moon away while most of it is still above the horizon.
 */
export function fullySet(altDeg: number, radiusDeg: number): boolean {
  return altDeg < -drawnRadiusDeg(radiusDeg) - HORIZON_MARGIN_DEG;
}

/** Everything that decides what a phase disc looks like. */
interface PhaseRequest {
  illuminated: number;
  darkAlpha: number;
  umbralBite: boolean;
  umbraRadii: number;
  missRadii: number;
  /** Direction across the disc toward the Sun, radians, with the Moon's north at +v. */
  sunAngle: number;
  /** Direction toward the centre of Earth's shadow, for the umbral bite. */
  shadowAngle: number;
}

// Shared quantisation prevents cache keys and rendered inputs from drifting apart.
const PHASE_STEPS = { illuminated: 48, darkAlpha: 16, radii: 24, degrees: 5 } as const;

/**
 * Snap cache inputs and draw from those snapped values. This reduces 128x128 texture churn
 * and makes bucket error deterministic and at most half a bucket.
 */
function snapPhase(want: PhaseRequest) {
  const step = (value: number, per: number) => Math.round(value * per);
  // Ignore drifting shadow geometry when no bite is drawn.
  const shadowed = want.umbralBite && Number.isFinite(want.umbraRadii);
  const qIllum = step(want.illuminated, PHASE_STEPS.illuminated);
  const qDark = step(want.darkAlpha, PHASE_STEPS.darkAlpha);
  // Folding one turn prevents about one duplicate texture in twelve.
  const buckets = 360 / PHASE_STEPS.degrees;
  const fold = (n: number) => ((n % buckets) + buckets) % buckets;
  const qSun = fold(step((want.sunAngle * 180) / Math.PI, 1 / PHASE_STEPS.degrees));
  const qShadow = fold(step((want.shadowAngle * 180) / Math.PI, 1 / PHASE_STEPS.degrees));
  const qUmbra = shadowed ? step(want.umbraRadii, PHASE_STEPS.radii) : 0;
  const qMiss = shadowed ? step(want.missRadii, PHASE_STEPS.radii) : 0;
  const sun = (qSun * PHASE_STEPS.degrees * Math.PI) / 180;
  const shadow = (qShadow * PHASE_STEPS.degrees * Math.PI) / 180;
  return {
    key: shadowed
      ? [qIllum, qDark, qUmbra, qMiss, qSun, qShadow].join(',')
      : `plain:${qIllum},${qDark},${qSun}`,
    shadowed,
    illuminated: qIllum / PHASE_STEPS.illuminated,
    darkAlpha: qDark / PHASE_STEPS.darkAlpha,
    umbraRadii: qUmbra / PHASE_STEPS.radii,
    missRadii: qMiss / PHASE_STEPS.radii,
    sunU: Math.cos(sun),
    sunV: Math.sin(sun),
    shadowU: Math.cos(shadow),
    shadowV: Math.sin(shadow),
  };
}


/** Average brightness of the Moon map, so sampling it modulates rather than darkens. */
const MOON_MAP_MEAN = 150;

/** Map a visible-disc unit vector to the tidally locked equirectangular surface map. */
export function discToMapPixel(
  u: number,
  v: number,
  w: number,
  width: number,
  height: number,
): [number, number] {
  const lonFrac = Math.atan2(u, w) / (Math.PI * 2); // -0.25 .. 0.25 across the near side
  const latFrac = Math.asin(Math.max(-1, Math.min(1, v))) / Math.PI; // -0.5 .. 0.5
  const clamp = (n: number, hi: number) => Math.min(hi - 1, Math.max(0, n));
  // Floor selects the containing texel; rounding shifts samples half a texel, about 10.7 km.
  return [
    clamp(Math.floor((0.5 + lonFrac) * width), width),
    clamp(Math.floor((0.5 - latFrac) * height), height),
  ];
}

/** Draw the ground-view Moon with its phase, surface, and eclipse bite. */
export class SkyMoon {
  /** Where the Moon was last drawn, which near the Sun is not where it truly is. */
  private drawnDir: THREE.Vector3 | null = null;

  /** The direction the sprite was last placed at, or null when it is not drawn. */
  get lastDrawnDir(): THREE.Vector3 | null {
    return this.drawnDir;
  }
  private moon: THREE.Sprite;
  private moonMat!: THREE.SpriteMaterial;
  private phaseCache = new Map<string, THREE.CanvasTexture>();
  /** Surface pixels, or null while flat shading is used. */
  private moonMap: ImageData | null = null;
  /**
   * Surface-map offsets for the fixed 128x128 disc. Precomputation avoids about 12,000 atan2
   * and asin calls per phase texture; negative entries are outside the disc.
   */
  private surfaceLookup: Int32Array | null = null;

  constructor(
    scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {
    this.moon = this.makeMoonSprite();
    scene.add(this.moon);
    this.loadMoonMap();
  }

  private makeMoonSprite(): THREE.Sprite {
    this.moonMat = new THREE.SpriteMaterial({
      map: this.phaseTexture({
        illuminated: 1,
        darkAlpha: 0.35,
        umbralBite: false,
        umbraRadii: Infinity,
        missRadii: 0,
        sunAngle: HALF_PI,
        shadowAngle: -HALF_PI,
      }),
      depthWrite: false,
      // Depth testing lets ground hide the Moon; its 0.90 shell stays inside the Sun's 0.92.
      depthTest: true,
      transparent: true,
    });
    const s = new THREE.Sprite(this.moonMat);
    s.renderOrder = 4; // in front of the Sun, so it can eclipse it
    s.visible = false;
    return s;
  }
  /** Load surface pixels for the per-pixel phase rasteriser. */
  private loadMoonMap() {
    const img = new Image();
    img.onload = () => {
      const W = 512;
      const H = 256;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, W, H);
      this.moonMap = ctx.getImageData(0, 0, W, H);
      this.surfaceLookup = buildSurfaceLookup(W, H);
      // Repaint textures that used flat fallback shading.
      for (const t of this.phaseCache.values()) t.dispose();
      this.phaseCache.clear();
    };
    img.onerror = () => {
      console.warn(`Obliquity: could not load ${img.src}; the Moon will be drawn plain`);
    };
    img.src = `${import.meta.env.BASE_URL}textures/moon.webp`;
  }
  /** Relative surface brightness, or 1 before the map loads. */
  private surfaceShade(offset: number): number {
    const map = this.moonMap;
    if (!map || offset < 0) return 1;
    return (map.data[offset] + map.data[offset + 1] + map.data[offset + 2]) / 3 / MOON_MAP_MEAN;
  }
  /** Rasterise a spherical lunar phase and any curved umbral bite. */
  private phaseTexture(want: PhaseRequest): THREE.CanvasTexture {
    const { key, shadowed, illuminated, darkAlpha, sunU, sunV, shadowU, shadowV, umbraRadii, missRadii } =
      snapPhase(want);
    const cached = this.phaseCache.get(key);
    if (cached) {
      // Move hits to the back of the LRU cache.
      this.phaseCache.delete(key);
      this.phaseCache.set(key, cached);
      return cached;
    }

    const N = DISC_PX;
    const lookup = this.surfaceLookup;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(N, N);
    const data = img.data;

    const cosI = Math.min(1, Math.max(-1, 2 * illuminated - 1));
    const sinI = Math.sqrt(Math.max(0, 1 - cosI * cosI));
    const R = DISC_R;
    // Sun and shadow directions are independent in the lunar-north-up frame.

    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        // Scalars avoid roughly 16,000 temporary coordinate objects per texture.
        const u = (px - N / 2 + 0.5) / R;
        const v = -(py - N / 2 + 0.5) / R; // canvas y runs downward
        const rr = u * u + v * v;
        const o = (py * N + px) * 4;
        if (rr > 1) {
          data[o + 3] = 0;
          continue;
        }
        const w = Math.sqrt(Math.max(0, 1 - rr));
        const towardSun = u * sunU + v * sunV;
        const lit = towardSun * sinI + w * cosI > 0;

        let shade = 1;
        if (shadowed) {
          // Offset the umbra by `missRadii` lunar radii toward the anti-solar point.
          const du = u - missRadii * shadowU;
          const dv = v - missRadii * shadowV;
          const inUmbra = Math.sqrt(du * du + dv * dv) < umbraRadii;
          if (inUmbra) shade = 0;
        }

        let r: number;
        let g: number;
        let b: number;
        let a: number;
        const surf = this.surfaceShade(lookup ? lookup[py * N + px] : -1);
        if (shade === 0) {
          // Refracted sunlight makes the umbra copper.
          r = 150 * surf;
          g = 58 * surf;
          b = 34 * surf;
          a = 255;
        } else if (lit) {
          r = 246 * surf;
          g = 243 * surf;
          b = 233 * surf;
          a = 255;
        } else {
          // Ramp colour with alpha so earthshine also darkens smoothly into a silhouette.
          const toSilhouette = (darkAlpha - EARTHSHINE_ALPHA) / (1 - EARTHSHINE_ALPHA);
          const mix = (shine: number, dark: number) =>
            shine * surf * (1 - toSilhouette) + dark * toSilhouette;
          r = mix(74, 6);
          g = mix(82, 7);
          b = mix(102, 12);
          a = Math.round(255 * darkAlpha);
        }
        const edge = Math.min(1, (1 - Math.sqrt(rr)) * R * 0.9);
        data[o] = Math.max(0, Math.min(255, r));
        data[o + 1] = Math.max(0, Math.min(255, g));
        data[o + 2] = Math.max(0, Math.min(255, b));
        data[o + 3] = Math.round(a * Math.max(0, edge));
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    // The rasterised values are sRGB; treating them as linear washes out eclipse colours.
    tex.colorSpace = THREE.SRGBColorSpace;
    // A 32-entry limit saved 8 MB versus 160, costing two misses and 2 ms over 20 seconds.
    this.phaseCache.set(key, tex);
    while (this.phaseCache.size > PHASE_CACHE_LIMIT) {
      const oldest = this.phaseCache.keys().next();
      if (oldest.done) break;
      this.phaseCache.get(oldest.value)?.dispose();
      this.phaseCache.delete(oldest.value);
    }
    return tex;
  }
  /** Place the Moon, shape its phase, and let it eclipse the Sun. */
  update(
    m: SkyMoonState | undefined,
    sunPos: THREE.Vector3,
    solarObscuration: number,
    dayFactor: number,
  ) {
    if (!m) {
      this.moon.visible = false;
      this.drawnDir = null;
      return;
    }
    // Cull only after the whole enlarged disc sets; ground depth hides the visible portion.
    if (fullySet(m.altDeg, m.radiusDeg)) {
      this.moon.visible = false;
      this.drawnDir = null;
      return;
    }

    const trueDir = dirFromAltAz(m.altDeg, m.azDeg);
    const sunDir = sunPos.clone().normalize();
    const drawnDir = eclipseMagnifiedDir(sunDir, trueDir);
    this.drawnDir = drawnDir.clone();
    const pos = drawnDir.multiplyScalar(MOON_SHELL_RADIUS);
    this.moon.position.copy(pos);
    this.moon.visible = true;
    this.moon.scale.setScalar(discScale(m.radiusDeg, MOON_SHELL_RADIUS));

    // Ramp earthshine to an opaque silhouette without snapping at the eclipse edge.
    const darkAlpha = unlitFaceAlpha(solarObscuration, dayFactor);

    // Project through the camera because sprite and texture angles live in screen space.
    this.camera.updateMatrixWorld();
    const screenAngle = (target: THREE.Vector3) =>
      screenAngleAt(this.camera, trueDir, target);
    const northAngle = screenAngle(dirFromAltAz(m.northAltDeg, m.northAzDeg));
    // Express Sun and shadow angles in the lunar-north-up texture frame.
    const sunAngle = HALF_PI + (screenAngle(sunDir) - northAngle);
    const shadowAngle =
      HALF_PI + (screenAngle(dirFromAltAz(m.antiSunAltDeg, m.antiSunAzDeg)) - northAngle);
    const tex = this.phaseTexture({
      illuminated: m.illuminated,
      darkAlpha,
      umbralBite: m.umbralBite,
      umbraRadii: m.umbraRadii,
      missRadii: m.missRadii,
      sunAngle,
      shadowAngle,
    });
    // Avoid forcing Three.js to re-resolve an unchanged material program.
    if (this.moonMat.map !== tex) {
      this.moonMat.map = tex;
      this.moonMat.needsUpdate = true;
    }

    // Anchor the face to lunar north; move the terminator within the texture.
    this.moonMat.rotation = northAngle - HALF_PI;
  }
}
