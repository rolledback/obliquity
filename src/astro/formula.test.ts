import { describe, expect, it } from 'vitest';
import { compileFormula, formulaVars, type FormulaVars } from './formula';

const VARS: FormulaVars = { phase: 0.25, lon: 90, year: 2.25, t: 2.25, orbit: 2, day: 172 };
const ev = (src: string, vars: Partial<FormulaVars> = {}) =>
  compileFormula(src).fn({ ...VARS, ...vars });
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

describe('formula compiler: numbers and operators', () => {
  it('parses numbers including decimals and scientific notation', () => {
    expect(ev('42')).toBe(42);
    expect(ev('3.5')).toBe(3.5);
    expect(close(ev('1.5e-2'), 0.015)).toBe(true);
  });

  it('respects operator precedence and parentheses', () => {
    expect(ev('2 + 3 * 4')).toBe(14);
    expect(ev('(2 + 3) * 4')).toBe(20);
    expect(ev('10 - 2 - 3')).toBe(5); // left associative
    expect(ev('12 / 2 / 3')).toBe(2);
  });

  it('treats ^ as right-associative and binds tighter than unary minus', () => {
    expect(ev('2 ^ 3 ^ 2')).toBe(512); // 2^(3^2)
    expect(ev('-2 ^ 2')).toBe(-4); // -(2^2)
    expect(ev('2 ^ -1')).toBe(0.5); // exponent may be negative
  });

  it('handles unary minus and plus', () => {
    expect(ev('-5')).toBe(-5);
    expect(ev('--5')).toBe(5);
    expect(ev('3 - -2')).toBe(5);
  });

  it('implements positive modulo via mod() and the % operator', () => {
    expect(ev('mod(-1, 360)')).toBe(359); // mod() is always positive
    expect(ev('7 % 3')).toBe(1);
  });
});

describe('formula compiler: variables and constants', () => {
  it('reads each exposed variable', () => {
    expect(ev('phase')).toBe(0.25);
    expect(ev('lon')).toBe(90);
    expect(ev('year')).toBe(2.25);
    expect(ev('t')).toBe(2.25);
    expect(ev('orbit')).toBe(2);
    expect(ev('day')).toBe(172);
  });

  it('knows PI, TAU and E', () => {
    expect(close(ev('PI'), Math.PI)).toBe(true);
    expect(close(ev('TAU'), 2 * Math.PI)).toBe(true);
    expect(close(ev('E'), Math.E)).toBe(true);
  });
});

describe('formula compiler: functions', () => {
  it('degree trig matches radian trig', () => {
    expect(close(ev('sind(90)'), 1)).toBe(true);
    expect(close(ev('cosd(180)'), -1)).toBe(true);
    expect(close(ev('sin(PI / 2)'), 1)).toBe(true);
  });

  it('shaping helpers behave correctly', () => {
    expect(ev('clamp(5, 0, 1)')).toBe(1);
    expect(ev('clamp(-5, 0, 1)')).toBe(0);
    expect(ev('lerp(10, 20, 0.5)')).toBe(15);
    expect(ev('sat(2)')).toBe(1);
    expect(close(ev('smooth(0, 1, 0.5)'), 0.5)).toBe(true);
    expect(ev('smooth(0, 1, -1)')).toBe(0);
    expect(ev('smooth(0, 1, 2)')).toBe(1);
  });

  it('wave is a smooth sine with period 1', () => {
    expect(close(ev('wave(0)'), 0)).toBe(true);
    expect(close(ev('wave(0.25)'), 1)).toBe(true);
    expect(close(ev('wave(0.5)'), 0, 1e-9)).toBe(true);
    // Continuity across the period boundary (a smooth primitive must not jump).
    expect(close(ev('wave(0.999)'), ev('wave(1.999)'), 1e-9)).toBe(true);
  });

  it('variadic min and max', () => {
    expect(ev('min(3, 1, 2)')).toBe(1);
    expect(ev('max(3, 1, 2)')).toBe(3);
  });

  it('frac and floor', () => {
    expect(close(ev('frac(2.25)'), 0.25)).toBe(true);
    expect(ev('floor(2.9)')).toBe(2);
  });
});

