// A tiny, safe math-expression compiler for "formula mode", where the user drives the
// rotation parameters with their own expressions of the orbital position.
//
// It is deliberately NOT JavaScript: the source is tokenised and parsed by a small
// recursive-descent parser into a tree of closures, so nothing the user types can run
// as code (no eval, no Function, no property access). Unknown names or malformed input
// produce a parse error string rather than throwing, and every compiled formula is
// guarded so it always returns a finite number (NaN or Infinity become 0). That makes
// it safe to evaluate every animation frame and every chart pixel.

import { posMod } from './vec';
import { dayOfYearFromLonFraction } from './calendar';

/** The physically-meaningful inputs a formula may reference. */
export interface FormulaVars {
  /** Fraction around the Sun this orbit, 0 at the March equinox, wrapping at 1. */
  phase: number;
  /** The Sun's ecliptic longitude this orbit in degrees, 0..360. */
  lon: number;
  /**
   * Elapsed time in years, accumulating across orbits, so a formula that uses it keeps
   * evolving lap after lap instead of repeating every year (a `phase`-only formula is
   * identical every orbit). With rational coefficients the whole thing still has a finite,
   * usually enormous, repeat period; an irrational coefficient makes it truly never repeat.
   */
  year: number;
  /** Alias of `year`: the overall progress of the simulation. */
  t: number;
  /** Whole orbits completed since the run began. */
  orbit: number;
  /** Day of the year, 1..~365. */
  day: number;
}

export interface CompiledFormula {
  source: string;
  /** Evaluates the formula; always returns a finite number (0 if the result is not). */
  fn: (vars: FormulaVars) => number;
  /** A human-readable parse error, or null when the formula compiled cleanly. */
  error: string | null;
  /** The variable names the formula actually reads (a subset of FORMULA_VARS). */
  refs: ReadonlySet<keyof FormulaVars>;
}

/** The variable names a formula may use. */
const FORMULA_VARS: readonly (keyof FormulaVars)[] = [
  'phase', 'lon', 'year', 't', 'orbit', 'day',
];

type Fn = (vars: FormulaVars) => number;

const DEG = Math.PI / 180;
const frac = (x: number) => x - Math.floor(x);

// Function library. Each entry is [arity, impl]; arity -1 means variadic (1 or more).
const FUNCTIONS: Record<string, [number, (a: number[]) => number]> = {
  // Trigonometry in radians.
  sin: [1, (a) => Math.sin(a[0])],
  cos: [1, (a) => Math.cos(a[0])],
  tan: [1, (a) => Math.tan(a[0])],
  asin: [1, (a) => Math.asin(a[0])],
  acos: [1, (a) => Math.acos(a[0])],
  atan: [1, (a) => Math.atan(a[0])],
  atan2: [2, (a) => Math.atan2(a[0], a[1])],
  // Trigonometry in degrees (handy since the parameters are in degrees).
  sind: [1, (a) => Math.sin(a[0] * DEG)],
  cosd: [1, (a) => Math.cos(a[0] * DEG)],
  tand: [1, (a) => Math.tan(a[0] * DEG)],
  // Scalar maths.
  abs: [1, (a) => Math.abs(a[0])],
  sign: [1, (a) => Math.sign(a[0])],
  sqrt: [1, (a) => Math.sqrt(Math.max(0, a[0]))],
  exp: [1, (a) => Math.exp(a[0])],
  ln: [1, (a) => Math.log(Math.max(1e-12, a[0]))],
  log: [1, (a) => Math.log(Math.max(1e-12, a[0]))],
  log10: [1, (a) => Math.log10(Math.max(1e-12, a[0]))],
  floor: [1, (a) => Math.floor(a[0])],
  ceil: [1, (a) => Math.ceil(a[0])],
  round: [1, (a) => Math.round(a[0])],
  frac: [1, (a) => frac(a[0])],
  pow: [2, (a) => Math.pow(a[0], a[1])],
  mod: [2, (a) => ((a[0] % a[1]) + a[1]) % a[1]],
  min: [-1, (a) => Math.min(...a)],
  max: [-1, (a) => Math.max(...a)],
  // Shaping helpers.
  clamp: [3, (a) => Math.min(Math.max(a[0], a[1]), a[2])],
  sat: [1, (a) => Math.min(Math.max(a[0], 0), 1)],
  lerp: [3, (a) => a[0] + (a[1] - a[0]) * a[2]],
  mix: [3, (a) => a[0] + (a[1] - a[0]) * a[2]],
  step: [2, (a) => (a[1] < a[0] ? 0 : 1)],
  smooth: [3, smoothstep3],
  smoothstep: [3, smoothstep3],
  // Periodic shaping helpers over a period of 1.
  wave: [1, (a) => Math.sin(2 * Math.PI * a[0])], // smooth sine, period 1
  cwave: [1, (a) => Math.cos(2 * Math.PI * a[0])], // smooth cosine, period 1 (starts at 1)
  tri: [1, (a) => 4 * Math.abs(frac(a[0]) - 0.5) - 1], // triangle wave, period 1
  // Choice (introduces a jump; use sparingly).
  if: [3, (a) => (a[0] > 0 ? a[1] : a[2])],
};

const CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  TAU: Math.PI * 2,
  E: Math.E,
};

function smoothstep3(a: number[]): number {
  const t = Math.min(Math.max((a[2] - a[0]) / (a[1] - a[0]), 0), 1);
  return t * t * (3 - 2 * t);
}

// ---- Tokenizer -------------------------------------------------------------

type TokenType = 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

class ParseError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < src.length && (isDigit(src[j]) || src[j] === '.')) j++;
      // Optional exponent, e.g. 1.5e-3.
      if (src[j] === 'e' || src[j] === 'E') {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && isDigit(src[j])) j++;
      }
      const text = src.slice(i, j);
      if (!Number.isFinite(Number(text))) throw new ParseError(`Bad number "${text}"`);
      tokens.push({ type: 'num', value: text, pos: i });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ('+-*/%^'.includes(c)) {
      tokens.push({ type: 'op', value: c, pos: i });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen', value: c, pos: i });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen', value: c, pos: i });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ type: 'comma', value: c, pos: i });
      i++;
      continue;
    }
    throw new ParseError(`Unexpected character "${c}"`);
  }
  return tokens;
}

// ---- Parser (recursive descent) --------------------------------------------
//
// Precedence, lowest to highest: + -  |  * / %  |  unary - +  |  ^ (right assoc).

const MAX_SOURCE_LENGTH = 1000;
const MAX_DEPTH = 64;

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new ParseError('Unexpected end of formula');
    this.pos++;
    return t;
  }

  parse(): Fn {
    const fn = this.parseAddSub();
    if (this.pos < this.tokens.length) {
      throw new ParseError(`Unexpected "${this.tokens[this.pos].value}"`);
    }
    return fn;
  }

  private parseAddSub(): Fn {
    // parseAddSub is re-entered for every parenthesised group and function argument,
    // so bounding its recursion bounds the overall nesting depth.
    if (++this.depth > MAX_DEPTH) throw new ParseError('Formula nested too deeply');
    try {
      return this.parseAddSubInner();
    } finally {
      this.depth--;
    }
  }

  private parseAddSubInner(): Fn {
    let left = this.parseMulDiv();
    for (;;) {
      const t = this.peek();
      if (t?.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.next();
        const right = this.parseMulDiv();
        const l = left;
        left = t.value === '+' ? (v) => l(v) + right(v) : (v) => l(v) - right(v);
      } else {
        return left;
      }
    }
  }

  private parseMulDiv(): Fn {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t?.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next();
        const right = this.parseUnary();
        const l = left;
        if (t.value === '*') left = (v) => l(v) * right(v);
        else if (t.value === '/') left = (v) => l(v) / right(v);
        else left = (v) => l(v) % right(v);
      } else {
        return left;
      }
    }
  }

  private parseUnary(): Fn {
    const t = this.peek();
    if (t?.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next();
      const operand = this.parseUnary();
      return t.value === '-' ? (v) => -operand(v) : operand;
    }
    return this.parsePower();
  }

  private parsePower(): Fn {
    const base = this.parseAtom();
    const t = this.peek();
    if (t?.type === 'op' && t.value === '^') {
      this.next();
      const exp = this.parseUnary(); // right-associative, allows 2^-3
      return (v) => Math.pow(base(v), exp(v));
    }
    return base;
  }

  private parseAtom(): Fn {
    const t = this.next();
    if (t.type === 'num') {
      const value = Number(t.value);
      return () => value;
    }
    if (t.type === 'lparen') {
      const inner = this.parseAddSub();
      const close = this.next();
      if (close.type !== 'rparen') throw new ParseError('Expected ")"');
      return inner;
    }
    if (t.type === 'ident') {
      // Function call?
      if (this.peek()?.type === 'lparen') {
        this.next();
        const args: Fn[] = [];
        if (this.peek()?.type !== 'rparen') {
          args.push(this.parseAddSub());
          while (this.peek()?.type === 'comma') {
            this.next();
            args.push(this.parseAddSub());
          }
        }
        const close = this.next();
        if (close.type !== 'rparen') throw new ParseError('Expected ")"');
        return this.makeCall(t.value, args);
      }
      // Constant?
      if (t.value in CONSTANTS) {
        const value = CONSTANTS[t.value];
        return () => value;
      }
      // Variable?
      if ((FORMULA_VARS as readonly string[]).includes(t.value)) {
        const name = t.value as keyof FormulaVars;
        return (v) => v[name];
      }
      throw new ParseError(`Unknown name "${t.value}"`);
    }
    throw new ParseError(`Unexpected "${t.value}"`);
  }

  private makeCall(name: string, args: Fn[]): Fn {
    const entry = FUNCTIONS[name];
    if (!entry) throw new ParseError(`Unknown function "${name}"`);
    const [arity, impl] = entry;
    if (arity === -1) {
      if (args.length < 1) throw new ParseError(`${name}() needs at least one argument`);
    } else if (args.length !== arity) {
      throw new ParseError(`${name}() takes ${arity} argument${arity === 1 ? '' : 's'}, got ${args.length}`);
    }
    return (v) => {
      const values = args.map((a) => a(v));
      const y = impl(values);
      // Localize the finite guard so one out-of-domain call (pow(-1, 0.5), mod by 0,
      // tan at a pole) collapses to 0 without killing an otherwise valid formula.
      return Number.isFinite(y) ? y : 0;
    };
  }
}

