import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVehicleSensors } from '../src/simulation/sampleSensors.js';

const sensorConfig = {
  light: { falloffPower: 2, minDistance: 0, defaultRange: 300, saturation: undefined },
  distance: { model: 'raycast', defaultRange: 100, output: 'normalized_inverse' },
};

function vehicle({ x = 0, y = 0, angle = 0 } = {}, components) {
  return { pose: { x, y, angle }, components: components ?? [] };
}

test('light sensor sums sources through inverse-square falloff in world space', () => {
  const v = vehicle(
    { x: 100, y: 0 },
    [
      { id: 'ls1', type: 'light_sensor', local: { x: 0, y: 0 }, aimAngle: 0, props: {} },
    ]
  );
  const world = {
    lights: [{ x: 150, y: 0, intensity: 1 }], // distance 50 -> 1/2500
    obstacles: [],
  };
  const out = evaluateVehicleSensors(v, world, sensorConfig);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].value - 1 / 2500) < 1e-12);
  assert.equal(out[0].componentId, 'ls1');
});

test('light sensor range comes from component props, not just config', () => {
  const v = vehicle({}, [
    { id: 'ls1', type: 'light_sensor', local: { x: 0, y: 0 }, aimAngle: 0, props: { range: 10 } },
  ]);
  const out = evaluateVehicleSensors(v, { lights: [{ x: 50, y: 0, intensity: 1 }], obstacles: [] }, sensorConfig);
  assert.equal(out[0].value, 0);
});

test('distance sensor returns normalized inverse of nearest obstacle along its aim direction', () => {
  const v = vehicle(
    {},
    [
      { id: 'ds1', type: 'distance_sensor', local: { x: 0, y: 0 }, aimAngle: 0, props: { range: 100 } },
    ]
  );
  const world = { lights: [], obstacles: [{ type: 'circle', x: 50, y: 0, radius: 5 }] }; // front face at 45 -> 1-45/100
  const out = evaluateVehicleSensors(v, world, sensorConfig);
  assert.ok(Math.abs(out[0].value - (1 - 45 / 100)) < 1e-9);
});

test('distance sensor reads 0 when nothing in range', () => {
  const v = vehicle({}, [
    { id: 'ds1', type: 'distance_sensor', local: { x: 0, y: 0 }, aimAngle: 0, props: { range: 100 } },
  ]);
  const out = evaluateVehicleSensors(v, { lights: [], obstacles: [{ type: 'circle', x: 200, y: 0, radius: 5 }] }, sensorConfig);
  assert.equal(out[0].value, 0);
});

test('sensor aim direction is relative to body heading', () => {
  // body rotated +90 (y-down): local aim 0 points world +y.
  // obstacle at (0, 50) with r=5: front face at y=45 -> value 1-45/100
  const v = vehicle(
    { angle: Math.PI / 2 },
    [
      { id: 'ds1', type: 'distance_sensor', local: { x: 0, y: 0 }, aimAngle: 0, props: { range: 100 } },
    ]
  );
  const out = evaluateVehicleSensors(v, { lights: [], obstacles: [{ type: 'circle', x: 0, y: 50, radius: 5 }] }, sensorConfig);
  assert.ok(Math.abs(out[0].value - (1 - 45 / 100)) < 1e-9);
});

test('non-sensor components produce no samples and light sources are excluded from distance casts', () => {
  const v = vehicle(
    {},
    [
      { id: 'w1', type: 'powered_wheel', local: { x: -20, y: 0 }, aimAngle: 0, props: {} },
      { id: 'ds1', type: 'distance_sensor', local: { x: 0, y: 0 }, aimAngle: 0, props: { range: 50 } },
    ]
  );
  const world = { lights: [{ x: 10, y: 0, intensity: 1 }], obstacles: [] };
  const out = evaluateVehicleSensors(v, world, sensorConfig);
  assert.deepEqual(out.map(o => o.componentId), ['ds1']);
});

test('samples include the world-space sample point and direction for beam visualization', () => {
  const v = vehicle(
    { x: 7, y: 9, angle: 0 },
    [
      { id: 'ds1', type: 'distance_sensor', local: { x: 10, y: 0 }, aimAngle: Math.PI / 2, props: { range: 50 } },
    ]
  );
  const out = evaluateVehicleSensors(v, { lights: [], obstacles: [] }, sensorConfig);
  assert.ok(Math.abs(out[0].samplePoint.x - 17) < 1e-9);
  assert.ok(Math.abs(out[0].samplePoint.y - 9) < 1e-9);
  assert.ok(Math.abs(out[0].direction - Math.PI / 2) < 1e-9);
});
