import * as THREE from 'three';
import { groundAppearance } from '../astro/season';
import { SUN_ANGULAR_RADIUS_DEG } from '../astro/moon';
import { TerrainMap, loadTerrainMap } from './terrain';
import { smoothstep, DEG, posMod } from '../astro/vec';
import { displayPixelRatio } from '../displayRatio';
import { SkyMoon } from './skyMoon';
import { SkyTrail } from './skyTrail';
import type { SkyMoonState } from './skyMoon';
import {
  DOME_RADIUS,
  GRID_RADIUS,
  LABEL_RADIUS,
  STARS_RADIUS,
  SUN_RADIUS,
  dirFromAltAz,
  discScale,
} from './skyGeometry';

const GRASS_TILE = 3.0; // world units covered by one tile of the grass texture
/** How far the surface sits below the eye, which sets the apparent scale of the field. */
const GROUND_Y = -1.5;

/** Shared logarithmic land and sea fade, from 0 underfoot to 1 at the outer edge. */
function surfaceFade(radius: number, maxRadius: number): number {
  return (Math.log2(1 + radius) / Math.log2(1 + maxRadius)) ** 2.3;
}
// Per-second camera follow rate.
const FOLLOW_RATE = 3.7; // ~0.06 per frame at 60fps

const NIGHT_ZENITH = new THREE.Color(0x05070f);
const NIGHT_HORIZON = new THREE.Color(0x0b1426);
const DAY_ZENITH = new THREE.Color(0x1f63c8);
const DAY_HORIZON = new THREE.Color(0xa8cdf5);
const TWILIGHT = new THREE.Color(0xff8a3a);
const WHITE = new THREE.Color(0xffffff);
const NIGHT_GROUND = new THREE.Color(0x0a0f0b);
const NIGHT_WATER = new THREE.Color(0x070c16);
// Crossfade ambiguous coastal cells instead of imposing a hard shoreline.
const WATER_FADE_START = 0.35;
const WATER_FADE_END = 0.65;
// Sun sprite and reflected glitter share this setting threshold.
const SUN_SET_ALT_DEG = -3;

/**
 * Water glitter strength by solar altitude. It peaks near 8 degrees and fades smoothly to
 * zero as the Sun reaches the shared -3 degree setting threshold.
 */
export function glitterStrength(sunAltDeg: number): number {
  const height = Math.max(0, Math.sin(((90 - Math.abs(sunAltDeg - 8)) * Math.PI) / 180)) ** 8;
  return height * smoothstep(SUN_SET_ALT_DEG, SUN_SET_ALT_DEG + 4, sunAltDeg);
}
const WATER_WARM = new THREE.Color(0xb0793f);
const GROUND_WARM = new THREE.Color(0xd79356);
const NIGHT_HAZE = new THREE.Color(0x16203a);
const DAY_HAZE = new THREE.Color(0x9fbbe2);

const GRID_COLOR = new THREE.Color(0xaec6f0);

// Seasonal distance-fade colours.
const GROUND_FG = new THREE.Color(0xffffff); // underfoot: show the grass at full colour
const SUMMER_HZ = new THREE.Color(0x8c9a78);
const DRY_HZ = new THREE.Color(0x9a8f64);
const SNOW_HZ = new THREE.Color(0xc2cdd6);

/** Inputs needed to update the first-person sky. */
export interface SkyState {
  altDeg: number; // Sun altitude
  azDeg: number; // Sun azimuth, 0 = N, 90 = E, 180 = S, 270 = W
  /** Thermal-lagged seasonal warmth at the location; tints the grass and adds snow. */
  warmth?: number;
  /** Ease the camera to keep the Sun centred (paused while the user is dragging). */
  followSun?: boolean;
  followMoon?: boolean;
  /** Apparent radius of the Sun in degrees; defaults to the real value. */
  sunRadiusDeg?: number;
  /** The Moon, or undefined to leave it out of the sky entirely. */
  moon?: SkyMoonState;
  /** Fraction of the Sun's disc currently covered, which is what dims the daylight. */
  solarObscuration?: number;
}

/**
 * Sky brightness from 0 to 1, shared with the Moon's unlit-face opacity.
 * Nonlinear eclipse dimming is strongest near totality.
 */
