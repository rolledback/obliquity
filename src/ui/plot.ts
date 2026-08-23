import { CALENDAR_DAYS } from '../astro/calendar';
import { beginCanvas } from './draw';
import { clamp, posMod } from '../astro/vec';

export interface Pad {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PlotRect {
  /** Full canvas size in CSS pixels. */
  w: number;
  h: number;
  /** Drawable area inside the padding. */
  plotW: number;
  plotH: number;
}

/** A time selected by scrubbing a plot. */
export interface TimePick {
  /** Day position to select. */
  dayOfYear?: number;
  /** Local solar time, 0..24. */
  timeOfDay?: number;
  /** Absolute elapsed orbit to jump to. */
  orbit?: number;
}

export abstract class Plot {
  protected ctx: CanvasRenderingContext2D;
  private statsHtml = '';

  constructor(
    protected canvas: HTMLCanvasElement,
    protected statsEl: HTMLElement,
    protected bannerEl: HTMLElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Update summary chips only when changed, since identical HTML writes still force layout. */
  protected setStats(html: string): void {
    if (html === this.statsHtml) return;
    this.statsHtml = html;
    this.statsEl.innerHTML = html;
  }

  /** Prepare the canvas, or return null before it has a layout size. */
  protected begin(pad: Pad): PlotRect | null {
    const dims = beginCanvas(this.canvas, this.ctx);
    if (!dims) return null;
    return {
      w: dims.w,
      h: dims.h,
      plotW: dims.w - pad.left - pad.right,
      plotH: dims.h - pad.top - pad.bottom,
    };
  }

  /** Map canvas coordinates to plot fractions, optionally clamping outside points. */
  protected pickFractions(
    px: number,
    py: number,
    pad: Pad,
    clampOutside: boolean,
  ): { fx: number; fy: number } | null {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    if (plotW <= 0 || plotH <= 0) return null;
    const inside =
      px >= pad.left && px <= w - pad.right && py >= pad.top && py <= h - pad.bottom;
    if (!inside && !clampOutside) return null;
    const fx = clamp((px - pad.left) / plotW, 0, 1);
    const fy = clamp((py - pad.top) / plotH, 0, 1);
    return { fx, fy };
  }
}

// Keep multi-year rendering and pointer inversion on the same aligned window.

/** Start of the aligned window containing the rounded orbit. */
export function alignedSpanStart(orbit: number, years: number): number {
  return Math.round(orbit) - posMod(Math.round(orbit), years);
}

/** Slot occupied by the rounded orbit within its aligned window. */
export function orbitSlot(orbit: number, years: number): number {
  return posMod(Math.round(orbit), years);
}

/** Invert a fractional x to an unclamped day position and year slot. */
export function pickDayOrbit(fx: number, years: number): { dayOfYear: number; slot: number } {
  const dayAbs = fx * years * CALENDAR_DAYS;
  const slot = Math.min(Math.floor(dayAbs / CALENDAR_DAYS), years - 1);
  return { dayOfYear: dayAbs - slot * CALENDAR_DAYS + 1, slot };
}
