// 2D "Sun through the day" chart: the Sun's height above the horizon (Y) over the
// course of one day (X = local solar time, midnight -> noon -> midnight). This is
// the layman-friendly view: "the Sun rises, climbs, peaks around noon, then sets."
//
// The compass direction the Sun rises/sets is preserved as text on the markers and
// in the summary, rather than as the X-axis (which people misread as time).

import type { DayPath, DaySample } from '../astro/daypath';
import { dayOfYearLabel } from '../astro/presets';
import { clamp, posMod, wrapSignedDeg } from '../astro/vec';
import { compass16, font, formatHours, splitHours, TIME_OF_DAY_TICKS } from './draw';
import { Plot } from './plot';
import type { TimePick } from './plot';

const ALT_MIN = -18;
const ALT_MAX = 90;
const PAD = { left: 64, right: 14, top: 20, bottom: 20 };

export interface SkyPlotInput {
  path: DayPath;
  dayOfYear: number;
  accent: string;
  /** Position of the current instant along the day, 0..1 (local solar time / 24). */
  nowFrac?: number;
}

interface Crossing {
  hour: number;
  azDeg: number;
  dir: 'up' | 'down';
}

export class SkyPlot extends Plot {
  /** Map a pointer position to a scrub target: the X axis is local solar time. */
  pickTime(px: number, py: number, clampOutside = false): TimePick | null {
    const f = this.pickFractions(px, py, PAD, clampOutside);
    if (!f) return null;
    return { timeOfDay: f.fx * 24 };
  }

  render(input: SkyPlotInput) {
    const r = this.begin(PAD);
    if (!r) return;
    const { w, h, plotW, plotH } = r;
    const ctx = this.ctx;
    const X = (hour: number) => PAD.left + (hour / 24) * plotW;
    const Y = (alt: number) =>
      PAD.top + ((ALT_MAX - clamp(alt, ALT_MIN, ALT_MAX)) / (ALT_MAX - ALT_MIN)) * plotH;

    const intervals = daylightIntervals(input.path.samples);
    this.drawDayNight(ctx, intervals, X, Y, w, plotH);
    this.drawAxes(ctx, X, Y, w, h, plotH);

    this.drawCurve(ctx, input.path, X, Y, input.accent);
    this.drawMarkers(ctx, input.path, X, Y, input.accent);
    if (input.nowFrac != null) this.drawNow(ctx, input.path, input.nowFrac, X, Y, h);

    this.updateBanner(input);
    this.renderStats(input);
  }

  // Shade night (whole plot) then paint daylight bands so "how long is the day"
  // is visible at a glance.
  private drawDayNight(
    ctx: CanvasRenderingContext2D,
    intervals: [number, number][],
    X: (hour: number) => number,
    Y: (alt: number) => number,
    w: number,
    plotH: number,
  ) {
    const left = PAD.left;
    const top = PAD.top;
    const right = w - PAD.right;
    const horizonY = Y(0);

    ctx.fillStyle = 'rgba(10,15,28,0.55)';
    ctx.fillRect(left, top, right - left, plotH);

    ctx.fillStyle = 'rgba(94,160,255,0.10)';
    for (const [h0, h1] of intervals) {
      ctx.fillRect(X(h0), top, X(h1) - X(h0), horizonY - top);
    }
    ctx.fillStyle = 'rgba(120,90,60,0.10)';
    ctx.fillRect(left, horizonY, right - left, top + plotH - horizonY);
  }

  private drawAxes(
    ctx: CanvasRenderingContext2D,
    X: (hour: number) => number,
    Y: (alt: number) => number,
    w: number,
    h: number,
    plotH: number,
  ) {
    ctx.font = font(10);
    ctx.textBaseline = 'middle';
    const right = w - PAD.right;

    const yLabels: [number, string][] = [
      [90, 'Overhead'],
      [60, '60\u00B0'],
      [30, '30\u00B0'],
      [0, 'Horizon'],
    ];
    ctx.textAlign = 'right';
    for (const [alt, label] of yLabels) {
      const y = Y(alt);
      ctx.strokeStyle = alt === 0 ? 'rgba(200,210,230,0.5)' : 'rgba(140,160,190,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillStyle = alt === 0 ? 'rgba(210,220,240,0.9)' : 'rgba(143,163,196,0.8)';
      ctx.fillText(label, PAD.left - 6, y);
    }

    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(143,163,196,0.75)';
    ctx.fillText('Sun height', 0, 0);
    ctx.restore();

    ctx.textAlign = 'center';
    for (const [hour, label] of TIME_OF_DAY_TICKS) {
      const x = X(hour);
      ctx.strokeStyle = 'rgba(140,160,190,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + plotH);
      ctx.stroke();
      ctx.fillStyle = 'rgba(143,163,196,0.8)';
      ctx.fillText(label, x, h - PAD.bottom + 10);
    }
  }

