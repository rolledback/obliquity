import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  axisParamsAt,
  earthMatrix,
  northPole,
  sunDirEcliptic,
} from '../astro/orientation';
import { sunLongitudeDeg } from '../astro/config';
import type { RotationConfig } from '../astro/config';
import { matVec, geographicUnit } from '../astro/vec';
import type { Mat3, V3 } from '../astro/vec';
import { makeGraticuleTexture } from './graticule';
import { displayPixelRatio } from '../displayRatio';
import type { ShowOptions } from '../state';
import {
  AU_KM,
  EARTH_RADIUS_KM,
  SUN_RADIUS_KM,
  MOON_RADIUS_KM,
  SEMI_MAJOR_AXIS_KM,
  SIDEREAL_MONTH_DAYS,
  moonPositionKm,
} from '../astro/moon';
import type { MoonState } from '../astro/moon';
import type { LunarEclipse } from '../astro/eclipse';
import { norm, normalize } from '../astro/vec';

/** Earth radius in scene units. */
export const EARTH_RADIUS = 2.2;
const AXIS_HALF = EARTH_RADIUS * 1.7;

/** Scene dimensions, with Earth fixed as the ruler in both layouts. */
export interface ScaleProfile {
  // applyScale caches by object identity, so profiles must not mutate.
  /** Earth's distance from the Sun. */
  readonly orbitRadius: number;
  /** Sun radius. */
  readonly sunRadius: number;
  /** Moon distance at its mean orbital distance. */
  readonly moonOrbitRadius: number;
  /** Inner radius of the enclosing star shell. */
  readonly starRadius: number;
}

/** Readable layout with compressed distances and an enlarged Sun. */
export const DIAGRAM_SCALE: ScaleProfile = {
  orbitRadius: 26,
  sunRadius: 4,
  moonOrbitRadius: EARTH_RADIUS * 3.1,
  starRadius: 900,
};

const UNITS_PER_KM = EARTH_RADIUS / EARTH_RADIUS_KM;
/** Real Sun, Earth, and Moon scale, plus an enclosing display shell. */
export const TRUE_SCALE: ScaleProfile = {
  orbitRadius: AU_KM * UNITS_PER_KM,
  sunRadius: SUN_RADIUS_KM * UNITS_PER_KM,
  moonOrbitRadius: SEMI_MAJOR_AXIS_KM * UNITS_PER_KM,
  starRadius: AU_KM * UNITS_PER_KM * 2.5,
};

// Moon size stays true relative to Earth in both layouts.
const MOON_RADIUS = EARTH_RADIUS * (MOON_RADIUS_KM / EARTH_RADIUS_KM);
// White preserves the texture color outside lunar eclipses.
const MOON_TINT = 0xffffff;

const STAR_SHELL_THICKNESS = 1 / 3;

