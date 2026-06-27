// Procedural fallback texture: a latitude/longitude graticule with tinted
// hemispheres and a marked prime meridian, so the globe's rotation is legible
// even if the photographic Earth texture fails to load.

import * as THREE from 'three';

export function makeGraticuleTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // Ocean-ish base, slightly lighter in the northern hemisphere.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#16324f');
  grad.addColorStop(0.5, '#1b3e5c');
  grad.addColorStop(1, '#122a44');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(150, 180, 220, 0.35)';
  ctx.lineWidth = 1;
  // Parallels every 15 degrees of latitude.
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // Meridians every 15 degrees of longitude.
  for (let lon = 0; lon <= 360; lon += 15) {
    const x = (lon / 360) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // Equator and prime meridian emphasised.
  ctx.strokeStyle = 'rgba(255, 206, 84, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(94, 200, 255, 0.8)';
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.stroke();

  // Pole caps.
  ctx.fillStyle = 'rgba(220, 235, 255, 0.5)';
  ctx.fillRect(0, 0, w, h * 0.06);
  ctx.fillRect(0, h * 0.94, w, h * 0.06);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
