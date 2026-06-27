// "Felt warmth across the climate cycle" curve for a fixed location.
//
// A companion to the day and year sky charts that answers a plainer question: when
// is it warm and when is it cold here, and how strong are the seasons? It plots the
// thermal-lagged warmth signal (see astro/season.ts) as a temperature band coloured
// blue (cold) to red (warm), with the raw "sunlight" curve drawn faintly on top so
// the ~month-long lag between peak Sun and peak warmth is visible.
//
// A steadily precessing axis can take several orbits to repeat, so the chart spans that
// world's whole multi-year cycle; a periodic world is a single year. The Real Earth and
// Your Earth panels each use their own cycle and warmth scale, so Real Earth stays a
// stable reference no matter which scenario you compare against.

import { seasonSpan } from '../astro/season';
import type { SeasonSpan } from '../astro/season';
import { dayOfYearLabel } from '../astro/presets';
import { clamp, posMod } from '../astro/vec';
import { drawNowMarker, drawYearStrip, font, sampleRamp, type RGB } from './draw';
import { Plot, alignedSpanStart, orbitSlot, pickDayOrbit } from './plot';
import type { TimePick } from './plot';
import type { RotationConfig } from '../astro/config';

const PAD = { left: 30, right: 14, top: 20, bottom: 30 };

export interface ClimatePlotInput {
  config: RotationConfig;
  latDeg: number;
  /** Absolute orbit the observer is on (for the "now" marker). */
  orbit: number;
  dayOfYear: number;
  /** Shared warmth scale (top of the Y axis) so both panels compare directly. */
  yMax: number;
  /** How many years the chart spans (follows the "Years shown" control). */
  years: number;
}

// Cold-to-warm temperature ramp.
const TEMP_STOPS: [number, RGB][] = [
  [0.0, [43, 95, 166]],
  [0.45, [74, 163, 160]],
  [0.7, [224, 178, 74]],
  [1.0, [217, 84, 43]],
];

export class ClimatePlot extends Plot {
  /** Years the x-axis currently spans; remembered so pickTime can invert the mapping. */
  private years = 1;
  /** The window's first absolute orbit; pickTime resolves clicks against this window. */
  private startOrbit = 0;

  /**
   * Map a pointer position to a scrub target. The X axis runs across the whole displayed
   * span (which may cover several years), so it yields both the day of year and the absolute
   * orbit the pointer landed on (within the current span window).
   */
  pickTime(px: number, py: number, clampOutside = false): TimePick | null {
    const f = this.pickFractions(px, py, PAD, clampOutside);
    if (!f) return null;
    const { dayOfYear, slot } = pickDayOrbit(f.fx, this.years);
    return { dayOfYear, orbit: this.startOrbit + slot };
  }

