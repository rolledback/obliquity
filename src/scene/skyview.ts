// First-person "stand at your location and look at the sky" view.
//
// This is a schematic local sky, not a photorealistic render: a gradient dome whose
// colours track the Sun's height, a flat ground, compass labels (N/E/S/W and the
// intercardinals) around the horizon, and the Sun placed at its true altitude and
// azimuth for the chosen location, date and rotation settings. Drag to look around,
// scroll to zoom.
//
// Local frame: +Y = up (zenith), +X = East, -Z = North (so the camera, which looks
// down -Z by default, starts facing North). A direction at altitude `alt` and
// azimuth `az` (0 = N, 90 = E, measured from North toward East) is therefore
//   ( cos(alt) sin(az),  sin(alt),  -cos(alt) cos(az) ).

import * as THREE from 'three';
import { groundAppearance } from '../astro/season';
import { smoothstep, DEG, posMod } from '../astro/vec';
import { displayPixelRatio } from '../displayRatio';

const DOME_RADIUS = 500;
const GRASS_TILE = 3.0; // world units covered by one tile of the grass texture

// Concentric shells the sky elements sit on, from the camera (small radius) outward. Their
// order sets occlusion against the depth-writing meshes (ground, stars); the labels are
// drawn depth-test-off so their radius is cosmetic only.
const GRID_RADIUS = DOME_RADIUS * 0.86;
const SUN_RADIUS = DOME_RADIUS * 0.92;
const STARS_RADIUS = DOME_RADIUS * 0.95;
const LABEL_RADIUS = DOME_RADIUS * 0.8;

// Camera follow easing as a rate per second, so the smoothing is frame-rate independent.
const FOLLOW_RATE = 3.7; // ~0.06 per frame at 60fps

const NIGHT_ZENITH = new THREE.Color(0x05070f);
const NIGHT_HORIZON = new THREE.Color(0x0b1426);
const DAY_ZENITH = new THREE.Color(0x1f63c8);
const DAY_HORIZON = new THREE.Color(0xa8cdf5);
const TWILIGHT = new THREE.Color(0xff8a3a);
const WHITE = new THREE.Color(0xffffff);
const NIGHT_GROUND = new THREE.Color(0x0a0f0b);
const GROUND_WARM = new THREE.Color(0xd79356);
const NIGHT_HAZE = new THREE.Color(0x16203a);
const DAY_HAZE = new THREE.Color(0x9fbbe2);

// Sky alt/az grid line colour.
const GRID_COLOR = new THREE.Color(0xaec6f0);

// Distance-fade colours for the ground, shifted by the season so the far field
// matches the grass underfoot (greenish in summer, tan when dry, pale when snowy).
const GROUND_FG = new THREE.Color(0xffffff); // underfoot: show the grass at full colour
const SUMMER_HZ = new THREE.Color(0x8c9a78);
const DRY_HZ = new THREE.Color(0x9a8f64);
const SNOW_HZ = new THREE.Color(0xc2cdd6);

export interface SkyState {
  altDeg: number; // Sun altitude
  azDeg: number; // Sun azimuth, 0 = N, 90 = E, 180 = S, 270 = W
  /** Thermal-lagged seasonal warmth at the location; tints the grass and adds snow. */
  warmth?: number;
  /** Ease the camera to keep the Sun centred (paused while the user is dragging). */
  followSun?: boolean;
}

/** Direction unit vector in the local sky frame for an altitude/azimuth in degrees. */
function dirFromAltAz(altDeg: number, azDeg: number): THREE.Vector3 {
  const a = altDeg * DEG;
  const z = azDeg * DEG;
  return new THREE.Vector3(
    Math.cos(a) * Math.sin(z),
    Math.sin(a),
    -Math.cos(a) * Math.cos(z),
  );
}

