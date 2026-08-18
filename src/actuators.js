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

export function computeActuation(sensorValue, wires, config) {
  const list = Array.isArray(wires) ? wires : [wires];
  const maxForce = config?.maxForce ?? 1;
  let force = 0;
  for (const wire of list) {
    const sign = wire.polarity === 'inhibitory' ? -1 : 1;
    force += sensorValue * (wire.weight ?? 0) * sign;
  }
  if (force > maxForce) return maxForce;
  if (force < -maxForce) return -maxForce;
  return force;
}
