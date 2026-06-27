import { describe, expect, it } from 'vitest';
import { buildShareUrl, parseShareFromUrl, slugify } from './share';
import { defaultState } from './state';
import { REALISTIC } from './astro/config';
import { CUSTOM_NAME, SCENARIO_NAMES } from './scenarios';

const HREF = 'https://example.test/app/';

describe('share links', () => {
  it('slugifies scenario names to unique URL-safe tokens', () => {
    expect(slugify('Maelstrom')).toBe('maelstrom');
    expect(slugify('On its side (90\u00B0)')).toBe('on-its-side-90');
    const slugs = SCENARIO_NAMES.filter((n) => n !== CUSTOM_NAME).map(slugify);
    expect(new Set(slugs).size).toBe(slugs.length); // no collisions
  });

  it('round-trips a built-in scenario by name slug', () => {
    const s = defaultState();
    s.scenario = 'Maelstrom';
    const url = buildShareUrl(s, HREF);
    expect(url).toContain('s=maelstrom');
    expect(url).not.toContain('c=');
    expect(parseShareFromUrl(url)).toEqual({ kind: 'builtin', name: 'Maelstrom' });
  });

  it('round-trips a hand-tuned custom world (including formulas)', () => {
    const s = defaultState();
    s.scenario = CUSTOM_NAME;
    s.config.axisMode = 'formula';
    s.config.obliquityDeg = 87;
    s.config.prograde = false;
    s.config.tiltFormula = '45 + 10*wave(phase + 0.1*year)';
    s.config.leanFormula = '90 + 360*sqrt(3)*year';

    const parsed = parseShareFromUrl(buildShareUrl(s, HREF));
    expect(parsed?.kind).toBe('custom');
    if (parsed?.kind !== 'custom') throw new Error('expected custom');
    expect(parsed.config.axisMode).toBe('formula');
    expect(parsed.config.obliquityDeg).toBe(87);
    expect(parsed.config.prograde).toBe(false);
    expect(parsed.config.tiltFormula).toBe('45 + 10*wave(phase + 0.1*year)');
    expect(parsed.config.leanFormula).toBe('90 + 360*sqrt(3)*year');
    // Untouched fields fall back to realistic Earth (diff-encoded, so they are not in the link).
    expect(parsed.config.rotationPeriodHours).toBe(REALISTIC.rotationPeriodHours);
    expect(parsed.config.spinFormula).toBe(REALISTIC.spinFormula);
  });

  it('clamps out-of-range values from an untrusted link', () => {
    const s = defaultState();
    s.scenario = CUSTOM_NAME;
    s.config.obliquityDeg = 9999; // absurd
    s.config.rotationPeriodHours = 0; // would divide by zero if trusted
    const parsed = parseShareFromUrl(buildShareUrl(s, HREF));
    if (parsed?.kind !== 'custom') throw new Error('expected custom');
    expect(parsed.config.obliquityDeg).toBe(180);
    expect(parsed.config.rotationPeriodHours).toBeGreaterThan(0);
  });

  it('ignores unknown slugs and malformed payloads', () => {
    expect(parseShareFromUrl(`${HREF}?s=does-not-exist`)).toBeNull();
    expect(parseShareFromUrl(`${HREF}?c=not%40valid%40base64`)).toBeNull();
    expect(parseShareFromUrl(HREF)).toBeNull();
  });
});
