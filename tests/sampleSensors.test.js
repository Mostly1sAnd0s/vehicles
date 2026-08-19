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

// ----- light sensors under the threshold-anchored normalization model -----
const lightCfg = {
  light: { falloffPower: 2, minDistance: 0, defaultRange: 900, detectionThreshold: 0.25, fullScaleRatio: 16 },
  distance: { model: 'raycast', defaultRange: 100, output: 'normalized_inverse' },
};

function lightVehicle(polarity) {
  return vehicle(
    { x: 0, y: 0 },
    [{ id: 'ls1', type: 'light_sensor', local: { x: 0, y: 0 }, aimAngle: 0, polarity, props: {} }]
  );
}

test('light sample value is normalized linearly in distance (normal polarity)', () => {
  // source at distance d=60. Level ramps 0->1 LINEARLY IN DISTANCE between the
  // full-scale radius D_F=sqrt(I/F) and the threshold radius D_T=sqrt(I/T).
  // (This replaced the old level-linear map, which was exponential in position.)
  const I = 6000, d = 60, T = 0.25, K = 16;
  const out = evaluateVehicleSensors(
    lightVehicle('normal'),
    { lights: [{ x: d, y: 0, intensity: I }], obstacles: [] },
    lightCfg
  );
  const D_T = Math.sqrt(I / T);      // 154.92 (capped at range 900, so unchanged)
  const D_F = Math.sqrt(I / (T * K)); // 38.73
  const expected = (D_T - d) / (D_T - D_F);
  assert.ok(out[0].value > 0 && out[0].value < 1);
  assert.ok(Math.abs(out[0].value - expected) < 1e-9);
  assert.equal(out[0].lightLevel, out[0].value);
});

test('inverted light sensor = 1 - normalized level, so it shares the normal band', () => {
  const src = { x: 60, y: 0, intensity: 6000 };
  const world = { lights: [src], obstacles: [] };
  const norm = evaluateVehicleSensors(lightVehicle('normal'), world, lightCfg)[0].value;
  const inv = evaluateVehicleSensors(lightVehicle('inverted'), world, lightCfg)[0].value;
  assert.ok(Math.abs(norm + inv - 1) < 1e-9); // exact complements
});

test('light sample exposes effectiveRange for beam length (sqrt(I/threshold), capped)', () => {
  const out = evaluateVehicleSensors(
    lightVehicle('normal'),
    { lights: [{ x: 60, y: 0, intensity: 6000 }], obstacles: [] },
    lightCfg
  );
  assert.ok(Math.abs(out[0].effectiveRange - Math.sqrt(6000 / 0.25)) < 1e-6);
});

test('light effectiveRange is capped at the sensor range when the source is huge', () => {
  const out = evaluateVehicleSensors(
    lightVehicle('normal'),
    { lights: [{ x: 60, y: 0, intensity: 1e8 }], obstacles: [] },
    lightCfg
  );
  assert.equal(out[0].effectiveRange, 900); // capped at defaultRange
});
