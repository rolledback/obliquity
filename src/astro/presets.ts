import { CALENDAR_DAYS, absDaysFrom, dateFromAbsDays, dayOfYearFromLonFraction } from './calendar';
import { posMod } from './vec';

export interface City {
  name: string;
  latDeg: number;
  lonDeg: number;
}

export const CITIES: City[] = [
  { name: 'Equator (0, 0)', latDeg: 0, lonDeg: 0 },
  { name: 'Reykjavik', latDeg: 64.15, lonDeg: -21.94 },
  { name: 'London', latDeg: 51.51, lonDeg: -0.13 },
  { name: 'Seattle', latDeg: 47.61, lonDeg: -122.33 },
  { name: 'New York', latDeg: 40.71, lonDeg: -74.01 },
  { name: 'Tokyo', latDeg: 35.68, lonDeg: 139.69 },
  { name: 'Cairo', latDeg: 30.04, lonDeg: 31.24 },
  { name: 'Mumbai', latDeg: 19.08, lonDeg: 72.88 },
  { name: 'Singapore', latDeg: 1.35, lonDeg: 103.82 },
  { name: 'Nairobi', latDeg: -1.29, lonDeg: 36.82 },
  { name: 'Rio de Janeiro', latDeg: -22.91, lonDeg: -43.17 },
  { name: 'Sydney', latDeg: -33.87, lonDeg: 151.21 },
  { name: 'Ushuaia', latDeg: -54.8, lonDeg: -68.3 },
  { name: 'McMurdo (Antarctica)', latDeg: -77.85, lonDeg: 166.67 },
  { name: 'North Pole', latDeg: 90, lonDeg: 0 },
];

/** Non-leap calendar month names. */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
/** Non-leap calendar month lengths. */
export const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Single-letter month labels for chart axes. */
export const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
/** Day offset at the start of each month (non-leap): [0, 31, 59, 90, ...]. */
export const MONTH_START_DAYS = MONTH_DAYS.reduce<number[]>((acc, _d, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + MONTH_DAYS[i - 1]);
  return acc;
}, []);

/** Format a day-of-year (1 = Jan 1) as a short calendar label, e.g. "Jun 21". */
export function dayOfYearLabel(dayOfYear: number): string {
  let d = Math.floor(posMod(dayOfYear - 1, CALENDAR_DAYS));
  let month = 0;
  while (month < 11 && d >= MONTH_DAYS[month]) {
    d -= MONTH_DAYS[month];
    month++;
  }
  return `${MONTHS[month]} ${d + 1}`;
}

/** Equinoxes and solstices, taken where the Sun's true longitude crosses each quarter turn. */
export const NOTABLE_DATES: { name: string; dayOfYear: number }[] = [
  { name: 'March equinox', dayOfYear: dayOfYearFromLonFraction(0) },
  { name: 'June solstice', dayOfYear: dayOfYearFromLonFraction(0.25) },
  { name: 'September equinox', dayOfYear: dayOfYearFromLonFraction(0.5) },
  { name: 'December solstice', dayOfYear: dayOfYearFromLonFraction(0.75) },
];

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Real calendar date at the observer, e.g. "23 Aug 2026". Shifted by longitude so it agrees
 * with the local solar clock shown next to it, rather than reading a UTC date beside a local time.
 */
export function calendarLabel(orbit: number, dayOfYear: number, lonDeg = 0): string {
  const d = dateFromAbsDays(absDaysFrom(orbit, dayOfYear) + lonDeg / 360);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Real calendar year covering a model orbit, taken at its midpoint so it does not flap. */
export function calendarYear(orbit: number): number {
  return dateFromAbsDays(absDaysFrom(orbit, 183)).getUTCFullYear();
}
