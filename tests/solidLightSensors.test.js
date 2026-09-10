import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldElementsToSnapshot } from '../src/simulation/worldSnapshot.js';
import { evaluateVehicleSensors } from '../src/simulation/sampleSensors.js';
import { lightLevelNormalized, lightEffectiveRange, sampleLight } from '../src/sensors/light.js';
import { castRay } from '../src/sensors/raycast.js';

/**
 * The two invariants that make a solid light safe to ship:
 *
 *   1. SOLIDITY NEVER CHANGES LIGHT SENSING. Sensors read `snapshot.lights`; the
 *      solid body goes into `snapshot.obstacles`. A lamp that dims, shrinks its
 *      beam, or changes a sensor's value when you tick "solid" would silently
 *      rewrite every Braitenberg demo in the app.
 *   2. SOLIDITY DOES make the lamp a physical object — rigid bodies and
 *      distance-sensor rays both stop at its surface.
 */

const LIGHT = { id: 'lamp', type: 'light', primitive: 'circle', position: { x: 0, y: 0 }, properties: { intensity: 6000 } };
const solidOf = (radius = 30) => ({ ...LIGHT, properties: { intensity: 6000, solid: true, radius } });

const lightCfg = { falloffPower: 2, minDistance: 0, range: 900, detectionThreshold: 0.25, fullScaleRatio: 16 };

test('snapshot.lights is byte-identical whether or not the light is solid', () => {
  const soft = worldElementsToSnapshot([LIGHT]);
  const hard = worldElementsToSnapshot([solidOf()]);
  assert.deepEqual(hard.lights, soft.lights);
  assert.equal(hard.obstacles.length, 1, 'and the solid one contributes exactly one body');
});

test('every light-sensor readout is identical with the light solid vs not', () => {
  const soft = worldElementsToSnapshot([LIGHT]);
  const hard = worldElementsToSnapshot([solidOf(30)]);
  const probe = { x: 60, y: 0 };
  const opts = { aim: 0, fov: 2 * Math.PI };

  assert.equal(
    lightLevelNormalized(probe, hard.lights, lightCfg, opts).level,
    lightLevelNormalized(probe, soft.lights, lightCfg, opts).level);
  assert.equal(
    lightLevelNormalized(probe, hard.lights, lightCfg, opts).distance,
    lightLevelNormalized(probe, soft.lights, lightCfg, opts).distance);
  assert.equal(
    lightEffectiveRange(hard.lights, lightCfg, probe, opts),
    lightEffectiveRange(soft.lights, lightCfg, probe, opts));
  assert.equal(sampleLight(probe, hard.lights, lightCfg, opts), sampleLight(probe, soft.lights, lightCfg, opts));
});

test('the invariant holds across a sweep of probe distances (not just one lucky point)', () => {
  const soft = worldElementsToSnapshot([LIGHT]).lights;
  const hard = worldElementsToSnapshot([solidOf(30)]).lights;
  for (let d = 1; d <= 400; d += 7) {
    const p = { x: d, y: 0 };
    assert.equal(
      lightLevelNormalized(p, hard, lightCfg, { aim: 0 }).level,
      lightLevelNormalized(p, soft, lightCfg, { aim: 0 }).level,
      `level must not depend on solidity at d=${d}`);
  }
});

test('a solid light blocks a distance-sensor ray; a non-solid one does not', () => {
  const soft = worldElementsToSnapshot([LIGHT]).obstacles;
  const hard = worldElementsToSnapshot([solidOf(30)]).obstacles;
  const origin = { x: 200, y: 0 };

  assert.equal(castRay(origin, Math.PI, 400, soft).hit, false, 'light is invisible to rays while soft');
  const hit = castRay(origin, Math.PI, 400, hard);
  assert.equal(hit.hit, true, 'a solid lamp is a real object');
  assert.ok(Math.abs(hit.distance - 170) < 1e-9, 'stops at the surface (200 - 30)');
});

test('a solid light does not block a ray aimed away from it', () => {
  const hard = worldElementsToSnapshot([solidOf(30)]).obstacles;
  assert.equal(castRay({ x: 200, y: 0 }, 0, 400, hard).hit, false);
});

test('end-to-end: a vehicle reads the same light value but a new distance value when the lamp turns solid', () => {
  const sensorConfig = {
    light: { falloffPower: 2, minDistance: 0, defaultRange: 900, detectionThreshold: 0.25, fullScaleRatio: 16 },
    distance: { model: 'raycast', defaultRange: 300, output: 'normalized_inverse' },
  };
  const v = {
    pose: { x: 200, y: 0, angle: Math.PI },
    components: [
      { id: 'ls', type: 'light_sensor', local: { x: 0, y: 0 }, aimAngle: 0, props: {} },
      { id: 'ds', type: 'distance_sensor', local: { x: 0, y: 0 }, aimAngle: 0, props: { range: 300 } },
    ],
  };

  const soft = evaluateVehicleSensors(v, worldElementsToSnapshot([LIGHT]), sensorConfig);
  const hard = evaluateVehicleSensors(v, worldElementsToSnapshot([solidOf(30)]), sensorConfig);
  const get = (out, id) => out.find(s => s.componentId === id);

  assert.equal(get(hard, 'ls').value, get(soft, 'ls').value, 'light sensing is untouched by solidity');
  assert.equal(get(hard, 'ls').effectiveRange, get(soft, 'ls').effectiveRange, 'and so is the drawn beam length');
  assert.equal(get(soft, 'ds').value, 0, 'soft lamp: nothing in the way');
  assert.ok(Math.abs(get(hard, 'ds').value - (1 - 170 / 300)) < 1e-9, 'solid lamp: distance sensor sees the surface');
});

test('a solid light does NOT occlude another light (occlusion is out of scope, by omission)', () => {
  // Documents the deliberate boundary: solidity adds a rigid body, not a shadow.
  // Real light occlusion would need a raycast inside the light model itself.
  const els = [solidOf(200), { ...LIGHT, id: 'far', position: { x: 500, y: 0 } }];
  const snap = worldElementsToSnapshot(els);
  const withBlockers = lightLevelNormalized({ x: 400, y: 0 }, snap.lights, lightCfg, { aim: 0 });
  assert.ok(withBlockers.level > 0, 'the far lamp is still sensed straight through the giant solid one');
});

test('a solid light is not double-counted as both a light and something the light model reads', () => {
  const snap = worldElementsToSnapshot([solidOf(30)]);
  assert.equal(snap.lights.length, 1, 'exactly one emitter');
  assert.equal(snap.obstacles.length, 1, 'exactly one body');
  assert.ok(!('intensity' in snap.obstacles[0]), 'the obstacle carries no photometric data');
});
