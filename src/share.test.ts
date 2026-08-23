import { describe, expect, it } from 'vitest';
import { applyShare, buildShareUrl, parseShareFromUrl, slugify } from './share';
import { defaultState } from './state';
import { REALISTIC, cloneConfig } from './astro/config';
import { CUSTOM_NAME, SCENARIO_NAMES } from './scenarios';

const HREF = 'https://example.test/app/';

describe('share links', () => {
  it('slugifies scenario names to unique URL-safe tokens', () => {
    expect(slugify('Maelstrom')).toBe('maelstrom');
    expect(slugify('On its side (90\u00B0)')).toBe('on-its-side-90');
    const slugs = SCENARIO_NAMES.filter((n) => n !== CUSTOM_NAME).map(slugify);
    expect(new Set(slugs).size).toBe(slugs.length);
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
    expect(parsed.config.rotationPeriodHours).toBe(REALISTIC.rotationPeriodHours);
    expect(parsed.config.spinFormula).toBe(REALISTIC.spinFormula);
  });

  it('clamps out-of-range values from an untrusted link', () => {
    const s = defaultState();
    s.scenario = CUSTOM_NAME;
    s.config.obliquityDeg = 9999;
    s.config.rotationPeriodHours = 0;
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

describe('a shared world cannot move the recipient', () => {
  it('leaves the recipient standing where they were, through applyShare itself', () => {
    const sender = cloneConfig(REALISTIC);
    sender.obliquityDeg = 62.5;
    sender.siteLatDeg = 47.6;
    sender.siteLonDeg = -122.3;
    const url = buildShareUrl(
      { scenario: CUSTOM_NAME, config: sender } as never,
      'http://x/',
    );

    // Through the real entry point. Asserting on the decoded config alone left the actual
    // clobber unguarded: applyShare could zero both location fields and every test passed.
    const state = defaultState();
    state.latDeg = -33.9;
    state.lonDeg = 151.2;
    state.config.siteLatDeg = -33.9;
    state.config.siteLonDeg = 151.2;

    const parsed = parseShareFromUrl(url);
    expect(parsed?.kind).toBe('custom');
    applyShare(state, parsed!);

    expect(state.config.obliquityDeg).toBe(62.5);
    expect(state.latDeg).toBe(-33.9);
    expect(state.lonDeg).toBe(151.2);
    expect(state.config.siteLatDeg).toBe(-33.9);
    expect(state.config.siteLonDeg).toBe(151.2);
  });

  it('never puts the observer position in the link itself', () => {
    const c = cloneConfig(REALISTIC);
    c.obliquityDeg = 62.5;
    c.siteLatDeg = 47.6;
    c.siteLonDeg = -122.3;
    const url = buildShareUrl({ scenario: CUSTOM_NAME, config: c } as never, 'http://x/');
    const payload = new URL(url).searchParams.get('c')!;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    expect(json).not.toContain('site');
    expect(JSON.parse(json)).toEqual({ obliquityDeg: 62.5 });
  });
});
