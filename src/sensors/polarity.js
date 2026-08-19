/**
 * Sensor polarity. A normal sensor passes its raw reading through; an
 * inverted sensor is active in the *absence* of its signal — e.g. a light
 * sensor with inverted polarity outputs full when it's dark and falls as
 * light increases. Inversion is relative to the model's inversionRef
 * (the "fully saturated" value) so outputs stay bounded: max(0, ref - raw).
 */
export function applySensorPolarity(value, polarity, refMax = 1) {
  if (polarity === 'inverted') return Math.max(0, (refMax ?? 1) - value);
  return value;
}
