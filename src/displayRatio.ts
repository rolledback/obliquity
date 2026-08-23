/** Device pixel ratio capped at 2: enough for crisp HiDPI without quadrupling fill cost. */
export function displayPixelRatio(): number {
  return Math.min(window.devicePixelRatio, 2);
}
