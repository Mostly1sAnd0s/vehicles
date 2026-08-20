/**
 * Per-step sensor evaluation for a vehicle instance.
 * Pure function: takes the vehicle (with pose), a world snapshot
 * ({ lights: [{x,y,intensity}], obstacles: [circle|rect] }) and sensor
 * config (from sensors.json). Returns one sample per sensor component:
 * { componentId, value, samplePoint, direction }.
 */

import { vehicleToWorld } from '../models/vehicle.js';
import { lightLevelNormalized, lightEffectiveRange } from '../sensors/light.js';
import { castRay } from '../sensors/raycast.js';
import { detectVehicle } from '../sensors/vehicleDetection.js';
import { applySensorPolarity } from '../sensors/polarity.js';

const SENSOR_TYPES = new Set(['light_sensor', 'distance_sensor', 'vehicle_detection_sensor']);

export function evaluateVehicleSensors(vehicle, world, sensorConfig) {
  const { pose } = vehicle;
  const samples = [];

  for (const c of vehicle.components ?? []) {
    if (!SENSOR_TYPES.has(c.type) || !c.local) continue;
    const point = vehicleToWorld(pose, c.local);
    const direction = pose.angle + (c.aimAngle ?? 0);

    let raw;
    let cfg;
    let value;
    if (c.type === 'light_sensor') {
      cfg = sensorConfig.light ?? {};
      const range = c.props?.range ?? cfg.defaultRange ?? 300;
      // Field of view: a per-sensor cone (radians, full aperture). Absent ->
      // the model default (sensors.json light.fov), which is omni by default so
      // existing vehicles are unaffected.
      const fov = c.props?.fov ?? cfg.fov;
      const aimOpts = { aim: direction, fov };
      // Per-sensor threshold / full-scale let each sensor's reach be tuned in
      // the inspector; sensing radius ~= sqrt(intensity / threshold).
      const lcfg = {
        range,
        minDistance: cfg.minDistance ?? 0.5,
        falloffPower: cfg.falloffPower ?? 2,
        detectionThreshold: c.props?.threshold ?? cfg.detectionThreshold,
        fullScaleRatio: c.props?.fullScaleRatio ?? cfg.fullScaleRatio,
      };
      // Linear-in-distance level in [0,1] (max over sources), then polarity.
      // lightLevel (pre-polarity) drives beam brightness; effectiveRange its
      // length; fov + range shape the beam; lightDistance is for readouts.
      const { level: n, distance: lightDistance } = lightLevelNormalized(point, world.lights ?? [], lcfg, aimOpts);
      value = applySensorPolarity(n, c.polarity, 1);
      samples.push({
        componentId: c.id,
        value,
        lightLevel: n,
        lightDistance,
        effectiveRange: lightEffectiveRange(world.lights ?? [], lcfg, point, aimOpts),
        fov,
        range,
        samplePoint: point,
        direction,
      });
      continue;
    }

    if (c.type === 'vehicle_detection_sensor') {
      // Same cone geometry as the light sensor (fov aperture on `direction`,
      // hard cap at `range`), but the targets are the other vehicles' poses and
      // the output is presence. effectiveRange = full range: there's no
      // threshold falloff, so the whole cone is the sensing area.
      const vcfg = sensorConfig.vehicle_detection ?? {};
      const vrange = c.props?.range ?? vcfg.defaultRange ?? 300;
      const vfov = c.props?.fov ?? vcfg.fov; // undefined -> omnidirectional
      const { detected, distance, target } = detectVehicle(point, direction, vrange, vfov, world.vehicles ?? [], vehicle.instanceId);
      value = applySensorPolarity(detected ? 1 : 0, c.polarity, 1);
      samples.push({
        componentId: c.id,
        kind: 'vehicle',
        value,
        detected,
        detectedDistance: distance,
        detectedTarget: target,
        effectiveRange: vrange,
        fov: vfov,
        range: vrange,
        samplePoint: point,
        direction,
      });
      continue;
    }

    cfg = sensorConfig.distance ?? {};
      const range = c.props?.range ?? cfg.defaultRange ?? 100;
      const hit = castRay(point, direction, range, world.obstacles ?? []);
      raw =
        cfg.output === 'normalized_inverse' && hit.hit
          ? 1 - hit.distance / range
          : hit.hit
            ? hit.distance
            : 0;

    // sensor polarity: inverted sensors are active in the absence of signal
    value = applySensorPolarity(raw, c.polarity, cfg.inversionRef);
    samples.push({ componentId: c.id, value, samplePoint: point, direction });
  }

  return samples;
}