describe('formula compiler: errors and guards', () => {
  it('reports a parse error for malformed input but still returns a usable fn', () => {
    const f = compileFormula('2 +');
    expect(f.error).not.toBeNull();
    expect(f.fn(VARS)).toBe(0); // safe fallback
  });

  it('rejects unknown names and functions', () => {
    expect(compileFormula('foo').error).not.toBeNull();
    expect(compileFormula('bar(1)').error).not.toBeNull();
    expect(compileFormula('sin(1, 2)').error).not.toBeNull(); // wrong arity
  });

  it('treats a blank formula as 0 with no error', () => {
    const f = compileFormula('   ');
    expect(f.error).toBeNull();
    expect(f.fn(VARS)).toBe(0);
  });

  it('guards NaN and Infinity to 0 so the simulation never sees them', () => {
    expect(ev('0 / 0')).toBe(0); // NaN -> 0
    expect(ev('1 / 0')).toBe(0); // +Infinity -> 0
    expect(ev('-1 / 0')).toBe(0); // -Infinity -> 0
  });

  it('keeps domain-restricted functions finite instead of NaN or -Infinity', () => {
    expect(ev('sqrt(-1)')).toBe(0); // clamped to sqrt(0)
    const lnZero = ev('ln(0)');
    expect(Number.isFinite(lnZero)).toBe(true); // clamped away from -Infinity
    expect(lnZero).toBeLessThan(0);
    expect(Number.isFinite(ev('log10(-5)'))).toBe(true);
  });

  it('compileFormula().error reflects parseability', () => {
    expect(compileFormula('23.4 + 10 * sind(lon)').error).toBeNull();
    expect(compileFormula('23.4 +').error).not.toBeNull();
  });

  it('a realistic axis formula evaluates sensibly', () => {
    // A gently wobbling tilt stays finite and near its base across the orbit.
    for (let p = 0; p <= 1; p += 0.1) {
      const tilt = ev('23.4 + 10 * sind(360 * phase)', { phase: p });
      expect(tilt >= 13 && tilt <= 34).toBe(true);
    }
  });

  it('rejects absurdly long or deeply nested formulas without crashing', () => {
    const tooLong = compileFormula('1+'.repeat(600) + '1');
    expect(tooLong.error).not.toBeNull();
    expect(tooLong.fn(VARS)).toBe(0);

    const deep = compileFormula('('.repeat(200) + '1' + ')'.repeat(200));
    expect(deep.error).not.toBeNull();
    expect(deep.fn(VARS)).toBe(0);
  });
});

describe('formulaVars: deriving inputs from the two longitudes', () => {
  it('maps a within-orbit longitude to phase, lon, day and year', () => {
    const v = formulaVars(90, 90);
    expect(close(v.lon, 90)).toBe(true);
    expect(close(v.phase, 0.25)).toBe(true);
    expect(close(v.year, 0.25)).toBe(true);
    expect(v.orbit).toBe(0);
    expect(v.day >= 1 && v.day <= 366).toBe(true);
  });

  it('accumulates year and orbit from the axis phase while lon stays wrapped', () => {
    const v = formulaVars(45, 2 * 360 + 45); // third orbit, 45 deg along
    expect(close(v.lon, 45)).toBe(true); // wrapped to 0..360
    expect(close(v.phase, 0.125)).toBe(true);
    expect(close(v.year, 2 + 0.125)).toBe(true);
    expect(v.orbit).toBe(2);
  });

  it('keeps lon and phase non-negative for negative longitudes', () => {
    const v = formulaVars(-90, -90);
    expect(v.lon).toBeGreaterThanOrEqual(0);
    expect(close(v.lon, 270)).toBe(true);
    expect(v.phase).toBeGreaterThanOrEqual(0);
  });
});
