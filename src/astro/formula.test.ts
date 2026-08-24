import { describe, expect, it } from 'vitest';
import { compileFormula, formulaVars, type FormulaVars } from './formula';

const VARS: FormulaVars = {
  phase: 0.25, sol_lon: 90, year: 2.25, t: 2.25, orbit: 2, day: 172, lat: 47.61, lon: -122.33,
};
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
    expect(ev('10 - 2 - 3')).toBe(5);
    expect(ev('12 / 2 / 3')).toBe(2);
  });

  it('treats ^ as right-associative and binds tighter than unary minus', () => {
    expect(ev('2 ^ 3 ^ 2')).toBe(512);
    expect(ev('-2 ^ 2')).toBe(-4);
    expect(ev('2 ^ -1')).toBe(0.5);
  });

  it('handles unary minus and plus', () => {
    expect(ev('-5')).toBe(-5);
    expect(ev('--5')).toBe(5);
    expect(ev('3 - -2')).toBe(5);
  });

  it('gives a positive modulo through mod(), while % is the raw remainder', () => {
    expect(ev('mod(-1, 360)')).toBe(359);
    expect(ev('7 % 3')).toBe(1);
    expect(ev('-1 % 360')).toBe(-1);
  });
});

describe('formula compiler: variables and constants', () => {
  it('reads each exposed variable, including the observer position', () => {
    expect(ev('phase')).toBe(0.25);
    expect(ev('sol_lon')).toBe(90);
    expect(ev('year')).toBe(2.25);
    expect(ev('t')).toBe(2.25);
    expect(ev('orbit')).toBe(2);
    expect(ev('day')).toBe(172);
    expect(ev('lat')).toBe(47.61);
    expect(ev('lon')).toBe(-122.33);
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
    expect(f.fn(VARS)).toBe(0);
  });

  it('rejects unknown names and functions', () => {
    expect(compileFormula('foo').error).not.toBeNull();
    expect(compileFormula('bar(1)').error).not.toBeNull();
    expect(compileFormula('sin(1, 2)').error).not.toBeNull();
  });

  it('treats a blank formula as 0 with no error', () => {
    const f = compileFormula('   ');
    expect(f.error).toBeNull();
    expect(f.fn(VARS)).toBe(0);
  });

  it('guards NaN and Infinity to 0 so the simulation never sees them', () => {
    expect(ev('0 / 0')).toBe(0);
    expect(ev('1 / 0')).toBe(0);
    expect(ev('-1 / 0')).toBe(0);
  });

  it('keeps domain-restricted functions finite instead of NaN or -Infinity', () => {
    expect(ev('sqrt(-1)')).toBe(0);
    const lnZero = ev('ln(0)');
    expect(Number.isFinite(lnZero)).toBe(true);
    expect(lnZero).toBeLessThan(0);
    expect(Number.isFinite(ev('log10(-5)'))).toBe(true);
  });

  it('compileFormula().error reflects parseability', () => {
    expect(compileFormula('23.4 + 10 * sind(lon)').error).toBeNull();
    expect(compileFormula('23.4 +').error).not.toBeNull();
  });

  it('evaluates a realistic axis formula to the right numbers', () => {
    // Exact values, not a range. Asserting only 13 <= tilt <= 34 passed even with sind
    // stubbed to return 0, because the constant term alone sits inside the range.
    const tilt = (phase: number) => ev('23.4 + 10 * sind(360 * phase)', { phase });
    expect(tilt(0)).toBeCloseTo(23.4, 9);
    expect(tilt(0.25)).toBeCloseTo(33.4, 9);
    expect(tilt(0.5)).toBeCloseTo(23.4, 9);
    expect(tilt(0.75)).toBeCloseTo(13.4, 9);
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
  it('maps a within-orbit longitude to phase, sol_lon, day and year', () => {
    const v = formulaVars(90, 90);
    expect(close(v.sol_lon, 90)).toBe(true);
    expect(close(v.phase, 0.25)).toBe(true);
    expect(close(v.year, 0.25)).toBe(true);
    expect(v.orbit).toBe(0);
    expect(v.day >= 1 && v.day <= 366).toBe(true);
  });

  it('accumulates year and orbit from the axis phase while sol_lon stays wrapped', () => {
    const v = formulaVars(45, 2 * 360 + 45);
    expect(close(v.sol_lon, 45)).toBe(true);
    expect(close(v.phase, 0.125)).toBe(true);
    expect(close(v.year, 2 + 0.125)).toBe(true);
    expect(v.orbit).toBe(2);
  });

  it('keeps sol_lon and phase non-negative for negative longitudes', () => {
    const v = formulaVars(-90, -90);
    expect(v.sol_lon).toBeGreaterThanOrEqual(0);
    expect(close(v.sol_lon, 270)).toBe(true);
    expect(v.phase).toBeGreaterThanOrEqual(0);
  });
});

describe('formula compiler: the allowlist is not the prototype chain', () => {
  it('rejects inherited Object names the same as any other unknown name', () => {
    // `in` walks the prototype chain, so these once compiled with error null and then
    // evaluated to 0: the field went green and the formula quietly did nothing.
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(compileFormula(name).error).toMatch(/Unknown name/);
      expect(compileFormula(`${name}(1)`).error).toMatch(/Unknown function/);
    }
  });

  it('still accepts the real constants and functions', () => {
    expect(compileFormula('PI').error).toBeNull();
    expect(compileFormula('sin(1)').error).toBeNull();
  });
});

it('answers 0 outside a domain instead of inventing an extreme', () => {
  const at = (src: string) => compileFormula(src).fn!({ phase: 0, sol_lon: 0, year: 0, t: 0, orbit: 0, day: 1, lat: 0, lon: 0 });
  expect(at('asin(2)')).toBe(0);
  expect(at('acos(-2)')).toBe(0);
  expect(at('ln(-4)')).toBe(0);
  // Roundoff-sized overshoot is still absorbed, which is what the clamp is for.
  expect(at('asin(1 + 1e-12)')).toBeCloseTo(Math.PI / 2, 9);
  expect(at('acos(-1 - 1e-12)')).toBeCloseTo(Math.PI, 9);
});
