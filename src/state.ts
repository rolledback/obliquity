// Shared application state and time bookkeeping.
//
// Time uses two independent primaries the user can set freely:
//   - dayOfYear (1..~365): orbital position. The orbit is fixed: one calendar day
//     is always 24 absolute hours, regardless of the rotation settings.
//   - timeOfDay (0..24): local apparent solar time at the observer, so 12:00 is
//     local solar noon (Sun highest) by construction.
// When animating, both advance together at rates linked by the solar-day length,
// so a faster spin cycles the day/night many times per orbital day.

import { YEAR_DAYS, accumulatedLonDeg, defaultCustomConfig, sunLongitudeDeg } from './astro/config';
import type { RotationConfig } from './astro/config';
import { noonSpinDeg } from './astro/orientation';
import { apparentSolarSpinSign, solarDayHours } from './astro/daypath';
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
}

/** The bottom-area view types, in their fixed left-to-right order. */
export type BottomViewId = 'realGraph' | 'customGraph' | 'locationMap';
export const BOTTOM_VIEW_ORDER: BottomViewId[] = ['realGraph', 'customGraph', 'locationMap'];

export interface AppState {
  config: RotationConfig;
  latDeg: number;
  lonDeg: number;
  city: string;
  scenario: string;
  /** Orbital position: day of year, 1..~365. */
  dayOfYear: number;
  /**
   * How many complete orbits ("years") have elapsed since the run began. Combined with
   * dayOfYear this gives the longitude accumulated across orbits, which a precessing
   * axis needs so that each lap around the Sun genuinely differs from the last instead
   * of resetting. Only a non-whole-number precession actually makes use of it; for any
   * other configuration every orbit looks the same.
   */
  orbit: number;
  /** Local apparent solar time at the observer, 0..24 (12 = local noon). */
  timeOfDay: number;
  playing: boolean;
  /** Absolute (orbital) hours advanced per real second while playing. */
  speed: number;
  show: ShowOptions;
  followEarth: boolean;
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
    },
    followEarth: true,
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

/**
 * Advance the clock by `dtSeconds` of real time while playing.
 * `speed` is in absolute (orbital) hours per second. The orbital calendar advances
 * at one day per 24 absolute hours; the local solar time advances by one full day
 * (24 h) per solar day, which may be much faster or slower than the calendar.
 */
export function advanceTime(state: AppState, dtSeconds: number): void {
  const absHours = dtSeconds * state.speed;
  const rawDay = state.dayOfYear + absHours / 24;
  // Count whole orbits crossed so the accumulated longitude (and a precessing axis)
  // keeps advancing past each year's end instead of snapping back.
  state.orbit += Math.floor((rawDay - 1) / YEAR_DAYS);
  state.dayOfYear = wrapDayOfYear(rawDay);

  const solarDay = solarDayHours(state.config, sunLongitudeDeg(state.dayOfYear), accumulatedSunLonDeg(state));
  if (Number.isFinite(solarDay) && solarDay > 0) {
    const next = wrapHour(state.timeOfDay + (absHours / solarDay) * 24);
    // Guard against a pathological (astronomically fast) spin overflowing the step; never
    // let a non-finite value stick to the clock.
    if (Number.isFinite(next)) state.timeOfDay = next;
  }
}

/** The current state's accumulated-across-orbits Sun longitude (see `accumulatedLonDeg`). */
export function accumulatedSunLonDeg(state: AppState): number {
  return accumulatedLonDeg(state.orbit, state.dayOfYear);
}

/** Earth's spin angle (degrees) at the current instant. */
export function currentSpinDeg(state: AppState): number {
  const noon = noonSpinDeg(state.config, state.dayOfYear, state.lonDeg, accumulatedSunLonDeg(state));
  // 15 deg of hour-angle per solar hour; 12:00 puts the Sun on the meridian. The sign
  // follows the Sun's apparent motion (which way the hour angle runs with the clock).
  const sign = apparentSolarSpinSign(state.config, sunLongitudeDeg(state.dayOfYear), accumulatedSunLonDeg(state));
  return noon + sign * 15 * (state.timeOfDay - 12);
}

/**
 * Move the observation point without spinning the globe. A longitude change re-anchors local
 * solar noon (noonSpinDeg = raSun - lon), which would otherwise rotate the Earth to keep the
 * same local time; instead we shift the local-solar clock by the matching amount (15 deg of
 * longitude = 1 solar hour), so the Earth's absolute orientation is preserved and only the
 * observer moves. The new longitude genuinely has a different local time at the same instant.
 * Latitude does not affect the spin, so it needs no compensation.
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
}

/** Format an hour value as HH:MM. */
export function clockLabel(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
