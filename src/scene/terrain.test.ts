import { describe, expect, it } from 'vitest';
import { TerrainMap, wetnessFromColor } from './terrain';

// Representative Blue Marble open-sea color.
const SEA: [number, number, number] = [11, 10, 50];

function mapFrom(
  width: number,
  height: number,
  color: (x: number, y: number) => [number, number, number],
): TerrainMap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = color(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return TerrainMap.fromImageData(data, width, height);
}

describe('telling sea from land by colour', () => {
  it('calls the ocean water and every kind of ground land', () => {
    expect(wetnessFromColor(...SEA)).toBe(1);
    // Sampled from the imagery: forest, desert, dry scrub, ice cap, bare rock.
    for (const land of [
      [65, 80, 23],
      [248, 235, 159],
      [117, 119, 70],
      [255, 255, 255],
      [176, 168, 156],
      [35, 58, 12],
    ] as [number, number, number][]) {
      expect(wetnessFromColor(...land)).toBe(0);
    }
  });

  it('grades the coast rather than forcing a choice', () => {
    const coast = wetnessFromColor(36, 40, 50);
    expect(coast).toBeGreaterThan(0);
    expect(coast).toBeLessThan(1);
  });

  it('rises with blueness and never leaves 0 to 1', () => {
    let previous = -1;
    for (let b = 0; b <= 255; b += 5) {
      const w = wetnessFromColor(20, 20, b);
      expect(w).toBeGreaterThanOrEqual(previous);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      previous = w;
    }
  });

  it('is not fooled by brightness alone', () => {
    for (const v of [0, 60, 128, 200, 255]) {
      expect(wetnessFromColor(v, v, v)).toBe(0);
    }
  });
});

describe('looking up a place on the water map', () => {
  it('reads the pixel a place actually falls in', () => {
    // Two columns: western hemisphere sea, eastern hemisphere land.
    const map = mapFrom(2, 1, (x) => (x === 0 ? SEA : [60, 80, 30]));
    expect(map.wetnessAt(0, -90)).toBeCloseTo(1, 6); // centre of the western pixel
    expect(map.wetnessAt(0, 90)).toBeCloseTo(0, 6); // centre of the eastern pixel
  });

  it('blends between pixels instead of stepping between them', () => {
    const map = mapFrom(2, 1, (x) => (x === 0 ? SEA : [60, 80, 30]));
    // Halfway between the two pixel centres, so halfway between their values.
    expect(map.wetnessAt(0, 0)).toBeCloseTo(0.5, 2);
    let previous = 2;
    for (let lon = -90; lon <= 90; lon += 10) {
      const w = map.wetnessAt(0, lon);
      expect(w).toBeLessThanOrEqual(previous + 1e-9);
      previous = w;
    }
  });

  it('reads across the date line rather than stopping at the edge of the map', () => {
    // The two edge columns must DIFFER, or wrapping and clamping give the same answer and
    // the test cannot tell them apart. With sea in both, clamping longitude passed this.
    // Sea only in column 0, land in 1..3, so the seam blends land into sea.
    const map = mapFrom(4, 1, (x) => (x === 0 ? SEA : [60, 80, 30]));
    // Exactly on the date line sits half a pixel past the last column, so it is the mean
    // of the last column and the first. Clamping would return the last column alone.
    expect(map.wetnessAt(0, 180)).toBeCloseTo(0.5, 6);
    expect(map.wetnessAt(0, -180)).toBeCloseTo(0.5, 6);
    // Well inside the last column there is no sea to reach.
    expect(map.wetnessAt(0, 130)).toBeCloseTo(0, 6);
  });

  it('survives the poles, where there is nothing beyond', () => {
    const map = mapFrom(4, 4, (_x, y) => (y === 0 ? SEA : [60, 80, 30]));
    for (const lat of [90, -90, 89.999, -89.999]) {
      const w = map.wetnessAt(lat, 0);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
    // The top row is sea, so the north pole reads as sea.
    expect(map.wetnessAt(90, 0)).toBeCloseTo(1, 6);
  });

  it('puts north at the top and south at the bottom', () => {
    // Equirectangular rows run from +90 to -90 degrees.
    const map = mapFrom(1, 2, (_x, y) => (y === 0 ? SEA : [60, 80, 30]));
    expect(map.wetnessAt(45, 0)).toBeCloseTo(1, 6);
    expect(map.wetnessAt(-45, 0)).toBeCloseTo(0, 6);
  });
});

describe('refusing to build a map that cannot answer', () => {
  it('rejects any shape it could not answer from', () => {
    const ok = new Uint8ClampedArray(4 * 4 * 4);
    expect(() => TerrainMap.fromImageData(ok, 4, 4)).not.toThrow();
    expect(() => TerrainMap.fromImageData(ok, 0, 4)).toThrow();
    expect(() => TerrainMap.fromImageData(ok, 4, 0)).toThrow();
    expect(() => TerrainMap.fromImageData(ok, -4, 4)).toThrow();
    expect(() => TerrainMap.fromImageData(ok, 4.5, 4)).toThrow();
    expect(() => TerrainMap.fromImageData(ok, Number.NaN, 4)).toThrow();
    expect(() => TerrainMap.fromImageData(ok, Infinity, 4)).toThrow();
    expect(() => TerrainMap.fromImageData(ok, 8, 8)).toThrow();
    expect(() => TerrainMap.fromImageData(ok, 2, 2)).toThrow();
  });
});
