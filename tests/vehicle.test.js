import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vehicleToWorld } from '../src/models/vehicle.js';

test('vehicleToWorld applies rotation then translation (identity pose)', () => {
  const p = vehicleToWorld({ x: 100, y: 50, angle: 0 }, { x: 10, y: -5 });
  assert.ok(Math.abs(p.x - 110) < 1e-9);
  assert.ok(Math.abs(p.y - 45) < 1e-9);
});

test('vehicleToWorld rotates local points (angle = PI/2, y-down)', () => {
  // +90deg in canvas coords: (1,0) -> (0,1)
  const p = vehicleToWorld({ x: 0, y: 0, angle: Math.PI / 2 }, { x: 10, y: 0 });
  assert.ok(Math.abs(p.x - 0) < 1e-9);
  assert.ok(Math.abs(p.y - 10) < 1e-9);
});

test('vehicleToWorld composes rotation with translation', () => {
  const p = vehicleToWorld({ x: 5, y: 7, angle: Math.PI / 2 }, { x: 10, y: 0 });
  assert.ok(Math.abs(p.x - 5) < 1e-9);
  assert.ok(Math.abs(p.y - 17) < 1e-9);
});

// (resolveComponentTransforms and its tests were removed with the function — see
//  src/models/vehicle.js; per-component resolution via vehicleToWorld is what production uses
//  and is covered by the tests above plus tests/sampleSensors.test.js.)
