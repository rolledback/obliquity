// Year-long "Sun height across the whole year" heatmap for a fixed location.
//
// X = day of the year (Jan -> Dec), Y = time of day (midnight -> noon -> midnight),
// colour = the Sun's height in the sky. The bright daytime region shows how the
// length of the day and the Sun's noon height change with the seasons; dark bands
// that swallow midday (or never get dark) reveal polar night and midnight Sun.
//
// Altitude is the closed form alt = asin(sin lat sin dec + cos lat cos dec cos H),
// where the declination comes from the rotation config for each day and H is the
// hour angle (15 deg per hour from local solar noon). This is exact and cheap, so
// the whole 365-day image rebuilds in a few milliseconds (and is cached besides).

import { declinationForDay, classifyDaylight, culminationAltitudesDeg, sunriseHourAngleRad } from '../astro/orientation';
import { solarDayHours } from '../astro/daypath';
import { accumulatedLonDeg, axisConfigKey, sunLongitudeDeg } from '../astro/config';
import type { RotationConfig } from '../astro/config';
import { DEG, RAD, clamp, posMod } from '../astro/vec';
import { drawNowMarker, drawYearStrip, font, formatHours, lerp3, sampleRamp, TIME_OF_DAY_TICKS, type RGB } from './draw';
import { Plot, alignedSpanStart, orbitSlot, pickDayOrbit } from './plot';
import type { TimePick } from './plot';

const COLS = 365; // one column per day
const ROWS = 192; // time-of-day resolution
const PAD = { left: 52, right: 12, top: 18, bottom: 30 };

export interface YearPlotInput {
  config: RotationConfig;
  latDeg: number;
  dayOfYear: number;
  timeOfDay: number;
  /** Which elapsed orbit to draw; a precessing axis makes each orbit's year differ. */
  orbit: number;
  /** How many years to lay side by side along X (1 = a single year, as before). */
  years: number;
}

interface YearStats {
  maxNoonAlt: number;
  minNoonAlt: number;
  maxDaylight: number;
  minDaylight: number;
  polarDayDays: number;
  polarNightDays: number;
  /** Whether any day this year completes a sunrise-to-sunrise cycle (a finite solar day). */
  hasFiniteDay: boolean;
}

export class YearPlot extends Plot {
  private heat = document.createElement('canvas');
  private cacheKey = '';
  private stats: YearStats | null = null;
  /** Years the x-axis currently spans; remembered so pickTime can invert the mapping. */
  private years = 1;
  /** The absolute orbit last rendered; pickTime resolves clicks against this window. */
  private orbit = 0;

  /**
   * Map a pointer position to a scrub target. X runs across the whole displayed span
   * (which may cover several years), so it yields the day of year and the absolute orbit
   * the pointer landed on; Y is the time of day.
   */
  pickTime(px: number, py: number, clampOutside = false): TimePick | null {
    const f = this.pickFractions(px, py, PAD, clampOutside);
    if (!f) return null;
    const { dayOfYear, slot } = pickDayOrbit(f.fx, this.years);
    return { dayOfYear, timeOfDay: f.fy * 24, orbit: alignedSpanStart(this.orbit, this.years) + slot };
  }

  render(input: YearPlotInput) {
    const r = this.begin(PAD);
    if (!r) return;
    const { w, h, plotW, plotH } = r;
    const ctx = this.ctx;

    const years = Math.max(1, Math.round(input.years));
    this.years = years;
    this.orbit = input.orbit;
    // The window is a block of `years` orbits aligned to the current one, so the "now"
    // marker always falls inside it (mirrors the climate chart).
    const spanStart = alignedSpanStart(input.orbit, years);

    // Rebuild the cached heatmap when the world, location, span length, or the exact
    // window of orbits shown changes. The heatmap is pure declination (axis only), so it
    // keys on axisConfigKey - spinning the rotation sliders never busts it. A periodic
    // world tiles identically; keying on the window keeps a secular world correct.
    const key = `${axisConfigKey(input.config)}|${input.latDeg}|${years}|${spanStart}`;
    if (key !== this.cacheKey) {
      this.buildHeat(input, years, spanStart);
      this.cacheKey = key;
    }

    // Blit the cached heatmap, scaled to the plot area.
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.heat, PAD.left, PAD.top, plotW, plotH);

