import { REALISTIC, accumulatedLonDeg, cloneConfig } from './astro/config';
import { compileFormula } from './astro/formula';
import { SMOOTH_POLE_STEP, declinationForDay, maxPoleStep } from './astro/orientation';

/** A generated pair of axis formulas. */
export interface FormulaPair {
  tiltFormula: string;
  leanFormula: string;
}

/**
 * Irrational multipliers. A year term scaled by a surd never returns to its starting
 * value, so the world cannot settle into a repeating cycle however long you watch.
 */
const SURDS = ['sqrt(2)', 'sqrt(3)', 'sqrt(5)', 'sqrt(7)', 'sqrt(11)', 'sqrt(13)'];

/** Below this declination span the world is too tame to be worth rolling. */
const MIN_DEC_SPAN = 35;

type Rng = () => number;

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function num(rng: Rng, lo: number, hi: number, places = 2): string {
  return (lo + rng() * (hi - lo)).toFixed(places);
}

/** A seasonal term. Integer multiples of phase close cleanly at the year wrap. */
function seasonal(rng: Rng, amp: [number, number]): string {
  const harmonic = pick(rng, [1, 1, 1, 2, 2, 3]);
  const arg = harmonic === 1 ? 'phase' : `${harmonic}*phase`;
  // A slow surd drift inside the argument keeps successive years from lining up.
  const drift = rng() < 0.7 ? ` + ${num(rng, 0.01, 0.12)}*${pick(rng, SURDS)}*year` : '';
  return `${num(rng, amp[0], amp[1], 1)}*wave(${arg}${drift})`;
}

/** A slow term that reshapes the world from one year to the next. */
function secular(rng: Rng, amp: [number, number]): string {
  return `${num(rng, amp[0], amp[1], 1)}*wave(${num(rng, 0.008, 0.05, 3)}*${pick(rng, SURDS)}*year)`;
}

function buildTilt(rng: Rng): string {
  const parts = [num(rng, 5, 65, 1)];
  parts.push(seasonal(rng, [10, 40]));
  if (rng() < 0.75) parts.push(secular(rng, [12, 45]));
  if (rng() < 0.5) parts.push(seasonal(rng, [6, 20]));
  return parts.join(' + ');
}

function buildLean(rng: Rng): string {
  const parts = [num(rng, 0, 360, 0)];
  const style = rng();
  if (style < 0.4) {
    // A precessing world: the lean winds steadily, at an irrational rate so it never repeats.
    parts.push(`${num(rng, 40, 720, 0)}*${pick(rng, SURDS)}*year`);
  } else if (style < 0.6) {
    // A whole number of turns per orbit, which multiplies the seasons instead.
    parts.push(`${pick(rng, [-1080, -720, -360, 360, 720, 1080])}*phase`);
  }
  parts.push(seasonal(rng, [20, 90]));
  if (rng() < 0.5) parts.push(seasonal(rng, [10, 40]));
  return parts.join(' + ');
}

/** Reject anything that will not compile, jumps, or is simply dull. */
function verdict(pair: FormulaPair): boolean {
  if (compileFormula(pair.tiltFormula).error || compileFormula(pair.leanFormula).error) return false;
  const config = cloneConfig(REALISTIC);
  config.axisMode = 'formula';
  config.tiltFormula = pair.tiltFormula;
  config.leanFormula = pair.leanFormula;
  const poleStep = maxPoleStep(config);
  if (!Number.isFinite(poleStep) || poleStep > SMOOTH_POLE_STEP) return false;

  let lo = Infinity;
  let hi = -Infinity;
  for (let orbit = 0; orbit < 3; orbit += 1) {
    for (let day = 1; day <= 365; day += 5) {
      const dec = declinationForDay(config, day, accumulatedLonDeg(orbit, day));
      if (!Number.isFinite(dec)) return false;
      lo = Math.min(lo, dec);
      hi = Math.max(hi, dec);
    }
  }
  return hi - lo >= MIN_DEC_SPAN;
}

/** Used only if a long run of rolls somehow all fail. Held to the same bar, and tested. */
const FALLBACK: FormulaPair = {
  tiltFormula: '45 + 30*wave(phase + 0.06*sqrt(2)*year) + 20*wave(0.02*sqrt(5)*year)',
  leanFormula: '90 + 300*sqrt(3)*year + 50*wave(phase)',
};

/**
 * Roll a fresh pair of axis formulas. The spin is deliberately left alone, so every world
 * this produces keeps an ordinary day and differs only in how its axis moves.
 */
export function randomFormulaPair(rng: Rng = Math.random): FormulaPair {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const pair = { tiltFormula: buildTilt(rng), leanFormula: buildLean(rng) };
    if (verdict(pair)) return pair;
  }
  return FALLBACK;
}
