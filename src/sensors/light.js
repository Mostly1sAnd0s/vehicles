/**
 * Light sensor sampling. Inverse-power falloff, summed over sources in range.
 * config: { range, minDistance, falloffPower, saturation? }
 */

// Smallest signed angle from b to a, in (-pi, pi].
function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
// True when a source at world-angle angTo is inside the sensor's FOV cone
// centered on aim with full aperture fov. No/undefined fov -> omnidirectional.
function inFov(angTo, opts = {}) {
  const fov = opts.fov;
  if (fov === undefined || !Number.isFinite(fov) || fov >= 2 * Math.PI - 1e-9) return true;
  return Math.abs(angleDiff(angTo, opts.aim ?? 0)) <= fov / 2 + 1e-9;
}

export function sampleLight(position, sources, config, opts = {}) {
  const { range, minDistance = 0.5, falloffPower = 2, saturation } = config;
  let total = 0;
  for (const src of sources) {
    const dx = src.x - position.x;
    const dy = src.y - position.y;
    const dist = Math.hypot(dx, dy);
    if (dist > range) continue;
    if (!inFov(Math.atan2(dy, dx), opts)) continue; // outside field of view
    const clamped = Math.max(dist, minDistance);
    total += (src.intensity ?? 1) / Math.pow(clamped, falloffPower);
  }
  if (saturation !== undefined && total > saturation) {
    total = saturation;
  }
  return total;
}

/**
 * How far this sensor can *see*: the largest radius, among sources it can
 * currently detect (within `range`), at which the light level still meets
 * `detectionThreshold`. For a source of intensity I and falloff power p that
 * is (I / T)^(1/p) (e.g. sqrt(I/T) for inverse-square). Capped at `range`.
 * Used to draw the sensor beam to its true sensitivity, so brighter sources
 * and lower thresholds produce visibly longer beams. 0 when nothing visible
 * exceeds the threshold.
 */
export function lightEffectiveRange(sources, config, center = { x: 0, y: 0 }, opts = {}) {
  const { range, detectionThreshold, falloffPower = 2 } = config;
  const T = detectionThreshold ?? 0.25;
  let best = 0;
  for (const src of sources ?? []) {
    const dx = src.x - center.x;
    const dy = src.y - center.y;
    const d = Math.hypot(dx, dy);
    if (range !== undefined && d > range) continue; // not detectable right now
    if (!inFov(Math.atan2(dy, dx), opts)) continue; // outside field of view
    const det = Math.pow((src.intensity ?? 1) / T, 1 / falloffPower);
    const capped = range !== undefined ? Math.min(det, range) : det;
    if (capped > best) best = capped;
  }
  return best;
}

/**
 * Per-source, LINEAR-IN-DISTANCE light level in [0,1]. For each source it
 * reads, compute the full-scale radius D_F=(I/F)^(1/p) and the threshold
 * radius D_T=min(range,(I/T)^(1/p)) (F=T*fullScaleRatio); the level ramps 0->1
 * linearly as the source moves from D_T to D_F, clamped. The sensor's output
 * is the MAX over sources (the one it "sees" most strongly), and we also
 * report the distance to that dominating source (for on-body readouts).
 *
 * Why linear in distance, not in level: level ~ 1/d^p, so a level-linear map
 * compresses the whole 0->1 sweep into the last few px near the source (the
 * "only moves when touching / exponential" complaint). A distance-linear map
 * gives a smooth, tunable approach and makes a dim source respond from a real
 * range. The physical inverse-square falloff still SETS the sensing window via
 * D_T/D_F (brighter sources are sensed from farther), it just no longer makes
 * the response nonlinear in position.
 */
export function lightLevelNormalized(position, sources, config, aimOpts = {}) {
  const p = config.falloffPower ?? 2;
  const T = config.detectionThreshold;
  if (!T || T <= 0) {
    // No threshold configured -> legacy behaviour: physical level clamped to
    // [0,1], distance to the nearest in-range/in-fov source.
    const raw = sampleLight(position, sources, config, aimOpts);
    let near = null;
    for (const src of sources ?? []) {
      const dx = src.x - position.x, dy = src.y - position.y;
      const d = Math.hypot(dx, dy);
      if (config.range !== undefined && d > config.range) continue;
      if (!inFov(Math.atan2(dy, dx), aimOpts)) continue;
      if (near === null || d < near) near = d;
    }
    return { level: Math.min(Math.max(raw ?? 0, 0), 1), distance: near };
  }
  const K = config.fullScaleRatio ?? 16;
  const F = T * (K > 1 ? K : 1 + 1e-6);
  let best = 0;
  let bestD = null;
  for (const src of sources ?? []) {
    const dx = src.x - position.x;
    const dy = src.y - position.y;
    const d = Math.max(Math.hypot(dx, dy), config.minDistance ?? 0.5);
    if (config.range !== undefined && d > config.range) continue;
    if (!inFov(Math.atan2(dy, dx), aimOpts)) continue;
    const I = src.intensity ?? 1;
    if (I <= T * Math.pow(config.minDistance ?? 0.5, p)) continue; // never reaches threshold
    const D_T = Math.pow(I / T, 1 / p);
    const D_F = Math.pow(I / F, 1 / p); // < D_T since F > T
    const dZero = config.range !== undefined ? Math.min(D_T, config.range) : D_T;
    if (d >= dZero) continue; // below threshold at this distance
    const denom = dZero - D_F;
    const nsrc = denom <= 1e-9 ? 1 : Math.min(1, Math.max(0, (dZero - d) / denom));
    if (nsrc > best) { best = nsrc; bestD = d; }
  }
  return { level: best, distance: best > 0 ? bestD : null };
}

/**
 * Map a raw light level onto [0,0..1] so the sensor's useful band spans its
 * effective range: 0 at/ below `detectionThreshold`, rising linearly to 1 at
 * full scale (T * `fullScaleRatio`), then clamped. This is what lets a normal
 * and an inverted light sensor share the same broad gradient (inverted =
 * 1 - n) instead of the inverted one saturating everywhere except right at the
 * source. Falls back to a plain clamp(raw,0,1) when no threshold is configured.
 */
export function normalizeLightLevel(raw, config) {
  const T = config?.detectionThreshold;
  if (!T || T <= 0) return Math.min(Math.max(raw ?? 0, 0), 1);
  const K = config?.fullScaleRatio ?? 16;
  const F = T * (K > 1 ? K : 1 + 1e-6); // full-scale level
  const span = F - T;
  return Math.min(Math.max((raw - T) / span, 0), 1);
}