function buildRingGeometry(radius: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const seg = 128;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

// Model contacts put the penumbra at 0.577 to 0.623 rad, with 0.583 at mean distance.
// The true 0.02 rad umbra is enlarged to 0.14 rad so it remains visible.
const PENUMBRA_ANGLE = 0.583;
const UMBRA_ANGLE = 0.14;
// Leaving 20% visible matches the modeled night side, about 21% after sRGB transfer.
const NIGHT_MATCH = 0.8;
// Must stay zero: the texture center and earth-fixed +X both represent longitude 0.
const TEXTURE_LON_OFFSET = 0;

/** Inputs needed to update the orbital scene for one frame. */
export interface SceneState {
  config: RotationConfig;
  dayOfYear: number;
  spinDeg: number;
  latDeg: number;
  lonDeg: number;
  show: ShowOptions;
  followEarth: boolean;
  /** Use true sizes and distances instead of the diagram layout. */
  trueScale: boolean;
  /** Longitude accumulated across orbits, driving a precessing axis. */
  axisPhaseLonDeg?: number;
  /** The Moon at this instant, or undefined to leave it hidden. */
  moon?: MoonState;
  /** Absolute days, used to trace the Moon's orbit from its real path. */
  absDays?: number;
  /** Lunar eclipse status, which is what reddens the Moon. */
  lunarEclipse?: LunarEclipse;
  /** Where the Moon's shadow meets the Earth (ecliptic frame, km), or null when it misses. */
  shadowCentreKm?: V3 | null;
}

function quatFromMat3(m: Mat3): THREE.Quaternion {
  const m4 = new THREE.Matrix4();
  m4.set(
    m[0], m[1], m[2], 0,
    m[3], m[4], m[5], 0,
    m[6], m[7], m[8], 0,
    0, 0, 0, 1,
  );
  return new THREE.Quaternion().setFromRotationMatrix(m4);
}

const toVec3 = (v: V3) => new THREE.Vector3(v[0], v[1], v[2]);

/** Three.js renderer for the orbital view. */
export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;

  private earthMesh: THREE.Mesh;
  private axis: THREE.Mesh;
  private equator: THREE.LineLoop;
  private orbit: THREE.LineLoop;
  private marker: THREE.Mesh;
  private markerStick: THREE.Mesh;
  private subsolar: THREE.Mesh;
  private sunLine: THREE.Line;
  private grid: THREE.PolarGridHelper;
  private stars: THREE.Points;
  private sunLight: THREE.PointLight;

  private moon: THREE.Mesh;
  private moonMat: THREE.MeshStandardMaterial;
  private moonOrbit: THREE.LineLoop;
  private moonShadow: THREE.Mesh;
  private moonOrbitDay = Number.NaN;

  private prevEarthPos = new THREE.Vector3();
  private hasPrev = false;
  // Null ensures the first applyScale initializes profile-dependent geometry.
  private applied: ScaleProfile | null = null;
  private sun!: THREE.Mesh;
  private sunGlow!: THREE.Mesh;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(displayPixelRatio());
    this.renderer.setClearColor(0x05070d, 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1); // ecliptic north is +Z in our world frame
    this.camera.position.set(-DIAGRAM_SCALE.orbitRadius + 6, -18, 13);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // No falloff, so position controls light direction without changing intensity.
    this.sunLight = new THREE.PointLight(0xfff6e0, 3.2, 0, 0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0x223046, 0.6));

    this.buildSun();
    this.stars = this.buildStars();
    this.scene.add(this.stars);

    const geo = new THREE.SphereGeometry(EARTH_RADIUS, 64, 48);
    geo.rotateX(Math.PI / 2); // move texture poles from +Y to +Z (our north pole)
    geo.rotateZ(TEXTURE_LON_OFFSET);
    const material = new THREE.MeshStandardMaterial({
      map: makeGraticuleTexture(),
      roughness: 1,
      metalness: 0,
    });
    this.earthMesh = new THREE.Mesh(geo, material);
    this.scene.add(this.earthMesh);
    this.loadSurfaceMap(material, 'earth.webp');

    this.axis = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, AXIS_HALF * 2, 12),
      new THREE.MeshBasicMaterial({ color: 0xffce54 }),
    );
    this.scene.add(this.axis);

    this.equator = this.buildRing(EARTH_RADIUS * 1.001, 0x5ec8ff);
    this.scene.add(this.equator);

    this.orbit = this.buildRing(DIAGRAM_SCALE.orbitRadius, 0x39507a);
    this.scene.add(this.orbit);

    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff5e7e }),
    );
    this.scene.add(this.marker);
    this.markerStick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, EARTH_RADIUS * 0.6, 8),
      new THREE.MeshBasicMaterial({ color: 0xff5e7e }),
    );
    this.scene.add(this.markerStick);

    this.subsolar = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd27f }),
    );
    this.scene.add(this.subsolar);

    const sunLineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.sunLine = new THREE.Line(
      sunLineGeo,
      new THREE.LineBasicMaterial({ color: 0x6b7a99 }),
    );
    // Mutable endpoints leave stale bounds, so frustum culling can hide the line.
    this.sunLine.frustumCulled = false;
    this.scene.add(this.sunLine);

    this.grid = this.makeEclipticGrid(DIAGRAM_SCALE.orbitRadius);
    this.scene.add(this.grid);

    // Ordinary lighting draws the Moon's phase.
    this.moonMat = new THREE.MeshStandardMaterial({
      color: MOON_TINT,
      roughness: 1,
      metalness: 0,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 32, 24), this.moonMat);
    this.loadSurfaceMap(this.moonMat, 'moon.webp');
    this.scene.add(this.moon);

    this.moonOrbit = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x4a5f86, transparent: true, opacity: 0.75 }),
    );
    this.scene.add(this.moonOrbit);

    this.moonShadow = this.buildMoonShadow();
    this.scene.add(this.moonShadow);

    this.resize();
  }

  /** Builds a curved cap with an umbral core and fading penumbra. */
  private buildMoonShadow(): THREE.Mesh {
    const RINGS = 24;
    const SEGMENTS = 64;
    const R = EARTH_RADIUS * 1.0015; // a hair above the surface, to avoid z-fighting
    const positions: number[] = [];
    const colors: number[] = [];

    // Fade from night-side darkness through the penumbra.
    const alphaAt = (angle: number) => {
      if (angle <= UMBRA_ANGLE) return NIGHT_MATCH;
      const t = (angle - UMBRA_ANGLE) / (PENUMBRA_ANGLE - UMBRA_ANGLE);
      // Sharp umbra edge, then a gradual penumbra fade.
      return NIGHT_MATCH * 0.62 * Math.pow(1 - Math.min(1, t), 1.5);
    };
    // A point on the cap, with the cap centred on +Y.
    const at = (ring: number, seg: number): [number, number, number] => {
      const angle = (ring / RINGS) * PENUMBRA_ANGLE;
      const phi = (seg / SEGMENTS) * Math.PI * 2;
      const sa = Math.sin(angle);
      return [R * sa * Math.cos(phi), R * Math.cos(angle), R * sa * Math.sin(phi)];
    };

    for (let ring = 0; ring < RINGS; ring++) {
      for (let seg = 0; seg < SEGMENTS; seg++) {
        const a = at(ring, seg);
        const b = at(ring + 1, seg);
        const c = at(ring + 1, seg + 1);
        const d = at(ring, seg + 1);
        const aIn = alphaAt((ring / RINGS) * PENUMBRA_ANGLE);
        const aOut = alphaAt(((ring + 1) / RINGS) * PENUMBRA_ANGLE);
        positions.push(...a, ...b, ...c, ...a, ...c, ...d);
        for (const alpha of [aIn, aOut, aOut, aIn, aOut, aIn]) {
          colors.push(0, 0, 0, alpha);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.visible = false;
    mesh.renderOrder = 3;
    return mesh;
  }

  /** Traces the model's elliptical, inclined Moon orbit and regressing nodes. */
  private rebuildMoonOrbit(absDays: number, radius: number) {
    // Rebuild after six hours; applyScale invalidates the cache for radius changes.
    if (Math.abs(absDays - this.moonOrbitDay) < 0.25) return;
    this.moonOrbitDay = absDays;
    const segments = 160;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < segments; i++) {
      const p = moonPositionKm(absDays + (i / segments) * SIDEREAL_MONTH_DAYS);
      const s = (radius * norm(p)) / SEMI_MAJOR_AXIS_KM;
      const u = normalize(p);
      pts.push(new THREE.Vector3(u[0] * s, u[1] * s, u[2] * s));
    }
    this.moonOrbit.geometry.dispose();
    this.moonOrbit.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  private buildSun() {
    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd14a }),
    );
    this.scene.add(this.sun);
    this.sunGlow = new THREE.Mesh(
      new THREE.SphereGeometry(1.6, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.18 }),
    );
    this.scene.add(this.sunGlow);
  }

  /** Applies profile-dependent geometry and camera clipping after a layout change. */
  private applyScale(next: ScaleProfile): ScaleProfile {
    if (next === this.applied) return next;
    const previous = this.applied;
    this.applied = next;
    this.moonOrbitDay = Number.NaN;

    this.sun.scale.setScalar(next.sunRadius);
    this.sunGlow.scale.setScalar(next.sunRadius);
    this.stars.scale.setScalar(next.starRadius);

    this.orbit.geometry.dispose();
    this.orbit.geometry = buildRingGeometry(next.orbitRadius);

    this.scene.remove(this.grid);
    (this.grid.material as THREE.Material).dispose();
    this.grid.geometry.dispose();
    this.grid = this.makeEclipticGrid(next.orbitRadius);
    this.scene.add(this.grid);

    // Include the shell thickness and camera offset; a 1.6x margin clipped about 5% of stars.
    const outermost = next.starRadius * (1 + STAR_SHELL_THICKNESS) + next.orbitRadius;
    this.camera.far = outermost * 1.05;
    this.camera.updateProjectionMatrix();

    // Preserve the camera-to-Earth offset while scaling its target between layouts.
    if (previous) {
      const factor = next.orbitRadius / previous.orbitRadius;
      const offset = this.camera.position.clone().sub(this.controls.target);
      this.controls.target.multiplyScalar(factor);
      this.camera.position.copy(this.controls.target).add(offset);
      this.prevEarthPos.multiplyScalar(factor);
    }
    return next;
  }

  private makeEclipticGrid(radius: number): THREE.PolarGridHelper {
    const grid = new THREE.PolarGridHelper(radius, 16, 6, 64, 0x1d2940, 0x141d30);
    grid.rotateX(Math.PI / 2); // lay it in the ecliptic (XY) plane
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    return grid;
  }

  private buildStars(): THREE.Points {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3()
        .randomDirection()
        .multiplyScalar(1 + Math.random() * STAR_SHELL_THICKNESS);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = v.y;
      pos[i * 3 + 2] = v.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: 0xaab4cc, size: 1.4, sizeAttenuation: false }),
    );
  }

  private buildRing(radius: number, color: number): THREE.LineLoop {
    return new THREE.LineLoop(
      buildRingGeometry(radius),
      new THREE.LineBasicMaterial({ color }),
    );
  }


  /** Load a surface map onto a material, leaving whatever is there if it cannot be had. */
  private loadSurfaceMap(material: THREE.MeshStandardMaterial, file: string) {
    new THREE.TextureLoader().load(
      `${import.meta.env.BASE_URL}textures/${file}`,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        const old = material.map;
        material.map = tex;
        material.needsUpdate = true;
        old?.dispose(); // free the replaced fallback texture
      },
      undefined,
      () => {
        // Keep the existing fallback.
      },
    );
  }

  /** Enable or disable the orbit view: toggle its controls and show/hide its canvas. */
  setEnabled(on: boolean): void {
    this.controls.enabled = on;
    this.renderer.domElement.style.display = on ? 'block' : 'none';
  }

  update(state: SceneState) {
    const { config, dayOfYear, spinDeg, latDeg, lonDeg, show } = state;
    const scale = this.applyScale(state.trueScale ? TRUE_SCALE : DIAGRAM_SCALE);
    const sunLon = sunLongitudeDeg(dayOfYear);
    const sunDir = sunDirEcliptic(sunLon);
    const earthPos = toVec3(sunDir).multiplyScalar(-scale.orbitRadius);

    const axisP = axisParamsAt(config, sunLon, state.axisPhaseLonDeg ?? sunLon);
    const fullM = earthMatrix(axisP.obliquityDeg, axisP.axisLongitudeDeg, spinDeg);
    const tiltM = earthMatrix(axisP.obliquityDeg, axisP.axisLongitudeDeg, 0);
    const nVec = toVec3(northPole(axisP.obliquityDeg, axisP.axisLongitudeDeg));

    // Keep the light at true distance in both layouts. Diagram compression is about 1987x
    // for Earth-Sun but 19x for Earth-Moon, so a drawn-position light skewed lunar
    // illumination by up to 13.8 percentage points. The residual is 0.13 points.
    this.sunLight.position
      .copy(earthPos)
      .addScaledVector(toVec3(sunDir), TRUE_SCALE.orbitRadius);

    this.earthMesh.position.copy(earthPos);
    this.earthMesh.quaternion.copy(quatFromMat3(fullM));

    this.axis.position.copy(earthPos);
    this.axis.quaternion.copy(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), nVec),
    );
    this.axis.visible = show.axis;

    this.equator.position.copy(earthPos);
    this.equator.quaternion.copy(quatFromMat3(tiltM));
    this.equator.visible = show.equator;

    this.orbit.visible = show.orbit;
    this.grid.visible = show.grid;
    this.stars.visible = show.stars;

    const locDir = toVec3(matVec(fullM, geographicUnit(latDeg, lonDeg)));
    const markerPos = earthPos.clone().add(locDir.clone().multiplyScalar(EARTH_RADIUS));
    this.marker.position.copy(markerPos);
    this.marker.visible = show.marker;
    this.markerStick.visible = show.marker;
    this.markerStick.position.copy(
      earthPos.clone().add(locDir.clone().multiplyScalar(EARTH_RADIUS * 1.3)),
    );
    this.markerStick.quaternion.copy(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), locDir),
    );

    this.subsolar.position.copy(
      earthPos.clone().add(toVec3(sunDir).multiplyScalar(EARTH_RADIUS)),
    );
    this.subsolar.visible = show.subsolar;

    this.sunLine.visible = show.sunline;
    if (show.sunline) {
      const arr = (this.sunLine.geometry.attributes.position as THREE.BufferAttribute);
      arr.setXYZ(0, earthPos.x, earthPos.y, earthPos.z);
      arr.setXYZ(1, 0, 0, 0);
      arr.needsUpdate = true;
    }

    this.updateMoon(state, earthPos, scale);

    if (state.followEarth) {
      // On first follow, translate from the current target so the camera is not left behind.
      const from = this.hasPrev ? this.prevEarthPos : this.controls.target;
      this.camera.position.add(earthPos.clone().sub(from));
      this.controls.target.copy(earthPos);
      this.prevEarthPos.copy(earthPos);
      this.hasPrev = true;
    } else {
      this.controls.target.set(0, 0, 0);
      this.hasPrev = false;
    }
  }

  /**
   * Places the Moon and its orbit, then maps the astro-computed shadow onto Earth.
   * Shadow placement uses true geometry, independent of compressed display distance.
   */
  private updateMoon(state: SceneState, earthPos: THREE.Vector3, scale: ScaleProfile) {
    const { moon, show } = state;
    if (!moon || !show.moon) {
      this.moon.visible = false;
      this.moonOrbit.visible = false;
      this.moonShadow.visible = false;
      return;
    }

    // Preserve real direction and distance variation while scaling the mean distance.
    const dist = (scale.moonOrbitRadius * moon.distanceKm) / SEMI_MAJOR_AXIS_KM;
    const moonPos = earthPos.clone().add(toVec3(moon.dir).multiplyScalar(dist));
    this.moon.position.copy(moonPos);
    this.moon.visible = true;

    this.moonOrbit.visible = show.moonOrbit;
    if (show.moonOrbit && state.absDays !== undefined) {
      this.rebuildMoonOrbit(state.absDays, scale.moonOrbitRadius);
      this.moonOrbit.position.copy(earthPos);
    }

    const shadow = state.shadowCentreKm ?? null;
    if (shadow) {
      const dir = toVec3(normalize(shadow));
      this.moonShadow.position.copy(earthPos);
      this.moonShadow.quaternion.copy(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir),
      );
      this.moonShadow.visible = true;
    } else {
      this.moonShadow.visible = false;
    }

    const lunar = state.lunarEclipse;
    // Atmospheric refraction reddens a Moon inside Earth's shadow.
    if (lunar && lunar.kind !== 'none') {
      const depth = Math.min(1, Math.max(0, lunar.immersion));
      this.moonMat.color.set(MOON_TINT).lerp(new THREE.Color(0x8c2f14), 0.35 + 0.6 * depth);
    } else {
      this.moonMat.color.set(MOON_TINT);
    }
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    // Refresh pixel ratio after moving between displays with different density.
    this.renderer.setPixelRatio(displayPixelRatio());
    // Keep setSize's default updateStyle=true so HiDPI buffer size does not become CSS size.
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
