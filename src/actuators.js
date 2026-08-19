/**
 * Actuator model: sensor value(s) through wires -> motor force, clamped.
 *
 * TODO(future, PLAN.md §Future Work): the polarity sign here only inverts the
 * signal. Per-motor spin direction (cw/ccw) should be an explicit actuator
 * parameter applied on top of this force, and a small threshold/condition
 * scripting layer may replace the linear value×weight×polarity model.
 * Keep this function as the single seam both would flow through.
 * Accepts a single wire object or an array of wires feeding the actuator.
 * config from actuators.json, e.g. { maxForce: 1.0 }
 */

/**
 * Actuator response curve. Maps a (non-negative) sensor magnitude to the
 * motor's output before weighting/summing. This is the "motor gain / torque"
 * knob: with an exponent < 1 (e.g. sqrt) low sensor values produce
 * proportionally MORE force, so the vehicle responds well before the sensor
 * saturates instead of only moving when it's on top of the light.
 *   linear (default): x          -> unchanged, existing behavior
 *   sqrt:             sqrt(x)    -> boosts low signals (~torque to beat inertia)
 */
function applyCurve(value, config) {
  const m = Math.max(0, value ?? 0);
  switch (config?.powerCurve ?? 'linear') {
    case 'sqrt': return Math.sqrt(m);
    default: return m; // linear
  }
}

export function computeActuation(sensorValue, wires, config) {
  const list = Array.isArray(wires) ? wires : [wires];
  const maxForce = config?.maxForce ?? 1;
  let force = 0;
  for (const wire of list) {
    const sign = wire.polarity === 'inhibitory' ? -1 : 1;
    force += applyCurve(sensorValue, config) * (wire.weight ?? 0) * sign;
  }
  if (force > maxForce) return maxForce;
  if (force < -maxForce) return -maxForce;
  return force;
}

/**
 * Per-motor polarity sign. Decouples "which way the motor turns" from the
 * sensor signal: the returned ±1 multiplies the final actuation force.
 * Explicit 'reverse' → -1; anything else falls back to
 * config.defaultPolarity, then 'forward' (+1).
 */
export function actuatorPolaritySign(polarity, config) {
  const dir = polarity ?? config?.defaultPolarity ?? 'forward';
  return dir === 'reverse' ? -1 : 1;
}

/**
 * Per-wheel motor power: a simple linear gain on that wheel's actuation force,
 * composited with the global thrustScale in the world sim. Sign is preserved
 * (so reverse motors stay reversed). Missing/undefined -> neutral 1.0, so the
 * setting is opt-in and never changes behaviour until you touch it.
 */
export function applyMotorPower(force, power) {
  const p = typeof power === 'number' && Number.isFinite(power) ? power : 1;
  return force * p;
}

/**
 * Map a wheel's friction (0..1) to a top-down drag coefficient (Matter.js
 * `frictionAir`). In this gravity-free world the only thing that slows a
 * coasting robot is air drag, so this IS the "wheel grip" knob:
 *   friction 0 -> base (~ice: keeps gliding)
 *   friction 1 -> base + scale (grippy: stops on the spot)
 * Clamped to [0,1]; missing/undefined falls back to config.defaultFriction.
 */
export function wheelFrictionAir(friction, config = {}) {
  let f = typeof friction === 'number' && Number.isFinite(friction) ? friction : (config.defaultFriction ?? 0.5);
  f = Math.max(0, Math.min(1, f));
  const base = config.frictionAirBase ?? 0.001;
  const scale = config.frictionAirScale ?? 0.2;
  return base + f * scale;
}
