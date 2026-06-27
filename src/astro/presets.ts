// Location presets and calendar helpers.

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

/** Calendar month names, lengths (non-leap), and single-letter labels for chart axes. */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
export const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
/** Day offset at the start of each month (non-leap): [0, 31, 59, 90, ...]. */
export const MONTH_START_DAYS = MONTH_DAYS.reduce<number[]>((acc, _d, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + MONTH_DAYS[i - 1]);
  return acc;
}, []);

/** Format a day-of-year (1 = Jan 1) as a short calendar label, e.g. "Jun 21". */
export function dayOfYearLabel(dayOfYear: number): string {
  let d = Math.floor(posMod(dayOfYear - 1, 365));
  let month = 0;
  while (month < 11 && d >= MONTH_DAYS[month]) {
    d -= MONTH_DAYS[month];
    month++;
  }
  return `${MONTHS[month]} ${d + 1}`;
}

export const NOTABLE_DATES: { name: string; dayOfYear: number }[] = [
  { name: 'March equinox', dayOfYear: 79 },
  { name: 'June solstice', dayOfYear: 172 },
  { name: 'September equinox', dayOfYear: 265 },
  { name: 'December solstice', dayOfYear: 355 },
];
