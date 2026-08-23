import { YEAR_DAYS, accumulatedLonDeg, defaultCustomConfig, sunLongitudeDeg } from './astro/config';
import type { RotationConfig } from './astro/config';
import { apparentSolarSpinSign, solarDayHours, spinAtLocalTime } from './astro/daypath';
import { posMod } from './astro/vec';

/** Which 3D scene elements are shown (toggled in the View controls, read by the orbit scene). */
export interface ShowOptions {
  axis: boolean;
  equator: boolean;
  orbit: boolean;
  marker: boolean;
  subsolar: boolean;
  sunline: boolean;
  grid: boolean;
  stars: boolean;
  moon: boolean;
  moonOrbit: boolean;
}

/** View types available in the bottom area. */
export type BottomViewId = 'realGraph' | 'customGraph' | 'locationMap';
/** Bottom view order used by the fixed layout. */
export const BOTTOM_VIEW_ORDER: BottomViewId[] = ['realGraph', 'customGraph', 'locationMap'];

/** Mutable application state shared across controls and renderers. */
export interface AppState {
  config: RotationConfig;
  latDeg: number;
  lonDeg: number;
  city: string;
  scenario: string;
  /** Orbital position: day of year, 1..~365. */
  dayOfYear: number;
  /** Completed orbits, used to keep precession and secular formulas from resetting. */
  orbit: number;
  /** Local apparent solar time at the observer, 0..24 (12 = local noon). */
  timeOfDay: number;
  playing: boolean;
  /** Absolute (orbital) hours advanced per real second while playing. */
  speed: number;
  show: ShowOptions;
  followEarth: boolean;
  /** Use true relative sizes and distances in the orbit view. */
  trueScale: boolean;
  /** Which 3D view is active. */
  viewMode: 'orbit' | 'ground';
  /** Which 2D chart is shown: a single day, the whole year, or the climate curve. */
  plotMode: 'day' | 'year' | 'climate';
  /** Year tab: how many years to lay side by side along X (1 = a single year). */
  yearsShown: number;
  /** Which views fill the bottom area, left to right (0-3 of them, fixed type order). */
  bottomViews: BottomViewId[];
  /** Relative width weight of each bottom view; only the visible ones are laid out. */
  bottomViewWeights: Record<BottomViewId, number>;
  /** Sky view only: trace a gradually fading line behind the Sun's recent path. */
  sunTrail: boolean;
  /** Sky view only: overlay a faint altitude/azimuth grid to read the Sun's position. */
  skyGrid: boolean;
  /** Sky view only: ease the camera to keep the Sun centred in the sky. */
  followSun: boolean;
}

/** Create the initial application state. */
export function defaultState(): AppState {
  return {
    config: defaultCustomConfig(),
    latDeg: 47.61,
    lonDeg: -122.33,
    city: 'Seattle',
    scenario: 'Earth (realistic)',
    dayOfYear: 172, // June solstice
    orbit: 0,
    timeOfDay: 12, // local solar noon
    playing: false,
    speed: 3,
    show: {
      axis: true,
      equator: true,
      orbit: true,
      marker: true,
      subsolar: true,
      sunline: false,
      grid: true,
      stars: true,
      moon: true,
      moonOrbit: true,
    },
    followEarth: true,
    trueScale: false,
    viewMode: 'orbit',
    plotMode: 'year',
    yearsShown: 12,
    bottomViews: ['customGraph', 'locationMap'],
    bottomViewWeights: { realGraph: 1, customGraph: 2.4, locationMap: 1 },
    sunTrail: false,
    skyGrid: true,
    followSun: false,
  };
}

function wrapDayOfYear(day: number): number {
  return posMod(day - 1, YEAR_DAYS) + 1;
}

function wrapHour(hour: number): number {
  return posMod(hour, 24);
}

// Fixed simulated-time slices limit frame-rate drift when formulas vary solar-day length.
const MAX_STEP_HOURS = 1;
// Cap slices so extreme speeds cannot make one frame unbounded.
const MAX_STEPS = 64;

/**
 * Advance by real seconds, using `speed` as absolute orbital hours per second.
 * Local time advances 24 hours per configured solar day.
 */
export function advanceTime(state: AppState, dtSeconds: number): void {
  const absHours = dtSeconds * state.speed;
  if (!Number.isFinite(absHours) || absHours === 0) return;
  const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(Math.abs(absHours) / MAX_STEP_HOURS)));
  const slice = absHours / steps;
  for (let i = 0; i < steps; i++) advanceOnce(state, slice);
}

function advanceOnce(state: AppState, absHours: number): void {
  const rawDay = state.dayOfYear + absHours / 24;
  // Count whole orbits crossed so the accumulated longitude (and a precessing axis)
  // keeps advancing past each year's end instead of snapping back.
  state.orbit += Math.floor((rawDay - 1) / YEAR_DAYS);
  state.dayOfYear = wrapDayOfYear(rawDay);

  const solarDay = solarDayHours(state.config, sunLongitudeDeg(state.dayOfYear), accumulatedSunLonDeg(state));
  if (Number.isFinite(solarDay) && solarDay > 0) {
    const next = wrapHour(state.timeOfDay + (absHours / solarDay) * 24);
    // Do not let an extreme spin leave a non-finite clock value.
    if (Number.isFinite(next)) state.timeOfDay = next;
  }
}

/** Return the Sun longitude accumulated across completed orbits. */
export function accumulatedSunLonDeg(state: AppState): number {
  return accumulatedLonDeg(state.orbit, state.dayOfYear);
}

/** Earth's spin angle (degrees) at the current instant. */
export function currentSpinDeg(state: AppState): number {
  return spinAtLocalTime(
    state.config,
    state.dayOfYear,
    state.lonDeg,
    state.timeOfDay,
    accumulatedSunLonDeg(state),
  );
}

/**
 * Move the observer while adjusting local time to preserve the globe's orientation.
 * The site is also mirrored onto config so location formulas immediately see the move.
 */
export function setObserverLocation(state: AppState, latDeg: number, lonDeg: number): void {
  const sign = apparentSolarSpinSign(
    state.config,
    sunLongitudeDeg(state.dayOfYear),
    accumulatedSunLonDeg(state),
  );
  const dLon = lonDeg - state.lonDeg;
  state.latDeg = latDeg;
  state.lonDeg = lonDeg;
  state.timeOfDay = posMod(state.timeOfDay + dLon / (sign * 15), 24);
  syncSiteToConfig(state);
}

/** Mirror the observer onto config because orientation consumers do not receive AppState. */
export function syncSiteToConfig(state: AppState): void {
  state.config.siteLatDeg = state.latDeg;
  state.config.siteLonDeg = state.lonDeg;
}

/** Format an hour value as HH:MM. */
export function clockLabel(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
