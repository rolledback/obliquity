// Open sea's blue lead is about 39, so 28 is fully wet; land is usually at or below zero.
const WATER_SCORE_FULL = 28;
const WATER_SCORE_NONE = 0;

/**
 * Returns 0 to 1 Blue Marble water-likeness, not a calibrated water fraction.
 * Half-water reference cells average about 0.2; global surface classification is 98.6%.
 */
export function wetnessFromColor(r: number, g: number, b: number): number {
  const score = b - Math.max(r, g);
  const t = (score - WATER_SCORE_NONE) / (WATER_SCORE_FULL - WATER_SCORE_NONE);
  return Math.min(1, Math.max(0, t));
}

/** Byte water-likeness map sampled from equirectangular Blue Marble imagery. */
export class TerrainMap {
  private constructor(
    private readonly wetness: Uint8Array,
    readonly width: number,
    readonly height: number,
  ) {}

  /**
   * Builds from equirectangular RGBA data.
   * Throws when dimensions are invalid or disagree with the buffer length.
   */
  static fromImageData(data: Uint8ClampedArray, width: number, height: number): TerrainMap {
    const sane = (n: number) => Number.isSafeInteger(n) && n > 0;
    if (!sane(width) || !sane(height) || data.length !== width * height * 4) {
      throw new Error(
        `terrain image claims ${width}x${height} but carries ${data.length} bytes`,
      );
    }
    const wetness = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      wetness[i] = Math.round(255 * wetnessFromColor(data[o], data[o + 1], data[o + 2]));
    }
    return new TerrainMap(wetness, width, height);
  }

  /**
   * Bilinearly samples water-likeness from 0 to 1.
   * Longitude wraps at the date line; latitude clamps at the poles.
   */
  wetnessAt(latDeg: number, lonDeg: number): number {
    // Pixel centres, hence the half pixel: column 0 is centred half a pixel in from the edge.
    const x = ((((lonDeg + 180) % 360) + 360) % 360) / 360 * this.width - 0.5;
    const y = ((90 - latDeg) / 180) * this.height - 0.5;

    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;

    const wrapX = (i: number) => ((i % this.width) + this.width) % this.width;
    const clampY = (j: number) => Math.min(this.height - 1, Math.max(0, j));
    const at = (i: number, j: number) => this.wetness[clampY(j) * this.width + wrapX(i)] / 255;

    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  }
}

/** Loads Blue Marble imagery as a terrain map, resolving to null on failure. */
export function loadTerrainMap(url: string): Promise<TerrainMap | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve(TerrainMap.fromImageData(data, canvas.width, canvas.height));
      } catch (err) {
        // Cross-origin pixel readback can throw; null makes callers assume land.
        console.warn(`Obliquity: could not read ${url} for the land and water map`, err);
        resolve(null);
      }
    };
    img.onerror = () => {
      console.warn(`Obliquity: could not load ${url}; every location will read as land`);
      resolve(null);
    };
    img.src = url;
  });
}
