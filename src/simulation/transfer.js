/**
 * Neuron transfer functions — Braitenberg's Vehicle 4 brand.
 *
 * A Neuron sits between a sensor and a motor and replaces the default monotonic
 * law ("the more, the more / the less") with a NON-monotonic one: the motor runs
 * harder as the sensor excites it only up to a point (a maximum at some
 * intensity), then softer again. That is what lets a Vehicle-4 robot seek a
 * source and turn away once the stimulus is too strong, orbit it, or show
 * instinct-like behaviours (see docs/v4.md).
 *
 * These functions are pure and unit-tested. `transferOutput` maps a normalised
 * input magnitude to an output clamped to [0,1]; excitation/inhibition and the
 * per-wire weight are still applied downstream by computeActuation (unchanged
 * model), so a Neuron reshapes the signal rather than re-weighting it.
 */

/** The component type id a Neuron uses in a vehicle doc / logicGates list. */
export const NEURON_TYPE = 'neuron';

/** True for a Neuron node (as opposed to a boolean logic gate). */
export function isNeuron(type) {
  return type === NEURON_TYPE;
}

/** The selectable response shapes, in dropdown order. */
export const TRANSFER_PRESETS = ['bell', 'triangle', 'custom'];

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Coerce a user's custom spline to a safe form: an array of >=2 {x,y} points,
 * each clamped to [0,1], sorted ascending by x. An empty/invalid list falls back
 * to the identity line (a neutral monotonic passthrough) so a fresh "custom"
 * Neuron behaves sanely until the user draws something.
 */
export function normalizeSpline(pts) {
  const ok = Array.isArray(pts) && pts.length >= 2 &&
    pts.every(p => p && Number.isFinite(+p.x) && Number.isFinite(+p.y));
  const arr = ok
    ? pts.map(p => ({ x: clamp01(+p.x), y: clamp01(+p.y) }))
    : [{ x: 0, y: 0 }, { x: 1, y: 1 }]; // identity (neutral) default
  arr.sort((a, b) => a.x - b.x);
  return arr;
}

/**
 * Gaussian "bell": value 1 at the threshold, falling symmetrically either side.
 * The literal 4a shape — maximum efficiency at one level of stimulation.
 */
function bell(n, p) {
  const t = clamp01(typeof p.threshold === 'number' ? p.threshold : 0.5);
  const s = (typeof p.sigma === 'number' && p.sigma > 0) ? p.sigma : 0.35;
  return Math.exp(-((n - t) * (n - t)) / (2 * s * s));
}

/**
 * Triangle: linear rise 0→1 from input 0 to the threshold, linear fall 1→0 from
 * the threshold to input 1. Piecewise-linear twin of the bell; degenerate to a
 * single ramp if the threshold sits at an edge.
 */
function triangle(n, p) {
  const t = clamp01(typeof p.threshold === 'number' ? p.threshold : 0.5);
  if (t <= 0) return clamp01(1 - n); // peak at the left edge -> falling ramp
  if (t >= 1) return clamp01(n);     // peak at the right edge -> rising ramp
  return n < t ? n / t : (1 - n) / (1 - t);
}

/** User-drawn response line: linear interpolation through the spline nodes. */
function custom(n, p) {
  const pts = normalizeSpline(p.spline);
  if (n <= pts[0].x) return pts[0].y;
  const last = pts[pts.length - 1];
  if (n >= last.x) return last.y;
  for (let i = 1; i < pts.length; i++) {
    if (n <= pts[i].x) {
      const a = pts[i - 1], b = pts[i];
      const f = b.x === a.x ? 0 : (n - a.x) / (b.x - a.x);
      return a.y + f * (b.y - a.y);
    }
  }
  return last.y;
}

const SHAPES = { bell, triangle, custom };

/**
 * Evaluate a Neuron for one input sample.
 *
 * @param {object} props  the neuron's props: { shape, threshold, sigma, gain, spline }.
 * @param {number} input  the (normalised) magnitude of whatever feeds its input.
 * @returns {number} the transfer output, clamped to [0,1].
 */
export function transferOutput(props, input) {
  const p = props ?? {};
  const shape = SHAPES[p.shape] ? p.shape : 'bell';
  const n = clamp01(input ?? 0);
  let out = SHAPES[shape](n, p);
  if (typeof p.gain === 'number' && Number.isFinite(p.gain)) out *= p.gain;
  return clamp01(out);
}
