/** Solve Kepler's equation M = E - e sin E for the eccentric anomaly, in radians. */
export function solveEccentricAnomalyRad(meanAnomRad: number, eccentricity: number): number {
  let e = meanAnomRad;
  for (let i = 0; i < 12; i += 1) {
    const step = (e - eccentricity * Math.sin(e) - meanAnomRad) / (1 - eccentricity * Math.cos(e));
    e -= step;
    if (Math.abs(step) < 1e-14) break;
  }
  return e;
}

/** True anomaly (radians) for an eccentric anomaly, wrapped to the principal branch. */
export function trueAnomalyRad(eccentricAnomRad: number, eccentricity: number): number {
  return (
    2 *
    Math.atan2(
      Math.sqrt(1 + eccentricity) * Math.sin(eccentricAnomRad / 2),
      Math.sqrt(1 - eccentricity) * Math.cos(eccentricAnomRad / 2),
    )
  );
}
