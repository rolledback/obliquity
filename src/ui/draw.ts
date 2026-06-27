// Shared 2D canvas helpers used by the chart panels (sky path, year heatmap, climate).

import { clamp, posMod } from '../astro/vec';
import { MONTH_DAYS, MONTH_LETTERS, MONTH_START_DAYS } from '../astro/presets';
import { displayPixelRatio } from '../displayRatio';

export type RGB = [number, number, number];

/** The UI sans-serif stack; `font(px)` builds a canvas font string for it. */
const SANS = '-apple-system, system-ui, sans-serif';
export const font = (px: number): string => `${px}px ${SANS}`;

/** Time-of-day gridline ticks (hour, label) shared by the day and year charts. */
export const TIME_OF_DAY_TICKS: readonly [number, string][] = [
  [0, '12am'],
  [6, '6am'],
  [12, 'Noon'],
  [18, '6pm'],
  [24, '12am'],
];

/**
 * Size a canvas for crisp HiDPI drawing and clear it. Returns the CSS pixel size, or
 * null when the canvas has no layout size yet (in which case the caller should bail).
 */
export function beginCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): { w: number; h: number } | null {
  const dpr = displayPixelRatio();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { w, h };
}

/** Linearly interpolate two RGB triples and round to integer channels. */
export function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Sample a colour ramp defined by sorted [position, rgb] stops at t in [0, 1]. */
export function sampleRamp(stops: [number, RGB][], t: number): RGB {
  const x = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return lerp3(c0, c1, (x - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

/** Split fractional hours into whole hours and minutes, rolling 60 m up to the next hour. */
export function splitHours(hours: number): { h: number; m: number } {
  let h = Math.floor(hours);
  let m = Math.round((hours - h) * 60);
  if (m === 60) {
    h += 1;
    m = 0;
  }
  return { h, m };
}

/** Hours to "5 h" / "5 h 30 m" / "all day", rounding 60 m up to the next hour. */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return 'all day';
  const { h, m } = splitHours(hours);
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 16-point compass abbreviation for an azimuth (0 = N, 90 = E). */
export function compass16(azDeg: number): string {
  return COMPASS_16[Math.round(posMod(azDeg, 360) / 22.5) % 16];
}

/**
 * Draw the "now" marker shared by the year and climate charts: a dashed vertical line
 * between lineTop and lineBottom plus a white dot (dark outline) at (x, y).
 */
export function drawNowMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  lineTop: number,
  lineBottom: number,
  lineAlpha = 0.4,
): void {
  ctx.strokeStyle = `rgba(255,255,255,${lineAlpha})`;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x, lineTop);
  ctx.lineTo(x, lineBottom);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(5,7,13,0.9)';
  ctx.stroke();
}

/**
 * Draw one year's worth of month gridlines and single-letter labels across a span. The
 * year heatmap calls it once for the whole width; the climate chart calls it per year
 * (passing that year's origin and width). `skipFirstGridline` lets the caller suppress the
 * January line where a heavier year separator already sits.
 */
function drawMonthTicks(
  ctx: CanvasRenderingContext2D,
  originX: number,
  yearWidth: number,
  top: number,
  height: number,
  labelY: number,
  opts: { gridColor: string; labelColor: string; skipFirstGridline?: boolean },
): void {
  ctx.textAlign = 'center';
  for (let m = 0; m < 12; m++) {
    if (!(opts.skipFirstGridline && m === 0)) {
      const x = originX + (MONTH_START_DAYS[m] / 365) * yearWidth;
      ctx.strokeStyle = opts.gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + height);
      ctx.stroke();
    }
    const xMid = originX + ((MONTH_START_DAYS[m] + MONTH_DAYS[m] / 2) / 365) * yearWidth;
    ctx.fillStyle = opts.labelColor;
    ctx.fillText(MONTH_LETTERS[m], xMid, labelY);
  }
}

/**
 * Draw the shared multi-year x-axis strip used by the year heatmap and the climate chart:
 * a per-year separator line, month gridlines/letters (only when few enough years fit), and
 * a "Year N" caption per orbit. The two charts differ only in their separator/gridline
 * colours and whether January's gridline is suppressed, so those are options; the geometry
 * (each year is 365 columns wide) is identical. `bottomY` is the axis baseline (h minus the
 * bottom padding). A null separator colour skips that year's separator line.
 */
export function drawYearStrip(
  ctx: CanvasRenderingContext2D,
  originX: number,
  plotW: number,
  top: number,
  plotH: number,
  bottomY: number,
  years: number,
  opts: {
    separatorColor: (yearIndex: number) => string | null;
    gridColor: string;
    labelColor: string;
    skipFirstGridline: boolean;
  },
): void {
  const spanDays = years * 365;
  const showMonths = years <= 2;
  const yearWidth = (365 / spanDays) * plotW;
  ctx.textBaseline = 'alphabetic';
  for (let y = 0; y < years; y++) {
    const xSep = originX + ((y * 365) / spanDays) * plotW;
    const sep = opts.separatorColor(y);
    if (sep) {
      ctx.strokeStyle = sep;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xSep, top);
      ctx.lineTo(xSep, top + plotH);
      ctx.stroke();
    }
    if (showMonths) {
      drawMonthTicks(ctx, xSep, yearWidth, top, plotH, bottomY + 12, {
        gridColor: opts.gridColor,
        labelColor: opts.labelColor,
        skipFirstGridline: opts.skipFirstGridline,
      });
    }
    if (years > 1) {
      const xYearMid = originX + ((y * 365 + 182) / spanDays) * plotW;
      ctx.fillStyle = 'rgba(160,176,205,0.7)';
      ctx.textAlign = 'center';
      ctx.fillText(`Year ${y + 1}`, xYearMid, bottomY + (showMonths ? 24 : 14));
    }
  }
}