  render(input: ClimatePlotInput) {
    const r = this.begin(PAD);
    if (!r) return;
    const { h, plotW, plotH } = r;
    const ctx = this.ctx;
    const baseY = PAD.top + plotH;
    const years = Math.max(1, Math.round(input.years));
    const startOrbit = alignedSpanStart(input.orbit, years);
    const span = seasonSpan(input.config, input.latDeg, startOrbit, years);
    const warmth = span.warmth;
    const insol = span.insolation;
    // Never let the displayed window clip: a secular (drifting) world can grow far past the
    // single-orbit amplitude that set input.yMax, so lift the ceiling to fit the whole span.
    const yMax = Math.max(input.yMax, span.warmthMax * 1.08, 1e-4);
    this.years = years;
    this.startOrbit = startOrbit;
    const spanDays = years * 365;

    const xOf = (dayAbs: number) => PAD.left + (dayAbs / spanDays) * plotW;
    const yOf = (v: number) => baseY - clamp(v / yMax, 0, 1) * plotH;
    // Sample the window array (length = spanDays) at a fractional day; clamp at the ends
    // since the window is open (it does not wrap like a single repeating cycle).
    const sample = (arr: Float64Array, dayAbs: number) => {
      const i0 = Math.min(Math.max(Math.floor(dayAbs), 0), arr.length - 1);
      const i1 = Math.min(i0 + 1, arr.length - 1);
      return arr[i0] + (arr[i1] - arr[i0]) * (dayAbs - Math.floor(dayAbs));
    };

    // Temperature band: one coloured vertical bar per pixel column, height = warmth.
    for (let px = 0; px <= plotW; px++) {
      const dayAbs = (px / plotW) * spanDays;
      const v = sample(warmth, dayAbs);
      const [r, g, b] = tempColor(v / yMax);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const y = yOf(v);
      ctx.fillRect(PAD.left + px, y, 1, baseY - y);
    }

    this.drawAxes(ctx, h, plotW, plotH, years);

    // Warmth curve outline.
    ctx.beginPath();
    for (let px = 0; px <= plotW; px++) {
      const y = yOf(sample(warmth, (px / plotW) * spanDays));
      px === 0 ? ctx.moveTo(PAD.left + px, y) : ctx.lineTo(PAD.left + px, y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Raw "sunlight" curve (before thermal lag), drawn faintly and dashed.
    ctx.beginPath();
    for (let px = 0; px <= plotW; px++) {
      const y = yOf(sample(insol, (px / plotW) * spanDays));
      px === 0 ? ctx.moveTo(PAD.left + px, y) : ctx.lineTo(PAD.left + px, y);
    }
    ctx.strokeStyle = 'rgba(255,236,170,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    const swing = span.warmthMax - span.warmthMin;
    // warmSeasonsPerYear is already forced to 0 below the seasonal-swing threshold.
    const hasSeasons = span.warmSeasonsPerYear > 0;

    // Warmest / coldest markers (at their place in the window).
    if (hasSeasons) {
      this.marker(ctx, xOf(span.warmthMaxIndex), yOf(span.warmthMax), '#ffd54a', 'warmest');
      this.marker(ctx, xOf(span.warmthMinIndex), yOf(span.warmthMin), '#9ec7ff', 'coldest');
    }

    // "Now" marker: place the observer within the displayed span by orbit and day.
    const orbitInSpan = clamp(orbitSlot(input.orbit, years), 0, years - 1);
    const nowAbs = orbitInSpan * 365 + (input.dayOfYear - 1);
    drawNowMarker(ctx, xOf(nowAbs), yOf(sample(warmth, nowAbs)), baseY - plotH, baseY, 0.4);
    this.drawLegend(ctx);
    this.renderStats(span, swing, hasSeasons);
    this.bannerEl.hidden = true;
  }

  private drawAxes(
    ctx: CanvasRenderingContext2D,
    h: number,
    plotW: number,
    plotH: number,
    years: number,
  ) {
    ctx.font = font(10);

    // Y: warmer at the top, cooler at the bottom (no numeric scale; units are relative).
    ctx.save();
    ctx.translate(11, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(160,176,205,0.85)';
    ctx.fillText('cooler \u2192 warmer', 0, 0);
    ctx.restore();

    // X: month ticks within each year (thinned when several years show), plus a heavier
    // separator and a "Year N" caption at each orbit boundary.
    drawYearStrip(ctx, PAD.left, plotW, PAD.top, plotH, h - PAD.bottom, years, {
      separatorColor: (y) => (y === 0 ? 'rgba(220,228,245,0.1)' : 'rgba(220,228,245,0.28)'),
      gridColor: 'rgba(220,228,245,0.08)',
      labelColor: 'rgba(160,176,205,0.85)',
      skipFirstGridline: true,
    });
  }

  private marker(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    label: string,
  ) {
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(5,7,13,0.9)';
    ctx.stroke();
    ctx.font = font(9.5);
    ctx.textBaseline = 'middle';
    // Keep the label inside the plot horizontally.
    const left = x < PAD.left + 40;
    ctx.textAlign = left ? 'left' : 'right';
    ctx.fillStyle = color;
    ctx.fillText(label, x + (left ? 7 : -7), y);
  }

  private drawLegend(ctx: CanvasRenderingContext2D) {
    ctx.font = font(9.5);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const y = PAD.top + 2;
    let x = PAD.left + 6;

    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 16, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(220,228,245,0.9)';
    ctx.fillText('felt warmth', x + 20, y);
    x += 20 + ctx.measureText('felt warmth').width + 14;

    ctx.strokeStyle = 'rgba(255,236,170,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 16, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(220,228,245,0.9)';
    ctx.fillText('sunlight', x + 20, y);
  }

  private renderStats(
    span: SeasonSpan,
    swing: number,
    hasSeasons: boolean,
  ) {
    const chips: string[] = [];
    // Label warmest/coldest by their place in the displayed window: "Yr N <date>" when the
    // span covers more than one year, otherwise just the date.
    const multiYear = span.years > 1;
    const dateLabel = (index: number) => {
      const day = (index % 365) + 1;
      const yr = Math.floor(index / 365) + 1;
      return multiYear ? `Yr ${yr} ${dayOfYearLabel(day)}` : dayOfYearLabel(day);
    };
    if (!hasSeasons) {
      chips.push('<span class="chip">Barely any seasons, warmth is near constant all year</span>');
    } else {
      chips.push(`<span class="chip">Warmest: <b>${dateLabel(span.warmthMaxIndex)}</b></span>`);
      chips.push(`<span class="chip">Coldest: <b>${dateLabel(span.warmthMinIndex)}</b></span>`);
      chips.push(`<span class="chip">Seasonal swing: <b>${swingWord(swing)}</b></span>`);
      const perYear = span.warmSeasonsPerYear;
      if (Math.abs(perYear - 1) < 0.05) {
        // The lag is a within-year offset, so measure it modulo the 365-day year.
        const lag = posMod(span.warmthMaxIndex - span.insolationMaxIndex, 365);
        chips.push(`<span class="chip">Warmth lags the Sun by <b>~${lag}\u00A0days</b></span>`);
      } else {
        chips.push(`<span class="chip"><b>${formatSeasons(perYear)}</b> warm seasons per year</span>`);
      }
    }
    if (span.secular) {
      chips.push('<span class="chip">Climate <b>never repeats</b> \u00B7 no two years alike</span>');
    } else if (span.periodOrbits > 1) {
      chips.push(`<span class="chip">Climate repeats every <b>${span.periodOrbits}\u00A0years</b></span>`);
    }
    this.statsEl.innerHTML = chips.join('');
  }
}

// ---- helpers ---------------------------------------------------------------

function tempColor(t: number): RGB {
  return sampleRamp(TEMP_STOPS, t);
}

function swingWord(swing: number): string {
  if (swing < 0.06) return 'slight';
  if (swing < 0.18) return 'moderate';
  return 'strong';
}

// Warm seasons per year may be fractional when the cycle spans several years (e.g.
// 2.5 swings a year over a 2-year cycle). Show a tidy number in either case.
function formatSeasons(perYear: number): string {
  const rounded = Math.round(perYear);
  return Math.abs(perYear - rounded) < 0.05 ? String(rounded) : perYear.toFixed(1);
}
