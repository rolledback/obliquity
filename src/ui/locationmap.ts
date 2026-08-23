import { clamp } from '../astro/vec';
import { beginCanvas } from './draw';

const PIN_COLOR = '#ff5e7e';
const GRATICULE = 'rgba(255,255,255,0.16)';
const MARGIN_FILL = '#05070f';

interface MapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class LocationMap {
  private ctx: CanvasRenderingContext2D;
  private img: HTMLImageElement;
  private imgReady = false;
  private latDeg = 0;
  private lonDeg = 0;
  private dragging = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private statsEl: HTMLElement,
    private onPick: (latDeg: number, lonDeg: number) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.img = new Image();
    this.img.onload = () => {
      this.imgReady = true;
      this.render();
    };
    this.img.onerror = () => {
      console.warn(`Obliquity: could not load ${this.img.src}; the location map will be blank`);
    };
    this.img.src = `${import.meta.env.BASE_URL}textures/earth.webp`;
    this.attachPointer();
    this.attachKeyboard();
  }

  /** Update the pin after the location changes elsewhere. */
  setLocation(latDeg: number, lonDeg: number) {
    this.latDeg = latDeg;
    this.lonDeg = lonDeg;
    this.render();
  }

  resize() {
    this.render();
  }

  // Preserve the map's 2:1 aspect ratio without stretching.
  private mapRect(cw: number, ch: number): MapRect {
    let w = cw;
    let h = cw / 2;
    if (h > ch) {
      h = ch;
      w = ch * 2;
    }
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  render() {
    const dims = beginCanvas(this.canvas, this.ctx);
    if (!dims) return;
    const { w: cw, h: ch } = dims;
    const ctx = this.ctx;

    ctx.fillStyle = MARGIN_FILL;
    ctx.fillRect(0, 0, cw, ch);

    const r = this.mapRect(cw, ch);
    if (this.imgReady) {
      ctx.drawImage(this.img, r.x, r.y, r.w, r.h);
    }
    this.drawGraticule(r);
    this.drawPin(r);
    this.renderStats();
  }

  private drawGraticule(r: MapRect) {
    const ctx = this.ctx;
    ctx.strokeStyle = GRATICULE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = r.x + ((lon + 180) / 360) * r.w;
      ctx.moveTo(x, r.y);
      ctx.lineTo(x, r.y + r.h);
    }
    for (let lat = -90; lat <= 90; lat += 30) {
      const y = r.y + ((90 - lat) / 180) * r.h;
      ctx.moveTo(r.x, y);
      ctx.lineTo(r.x + r.w, y);
    }
    ctx.stroke();
  }

  private drawPin(r: MapRect) {
    const x = r.x + ((this.lonDeg + 180) / 360) * r.w;
    const y = r.y + ((90 - this.latDeg) / 180) * r.h;
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,94,126,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r.x, y);
    ctx.lineTo(r.x + r.w, y);
    ctx.moveTo(x, r.y);
    ctx.lineTo(x, r.y + r.h);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = PIN_COLOR;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(5,7,13,0.9)';
    ctx.stroke();
  }

  private renderStats() {
    const ns = this.latDeg >= 0 ? 'N' : 'S';
    const ew = this.lonDeg >= 0 ? 'E' : 'W';
    this.statsEl.innerHTML =
      `<span class="chip">Lat: <b>${Math.abs(this.latDeg).toFixed(1)}\u00B0${ns}</b></span>` +
      `<span class="chip">Lon: <b>${Math.abs(this.lonDeg).toFixed(1)}\u00B0${ew}</b></span>`;
  }

  private pickLatLon(e: PointerEvent): { latDeg: number; lonDeg: number } {
    const rect = this.canvas.getBoundingClientRect();
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const r = this.mapRect(cw, ch);
    const fx = clamp((e.clientX - rect.left - r.x) / r.w, 0, 1);
    const fy = clamp((e.clientY - rect.top - r.y) / r.h, 0, 1);
    return { lonDeg: fx * 360 - 180, latDeg: 90 - fy * 180 };
  }

  private attachPointer() {
    const el = this.canvas;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dragging = true;
      el.setPointerCapture(e.pointerId);
      const { latDeg, lonDeg } = this.pickLatLon(e);
      this.onPick(latDeg, lonDeg);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const { latDeg, lonDeg } = this.pickLatLon(e);
      this.onPick(latDeg, lonDeg);
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  private attachKeyboard() {
    this.canvas.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      let lat = this.latDeg;
      let lon = this.lonDeg;
      if (e.key === 'ArrowUp') lat = clamp(lat + step, -90, 90);
      else if (e.key === 'ArrowDown') lat = clamp(lat - step, -90, 90);
      else if (e.key === 'ArrowLeft') lon = clamp(lon - step, -180, 180);
      else if (e.key === 'ArrowRight') lon = clamp(lon + step, -180, 180);
      else return;
      e.preventDefault();
      this.onPick(lat, lon);
    });
  }
}
