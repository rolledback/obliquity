import * as THREE from 'three';

/** Builds the fallback Earth texture used when the surface image cannot load. */
export function makeGraticuleTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#16324f');
  grad.addColorStop(0.5, '#1b3e5c');
  grad.addColorStop(1, '#122a44');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(150, 180, 220, 0.35)';
  ctx.lineWidth = 1;
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (let lon = 0; lon <= 360; lon += 15) {
    const x = (lon / 360) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // Emphasize the equator and prime meridian.
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
