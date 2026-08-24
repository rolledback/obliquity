import { AXIS_MODE_LABELS, REALISTIC, cloneConfig } from './astro/config';
import type { AxisMode, RotationConfig } from './astro/config';
import { MAX_SOURCE_LENGTH } from './astro/formula';
import { CUSTOM_NAME, SCENARIO_NAMES, applyScenario, scenarioRerolls } from './scenarios';
import type { AppState } from './state';

const PARAM_BUILTIN = 's';
const PARAM_CUSTOM = 'c';

type SiteField = 'siteLatDeg' | 'siteLonDeg';

// A Record makes omitting a new shareable field a compile error. Site fields are excluded
// because a shared world must not move its recipient.
const SHAREABLE_FIELDS: Record<Exclude<keyof RotationConfig, SiteField>, true> = {
  obliquityDeg: true,
  axisLongitudeDeg: true,
  rotationPeriodHours: true,
  prograde: true,
  axisMode: true,
  precessionTurnsPerYear: true,
  obliquityAmplitudeDeg: true,
  rollAmplitudeDeg: true,
  tiltFormula: true,
  leanFormula: true,
  spinFormula: true,
};

const CONFIG_FIELDS = Object.keys(SHAREABLE_FIELDS) as (keyof RotationConfig)[];

const AXIS_MODES = Object.keys(AXIS_MODE_LABELS) as AxisMode[];

/** Convert a scenario name to a URL-safe token. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const BUILTIN_NAMES = SCENARIO_NAMES.filter((n) => n !== CUSTOM_NAME);

function builtinNameFromSlug(slug: string): string | null {
  const target = slug.toLowerCase();
  return BUILTIN_NAMES.find((n) => slugify(n) === target) ?? null;
}

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

/** Build a URL containing the selected built-in or custom rotation world. */
export function buildShareUrl(state: AppState, href: string = location.href): string {
  const url = new URL(href);
  url.hash = '';
  url.searchParams.delete(PARAM_BUILTIN);
  url.searchParams.delete(PARAM_CUSTOM);
  // A scenario that rolls a new world each time cannot travel as a name: the recipient
  // would roll their own. Send what was actually on screen instead.
  if (isBuiltinName(state.scenario) && !scenarioRerolls(state.scenario)) {
    url.searchParams.set(PARAM_BUILTIN, slugify(state.scenario));
  } else {
    url.searchParams.set(PARAM_CUSTOM, toBase64Url(JSON.stringify(diffConfig(state.config))));
  }
  return url.toString();
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback;
}

/** Rotation fields a shared world may carry, excluding the recipient's location. */
export type ShareableConfig = Omit<RotationConfig, SiteField>;

/** Build a safe world from an untrusted decoded payload: realistic base, validated overrides. */
function sanitizeConfig(raw: unknown): ShareableConfig {
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
  if (typeof r.tiltFormula === 'string') c.tiltFormula = r.tiltFormula.slice(0, MAX_SOURCE_LENGTH);
  if (typeof r.leanFormula === 'string') c.leanFormula = r.leanFormula.slice(0, MAX_SOURCE_LENGTH);
  if (typeof r.spinFormula === 'string') c.spinFormula = r.spinFormula.slice(0, MAX_SOURCE_LENGTH);
  const { siteLatDeg, siteLonDeg, ...world } = c;
  void siteLatDeg;
  void siteLonDeg;
  return world;
}

/** A validated built-in or custom share directive. */
export type ParsedShare =
  | { kind: 'builtin'; name: string }
  | { kind: 'custom'; config: ShareableConfig }
  | null;

/** Read a share directive, returning null when absent or malformed. */
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
      return null;
    }
  }
  return null;
}

/** Apply a share in place because plots retain a live reference to `state.config`. */
export function applyShare(state: AppState, share: NonNullable<ParsedShare>): void {
  if (share.kind === 'builtin') {
    applyScenario(state.config, share.name);
    state.scenario = share.name;
    state.orbit = 0;
  } else {
    Object.assign(state.config, share.config);
    state.scenario = CUSTOM_NAME;
    state.orbit = 0;
  }
}
