// Showcase formula sets for "formula mode". Each one drives the axial tilt and the
// axis lean direction (both in degrees) from the orbital position, chosen to look wild
// yet stay perfectly smooth. They never touch the spin, so the day length stays normal.
//
// Variables a formula may use: phase (0..1 around the Sun this orbit), lon (0..360
// degrees), year / t (years elapsed, accumulating across orbits), orbit (whole orbits
// done), day (1..365). Handy smooth helpers: wave(x) = sin(2*pi*x), cwave(x) =
// cos(2*pi*x), sind/cosd take degrees, sat clamps to 0..1, smooth/lerp blend.

export interface FormulaExample {
  name: string;
  blurb: string;
  tiltFormula: string;
  leanFormula: string;
}

export const FORMULA_EXAMPLES: FormulaExample[] = [
  {
    name: 'Analemma Dance',
    blurb:
      'The tilt waves once a year and the lean twice, weaving the noon Sun into a ' +
      'looping figure-eight across the sky.',
    tiltFormula: '30 + 18*wave(phase)',
    leanFormula: '90 + 80*wave(2*phase)',
  },
  {
    name: 'Wandering Pole',
    blurb:
      'The lean direction sweeps three full turns a year while the tilt softly ' +
      'breathes, tracing the pole through a rosette and scattering the seasons.',
    tiltFormula: '40 + 12*wave(phase)',
    leanFormula: '90 + 1080*phase',
  },
  {
    name: 'Slow Awakening',
    blurb:
      'A nearly upright world whose tilt creeps upward over six orbits, then holds. ' +
      'Watch the year heatmap deepen from flat calm into full-blown seasons.',
    tiltFormula: '8 + 28*sat(year/6)',
    leanFormula: '90',
  },
  {
    name: 'Tumbling World',
    blurb:
      'A steep axis that rolls its tilt and lean together through the year, throwing ' +
      'the Sun into wide, woozy arcs that still glide smoothly from day to day.',
    tiltFormula: '65 + 30*wave(phase)',
    leanFormula: '90 + 70*wave(phase)',
  },
  {
    name: 'Maelstrom',
    blurb:
      'Many out-of-step rhythms drive the tilt and the lean at once, tuned to incommensurable ' +
      '(irrational) rates so the axis never retraces its path and truly no two years ever play ' +
      'out the same, not even over thousands of years. A hard year-to-year swing in the tilt ' +
      'spares no latitude: even the tropics lurch between scorching overhead Suns and feeble ' +
      'low ones, while the poles flip between endless day and weeks-long night. It looks ' +
      'chaotic yet still glides smoothly from day to day.',
    tiltFormula: '50 + 24*wave(phase + 0.092*sqrt(2)*year) + 18*wave(2*phase + 0.041*sqrt(3)*year) + 40*wave(0.017*sqrt(5)*year)',
    leanFormula: '90 + 360*sqrt(3)*year + 55*wave(phase + 0.027*sqrt(7)*year) + 22*wave(2*phase + 0.013*sqrt(11)*year)',
  },
  {
    name: 'Fractal Coastline',
    blurb:
      'Several rhythms stack up, each octave twice as fast and a little over half as ' +
      'strong as the last, building fractal-inspired structure across a handful of ' +
      'scales. The pole traces a crinkled, coastline-like path and the year heatmap ' +
      'sprouts fine detail within its broad seasons, while two slow, out-of-step drifts ' +
      'keep nearby years from matching so the pattern never settles into a short repeat. ' +
      'It looks intricate yet still glides smoothly from one day to the next.',
    tiltFormula:
      '40 + 18*(wave(phase) + 0.55*wave(2*phase) + 0.3*wave(4*phase) + 0.17*wave(8*phase) + 0.09*wave(16*phase)) + 6*wave(0.0167*year)',
    leanFormula:
      '90 + 52*(cwave(phase) + 0.55*cwave(2*phase) + 0.3*cwave(4*phase) + 0.17*cwave(8*phase) + 0.09*cwave(16*phase)) + 12*wave(0.0411*year)',
  },
];