export class SkyView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private dome: THREE.Mesh;
  private domeColors: THREE.BufferAttribute;
  private sun: THREE.Sprite;
  private sunGlow: THREE.Sprite;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private groundMat: THREE.MeshBasicMaterial;
  private ringMat: THREE.LineBasicMaterial;
  private hazeMat: THREE.MeshBasicMaterial;
  private gridLines!: THREE.LineSegments;
  private gridMat!: THREE.LineBasicMaterial;

  // Fading "comet trail" of the Sun's recent path: soft round points laid down along the
  // dome as the simulation plays, their opacity ramping from transparent (oldest) to bright
  // (newest, at the Sun). Drawn as fat points rather than a 1px line so it is easy to follow
  // (WebGL ignores line width, but honours gl_PointSize).
  private trail!: THREE.Points;
  private trailLine!: THREE.Line; // thin core through the dots so it reads continuous at speed
  private trailGeo!: THREE.BufferGeometry;
  private trailMat!: THREE.ShaderMaterial;
  private trailLineMat!: THREE.ShaderMaterial;
  private trailPos!: Float32Array;
  private trailAlpha!: Float32Array;
  private trailPoints: THREE.Vector3[] = [];
  private trailEnabled = false;
  private readonly trailMax = 320; // most points retained (older ones drop off the tail)
  private readonly trailRadius = DOME_RADIUS * 0.9; // just inside the Sun's shell
  private readonly trailDotPx = 13; // on-screen diameter of each soft trail dot (CSS px)
  private readonly trailMinSepCos = Math.cos(0.5 * DEG); // record once moved ~0.5deg
  private readonly trailBreakCos = Math.cos(30 * DEG); // a bigger jump restarts the trail

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
  private lastFollowMs = 0; // timestamp of the previous follow-Sun ease, for frame-rate-independent dt

  // Scratch colours reused every frame by updateColors so it allocates nothing.
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

    // Gradient sky dome (vertex coloured, painted on the inside).
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

    // Ground: a large grassy disk at eye level that hides everything below the
    // horizon. A tiling turf texture gives it grass; a radial vertex-colour fade
    // plus the day/night tint below keep the distance and lighting believable. The
    // texture and far-fade colour are swapped by season to show dry grass and snow.
    this.groundMat = new THREE.MeshBasicMaterial({
      map: this.grassFor(0, 0),
      vertexColors: true,
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthWrite: true,
      fog: false,
    });
    this.scene.add(this.makeGround());

    // Soft horizon haze: a short upright band at the horizon that fades from a hazy
    // glow at the bottom to transparent, blending the ground into the sky.
    this.hazeMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    this.scene.add(this.makeHazeBand());

    // Faint altitude/azimuth grid: almucantars (rings of equal Sun height) and azimuth
    // meridians, so the Sun's height and compass direction are readable at a glance.
    this.gridLines = this.makeGrid();
    this.scene.add(this.gridLines);

    // A soft horizon line just above the ground.
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
    // Draw the Sun and its glow after the trail so the bright head sits on top of it.
    this.sunGlow.renderOrder = 2;
    this.sun.renderOrder = 2;

    this.trail = this.makeTrail();
    this.scene.add(this.trail);
    this.scene.add(this.trailLine); // the thin core, built alongside the points in makeTrail

    this.addCompassLabels();

    this.updateColors(45);
    this.applyLook();
    this.attachControls();
  }

  // A flat disk built as concentric rings so a tiling grass texture (via UVs scaled
  // to world units) and a radial vertex-colour fade can both run from underfoot out
  // to the horizon. Radii are log-spaced so the near grass keeps detail while the
  // disk still reaches far enough to meet the sky at the horizon.
  private makeGround(): THREE.Mesh {
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
    this.groundColors = new THREE.BufferAttribute(new Float32Array(positions.length), 3);
    geo.setAttribute('color', this.groundColors);
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(index);
    this.paintGround(GROUND_FG, SUMMER_HZ);
    const mesh = new THREE.Mesh(geo, this.groundMat);
    mesh.position.y = -1.5; // stand a little above the grass so the field is visible
    mesh.renderOrder = -1;
    return mesh;
  }

  // Repaint the ground's radial fade from a near (underfoot) colour to a far (horizon)
  // colour. Near stays white so the grass texture shows; far shifts with the season.
  private paintGround(fg: THREE.Color, hz: THREE.Color) {
    const radii = this.groundRadii;
    const seg = this.groundSeg;
    const rMax = radii[radii.length - 1];
    const col = this.groundColors;
    const tmp = new THREE.Color();
    let i = 0;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      // Stay coloured for most of the field, fading only as it nears the horizon.
      const t = (Math.log2(1 + r) / Math.log2(1 + rMax)) ** 2.3;
      tmp.copy(fg).lerp(hz, t);
      for (let s = 0; s <= seg; s++) col.setXYZ(i++, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;
  }

  // A grass texture for the given dryness/snow, GPU-ready and cached by appearance.
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

  // Update the ground's look for the season: greener grass when warm, golden when
  // cool, snow-covered when cold. Quantised so the texture is only rebuilt at a few
  // distinct steps as the date scrubs through the year.
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

  // A soft haze band centred just above the horizon, so the grass field blends
  // gently into the sky without washing out the green underfoot.
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

  // Faint altitude/azimuth graticule on the inside of the dome: rings of equal Sun
  // height (almucantars at 15..75 deg) plus azimuth meridians every 30 deg from just
  // above the horizon up toward the zenith. Built as one LineSegments so it is a single
  // cheap draw. The cardinal meridians (N/E/S/W) are skipped so the brighter labels stand
  // alone there.
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
      // opacity is owned by updateColors (it eases with day/night); it runs in the
      // constructor before the first render, so no resting value is needed here.
      depthWrite: false,
      depthTest: true,
    });
    const lines = new THREE.LineSegments(geo, this.gridMat);
    lines.renderOrder = 0;
    return lines;
  }

  /** Show or hide the altitude/azimuth grid. */
  setGridVisible(on: boolean) {
    this.gridLines.visible = on;
  }

  private buildStars(): THREE.Points {
    const n = 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Only stars above the horizon so none sit "in the ground". Sample sin(alt)
      // uniformly so the stars spread evenly over the dome instead of clustering at
      // the zenith.
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
    // A dark outline keeps the letters legible against a bright daytime sky.
    ctx.lineWidth = major ? 6 : 4;
    ctx.strokeStyle = 'rgba(5,8,16,0.55)';
    ctx.strokeText(text, 64, 34);
    ctx.fillStyle = major ? '#ffdf6e' : 'rgba(196,210,236,0.9)';
    ctx.fillText(text, 64, 34);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false, transparent: true });
    const s = new THREE.Sprite(mat);
    // Just above the horizon, at a fixed distance.
    const dir = dirFromAltAz(major ? 3.5 : 2.4, azDeg).multiplyScalar(LABEL_RADIUS);
    s.position.copy(dir);
    const k = major ? 1.15 : 0.7;
    s.scale.set(60 * k, 30 * k, 1);
    s.renderOrder = 5;
    return s;
  }

  // Repaint the dome gradient and star/sun brightness for the Sun's current height.
  private updateColors(sunAltDeg: number) {
    const dayF = smoothstep(-6, 8, sunAltDeg);
    const twilightF = Math.exp(-((sunAltDeg / 7) ** 2));
    // Blend a material colour from night -> day -> a twilight tint, in place (no allocation).
    const tint = (out: THREE.Color, night: THREE.Color, day: THREE.Color, twi: THREE.Color, twiAmt: number) =>
      out.copy(night).lerp(day, dayF).lerp(twi, twilightF * twiAmt);

    const zenith = tint(this.cZenith, NIGHT_ZENITH, DAY_ZENITH, NIGHT_ZENITH, 0);
    const horizon = tint(this.cHorizon, NIGHT_HORIZON, DAY_HORIZON, TWILIGHT, 0.55);

    const pos = this.dome.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.domeColors;
    const tmp = this.cTmp;
    for (let i = 0; i < pos.count; i++) {
      const yNorm = pos.getY(i) / DOME_RADIUS; // -1..1
      const t = smoothstep(0, 0.55, yNorm);
      tmp.copy(horizon).lerp(zenith, t);
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;

    // Ground brightness tracks day/night (full grass by day, a near-black tint at
    // night), warming toward gold as the Sun nears the horizon.
    tint(this.groundMat.color, NIGHT_GROUND, WHITE, GROUND_WARM, 0.45);
    // Horizon line and haze blend toward the sky, with a warm tint near sunrise/set.
    tint(this.ringMat.color, NIGHT_HAZE, DAY_HAZE, NIGHT_HAZE, 0);
    this.ringMat.opacity = 0.2 + 0.35 * dayF;
    tint(this.hazeMat.color, NIGHT_HAZE, DAY_HAZE, TWILIGHT, 0.6);

    // Sky grid: faint always, a touch dimmer at night so the stars still read.
    this.gridMat.opacity = 0.08 + 0.08 * dayF;

    this.starMat.opacity = 1 - smoothstep(-12, 0, sunAltDeg);
    this.stars.visible = this.starMat.opacity > 0.02;
  }

  update(state: SkyState) {
    if (state.warmth !== undefined) this.updateSeason(state.warmth);
    const p = dirFromAltAz(state.altDeg, state.azDeg).multiplyScalar(SUN_RADIUS);
    this.sun.position.copy(p);
    this.sunGlow.position.copy(p);
    // Fade and warm the Sun as it nears/drops below the horizon.
    const vis = state.altDeg > -3;
    this.sun.visible = vis;
    this.sunGlow.visible = vis;
    const lowF = 1 - smoothstep(0, 25, state.altDeg);
    this.sunGlow.scale.setScalar(120 + lowF * 120);
    this.updateColors(state.altDeg);

    if (state.followSun) this.easeCameraToSun(state.altDeg, state.azDeg);
    else this.lastFollowMs = 0; // reset so re-enabling starts from a small dt
  }

  // Gently ease the camera to keep the Sun centred. Frame-rate independent (eases by the
  // elapsed time, not a fixed per-frame fraction) and never fights an active drag.
  private easeCameraToSun(altDeg: number, azDeg: number) {
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

  // Build the empty trail: a pre-allocated point cloud with a per-vertex alpha attribute,
  // drawn as fat soft discs (gl_PointSize) that overlap into a continuous, easy-to-follow
  // ribbon which fades to transparent toward the tail. A thin line through the same points
  // keeps it looking continuous at high playback speed, where the Sun can step far enough
  // between frames to space the dots apart. Both share one geometry.
  private makeTrail(): THREE.Points {
    const N = this.trailMax;
    this.trailPos = new Float32Array(N * 3);
    this.trailAlpha = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.trailAlpha, 1));
    geo.setDrawRange(0, 0);
    this.trailGeo = geo;
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xffd884) },
        // gl_PointSize is in framebuffer pixels, so scale the CSS size by the pixel ratio.
        uSize: { value: this.trailDotPx * this.renderer.getPixelRatio() },
      },
      vertexShader: `
        attribute float aAlpha;
        uniform float uSize;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_PointSize = uSize;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          // Soft round disc: solid core, quick falloff at the rim.
          float d = length(gl_PointCoord - vec2(0.5));
          float a = vAlpha * smoothstep(0.5, 0.32, d);
          if (a <= 0.001) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true, // let the ground occlude any part below the horizon
    });
    const points = new THREE.Points(geo, this.trailMat);
    points.frustumCulled = false; // positions are mutated in place; skip stale-bounds culling
    points.renderOrder = 1;
    points.visible = false;

    // Thin connecting core: a 1px line (WebGL ignores wider widths) sharing the same
    // per-vertex alpha, so even when the dots are spaced out the path stays unbroken.
    this.trailLineMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffd884) } },
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor, vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    const line = new THREE.Line(geo, this.trailLineMat);
    line.frustumCulled = false;
    line.renderOrder = 1;
    line.visible = false;
    this.trailLine = line;

    return points;
  }

  /** Turn the Sun trail on or off; turning it off discards the recorded path. */
  setTrailEnabled(on: boolean) {
    if (on === this.trailEnabled) return;
    this.trailEnabled = on;
    this.trail.visible = on;
    this.trailLine.visible = on;
    if (!on) this.clearTrail();
  }

  /** Forget the recorded path (used on date/scenario/location jumps and view changes). */
  clearTrail() {
    this.trailPoints.length = 0;
    this.trailGeo.setDrawRange(0, 0);
  }

  /**
   * Record the Sun's current sky position for the trail. Points are only added once the
   * Sun has moved far enough (so the line stays smooth and speed-independent and never
   * piles up while paused); a large jump (a scrub or a singular standstill) restarts the
   * trail instead of drawing a streak across the sky.
   */
  pushTrail(altDeg: number, azDeg: number) {
    if (!this.trailEnabled) return;
    const dir = dirFromAltAz(altDeg, azDeg).multiplyScalar(this.trailRadius);
    const pts = this.trailPoints;
    if (pts.length > 0) {
      const last = pts[pts.length - 1];
      // Both points sit on the dome at trailRadius, so |last||dir| = trailRadius^2.
      const cos = last.dot(dir) / (this.trailRadius * this.trailRadius);
      if (cos > this.trailMinSepCos) return; // not moved enough yet
      if (cos < this.trailBreakCos) this.clearTrail(); // discontinuity: start fresh
    }
    pts.push(dir);
    if (pts.length > this.trailMax) pts.shift();
    this.writeTrail();
  }

  // Copy the recorded points into the GPU buffers, ramping alpha from 0 at the oldest
  // point to 1 at the newest so the tail gradually disappears.
  private writeTrail() {
    const pts = this.trailPoints;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      this.trailPos[i * 3] = p.x;
      this.trailPos[i * 3 + 1] = p.y;
      this.trailPos[i * 3 + 2] = p.z;
      this.trailAlpha[i] = n > 1 ? i / (n - 1) : 1;
    }
    this.trailGeo.setDrawRange(0, n);
    (this.trailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
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
      // Grab-style, matching the orbital view: drag right looks left, drag down
      // tilts up, as if pulling the sky around.
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
    // Keep the trail dots a fixed CSS-pixel size even if the display's pixel density changed
    // (gl_PointSize is in framebuffer pixels, so it must track the renderer's pixel ratio).
    this.trailMat.uniforms.uSize.value = this.trailDotPx * this.renderer.getPixelRatio();
  }
}
// A seamless, tileable turf texture for a given season appearance: green when lush
// (dryness 0), golden/tan when dormant (dryness 1), and snow-covered when cold
// (snow 1, with sparse dry blades poking through). Drawn with wrap-around copies so
// it repeats cleanly.
function makeGrassTexture(dryness = 0, snow = 0): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;

  // Base turf colour: green -> dry tan -> snow white.
  const base = mix(mix([0x49, 0x6a, 0x3b], [0x8a, 0x7d, 0x44], dryness), [0xe9, 0xee, 0xf2], snow);
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, S, S);

  // Soft lighter/darker patches (kept clear of edges so they tile).
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

  // Blade strokes, each drawn in a 3x3 wrap so the texture tiles seamlessly. Greens
  // shift toward gold as the grass dries; fewer blades show through deepening snow.
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

  // Snow blanket on top: a soft white wash plus a few brighter sparkles.
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

