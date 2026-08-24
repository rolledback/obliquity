import * as THREE from 'three';
import { DEG } from '../astro/vec';
import { dirFromAltAz } from './skyGeometry';

const MAX_POINTS = 320;
const DOT_PX = 13; // on-screen diameter of each soft dot
const MIN_SEP_COS = Math.cos(0.5 * DEG); // record once moved about half a degree
const BREAK_COS = Math.cos(30 * DEG); // a bigger jump restarts the trail

/**
 * A fading trail across the sky dome: soft overlapping dots with a thin line through them,
 * since WebGL ignores line width and dots alone separate at speed.
 */
export class SkyTrail {
  readonly points: THREE.Points;
  readonly line: THREE.Line;

  private readonly geo: THREE.BufferGeometry;
  private readonly dotMat: THREE.ShaderMaterial;
  private readonly lineMat: THREE.ShaderMaterial;
  private readonly pos = new Float32Array(MAX_POINTS * 3);
  private readonly alpha = new Float32Array(MAX_POINTS);
  private readonly recorded: THREE.Vector3[] = [];
  private enabled = false;

  constructor(
    private readonly radius: number,
    color: number,
    pixelRatio: number,
  ) {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo.setDrawRange(0, 0);

    this.dotMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        // gl_PointSize uses framebuffer pixels, not CSS pixels.
        uSize: { value: DOT_PX * pixelRatio },
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
    this.points = new THREE.Points(this.geo, this.dotMat);
    this.points.frustumCulled = false; // positions are mutated in place
    this.points.renderOrder = 1;
    this.points.visible = false;

    this.lineMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) } },
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
          if (vAlpha <= 0.001) discard;
          gl_FragColor = vec4(uColor, vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.line = new THREE.Line(this.geo, this.lineMat);
    this.line.frustumCulled = false;
    this.line.renderOrder = 1;
    this.line.visible = false;
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.points.visible = on;
    this.line.visible = on;
    if (!on) this.clear();
  }

  clear() {
    this.recorded.length = 0;
    this.geo.setDrawRange(0, 0);
  }

  /** Record a position, skipping tiny moves and restarting after a jump. */
  push(altDeg: number, azDeg: number) {
    this.pushDir(dirFromAltAz(altDeg, azDeg));
  }

  /** Record from a unit direction, for callers that already have the drawn one. */
  pushDir(unitDir: THREE.Vector3) {
    if (!this.enabled) return;
    const dir = unitDir.clone().multiplyScalar(this.radius);
    const pts = this.recorded;
    if (pts.length > 0) {
      const cos = pts[pts.length - 1].dot(dir) / (this.radius * this.radius);
      if (cos > MIN_SEP_COS) return;
      if (cos < BREAK_COS) this.clear();
    }
    pts.push(dir);
    if (pts.length > MAX_POINTS) pts.shift();
    this.write();
  }

  /** Point size is in framebuffer pixels, so it must follow a display change. */
  setPixelRatio(ratio: number) {
    this.dotMat.uniforms.uSize.value = DOT_PX * ratio;
  }

  private write() {
    const pts = this.recorded;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      this.alpha[i] = n > 1 ? i / (n - 1) : 1; // brightest at the newest point
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.setDrawRange(0, n);
  }
}
