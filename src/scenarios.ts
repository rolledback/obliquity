// Named, ready-made rotation configurations ("scenarios") with human-readable
// descriptions. The orbit is always fixed; a scenario only changes the rotation.
//
// Each scenario lists only the fields that differ from the realistic Earth; the
// rest are filled in from REALISTIC when the scenario is applied.

import { REALISTIC } from './astro/config';
import type { RotationConfig } from './astro/config';
import { FORMULA_EXAMPLES } from './formulaExamples';

interface Scenario {
  name: string;
  description: string;
  config: Partial<RotationConfig>;
  /** Optional: snap the observer here when the scenario is selected. */
  location?: { latDeg: number; lonDeg: number; city: string };
}

// Shown in the dropdown to represent "the user has hand-tuned the controls".
export const CUSTOM_NAME = 'Custom (your tweaks)';
const CUSTOM_DESCRIPTION =
  'Your own hand-tuned world. Adjust the Rotation and Axis behaviour controls to ' +
  'explore any combination you like, then watch the two sky panels diverge.';

const SCENARIOS: Scenario[] = [
  {
    name: 'Earth (realistic)',
    description:
      'The world as it is: a 23.4-degree tilt fixed in space and a 24-hour day, ' +
      'giving the familiar march of four seasons as first one hemisphere then the ' +
      'other leans toward the Sun.',
    config: {},
  },
  {
    name: 'On its side (90\u00B0)',
    description:
      'The axis lies flat in the orbital plane. At the solstices a pole aims almost ' +
      'straight at the Sun, baking one hemisphere in endless day while the other ' +
      'sits in endless night; at the equinoxes the whole planet briefly shares a ' +
      'normal day. (This is roughly how Uranus spins.)',
    config: { obliquityDeg: 90 },
  },
  {
    name: 'Double seasons',
    description:
      'The lean direction wheels backward once per orbit, doubling the seasonal ' +
      'rhythm. Two full summers and two winters arrive in a single trip around the ' +
      'Sun.',
    config: { axisMode: 'precession', precessionTurnsPerYear: -1, obliquityDeg: 23.4397 },
  },
  {
    name: 'Scrambled seasons',
    description:
      'The precession runs at three and a half turns per orbit, giving two and a ' +
      'half summer-to-winter swings in a single year. That half swing does not ' +
      'divide evenly into the calendar, so the seasons fall out of step with the ' +
      'months and the year never closes on the note it began.',
    config: { axisMode: 'precession', precessionTurnsPerYear: 3.5, obliquityDeg: 35 },
  },
  {
    name: 'Pulsing tilt',
    description:
      'The tilt itself breathes from perfectly upright to fully on its side and ' +
      'back over the year. One solstice swells to a brutal, near-overhead extreme ' +
      'while the opposite season barely tilts at all, giving strongly lopsided ' +
      'seasons.',
    config: { axisMode: 'obliquityWave', obliquityDeg: 45, obliquityAmplitudeDeg: 45 },
  },
  {
    name: 'Drunken lighthouse',
    description:
      'The tilt stays strong while the lean direction lurches far back and forth ' +
      'across the year. The solstice keeps overshooting and reversing, so the ' +
      'seasons surge ahead, stall, then stagger backward.',
    config: { axisMode: 'rollWave', obliquityDeg: 60, rollAmplitudeDeg: 120 },
  },

  // --- Pure chaos ---------------------------------------------------------
  {
    name: 'The Blender',
    description:
      'Everything dialed to chaos: a nearly sideways planet spinning backwards ' +
      'while its axis whirls five times a year. The seasons blur and the Sun tears ' +
      'across the sky the wrong way.',
    config: { obliquityDeg: 87, prograde: false, axisMode: 'precession', precessionTurnsPerYear: 5 },
  },

  // --- Formula mode showcases ---------------------------------------------
  // Built from the shared example list so the dropdown and the in-panel example
  // picker never drift apart. Each one drives tilt and lean from a formula; the spin
  // speed is left at normal (the spin formula stays a hand-tuned capability, not a
  // built-in scenario).
  ...FORMULA_EXAMPLES.map(
    (ex): Scenario => ({
      name: ex.name,
      description: ex.blurb,
      config: {
        axisMode: 'formula',
        tiltFormula: ex.tiltFormula,
        leanFormula: ex.leanFormula,
      },
    }),
  ),
];

const BY_NAME = new Map(SCENARIOS.map((s) => [s.name, s]));

/** All selectable scenario names, with the Custom sentinel at the end. */
export const SCENARIO_NAMES: string[] = [
  ...SCENARIOS.map((s) => s.name),
  CUSTOM_NAME,
];

/** Apply a scenario's parameters onto a config. Custom leaves the config as-is. */
export function applyScenario(config: RotationConfig, name: string): void {
  const sc = BY_NAME.get(name);
  if (!sc) return; // CUSTOM_NAME or unknown: keep the current configuration
  Object.assign(config, REALISTIC, sc.config);
}

/** The description text for a scenario name (falls back to the Custom blurb). */
export function scenarioDescription(name: string): string {
  return BY_NAME.get(name)?.description ?? CUSTOM_DESCRIPTION;
}

/** Optional view side-effects (e.g. snapping to a location) a scenario applies when selected. */
export function scenarioSetup(name: string): {
  location?: { latDeg: number; lonDeg: number; city: string };
} {
  const sc = BY_NAME.get(name);
  return { location: sc?.location };
}
