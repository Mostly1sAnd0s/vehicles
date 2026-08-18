/**
 * Light sensor sampling. Inverse-power falloff, summed over sources in range.
 * config: { range, minDistance, falloffPower, saturation? }
 */

export function sampleLight(position, sources, config) {
  const { range, minDistance = 0.5, falloffPower = 2, saturation } = config;
  let total = 0;
  for (const src of sources) {
    const dx = src.x - position.x;
    const dy = src.y - position.y;
    const dist = Math.hypot(dx, dy);
    if (dist > range) continue;
    const clamped = Math.max(dist, minDistance);
    total += (src.intensity ?? 1) / Math.pow(clamped, falloffPower);
  }
  if (saturation !== undefined && total > saturation) {
    total = saturation;
  }
  return total;
}