  private drawCurve(
    ctx: CanvasRenderingContext2D,
    path: DayPath,
    X: (hour: number) => number,
    Y: (alt: number) => number,
    color: string,
  ) {
    const samples = path.samples;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.strokeStyle = fade(color, 0.3);
    ctx.lineWidth = 1.5;
    this.stroke(ctx, samples, X, Y, () => true);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6;
    this.stroke(ctx, samples, X, Y, (a, b) => a.altDeg >= 0 || b.altDeg >= 0);
  }

  // Stroke altitude-vs-time. The time axis is single valued, so the line never has a
  // wrap seam to break it.
  private stroke(
    ctx: CanvasRenderingContext2D,
    samples: DaySample[],
    X: (hour: number) => number,
    Y: (alt: number) => number,
    accept: (a: DaySample, b: DaySample) => boolean,
  ) {
    ctx.beginPath();
    let pen = false;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      if (!accept(a, b)) {
        pen = false;
        continue;
      }
      if (!pen) {
        ctx.moveTo(X(a.t * 24), Y(a.altDeg));
        pen = true;
      }
      ctx.lineTo(X(b.t * 24), Y(b.altDeg));
    }
    ctx.stroke();
  }

  private drawMarkers(
    ctx: CanvasRenderingContext2D,
    path: DayPath,
    X: (hour: number) => number,
    Y: (alt: number) => number,
    color: string,
  ) {
    const crossings = findCrossings(path.samples);
    const sunrise = crossings.find((c) => c.dir === 'up');
    const sunset = crossings.find((c) => c.dir === 'down');

    if (sunrise) {
      this.marker(ctx, X(sunrise.hour), Y(0), '#7CFC9B', 'up');
      this.label(ctx, X(sunrise.hour), Y(0) - 12,
        `Sunrise ${clockShort(sunrise.hour)} \u00B7 ${compass16(sunrise.azDeg)}`, 'center');
    }
    if (sunset) {
      this.marker(ctx, X(sunset.hour), Y(0), '#ff8b6b', 'down');
      this.label(ctx, X(sunset.hour), Y(0) - 12,
        `Sunset ${clockShort(sunset.hour)} \u00B7 ${compass16(sunset.azDeg)}`, 'center');
    }

    // The Sun is highest at local solar noon by construction (12:00 is defined that way),
    // so the peak marker uses the exact culmination altitude rather than scanning samples.
    const peakAlt = path.stats.peakAltDeg;
    if (peakAlt > 0) {
      const px = X(12);
      const py = Y(peakAlt);
      this.marker(ctx, px, py, color, 'dot');
      this.label(ctx, px, py - 11, `Highest ${peakAlt.toFixed(0)}\u00B0`, 'center');
    }
  }

  private marker(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    fill: string,
    shape: 'up' | 'down' | 'dot',
  ) {
    ctx.fillStyle = fill;
    ctx.strokeStyle = 'rgba(5,7,13,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (shape === 'dot') {
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    } else if (shape === 'up') {
      ctx.moveTo(x, y - 4);
      ctx.lineTo(x + 4, y + 3);
      ctx.lineTo(x - 4, y + 3);
      ctx.closePath();
    } else {
      ctx.moveTo(x, y + 4);
      ctx.lineTo(x + 4, y - 3);
      ctx.lineTo(x - 4, y - 3);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
  }

  // A small text label with a translucent backing pill for legibility.
  private label(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    align: CanvasTextAlign,
  ) {
    ctx.font = font(9);
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    const padX = 3;
    let bx = x;
    if (align === 'center') bx = x - tw / 2 - padX;
    else if (align === 'right') bx = x - tw - padX * 2;
    const minX = PAD.left + 1;
    const maxX = this.canvas.clientWidth - PAD.right - (tw + padX * 2) - 1;
    bx = Math.max(minX, Math.min(bx, maxX));
    ctx.fillStyle = 'rgba(5,7,13,0.7)';
    ctx.fillRect(bx, y - 7, tw + padX * 2, 14);
    ctx.fillStyle = 'rgba(231,238,252,0.95)';
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + padX, y);
  }

  private drawNow(
    ctx: CanvasRenderingContext2D,
    path: DayPath,
    frac: number,
    X: (hour: number) => number,
    Y: (alt: number) => number,
    h: number,
  ) {
    const samples = path.samples;
    const idx = Math.max(0, Math.min(samples.length - 1, Math.round(frac * (samples.length - 1))));
    const s = samples[idx];
    const x = X(s.t * 24);
    const y = Y(s.altDeg);
    const above = s.altDeg >= 0;

    ctx.strokeStyle = 'rgba(255,210,90,0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, h - PAD.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = above ? 'rgba(255,210,90,0.95)' : 'rgba(120,140,170,0.9)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(5,7,13,0.9)';
    ctx.stroke();
    if (above) {
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,210,90,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    this.label(ctx, x, y + 16, 'Now', 'center');
  }

  private updateBanner(input: SkyPlotInput) {
    const s = input.path.stats;
    let msg = '';
    if (s.condition === 'polar-day') msg = '\u2600\uFE0F Midnight Sun: the Sun never sets today';
    else if (s.condition === 'polar-night') msg = '\uD83C\uDF11 Polar night: the Sun never rises today';
    else if (s.condition === 'no-cycle') msg = '\uD83D\uDD12 No day or night: the Sun stays fixed in the sky';

    if (msg) {
      this.bannerEl.textContent = msg;
      this.bannerEl.hidden = false;
    } else {
      this.bannerEl.hidden = true;
      this.bannerEl.textContent = '';
    }
  }

  private renderStats(input: SkyPlotInput) {
    const s = input.path.stats;
    const chips: string[] = [];
    chips.push(`<span class="chip"><b>${dayOfYearLabel(input.dayOfYear)}</b></span>`);

    if (s.condition === 'polar-day') {
      chips.push('<span class="chip">Daylight: <b>all day</b></span>');
      chips.push(`<span class="chip">Highest: <b>${s.peakAltDeg.toFixed(0)}\u00B0</b></span>`);
    } else if (s.condition === 'polar-night') {
      chips.push('<span class="chip">Daylight: <b>none</b> (Sun stays down)</span>');
    } else if (s.condition === 'no-cycle') {
      chips.push('<span class="chip"><b>No day/night cycle</b></span>');
      chips.push(`<span class="chip">Sun height: <b>${s.peakAltDeg.toFixed(0)}\u00B0</b></span>`);
    } else {
      const crossings = findCrossings(input.path.samples);
      const sunrise = crossings.find((c) => c.dir === 'up');
      const sunset = crossings.find((c) => c.dir === 'down');
      chips.push(`<span class="chip">Daylight: <b>${formatHours(s.daylightHours)}</b></span>`);
      chips.push(`<span class="chip">Highest: <b>${s.peakAltDeg.toFixed(0)}\u00B0</b></span>`);
      if (sunrise) chips.push(`<span class="chip">Rises: <b>${clockShort(sunrise.hour)}</b> in the <b>${compassWord(sunrise.azDeg)}</b></span>`);
      if (sunset) chips.push(`<span class="chip">Sets: <b>${clockShort(sunset.hour)}</b> in the <b>${compassWord(sunset.azDeg)}</b></span>`);
    }

    if (Number.isFinite(s.solarDayHours) && Math.abs(s.solarDayHours - 24) > 0.05) {
      chips.push(`<span class="chip">One full day lasts <b>${s.solarDayHours.toFixed(1)} h</b></span>`);
    }
    this.statsEl.innerHTML = chips.join('');
  }
}

