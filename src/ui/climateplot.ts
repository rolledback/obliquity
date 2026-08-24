import { CALENDAR_DAYS } from '../astro/calendar';
import { seasonSpan } from '../astro/season';
import type { SeasonSpan } from '../astro/season';
import { calendarYear, dayOfYearLabel } from '../astro/presets';
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
  /** Top of this panel's warmth scale. */
  yMax: number;
  /** Number of years shown. */
  years: number;
}

const TEMP_STOPS: [number, RGB][] = [
  [0.0, [43, 95, 166]],
  [0.45, [74, 163, 160]],
  [0.7, [224, 178, 74]],
  [1.0, [217, 84, 43]],
];

export class ClimatePlot extends Plot {
  private years = 1;
  private startOrbit = 0;

  /** Map a pointer to its day and absolute orbit in the displayed span. */
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
    // Secular climates can outgrow the initial scale, so expand it to avoid clipping.
    const yMax = Math.max(input.yMax, span.warmthMax * 1.08, 1e-4);
    this.years = years;
    this.startOrbit = startOrbit;
    const spanDays = years * CALENDAR_DAYS;

    const xOf = (dayAbs: number) => PAD.left + (dayAbs / spanDays) * plotW;
    const yOf = (v: number) => baseY - clamp(v / yMax, 0, 1) * plotH;
    // Clamp at the open window's ends instead of wrapping into another year.
    const sample = (arr: Float64Array, dayAbs: number) => {
      const i0 = Math.min(Math.max(Math.floor(dayAbs), 0), arr.length - 1);
      const i1 = Math.min(i0 + 1, arr.length - 1);
      return arr[i0] + (arr[i1] - arr[i0]) * (dayAbs - Math.floor(dayAbs));
    };

    for (let px = 0; px <= plotW; px++) {
      const dayAbs = (px / plotW) * spanDays;
      const v = sample(warmth, dayAbs);
      const [r, g, b] = tempColor(v / yMax);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const y = yOf(v);
      ctx.fillRect(PAD.left + px, y, 1, baseY - y);
    }

    this.drawAxes(ctx, h, plotW, plotH, years, span.startOrbit);

    ctx.beginPath();
    for (let px = 0; px <= plotW; px++) {
      const y = yOf(sample(warmth, (px / plotW) * spanDays));
      px === 0 ? ctx.moveTo(PAD.left + px, y) : ctx.lineTo(PAD.left + px, y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

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
    const hasSeasons = span.warmSeasonsPerYear > 0;

    if (hasSeasons) {
      this.marker(ctx, xOf(span.warmthMaxIndex), yOf(span.warmthMax), '#ffd54a', 'warmest');
      this.marker(ctx, xOf(span.warmthMinIndex), yOf(span.warmthMin), '#9ec7ff', 'coldest');
    }

    const orbitInSpan = clamp(orbitSlot(input.orbit, years), 0, years - 1);
    const nowAbs = orbitInSpan * CALENDAR_DAYS + (input.dayOfYear - 1);
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
    startOrbit: number,
  ) {
    ctx.font = font(10);

    ctx.save();
    ctx.translate(11, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(160,176,205,0.85)';
    ctx.fillText('cooler \u2192 warmer', 0, 0);
    ctx.restore();

    drawYearStrip(ctx, PAD.left, plotW, PAD.top, plotH, h - PAD.bottom, years, {
      label: (slot) => String(calendarYear(startOrbit + slot)),
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
    const multiYear = span.years > 1;
    const dateLabel = (index: number) => {
      const day = (index % CALENDAR_DAYS) + 1;
      const yr = Math.floor(index / CALENDAR_DAYS) + 1;
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
        // Lag is a within-year offset, so measure it modulo one year.
        const lag = posMod(span.warmthMaxIndex - span.insolationMaxIndex, CALENDAR_DAYS);
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
    this.setStats(chips.join(''));
  }
}

function tempColor(t: number): RGB {
  return sampleRamp(TEMP_STOPS, t);
}

function swingWord(swing: number): string {
  if (swing < 0.06) return 'slight';
  if (swing < 0.18) return 'moderate';
  return 'strong';
}

function formatSeasons(perYear: number): string {
  const rounded = Math.round(perYear);
  return Math.abs(perYear - rounded) < 0.05 ? String(rounded) : perYear.toFixed(1);
}