export function skyDayFactor(sunAltDeg: number, solarObscuration = 0): number {
  const eclipseDim = 1 - Math.pow(solarObscuration, 3.2) * 0.995;
  return smoothstep(-6, 8, sunAltDeg) * eclipseDim;
}

/** Render and control the first-person sky view. */
export class SkyView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private dome: THREE.Mesh;
  private domeColors: THREE.BufferAttribute;
  private sun: THREE.Sprite;
  private sunGlow: THREE.Sprite;
  private corona!: THREE.Sprite;
  private skyMoon: SkyMoon;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private groundMat: THREE.MeshBasicMaterial;
  private waterMat!: THREE.MeshBasicMaterial;
  private water!: THREE.Mesh;
  private waterColors!: THREE.BufferAttribute;
  /** Where the water is, once the imagery has been read. Null until then, and on failure. */
  private terrain: TerrainMap | null = null;
  private latDeg = 0;
  private lonDeg = 0;
  /** Quantised Sun position used for the current glint colours. */
  private glintKey = '';
  private ringMat: THREE.LineBasicMaterial;
  private hazeMat: THREE.MeshBasicMaterial;
  private gridLines!: THREE.LineSegments;
  private gridMat!: THREE.LineBasicMaterial;

  private sunTrail!: SkyTrail;
  private moonTrail!: SkyTrail;

  private groundColors!: THREE.BufferAttribute;
  private readonly groundRadii = [0, 1, 2, 4, 8, 16, 32, 64, 128, 280, 700, DOME_RADIUS * 4];
  private readonly groundSeg = 128;
  private grassCache = new Map<string, THREE.CanvasTexture>();
  private seasonKey = '';

  private yaw = 0; // 0 = facing North
  private pitch = 15 * DEG; // looking slightly up
  private enabled = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastFollowMs = 0; // previous follow ease, Sun or Moon, for frame-rate-independent dt

  // Reused by updateColors to avoid per-frame allocation.
  private cZenith = new THREE.Color();
  private cHorizon = new THREE.Color();
  private cTmp = new THREE.Color();

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(displayPixelRatio());
    this.renderer.domElement.style.display = 'none';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 4000);
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(0, 0, 0);

    // Vertex-coloured inner sky dome.
    const domeGeo = new THREE.SphereGeometry(DOME_RADIUS, 48, 24);
    const count = domeGeo.attributes.position.count;
    this.domeColors = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    domeGeo.setAttribute('color', this.domeColors);
    this.dome = new THREE.Mesh(
      domeGeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.scene.add(this.dome);

    // Seasonal ground disc below the eye, fading toward the horizon.
    this.groundMat = new THREE.MeshBasicMaterial({
      map: this.grassFor(0, 0),
      vertexColors: true,
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthWrite: true,
      fog: false,
    });
    this.scene.add(this.makeGround());
    this.water = this.makeWater();
    this.scene.add(this.water);
    this.loadTerrain();

    // Horizon haze blends the surface into the sky.
    this.hazeMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    this.scene.add(this.makeHazeBand());

    // Optional altitude and azimuth grid.
    this.gridLines = this.makeGrid();
    this.scene.add(this.gridLines);

    // Horizon line above the ground.
    const ringPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a) * DOME_RADIUS, 0.2, Math.sin(a) * DOME_RADIUS));
    }
    this.ringMat = new THREE.LineBasicMaterial({ color: 0x8aa0c4, transparent: true, opacity: 0.45 });
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ringPts),
      this.ringMat,
    );
    this.scene.add(ring);

    this.stars = this.buildStars();
    this.starMat = this.stars.material as THREE.PointsMaterial;
    this.scene.add(this.stars);

    this.sunGlow = this.makeGlowSprite();
    this.scene.add(this.sunGlow);
    this.sun = this.makeSunSprite();
    this.scene.add(this.sun);
    this.corona = this.makeCoronaSprite();
    this.scene.add(this.corona);
    this.skyMoon = new SkyMoon(this.scene, this.camera);
    // Keep the Sun and glow above the trail.
    this.sunGlow.renderOrder = 2;
    this.sun.renderOrder = 2;

    const ratio = this.renderer.getPixelRatio();
    this.sunTrail = new SkyTrail(DOME_RADIUS * 0.9, 0xffd884, ratio);
    this.moonTrail = new SkyTrail(DOME_RADIUS * 0.88, 0xbcd0ee, ratio);
    for (const t of [this.sunTrail, this.moonTrail]) {
      this.scene.add(t.points);
      this.scene.add(t.line);
    }

    this.addCompassLabels();

    this.updateColors(45);
    this.applyLook();
    this.attachControls();
  }

  // Log-spaced rings preserve near-field surface detail while reaching the sky.
  private buildSurfaceGeometry(): { geo: THREE.BufferGeometry; colors: THREE.BufferAttribute } {
    const radii = this.groundRadii;
    const seg = this.groundSeg;
    const positions: number[] = [];
    const uvs: number[] = [];
    const index: number[] = [];
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        positions.push(x, 0, z);
        uvs.push(x / GRASS_TILE, z / GRASS_TILE);
      }
    }
    const cols = seg + 1;
    for (let ri = 0; ri < radii.length - 1; ri++) {
      for (let s = 0; s < seg; s++) {
        const a0 = ri * cols + s;
        const a1 = ri * cols + s + 1;
        const b0 = (ri + 1) * cols + s;
        const b1 = (ri + 1) * cols + s + 1;
        index.push(a0, b0, a1, a1, b0, b1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const colors = new THREE.BufferAttribute(new Float32Array(positions.length), 3);
    geo.setAttribute('color', colors);
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(index);
    return { geo, colors };
  }

  private makeGround(): THREE.Mesh {
    const { geo, colors } = this.buildSurfaceGeometry();
    this.groundColors = colors;
    this.paintGround(GROUND_FG, SUMMER_HZ);
    const mesh = new THREE.Mesh(geo, this.groundMat);
    mesh.position.y = GROUND_Y; // stand a little above the grass so the field is visible
    mesh.renderOrder = -1;
    return mesh;
  }

  // A separate surface supports coastal crossfades and independent water glint.
  private makeWater(): THREE.Mesh {
    const { geo, colors } = this.buildSurfaceGeometry();
    this.waterColors = colors;
    this.waterMat = new THREE.MeshBasicMaterial({
      map: makeWaterTexture(),
      vertexColors: true,
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, this.waterMat);
    // Offset above land to prevent z-fighting.
    mesh.position.y = GROUND_Y + 0.01;
    mesh.renderOrder = -1;
    mesh.visible = false;
    this.paintWater(0, 0);
    return mesh;
  }

  // Repaint only for whole-degree motion, using the rounded values to keep buckets deterministic.
  private updateGlint(sunAzDeg: number, sunAltDeg: number) {
    const az = Math.round(sunAzDeg);
    const alt = Math.round(sunAltDeg);
    const key = `${az},${alt}`;
    if (key === this.glintKey) return;
    this.glintKey = key;
    this.paintWater(az, alt);
  }

  // Apply the shared horizon fade and a low-Sun glitter path toward the solar bearing.
  private paintWater(sunAzDeg: number, sunAltDeg: number) {
    const radii = this.groundRadii;
    const seg = this.groundSeg;
    const rMax = radii[radii.length - 1];
    const col = this.waterColors;
    const glint = glitterStrength(sunAltDeg);
    const sunRad = (sunAzDeg * Math.PI) / 180;
    let i = 0;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      const t = surfaceFade(r, rMax);
      // Distant water pales as reflected sky dominates.
      const base = 1 - 0.35 * t;
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        // Convert +x ground angle to clockwise azimuth from -z.
        const bearing = a + Math.PI / 2;
        const align = Math.cos(bearing - sunRad);
        // Widen the glitter path toward the horizon.
        const lobe = Math.max(0, align) ** (28 - 20 * t);
        const shine = glint * lobe * (0.25 + 0.75 * t);
        const v = base + shine * 1.9;
        col.setXYZ(i++, v, v, v);
      }
    }
    col.needsUpdate = true;
  }

  // Repaint the land from full-colour foreground to its seasonal horizon tint.
  private paintGround(fg: THREE.Color, hz: THREE.Color) {
    const radii = this.groundRadii;
    const seg = this.groundSeg;
    const rMax = radii[radii.length - 1];
    const col = this.groundColors;
    const tmp = new THREE.Color();
    let i = 0;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      const t = surfaceFade(r, rMax);
      tmp.copy(fg).lerp(hz, t);
      for (let s = 0; s <= seg; s++) col.setXYZ(i++, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;
  }

  // Cache grass textures by quantised seasonal appearance.
  private grassFor(dryness: number, snow: number): THREE.CanvasTexture {
    const key = `${dryness}_${snow}`;
    let tex = this.grassCache.get(key);
    if (!tex) {
      tex = makeGrassTexture(dryness, snow);
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.grassCache.set(key, tex);
    }
    return tex;
  }

  // Quantise seasonal appearance to avoid rebuilding textures while scrubbing.
  private updateSeason(warmth: number) {
    const { dryness, snow } = groundAppearance(warmth);
    const qd = Math.round(dryness * 5) / 5;
    const qs = Math.round(snow * 5) / 5;
    const key = `${qd}_${qs}`;
    if (key === this.seasonKey) return;
    this.seasonKey = key;
    this.groundMat.map = this.grassFor(qd, qs);
    this.groundMat.needsUpdate = true;
    const hz = SUMMER_HZ.clone().lerp(DRY_HZ, qd).lerp(SNOW_HZ, qs);
    this.paintGround(GROUND_FG, hz);
  }

  // Haze centred just above the horizon.
  private makeHazeBand(): THREE.Mesh {
    const lo = -35;
    const hi = 90;
    const H = hi - lo;
    const geo = new THREE.CylinderGeometry(DOME_RADIUS * 0.985, DOME_RADIUS * 0.985, H, 96, 1, true);
    geo.translate(0, (lo + hi) / 2, 0);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const alpha = 0.34 * Math.exp(-(((y - 7) / 22) ** 2)); // peak just above the horizon
      colors[i * 4] = 1;
      colors[i * 4 + 1] = 1;
      colors[i * 4 + 2] = 1;
      colors[i * 4 + 3] = alpha;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    const mesh = new THREE.Mesh(geo, this.hazeMat);
    mesh.renderOrder = 1;
    return mesh;
  }

  // One line mesh holds 15-degree altitude rings and 30-degree non-cardinal meridians.
  private makeGrid(): THREE.LineSegments {
    const R = GRID_RADIUS; // inside the Sun/trail so they always draw on top
    const pts: number[] = [];
    const push = (alt: number, az: number) => {
      const d = dirFromAltAz(alt, az).multiplyScalar(R);
      pts.push(d.x, d.y, d.z);
    };
    const AZ_STEP = 5; // ring resolution
    for (const alt of [15, 30, 45, 60, 75]) {
      for (let az = 0; az < 360; az += AZ_STEP) {
        push(alt, az);
        push(alt, az + AZ_STEP);
      }
    }
    const ALT_STEP = 5;
    for (let az = 0; az < 360; az += 30) {
      if (az % 90 === 0) continue; // leave the cardinal directions to the labels
      for (let alt = 2; alt < 86; alt += ALT_STEP) {
        push(alt, az);
        push(Math.min(alt + ALT_STEP, 86), az);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.gridMat = new THREE.LineBasicMaterial({
      color: GRID_COLOR,
      transparent: true,
      // updateColors sets opacity before first render.
      depthWrite: false,
      depthTest: true,
    });
    const lines = new THREE.LineSegments(geo, this.gridMat);
    lines.renderOrder = 0;
    return lines;
  }

  // The corona appears only as the photosphere becomes fully obscured.
  private makeCoronaSprite(): THREE.Sprite {
    const N = 256;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d')!;
    const mid = N / 2;

    // Soft inner glow around the limb.
    const g = ctx.createRadialGradient(mid, mid, N * 0.16, mid, mid, mid);
    g.addColorStop(0, 'rgba(255,252,242,0.95)');
    g.addColorStop(0.12, 'rgba(246,244,232,0.55)');
    g.addColorStop(0.4, 'rgba(214,222,236,0.2)');
    g.addColorStop(0.75, 'rgba(180,198,226,0.06)');
    g.addColorStop(1, 'rgba(160,180,220,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(mid, mid, mid, 0, Math.PI * 2);
    ctx.fill();

    // Radial streamers give the corona its irregular edge.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 64; i++) {
      const ang = (i / 64) * Math.PI * 2 + (i % 3) * 0.05;
      const len = mid * (0.42 + 0.5 * Math.abs(Math.sin(i * 2.399)));
      const sg = ctx.createLinearGradient(
        mid + Math.cos(ang) * N * 0.16,
        mid + Math.sin(ang) * N * 0.16,
        mid + Math.cos(ang) * len,
        mid + Math.sin(ang) * len,
      );
      sg.addColorStop(0, 'rgba(255,250,238,0.4)');
      sg.addColorStop(1, 'rgba(220,232,255,0)');
      ctx.strokeStyle = sg;
      ctx.lineWidth = N * (0.012 + 0.02 * Math.abs(Math.cos(i * 1.77)));
      ctx.beginPath();
      ctx.moveTo(mid + Math.cos(ang) * N * 0.16, mid + Math.sin(ang) * N * 0.16);
      ctx.lineTo(mid + Math.cos(ang) * len, mid + Math.sin(ang) * len);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
    );
    s.renderOrder = 3; // behind the Moon, which must stay a clean silhouette on top
    s.visible = false;
    return s;
  }

  // Load land and water classification without blocking the grass fallback.
  private loadTerrain() {
    void loadTerrainMap(`${import.meta.env.BASE_URL}textures/earth.webp`).then((map) => {
      this.terrain = map;
      this.applyWetness();
    });
  }

  /** Set the observer location and update its surface. */
  setLocation(latDeg: number, lonDeg: number) {
    this.latDeg = latDeg;
    this.lonDeg = lonDeg;
    this.applyWetness();
  }

  // Imagery resolves about 20 km, too coarse for a local shoreline, so crossfade one verdict.
  private applyWetness() {
    const wetness = this.terrain?.wetnessAt(this.latDeg, this.lonDeg) ?? 0;
    const opacity = smoothstep(WATER_FADE_START, WATER_FADE_END, wetness);
    this.waterMat.opacity = opacity;
    this.water.visible = opacity > 0.01;
  }

  /** Show or hide the altitude/azimuth grid. */
  setGridVisible(on: boolean) {
    this.gridLines.visible = on;
  }

  private buildStars(): THREE.Points {
    const n = 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Uniform sin(altitude) distributes stars evenly above the horizon.
      const az = Math.random() * Math.PI * 2;
      const alt = Math.asin(Math.random());
      const d = dirFromAltAz((alt / DEG), (az / DEG)).multiplyScalar(STARS_RADIUS);
      pos[i * 3] = d.x;
      pos[i * 3 + 1] = d.y;
      pos[i * 3 + 2] = d.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: 0xccd6ec, size: 2, sizeAttenuation: false, transparent: true }),
    );
  }

  private makeSunSprite(): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,245,1)');
    g.addColorStop(0.5, 'rgba(255,236,170,1)');
    g.addColorStop(1, 'rgba(255,220,130,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true });
    const s = new THREE.Sprite(mat);
    s.scale.set(34, 34, 1);
    return s;
  }

  private makeGlowSprite(): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,220,150,0.55)');
    g.addColorStop(0.4, 'rgba(255,170,90,0.22)');
    g.addColorStop(1, 'rgba(255,150,80,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
    });
    const s = new THREE.Sprite(mat);
    s.scale.set(150, 150, 1);
    return s;
  }

  private addCompassLabels() {
    const majors: [string, number][] = [
      ['N', 0], ['E', 90], ['S', 180], ['W', 270],
    ];
    const minors: [string, number][] = [
      ['NE', 45], ['SE', 135], ['SW', 225], ['NW', 315],
    ];
    for (const [text, az] of majors) this.scene.add(this.makeLabel(text, az, true));
    for (const [text, az] of minors) this.scene.add(this.makeLabel(text, az, false));
  }

  private makeLabel(text: string, azDeg: number, major: boolean): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.font = `${major ? 'bold 52px' : '30px'} -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = major ? 6 : 4;
    ctx.strokeStyle = 'rgba(5,8,16,0.55)';
    ctx.strokeText(text, 64, 34);
    ctx.fillStyle = major ? '#ffdf6e' : 'rgba(196,210,236,0.9)';
    ctx.fillText(text, 64, 34);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false, transparent: true });
    const s = new THREE.Sprite(mat);
    const dir = dirFromAltAz(major ? 3.5 : 2.4, azDeg).multiplyScalar(LABEL_RADIUS);
    s.position.copy(dir);
    const k = major ? 1.15 : 0.7;
    s.scale.set(60 * k, 30 * k, 1);
    s.renderOrder = 5;
    return s;
  }

  // Update sky, surface, grid, and star brightness for Sun height and obscuration.
  private updateColors(sunAltDeg: number, obscuration = 0) {
    const dayF = skyDayFactor(sunAltDeg, obscuration);
    // Only a low Sun warms the ground; totality is darkness, not evening.
    const twilightF = Math.exp(-((sunAltDeg / 7) ** 2));
    // Totality leaves a dim ring of sunlit atmosphere at the horizon.
    const eclipseGlow = sunAltDeg > 0 ? Math.pow(obscuration, 12) : 0;
    // Blend night, day, and twilight colours in place.
    const tint = (
      out: THREE.Color,
      night: THREE.Color,
      day: THREE.Color,
      twi: THREE.Color,
      twiAmt: number,
      twiF = twilightF,
    ) => out.copy(night).lerp(day, dayF).lerp(twi, twiF * twiAmt);

    const zenith = tint(this.cZenith, NIGHT_ZENITH, DAY_ZENITH, NIGHT_ZENITH, 0);
    const horizon = tint(
      this.cHorizon, NIGHT_HORIZON, DAY_HORIZON, TWILIGHT, 0.55,
      Math.max(twilightF, eclipseGlow * 0.34),
    );

    // Tighten the horizon gradient during totality to keep the light in a low band.
    const horizonSpan = 0.55 - 0.4 * eclipseGlow;

    const pos = this.dome.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.domeColors;
    const tmp = this.cTmp;
    for (let i = 0; i < pos.count; i++) {
      const yNorm = pos.getY(i) / DOME_RADIUS; // -1..1
      const t = smoothstep(0, horizonSpan, yNorm);
      tmp.copy(horizon).lerp(zenith, t);
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;

    // Tint land and water separately through day, night, and twilight.
    tint(this.groundMat.color, NIGHT_GROUND, WHITE, GROUND_WARM, 0.45);
    tint(this.waterMat.color, NIGHT_WATER, WHITE, WATER_WARM, 0.3);
    tint(this.ringMat.color, NIGHT_HAZE, DAY_HAZE, NIGHT_HAZE, 0);
    this.ringMat.opacity = 0.2 + 0.35 * dayF;
    tint(
      this.hazeMat.color, NIGHT_HAZE, DAY_HAZE, TWILIGHT, 0.6,
      Math.max(twilightF, eclipseGlow * 0.5),
    );

    this.gridMat.opacity = 0.08 + 0.08 * dayF;

    // Deep eclipse obscuration reveals stars like nightfall.
    const nightStars = 1 - smoothstep(-12, 0, sunAltDeg);
    this.starMat.opacity = Math.max(nightStars, Math.pow(obscuration, 6));
    this.stars.visible = this.starMat.opacity > 0.02;
  }

  update(state: SkyState) {
    if (state.warmth !== undefined) this.updateSeason(state.warmth);
    const p = dirFromAltAz(state.altDeg, state.azDeg).multiplyScalar(SUN_RADIUS);
    this.sun.position.copy(p);
    this.sunGlow.position.copy(p);
    // Hide the Sun and glow below the setting threshold.
    const vis = state.altDeg > SUN_SET_ALT_DEG;
    this.sun.visible = vis;
    this.sunGlow.visible = vis;

    const obscuration = state.solarObscuration ?? 0;
    // Use the same size exaggeration as the Moon to preserve eclipse ratios.
    const sunRadiusDeg = state.sunRadiusDeg ?? SUN_ANGULAR_RADIUS_DEG;
    this.sun.scale.setScalar(discScale(sunRadiusDeg, SUN_RADIUS));
    // Dim the last photospheric sliver so it does not swamp the corona.
    (this.sun.material as THREE.SpriteMaterial).opacity = 1 - 0.9 * smoothstep(0.9, 1, obscuration);
    const lowF = 1 - smoothstep(0, 25, state.altDeg);
    // Obscuration also removes the scattered-light halo.
    this.sunGlow.scale.setScalar((120 + lowF * 120) * (1 - 0.85 * obscuration));

    // Reveal the corona only in the final 3.5% of obscuration.
    const coronaF = smoothstep(0.965, 1, obscuration);
    this.corona.visible = vis && coronaF > 0.01;
    if (this.corona.visible) {
      this.corona.position.copy(p);
      const sunPx = discScale(sunRadiusDeg, SUN_RADIUS);
      this.corona.scale.setScalar(sunPx * 3.4);
      (this.corona.material as THREE.SpriteMaterial).opacity = coronaF;
    }

    if (this.water.visible) this.updateGlint(state.azDeg, state.altDeg);
    // Share brightness so Moon opacity cannot drift from the sky state.
    const dayF = skyDayFactor(state.altDeg, obscuration);
    this.skyMoon.update(state.moon, p, obscuration, dayF);
    // Follow the DRAWN Moon: near the Sun the sprite is pushed aside so partial eclipses do
    // not look total, and a trail on the true position detaches and runs into the Sun.
    const drawnMoon = this.skyMoon.lastDrawnDir;
    if (drawnMoon) this.moonTrail.pushDir(drawnMoon);
    this.updateColors(state.altDeg, obscuration);

    // Following the Moon wins when both are on, since it is the harder thing to keep in view.
    const follow = state.followMoon && state.moon ? state.moon : state.followSun ? state : null;
    if (follow) this.easeCameraTo(follow.altDeg, follow.azDeg);
    else this.lastFollowMs = 0; // reset so re-enabling starts from a small dt
  }

  // Ease toward a target by elapsed time, without fighting an active drag.
  private easeCameraTo(altDeg: number, azDeg: number) {
    if (this.dragging) {
      this.lastFollowMs = 0;
      return;
    }
    const now = performance.now();
    const dt = this.lastFollowMs ? Math.min((now - this.lastFollowMs) / 1000, 0.1) : 1 / 60;
    this.lastFollowMs = now;
    const k = 1 - Math.exp(-FOLLOW_RATE * dt); // 0..1 easing fraction for this step
    const targetYaw = azDeg * DEG;
    const targetPitch = THREE.MathUtils.clamp(altDeg, -6, 70) * DEG;
    const dYaw = Math.atan2(Math.sin(targetYaw - this.yaw), Math.cos(targetYaw - this.yaw));
    this.yaw += dYaw * k;
    this.pitch += (targetPitch - this.pitch) * k;
    this.applyLook();
  }

  setTrailEnabled(on: boolean) {
    this.sunTrail.setEnabled(on);
  }

  setMoonTrailEnabled(on: boolean) {
    this.moonTrail.setEnabled(on);
  }

  clearTrail() {
    this.sunTrail.clear();
    this.moonTrail.clear();
  }

  pushTrail(altDeg: number, azDeg: number) {
    this.sunTrail.push(altDeg, azDeg);
  }

  /** The compass azimuth and altitude the camera is currently looking toward. */
  getHeading(): { azDeg: number; altDeg: number } {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    const azDeg = posMod(Math.atan2(f.x, -f.z) / DEG, 360);
    const altDeg = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)) / DEG;
    return { azDeg, altDeg };
  }

  private applyLook() {
    const cp = Math.cos(this.pitch);
    const forward = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    );
    this.camera.lookAt(forward);
  }

  private attachControls() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.enabled) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      const s = 0.005;
      // Grab-style dragging pulls the sky with the pointer.
      this.yaw -= dx * s;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * s, -35 * DEG, 89 * DEG);
      this.applyLook();
    });
    const end = (e: PointerEvent) => {
      this.dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + e.deltaY * 0.03, 35, 90);
      this.camera.updateProjectionMatrix();
    }, { passive: false });
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.renderer.domElement.style.display = on ? 'block' : 'none';
    if (on) this.resize();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setPixelRatio(displayPixelRatio());
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Track pixel ratio to keep trail dots at a fixed CSS size.
    const ratio = this.renderer.getPixelRatio();
    this.sunTrail.setPixelRatio(ratio);
    this.moonTrail.setPixelRatio(ratio);
  }
}
// Tileable dark-water texture with low crossing swells and brighter crests.
function makeWaterTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = rgb([0x1c, 0x33, 0x4e]);
  ctx.fillRect(0, 0, S, S);

  // Keep broad colour patches clear of edges for seamless tiling.
  for (let i = 0; i < 30; i++) {
    const r = 20 + Math.random() * 44;
    const x = r + Math.random() * (S - 2 * r);
    const y = r + Math.random() * (S - 2 * r);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, Math.random() < 0.5 ? 'rgba(120,170,210,0.10)' : 'rgba(0,10,30,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }

  // Draw each swell across a 3x3 wrap to hide tile seams.
  ctx.lineCap = 'round';
  for (let i = 0; i < 150; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const len = 18 + Math.random() * 46;
    // Keep swells nearly parallel with slight scatter.
    const ang = 0.28 + (Math.random() - 0.5) * 0.5;
    const bright = Math.random() < 0.28;
    ctx.strokeStyle = bright
      ? `rgba(186,214,238,${0.10 + Math.random() * 0.16})`
      : `rgba(9,20,38,${0.10 + Math.random() * 0.18})`;
    ctx.lineWidth = bright ? 0.8 + Math.random() * 1.1 : 1.2 + Math.random() * 2.2;
    for (let ox = -S; ox <= S; ox += S) {
      for (let oy = -S; oy <= S; oy += S) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.quadraticCurveTo(
          x + ox + Math.cos(ang) * len * 0.5,
          y + oy + Math.sin(ang) * len * 0.5 - 2.5,
          x + ox + Math.cos(ang) * len,
          y + oy + Math.sin(ang) * len,
        );
        ctx.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Tileable seasonal turf, from green through dry tan to snow.
function makeGrassTexture(dryness = 0, snow = 0): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;

  // Blend the base from green through dry tan to snow.
  const base = mix(mix([0x49, 0x6a, 0x3b], [0x8a, 0x7d, 0x44], dryness), [0xe9, 0xee, 0xf2], snow);
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, S, S);

  // Keep soft colour patches clear of tile edges.
  for (let i = 0; i < 44; i++) {
    const r = 14 + Math.random() * 36;
    const x = r + Math.random() * (S - 2 * r);
    const y = r + Math.random() * (S - 2 * r);
    const lighter = Math.random() < 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, lighter ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }

  // Wrap blades across tile edges; drying shifts green to gold and snow thins coverage.
  const greens = [
    [0x2f, 0x4a, 0x26], [0x3a, 0x5a, 0x2d], [0x55, 0x7a, 0x3a],
    [0x68, 0x8f, 0x44], [0x41, 0x61, 0x2e], [0x7b, 0x92, 0x49],
  ];
  const golds = [
    [0x5c, 0x53, 0x26], [0x7a, 0x6a, 0x30], [0x9a, 0x85, 0x40],
    [0xb6, 0xa0, 0x52], [0x6b, 0x5d, 0x2a], [0xc8, 0xb4, 0x6a],
  ];
  const palette = greens.map((g, i) => mix(g, golds[i], dryness));
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  const blades = Math.round(1500 * (1 - 0.75 * snow));
  for (let i = 0; i < blades; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const len = 2.5 + Math.random() * 5;
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.cos(ang) * len;
    const dy = Math.sin(ang) * len;
    ctx.strokeStyle = rgb(mix(palette[(Math.random() * palette.length) | 0], [0x84, 0x82, 0x6c], snow * 0.6));
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + dx, y + oy + dy);
        ctx.stroke();
      }
    }
  }

  // Add a snow wash and sparse highlights.
  if (snow > 0) {
    ctx.fillStyle = `rgba(236,240,245,${0.7 * snow})`;
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 120 * snow; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type RGB = number[];
function mix(a: RGB, b: RGB, t: number): RGB {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
function rgb(c: RGB): string {
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
}
