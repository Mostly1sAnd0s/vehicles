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
import { detectVehicle, detectVehicleGrid } from '../sensors/vehicleDetection.js';
import { applySensorPolarity } from '../sensors/polarity.js';
import { heatConfig, heatField, stepSensorTemperature, heatOutput, heatEffectiveRange } from '../sensors/heat.js';

const SENSOR_TYPES = new Set(['light_sensor', 'heat_sensor', 'distance_sensor', 'vehicle_detection_sensor']);

/**
 * @param {object} vehicle  pose + components (+instanceId)
 * @param {object} world    { lights, heats, obstacles, vehicles }
 * @param {object} sensorConfig  the merged `sensors.json`
 * @param {object} [opts]
 *   sensorStates: Map<componentId, {temperatureC,…}> — the sensor's THERMAL MASS. Heat is the
 *     one sensor in this file with a past: its reading depends on where it has been. It
 *     cannot live on `vehicle` (both engines pass a fresh `{...v, pose}` object every tick) so
 *     the ENGINE owns the map, one per instance, and clears it on Reset. Optional: without it
 *     the sensor still works, starting cold each call — no existing caller has to change.
 *   dtMs: the fixed timestep, for the exponential response. Defaults to 1/60 s.
 */
export function evaluateVehicleSensors(vehicle, world, sensorConfig, opts = {}) {
  const { pose } = vehicle;
  const samples = [];
  const heatSeen = opts.sensorStates ? [] : null;

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

    if (c.type === 'heat_sensor') {
      // Thermal radiation incident here, then the sensor's own lumped heat capacitance.
      // Note what this branch does NOT read: `world.lights`. A furnace is not a lamp.
      const hcfgRaw = sensorConfig.heat ?? {};
      const range = c.props?.range ?? hcfgRaw.defaultRange ?? 600;
      const fov = c.props?.fov ?? hcfgRaw.fov;
      const aimOpts = { aim: direction, fov };
      // Per-sensor overrides: `sensitivity` multiplies the probe's radiative CONDUCTANCE
      // (how strongly it is pulled toward the temperature of what it sees, relative to its
      // leak to ambient), `lagMs` overrides τ. Both keep the physics shape and move only its
      // scale — and because the equilibrium is a weighted mean, a sensitivity of 100 still
      // cannot read hotter than the source, which the old flux-gain version could.
      // The base coupling comes from heatConfig, so the default lives in one place.
      const hcfg = heatConfig({
        ...hcfgRaw,
        range,
        coupling: heatConfig(hcfgRaw).coupling * (Number.isFinite(c.props?.sensitivity) ? c.props.sensitivity : 1),
        timeConstantMs: Number.isFinite(c.props?.lagMs) ? c.props.lagMs : hcfgRaw.timeConstantMs,
      });
      const field = heatField(point, world.heats ?? [], hcfg, { ...aimOpts, obstacles: world.obstacles ?? [] });
      const prev = opts.sensorStates?.get(c.id);
      const state = stepSensorTemperature(prev, field, opts.dtMs ?? 1000 / 60, hcfg);
      if (heatSeen) { opts.sensorStates.set(c.id, state); heatSeen.push(c.id); }
      const level = heatOutput(state.temperatureC, hcfg);
      samples.push({
        componentId: c.id,
        kind: 'heat',
        value: applySensorPolarity(level, c.polarity, 1),
        heatLevel: level,
        heatTemperatureC: state.temperatureC,
        heatEquilibriumC: state.equilibriumC,
        heatFlux: state.flux,
        ambientC: hcfg.ambientTemp,
        // The beam is drawn at the source's TRUE thermal reach (where equilibrium still
        // clears a tenth of full scale), not at an arbitrary circle.
        effectiveRange: heatEffectiveRange(world.heats ?? [], { ...hcfg, thresholdC: hcfg.outputSpanC / 10 }, point, aimOpts),
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
      // Grid-backed when the engine indexed this step's fleet poses (`world.vehicleGrid`,
      // built once per step by both engines); the array scan is the identical predicate
      // over every target and stays the fallback for any caller without a grid. Same
      // result, O(near) instead of O(fleet).
      const { detected, distance, target } = world.vehicleGrid
        ? detectVehicleGrid(point, direction, vrange, vfov, world.vehicleGrid, vehicle.instanceId)
        : detectVehicle(point, direction, vrange, vfov, world.vehicles ?? [], vehicle.instanceId);
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

  // A sensor that was removed must not leave heat behind: its id would otherwise hold a hot
  // reading forever, and a NEW sensor reusing that id (component ids are stable per design,
  // and two clones of one prototype share them) would boot up hot from a component that no
  // longer exists. The map is per instance, so pruning here cannot touch another robot.
  if (heatSeen && opts.sensorStates) {
    for (const id of Array.from(opts.sensorStates.keys())) {
      if (!heatSeen.includes(id)) opts.sensorStates.delete(id);
    }
  }

  return samples;
}
