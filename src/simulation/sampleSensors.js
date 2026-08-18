/**
 * Per-step sensor evaluation for a vehicle instance.
 * Pure function: takes the vehicle (with pose), a world snapshot
 * ({ lights: [{x,y,intensity}], obstacles: [circle|rect] }) and sensor
 * config (from sensors.json). Returns one sample per sensor component:
 * { componentId, value, samplePoint, direction }.
 */

import { vehicleToWorld } from '../models/vehicle.js';
import { sampleLight } from '../sensors/light.js';
import { castRay } from '../sensors/raycast.js';

const SENSOR_TYPES = new Set(['light_sensor', 'distance_sensor']);

export function evaluateVehicleSensors(vehicle, world, sensorConfig) {
  const { pose } = vehicle;
  const samples = [];

  for (const c of vehicle.components ?? []) {
    if (!SENSOR_TYPES.has(c.type) || !c.local) continue;
    const point = vehicleToWorld(pose, c.local);
    const direction = pose.angle + (c.aimAngle ?? 0);

    let value;
    if (c.type === 'light_sensor') {
      const cfg = sensorConfig.light ?? {};
      value = sampleLight(point, world.lights ?? [], {
        range: c.props?.range ?? cfg.defaultRange ?? 300,
        minDistance: cfg.minDistance ?? 0.5,
        falloffPower: cfg.falloffPower ?? 2,
        saturation: cfg.saturation,
      });
    } else {
      const cfg = sensorConfig.distance ?? {};
      const range = c.props?.range ?? cfg.defaultRange ?? 100;
      const hit = castRay(point, direction, range, world.obstacles ?? []);
      value =
        cfg.output === 'normalized_inverse' && hit.hit
          ? 1 - hit.distance / range
          : hit.hit
            ? hit.distance
            : 0;
    }

    samples.push({ componentId: c.id, value, samplePoint: point, direction });
  }

  return samples;
}
