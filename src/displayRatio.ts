// A neutral, DOM-aware leaf helper shared by the 2D canvas charts (src/ui) and the 3D
// scenes (src/scene), so neither layer has to depend on the other just to read it.

/** Device pixel ratio capped at 2: enough for crisp HiDPI without quadrupling fill cost. */
export function displayPixelRatio(): number {
  return Math.min(window.devicePixelRatio, 2);
}
