// Shareable links. A "Share" produces a URL that, when opened, reloads the same rotation
// scenario the sender was looking at. Two compact, human-readable forms:
//   - Built-in scenario:  ?s=<slug>      (a URL-safe form of the scenario name)
//   - Custom (hand-tuned): ?c=<payload>  (the rotation config, diffed against realistic
//                                          Earth, as base64url-encoded JSON)
// Only the rotation scenario travels in the link (not the observation location or the clock);
// the recipient keeps their own place and time, exactly like picking the scenario themselves.
//
// The decoded payload is untrusted input, so it is fully validated/clamped before use: every
// numeric field is range-checked and every formula is length-capped (the formula DSL is
// already sandboxed and can only ever yield a finite number, so a hostile string cannot do
// more than describe a wild-but-safe world).

import { AXIS_MODE_LABELS, REALISTIC, cloneConfig } from './astro/config';
import type { AxisMode, RotationConfig } from './astro/config';
import { CUSTOM_NAME, SCENARIO_NAMES, applyScenario, scenarioSetup } from './scenarios';
import type { AppState } from './state';

const PARAM_BUILTIN = 's';
const PARAM_CUSTOM = 'c';
const MAX_FORMULA_LEN = 1000; // matches the formula compiler's own cap

// The rotation fields that define a scenario (everything except the observation/time state).
const CONFIG_FIELDS: (keyof RotationConfig)[] = [
  'obliquityDeg',
  'axisLongitudeDeg',
  'rotationPeriodHours',
  'prograde',
  'axisMode',
  'precessionTurnsPerYear',
  'obliquityAmplitudeDeg',
  'rollAmplitudeDeg',
  'tiltFormula',
  'leanFormula',
  'spinFormula',
];

const AXIS_MODES = Object.keys(AXIS_MODE_LABELS) as AxisMode[];

/** A URL-safe token for a scenario name, e.g. "On its side (90°)" -> "on-its-side-90". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics (spaces, °, parens) -> hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

const BUILTIN_NAMES = SCENARIO_NAMES.filter((n) => n !== CUSTOM_NAME);

/** Resolve a slug back to its exact scenario name, or null if it matches none. */
function builtinNameFromSlug(slug: string): string | null {
  const target = slug.toLowerCase();
  return BUILTIN_NAMES.find((n) => slugify(n) === target) ?? null;
}

// ---- base64url <-> string (UTF-8 safe) -------------------------------------

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(token: string): string {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---- encode ----------------------------------------------------------------

/** Only the rotation fields that differ from realistic Earth, so simple worlds stay short. */
function diffConfig(config: RotationConfig): Partial<RotationConfig> {
  const diff: Record<string, unknown> = {};
  for (const key of CONFIG_FIELDS) {
    if (config[key] !== REALISTIC[key]) diff[key] = config[key];
  }
  return diff as Partial<RotationConfig>;
}

function isBuiltinName(name: string): boolean {
  return name !== CUSTOM_NAME && BUILTIN_NAMES.includes(name);
}

/**
 * Build the shareable URL for the current scenario. A selected built-in is shared by its
 * name slug; a hand-tuned world is shared as its encoded config diff.
 */
export function buildShareUrl(state: AppState, href: string = location.href): string {
  const url = new URL(href);
  url.hash = '';
  url.searchParams.delete(PARAM_BUILTIN);
  url.searchParams.delete(PARAM_CUSTOM);
  if (isBuiltinName(state.scenario)) {
    url.searchParams.set(PARAM_BUILTIN, slugify(state.scenario));
  } else {
    url.searchParams.set(PARAM_CUSTOM, toBase64Url(JSON.stringify(diffConfig(state.config))));
  }
  return url.toString();
}

// ---- decode ----------------------------------------------------------------

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback;
}

/** Turn an untrusted decoded object into a safe RotationConfig (realistic base + valid overrides). */
function sanitizeConfig(raw: unknown): RotationConfig {
  const c = cloneConfig(REALISTIC);
  if (typeof raw !== 'object' || raw === null) return c;
  const r = raw as Record<string, unknown>;
  c.obliquityDeg = clampNum(r.obliquityDeg, 0, 180, c.obliquityDeg);
  c.axisLongitudeDeg = clampNum(r.axisLongitudeDeg, 0, 360, c.axisLongitudeDeg);
  c.rotationPeriodHours = clampNum(r.rotationPeriodHours, 0.1, 100000, c.rotationPeriodHours);
  if (typeof r.prograde === 'boolean') c.prograde = r.prograde;
  if (typeof r.axisMode === 'string' && AXIS_MODES.includes(r.axisMode as AxisMode)) {
    c.axisMode = r.axisMode as AxisMode;
  }
  c.precessionTurnsPerYear = clampNum(r.precessionTurnsPerYear, -100, 100, c.precessionTurnsPerYear);
  c.obliquityAmplitudeDeg = clampNum(r.obliquityAmplitudeDeg, 0, 180, c.obliquityAmplitudeDeg);
  c.rollAmplitudeDeg = clampNum(r.rollAmplitudeDeg, 0, 360, c.rollAmplitudeDeg);
  if (typeof r.tiltFormula === 'string') c.tiltFormula = r.tiltFormula.slice(0, MAX_FORMULA_LEN);
  if (typeof r.leanFormula === 'string') c.leanFormula = r.leanFormula.slice(0, MAX_FORMULA_LEN);
  if (typeof r.spinFormula === 'string') c.spinFormula = r.spinFormula.slice(0, MAX_FORMULA_LEN);
  return c;
}

export type ParsedShare =
  | { kind: 'builtin'; name: string }
  | { kind: 'custom'; config: RotationConfig }
  | null;

/** Read a share directive from a URL, or null if there is none (or it is malformed). */
export function parseShareFromUrl(href: string = location.href): ParsedShare {
  let params: URLSearchParams;
  try {
    params = new URL(href).searchParams;
  } catch {
    return null;
  }
  const slug = params.get(PARAM_BUILTIN);
  if (slug) {
    const name = builtinNameFromSlug(slug);
    return name ? { kind: 'builtin', name } : null;
  }
  const payload = params.get(PARAM_CUSTOM);
  if (payload) {
    try {
      return { kind: 'custom', config: sanitizeConfig(JSON.parse(fromBase64Url(payload))) };
    } catch {
      return null; // corrupt token: fall back to the default world
    }
  }
  return null;
}

/**
 * Apply a parsed share onto the app state, mutating config in place (the plots hold a live
 * reference to state.config). Done before the controls are built, so the whole UI simply
 * initialises from the shared state. A built-in also re-applies its optional location snap,
 * matching what choosing it from the picker would do.
 */
export function applyShare(state: AppState, share: NonNullable<ParsedShare>): void {
  if (share.kind === 'builtin') {
    applyScenario(state.config, share.name);
    state.scenario = share.name;
    state.orbit = 0;
    const setup = scenarioSetup(share.name);
    if (setup.location) {
      state.latDeg = setup.location.latDeg;
      state.lonDeg = setup.location.lonDeg;
      state.city = setup.location.city;
    }
  } else {
    Object.assign(state.config, share.config);
    state.scenario = CUSTOM_NAME;
    state.orbit = 0;
  }
}