    this.drawAxes(ctx, w, h, plotW, plotH, years);
    this.drawNow(ctx, input, plotW, plotH, years);
    // Stats summarise the single year the "now" marker sits in (round(orbit)), so the chips
    // always match the highlighted year even when several drifting years are on screen.
    this.computeStats(input, Math.round(input.orbit));
    this.renderStats();

    this.bannerEl.hidden = true;
  }

  private buildHeat(input: YearPlotInput, years: number, spanStart: number) {
    const lat = input.latDeg * DEG;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const cols = COLS * years;

    // Declination per day-column. Each successive year reads the axis at its own elapsed
    // orbit, so a secular (drifting) world shows a different pattern in every year while a
    // periodic one simply repeats.
    const dec = new Float64Array(cols);
    for (let c = 0; c < cols; c++) {
      const day = (c % COLS) + 1;
      const absOrbit = spanStart + Math.floor(c / COLS);
      dec[c] = declinationForDay(input.config, day, accumulatedLonDeg(absOrbit, day)) * DEG;
    }

    this.heat.width = cols;
    this.heat.height = ROWS;
    const hctx = this.heat.getContext('2d')!;
    const img = hctx.createImageData(cols, ROWS);
    const data = img.data;

    // Precompute cos(H) per row (time of day).
    const cosH = new Float64Array(ROWS);
    for (let r = 0; r < ROWS; r++) {
      const hour = (r / (ROWS - 1)) * 24;
      cosH[r] = Math.cos((hour - 12) * 15 * DEG);
    }

    for (let c = 0; c < cols; c++) {
      const a = sinLat * Math.sin(dec[c]);
      const b = cosLat * Math.cos(dec[c]);
      for (let r = 0; r < ROWS; r++) {
        const alt = Math.asin(clamp(a + b * cosH[r], -1, 1)) * RAD;
        const [cr, cg, cb] = altColor(alt);
        const idx = (r * cols + c) * 4;
        data[idx] = cr;
        data[idx + 1] = cg;
        data[idx + 2] = cb;
        data[idx + 3] = 255;
      }
    }

    hctx.putImageData(img, 0, 0);
  }

  // Summary chips for a single year (the one the "now" marker is on). Kept separate from the
  // heatmap so a drifting multi-year view always describes the year you are actually viewing.
  private computeStats(input: YearPlotInput, statOrbit: number) {
    const lat = input.latDeg * DEG;

    let maxNoon = -Infinity;
    let minNoon = Infinity;
    let maxDay = -Infinity;
    let minDay = Infinity;
    let anyFiniteSolarDay = false;
    let polarDay = 0;
    let polarNight = 0;

    for (let day = 1; day <= COLS; day++) {
      const decRad = declinationForDay(input.config, day, accumulatedLonDeg(statOrbit, day)) * DEG;
      const noonAlt = culminationAltitudesDeg(lat, decRad).upperDeg;
      maxNoon = Math.max(maxNoon, noonAlt);
      minNoon = Math.min(minNoon, noonAlt);

      const H0 = sunriseHourAngleRad(lat, decRad);
      const { fraction: df, polar } = classifyDaylight(H0);
      if (polar === 'day') polarDay++;
      else if (polar === 'night') polarNight++;
      // The solar day length can vary day to day when a spin formula is in play, so the
      // longest/shortest-day stats sample it per day at that day's orbital position. Only
      // days with a finite solar day count: a frozen (tidally locked) day has no
      // sunrise-to-sunrise length, so it must not register as a 0-hour day.
      const solarDay = solarDayHours(
        input.config,
        sunLongitudeDeg(day),
        accumulatedLonDeg(statOrbit, day),
      );
      if (Number.isFinite(solarDay)) {
        anyFiniteSolarDay = true;
        const dayHours = df * solarDay; // 0 on a polar-night day, up to the full solar day
        maxDay = Math.max(maxDay, dayHours);
        minDay = Math.min(minDay, dayHours);
      }
    }

    this.stats = {
      maxNoonAlt: maxNoon,
      minNoonAlt: minNoon,
      maxDaylight: Number.isFinite(maxDay) ? maxDay : 24,
      minDaylight: Number.isFinite(minDay) ? minDay : 0,
      polarDayDays: polarDay,
      polarNightDays: polarNight,
      hasFiniteDay: anyFiniteSolarDay,
    };
  }

  private drawAxes(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    plotW: number,
    plotH: number,
    years: number,
  ) {
    ctx.font = font(10);
    ctx.textBaseline = 'middle';

    // Time-of-day gridlines + labels (Y).
    ctx.textAlign = 'right';
    ctx.strokeStyle = 'rgba(220,228,245,0.16)';
    ctx.fillStyle = 'rgba(160,176,205,0.85)';
    for (const [hour, label] of TIME_OF_DAY_TICKS) {
      const y = PAD.top + (hour / 24) * plotH;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(w - PAD.right, y);
      ctx.stroke();
      ctx.fillText(label, PAD.left - 6, y);
    }

    // Month letters within each year (X), with a separator and a "Year N" caption per
    // orbit. With several years on screen the month letters would collide, so they only
    // show for one or two years (handled inside drawYearStrip).
    drawYearStrip(ctx, PAD.left, plotW, PAD.top, plotH, h - PAD.bottom, years, {
      separatorColor: (y) => (y > 0 ? 'rgba(220,228,245,0.3)' : null),
      gridColor: 'rgba(220,228,245,0.12)',
      labelColor: 'rgba(160,176,205,0.85)',
      skipFirstGridline: years > 1,
    });
  }

  private drawNow(
    ctx: CanvasRenderingContext2D,
    input: YearPlotInput,
    plotW: number,
    plotH: number,
    years: number,
  ) {
    // Place the marker within the displayed span by the orbit's slot and the day of year.
    // Clamp the day fraction (dayOfYear can edge just past 365 before the orbit rolls over).
    const dayFrac = Math.min(Math.max((input.dayOfYear - 1) / COLS, 0), 1);
    const slot = orbitSlot(input.orbit, years);
    const x = PAD.left + ((slot + dayFrac) / years) * plotW;
    const y = PAD.top + (posMod(input.timeOfDay, 24) / 24) * plotH;
    drawNowMarker(ctx, x, y, PAD.top, PAD.top + plotH, 0.35);
  }

  private renderStats() {
    const s = this.stats;
    if (!s) return;
    const chips: string[] = [];
    chips.push(`<span class="chip">Highest noon Sun: <b>${s.maxNoonAlt.toFixed(0)}\u00B0</b></span>`);
    chips.push(`<span class="chip">Lowest noon Sun: <b>${s.minNoonAlt.toFixed(0)}\u00B0</b></span>`);
    if (s.hasFiniteDay) {
      chips.push(`<span class="chip">Longest day: <b>${formatHours(s.maxDaylight)}</b></span>`);
      chips.push(`<span class="chip">Shortest day: <b>${formatHours(s.minDaylight)}</b></span>`);
    }
    if (s.polarDayDays > 0) chips.push(`<span class="chip"><b>${s.polarDayDays}</b> days of midnight Sun</span>`);
    if (s.polarNightDays > 0) chips.push(`<span class="chip"><b>${s.polarNightDays}</b> days of polar night</span>`);
    this.statsEl.innerHTML = chips.join('');
  }
}

// ---- helpers ---------------------------------------------------------------

// Sun-height colour ramp: dark night below the horizon, brightening blue -> gold ->
// white as the Sun climbs above it.
const DAY_STOPS: [number, RGB][] = [
  [0, [31, 79, 143]],
  [0.33, [111, 168, 220]],
  [0.66, [255, 209, 102]],
  [1, [255, 247, 230]],
];
const NIGHT_LO: RGB = [5, 7, 14];
const NIGHT_HI: RGB = [22, 30, 58];

function altColor(altDeg: number): RGB {
  if (altDeg < 0) {
    const t = clamp((altDeg + 18) / 18, 0, 1); // -18 or below = darkest
    return lerp3(NIGHT_LO, NIGHT_HI, t);
  }
  return sampleRamp(DAY_STOPS, altDeg / 90);
}