// ---- Public API ------------------------------------------------------------

const cache = new Map<string, CompiledFormula>();

/**
 * Compile a formula string into a guarded evaluator. Results are memoised by source so
 * this is cheap to call every frame. A blank formula evaluates to 0.
 */
const EMPTY_REFS: ReadonlySet<keyof FormulaVars> = new Set();

// The variable names a token stream reads, used to tell periodic formulas (phase/lon/day)
// from secular ones (year/t/orbit) that evolve across orbits.
function collectRefs(tokens: Token[]): ReadonlySet<keyof FormulaVars> {
  const refs = new Set<keyof FormulaVars>();
  for (const t of tokens) {
    if (t.type === 'ident' && (FORMULA_VARS as readonly string[]).includes(t.value)) {
      refs.add(t.value as keyof FormulaVars);
    }
  }
  return refs;
}

export function compileFormula(source: string): CompiledFormula {
  const cached = cache.get(source);
  if (cached) return cached;

  let result: CompiledFormula;
  const trimmed = source.trim();
  if (trimmed === '') {
    result = { source, fn: () => 0, error: null, refs: EMPTY_REFS };
  } else if (source.length > MAX_SOURCE_LENGTH) {
    result = { source, fn: () => 0, error: 'Formula is too long', refs: EMPTY_REFS };
  } else {
    try {
      const tokens = tokenize(source);
      const refs = collectRefs(tokens);
      const raw = new Parser(tokens).parse();
      // Guard so the simulation never sees NaN or Infinity from a wild formula.
      const fn: Fn = (v) => {
        const y = raw(v);
        return Number.isFinite(y) ? y : 0;
      };
      result = { source, fn, error: null, refs };
    } catch (e) {
      const message = e instanceof ParseError ? e.message : 'Invalid formula';
      result = { source, fn: () => 0, error: message, refs: EMPTY_REFS };
    }
  }

  if (cache.size > 256) cache.clear();
  cache.set(source, result);
  return result;
}

/** True when the formula reads a variable that evolves across orbits (year, t, or orbit). */
export function formulaIsSecular(source: string): boolean {
  const { refs } = compileFormula(source);
  return refs.has('year') || refs.has('t') || refs.has('orbit');
}

/**
 * Build the formula variables from the two longitudes the orientation pipeline already
 * carries: `sunLonDeg` is the Sun's longitude this orbit, and `axisPhaseLonDeg` is the
 * longitude accumulated across orbits. Everything else is derived by wrapping and
 * division, which is exactly why a formula evaluated during the cycle-mean RA sweep
 * (where the accumulated phase equals the within-orbit longitude) agrees with a formula
 * evaluated at a real instant: both fold through the same mod-360 periodicity.
 *
 * `phase`, `lon`, and `day` are wrapped to be non-negative for any longitude. `year`/`t`
 * follow the (signed, unwrapped) accumulated phase, so within the first orbit before the
 * March-equinox epoch they can be slightly negative; real callers pass accumulated
 * longitudes that make this a non-issue, and the smooth examples avoid relying on it.
 */
export function formulaVars(sunLonDeg: number, axisPhaseLonDeg: number): FormulaVars {
  const lon = posMod(sunLonDeg, 360);
  const year = axisPhaseLonDeg / 360;
  const day = dayOfYearFromLonFraction(lon / 360);
  return {
    phase: lon / 360,
    lon,
    year,
    t: year,
    orbit: Math.floor(year),
    day,
  };
}