// ---- helpers ---------------------------------------------------------------

function fade(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

// Interpolate azimuth across the 0/360 wrap.
function lerpAz(a: number, b: number, f: number): number {
  return posMod(a + wrapSignedDeg(b - a) * f, 360);
}

// Horizon crossings (sunrise = altitude going up, sunset = going down), with the
// interpolated local-solar-time hour and compass azimuth at each crossing.
function findCrossings(samples: DaySample[]): Crossing[] {
  const out: Crossing[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const up = a.altDeg <= 0 && b.altDeg > 0;
    const down = a.altDeg >= 0 && b.altDeg < 0;
    if (!up && !down) continue;
    const f = a.altDeg / (a.altDeg - b.altDeg);
    out.push({
      hour: (a.t + (b.t - a.t) * f) * 24,
      azDeg: lerpAz(a.azDeg, b.azDeg, f),
      dir: up ? 'up' : 'down',
    });
  }
  return out;
}

// Time ranges (in hours) where the Sun is above the horizon.
function daylightIntervals(samples: DaySample[]): [number, number][] {
  const intervals: [number, number][] = [];
  let start: number | null = samples.length && samples[0].altDeg > 0 ? 0 : null;
  for (const c of findCrossings(samples)) {
    if (c.dir === 'up') start = c.hour;
    else if (start != null) {
      intervals.push([start, c.hour]);
      start = null;
    }
  }
  if (start != null) intervals.push([start, 24]);
  return intervals;
}

// Plain-word 8-point direction, e.g. "north-east".
function compassWord(azDeg: number): string {
  const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return dirs[Math.round(posMod(azDeg, 360) / 45) % 8];
}

// Hour 0..24 -> "5:12am" / "1:30pm" / "Noon" / "Midnight".
function clockShort(hour: number): string {
  const { h: rawH, m } = splitHours(posMod(hour, 24));
  const h = rawH % 24; // splitHours can roll 23:59.7 up to 24:00
  if (h === 12 && m === 0) return 'Noon';
  if (h === 0 && m === 0) return 'Midnight';
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}
