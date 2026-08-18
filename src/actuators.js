/**
 * Actuator model: sensor value(s) through wires -> motor force, clamped.
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
