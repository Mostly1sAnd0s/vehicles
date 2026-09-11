/**
 * Element-side heat helpers: the bounds a world's heat sources may take, and the one place
 * that decides what a temperature LOOKS like.
 *
 * Deliberately separate from `src/sensors/heat.js` (the physics of sensing) and from the
 * renderer: the inspector needs the config bounds without importing a sampler, and the world
 * canvas and the editor's component palette must agree on the colour of "hot" rather than
 * each inventing one. Pure — no DOM, no config fetching, every read optional so a bundle
 * without a `world.heat` key still renders sensibly.
 */

export const DEFAULT_MIN_TEMPERATURE = -50;
export const DEFAULT_MAX_TEMPERATURE = 1500;
export const DEFAULT_ELEMENT_TEMPERATURE = 220;
/** The world's room temperature, as the ELEMENT side calls it (sensors own the real one). */
export const DEFAULT_AMBIENT_C = 20;

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function slice(configs) {
  const c = configs?.world?.heat;
  return c && typeof c === 'object' ? c : {};
}

/** [min °C, max °C] a heat-source slider may offer. Always an ordered pair. */
export function heatElementRange(configs) {
  const c = slice(configs);
  const lo = num(c.minTemperature, DEFAULT_MIN_TEMPERATURE);
  const hi = num(c.maxTemperature, DEFAULT_MAX_TEMPERATURE);
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** The temperature a newly-dropped heat source gets. */
export function defaultElementTemperature(configs) {
  const c = slice(configs);
  const [lo, hi] = heatElementRange(configs);
  return Math.min(hi, Math.max(lo, num(c.temperature, DEFAULT_ELEMENT_TEMPERATURE)));
}

/** Ambient, for the colour ramp's "this is just room temperature" pivot. */
export function elementAmbientC(configs) {
  const sensorAmbient = configs?.sensors?.heat?.ambientTemp;
  if (typeof sensorAmbient === 'number' && Number.isFinite(sensorAmbient)) return sensorAmbient;
  return num(slice(configs).ambientTemp, DEFAULT_AMBIENT_C);
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * The colour of a heat source, as rgb() — cold sinks blue, warm amber, furious white.
 *
 * Anchored on AMBIENT rather than on 0 °C, because that is what a viewer actually judges:
 * a 20 °C radiator looks like nothing, a 60 °C one looks warm, a 1200 °C one is white-hot.
 * The same ramp therefore works for any world whose ambient the user has retuned.
 */
export function heatSourceColor(temperatureC, configs) {
  const ambient = elementAmbientC(configs);
  const t = num(temperatureC, ambient);
  if (!Number.isFinite(t) || t <= ambient) {
    // At or below ambient: a cold sink. Cool blue deepening as it gets colder.
    const k = Math.min(1, Math.max(0, (ambient - t) / Math.max(1, ambient + 40)));
    return `rgb(${Math.round(lerp(90, 60, k))},${Math.round(lerp(150, 120, k))},${Math.round(lerp(210, 230, k))})`;
  }
  // Above ambient: dark red → orange → yellow → white, on a sqrt scale so the first few
  // tens of degrees are visible without a 1000 °C source being indistinguishable from 200.
  const span = Math.max(1, num(slice(configs).maxTemperature, DEFAULT_MAX_TEMPERATURE) - ambient);
  const k = Math.min(1, Math.sqrt((t - ambient) / span));
  const r = Math.round(lerp(180, 255, Math.min(1, k * 1.6)));
  const g = Math.round(lerp(60, 245, Math.max(0, k * 1.6 - 0.55)));
  const b = Math.round(lerp(40, 220, Math.max(0, k * 1.6 - 0.95)));
  return `rgb(${r},${g},${b})`;
}
