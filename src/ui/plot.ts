// Shared scaffolding for the comparison chart panels (sky path, year heatmap, climate).
// Each concrete plot owns its own PAD and render logic; the base supplies the canvas,
// drawing context, stat/banner elements, and the sized "begin" that every render repeats.

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

/** A scrub target produced by a plot's pickTime(): the time to move the simulation to. */
export interface TimePick {
  /** Day of the year, 1..365. */
  dayOfYear?: number;
  /** Local solar time, 0..24. */
  timeOfDay?: number;
  /** Absolute elapsed orbit to jump to (climate plot, which can span several years). */
  orbit?: number;
}

export abstract class Plot {
  protected ctx: CanvasRenderingContext2D;

  constructor(
    protected canvas: HTMLCanvasElement,
    protected statsEl: HTMLElement,
    protected bannerEl: HTMLElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Size and clear the canvas, returning the plot rectangle, or null when it has no
   * layout size yet (in which case the caller should bail out of render). */
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

  /**
   * Map a pointer position (canvas-local CSS pixels) to fractions across the plotting
   * area, 0..1 in each axis. Returns null when the canvas has no size, or when the point
   * is outside the plotting rectangle and `clampOutside` is false (used so a hover only
   * lights up over the chart, while an active drag keeps tracking past the edges).
   */
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

// ---- multi-year window helpers ---------------------------------------------
// The year heatmap and the climate chart both lay `years` consecutive orbits side by side,
// aligned to a block that contains the current orbit, so the "now" marker always lands in
// view. These shared helpers keep the render-time placement and the pointer-inversion in
// lock-step (any drift between them would put a click on the wrong year).

/** Start of the `years`-orbit window that contains the given orbit. */
export function alignedSpanStart(orbit: number, years: number): number {
  return Math.round(orbit) - posMod(Math.round(orbit), years);
}

/** Which slot (0..years-1) within its aligned window the orbit occupies. */
export function orbitSlot(orbit: number, years: number): number {
  return posMod(Math.round(orbit), years);
}

/** Invert a fractional x (0..1 across a `years`-wide span) to a day-of-year and a slot. */
export function pickDayOrbit(fx: number, years: number): { dayOfYear: number; slot: number } {
  const dayAbs = fx * years * 365;
  const slot = Math.min(Math.floor(dayAbs / 365), years - 1);
  return { dayOfYear: dayAbs - slot * 365 + 1, slot };
}
