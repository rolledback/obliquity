// 3D visualisation: the Sun, the orbiting/spinning Earth, its rotation axis,
// equator, orbit path, a location marker and the sub-solar point.

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

const ORBIT_RADIUS = 26;
const EARTH_RADIUS = 2.2;
const SUN_RADIUS = 4;
const AXIS_HALF = EARTH_RADIUS * 1.7;
// Aligns the photographic map so its prime meridian (the image's horizontal centre,
// 0 deg longitude) lands on the earth-fixed +X axis, which is exactly where the
// location pin places longitude 0. This MUST be 0 for the pin to sit over the right
// place on the map and for the Sun to light the correct continents; any non-zero
// value rotates the continents away from the pin (a -90 deg value put every pin a
// quarter-globe off). It does not affect the Sun-position math, only the texture.
const TEXTURE_LON_OFFSET = 0;

export interface SceneState {
  config: RotationConfig;
  dayOfYear: number;
  spinDeg: number;
  latDeg: number;
  lonDeg: number;
  show: ShowOptions;
  followEarth: boolean;
  /** Longitude accumulated across orbits, driving a precessing axis. */
  axisPhaseLonDeg?: number;
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

  private prevEarthPos = new THREE.Vector3();
  private hasPrev = false;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(displayPixelRatio());
    this.renderer.setClearColor(0x05070d, 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1); // ecliptic north is +Z in our world frame
    this.camera.position.set(-ORBIT_RADIUS + 6, -18, 13);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Lighting: the Sun is a point light at the origin; a little ambient keeps the
    // night side from being pure black.
    this.sunLight = new THREE.PointLight(0xfff6e0, 3.2, 0, 0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0x223046, 0.6));

    this.buildSun();
    this.stars = this.buildStars();
    this.scene.add(this.stars);

    // Earth.
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
    this.loadEarthTexture(material);

    // Rotation axis (thin cylinder along the north-pole direction).
    this.axis = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, AXIS_HALF * 2, 12),
      new THREE.MeshBasicMaterial({ color: 0xffce54 }),
    );
    this.scene.add(this.axis);

    this.equator = this.buildRing(EARTH_RADIUS * 1.001, 0x5ec8ff);
    this.scene.add(this.equator);

    this.orbit = this.buildRing(ORBIT_RADIUS, 0x39507a);
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
    this.scene.add(this.sunLine);

    this.grid = new THREE.PolarGridHelper(ORBIT_RADIUS, 16, 6, 64, 0x1d2940, 0x141d30);
    this.grid.rotateX(Math.PI / 2); // lay it in the ecliptic (XY) plane
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(this.grid);

    this.resize();
  }

  private buildSun() {
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_RADIUS, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd14a }),
    );
    this.scene.add(sun);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_RADIUS * 1.6, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.18 }),
    );
    this.scene.add(glow);
  }

  private buildStars(): THREE.Points {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3()
        .randomDirection()
        .multiplyScalar(900 + Math.random() * 300);
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
    const pts: THREE.Vector3[] = [];
    const seg = 128;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color }));
  }

  private loadEarthTexture(material: THREE.MeshStandardMaterial) {
    new THREE.TextureLoader().load(
      `${import.meta.env.BASE_URL}textures/earth.jpg`,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        const old = material.map;
        material.map = tex;
        material.needsUpdate = true;
        old?.dispose(); // free the procedural graticule fallback's GPU texture
      },
      undefined,
      () => {
        // Keep the procedural graticule fallback already in place.
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
    const sunLon = sunLongitudeDeg(dayOfYear);
    const sunDir = sunDirEcliptic(sunLon);
    const earthPos = toVec3(sunDir).multiplyScalar(-ORBIT_RADIUS);

    const axisP = axisParamsAt(config, sunLon, state.axisPhaseLonDeg ?? sunLon);
    const fullM = earthMatrix(axisP.obliquityDeg, axisP.axisLongitudeDeg, spinDeg);
    const tiltM = earthMatrix(axisP.obliquityDeg, axisP.axisLongitudeDeg, 0);
    const nVec = toVec3(northPole(axisP.obliquityDeg, axisP.axisLongitudeDeg));

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

    // Location marker on the surface.
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

    // Sub-solar point: where the Sun is directly overhead.
    this.subsolar.position.copy(
      earthPos.clone().add(toVec3(sunDir).multiplyScalar(EARTH_RADIUS)),
    );
    this.subsolar.visible = show.subsolar;

    // Earth-to-Sun line.
    this.sunLine.visible = show.sunline;
    if (show.sunline) {
      const arr = (this.sunLine.geometry.attributes.position as THREE.BufferAttribute);
      arr.setXYZ(0, earthPos.x, earthPos.y, earthPos.z);
      arr.setXYZ(1, 0, 0, 0);
      arr.needsUpdate = true;
    }

    // Camera follow: translate the camera and target with the Earth so it stays
    // centred while preserving the user's orbit/zoom.
    if (state.followEarth) {
      if (this.hasPrev) {
        const delta = earthPos.clone().sub(this.prevEarthPos);
        this.camera.position.add(delta);
      }
      this.controls.target.copy(earthPos);
      this.prevEarthPos.copy(earthPos);
      this.hasPrev = true;
    } else {
      this.controls.target.set(0, 0, 0);
      this.hasPrev = false;
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
    // Re-apply the capped device pixel ratio in case the window moved to a display with a
    // different density (mirrors SkyView.resize, so all renderers stay consistent).
    this.renderer.setPixelRatio(displayPixelRatio());
    // updateStyle must stay true: with setPixelRatio > 1 the canvas buffer is
    // larger than the container, and the CSS size must be set back to w x h so the
    // canvas displays at container size (otherwise it renders at buffer size and
    // overflows to the bottom-right on HiDPI screens).
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
