import { REALISTIC } from './astro/config';
import type { RotationConfig } from './astro/config';
import { FORMULA_EXAMPLES } from './formulaExamples';

interface Scenario {
  name: string;
  description: string;
  config: Partial<RotationConfig>;
}

/** Dropdown sentinel for a hand-tuned configuration. */
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

  {
    name: 'The Blender',
    description:
      'Everything dialed to chaos: a nearly sideways planet spinning backwards ' +
      'while its axis whirls five times a year. The seasons blur and the Sun tears ' +
      'across the sky the wrong way.',
    config: { obliquityDeg: 87, prograde: false, axisMode: 'precession', precessionTurnsPerYear: 5 },
  },

  // Location formulas can improve eclipse visibility, but cannot change the fixed lunar orbit.
  {
    name: 'Eclipse Chaser',
    description:
      'A world tipped a long way over, with the pole on your side of the equator leaning ' +
      'toward the Sun. That keeps the Sun high and, at anything above about fifteen ' +
      'degrees of latitude, stops it setting at all, so no eclipse is ever lost to night ' +
      'and the Sun wheels around the sky instead of rising and setting. Expect between ' +
      'fifteen percent and twice as many eclipses as an ordinary Earth, depending on ' +
      'where you stand. Move the pin and the world re-aims itself, because the lean ' +
      'formula reads your latitude. The eclipses themselves are fixed by the Moon\u2019s ' +
      'orbit; all this changes is whether you are the one standing under them.',
    config: {
      axisMode: 'formula',
      // Keep the tilt below 90 to avoid putting the Sun on the spin-axis singularity.
      tiltFormula: '75',
      leanFormula: 'if(lat, lon, lon + 180)',
    },
  },
  {
    name: 'Moonshadow',
    description:
      'The mirror of Eclipse Chaser, aimed at the far side of the sky. The tilt is set ' +
      'to your own latitude and the pole on your side leans away from the Sun, which ' +
      'parks the anti-solar point directly over your head. That is exactly where a fully ' +
      'eclipsed Moon sits, so every lunar eclipse happens almost at your zenith rather ' +
      'than down in the haze. At most latitudes the count barely moves, because a lunar ' +
      'eclipse is visible from the whole night side and an ordinary Earth already catches ' +
      'nearly all of them; near the poles, where an ordinary Earth does start missing ' +
      'them, it recovers a good half as many again. What changes everywhere is that they ' +
      'ride overhead. Move the pin and the tilt follows your latitude.',
    config: {
      axisMode: 'formula',
      tiltFormula: 'abs(lat)',
      leanFormula: 'if(lat, lon + 180, lon)',
    },
  },

  // Share one source with the formula picker so the two lists cannot drift.
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

/** Apply a scenario while preserving the observer fields used by location formulas. */
export function applyScenario(config: RotationConfig, name: string): void {
  const sc = BY_NAME.get(name);
  if (!sc) return;
  const { siteLatDeg, siteLonDeg } = config;
  Object.assign(config, REALISTIC, sc.config);
  // REALISTIC contains placeholder site values.
  config.siteLatDeg = siteLatDeg;
  config.siteLonDeg = siteLonDeg;
}

/** The description text for a scenario name (falls back to the Custom blurb). */
export function scenarioDescription(name: string): string {
  return BY_NAME.get(name)?.description ?? CUSTOM_DESCRIPTION;
}
