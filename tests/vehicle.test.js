import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveComponentTransforms, vehicleToWorld } from '../src/models/vehicle.js';

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

test('resolveComponentTransforms places components and orients them with the body', () => {
  const vehicle = {
    components: [
      { id: 'w1', local: { x: -20, y: 20 }, localRotation: 0 },
      { id: 'w2', local: { x: 20, y: 20 }, localRotation: Math.PI },
    ],
  };
  const ts = resolveComponentTransforms({ x: 0, y: 0, angle: 0 }, vehicle);
  assert.deepEqual(ts.map(t => t.id), ['w1', 'w2']);
  assert.ok(Math.abs(ts[0].x + 20) < 1e-9);
  assert.ok(Math.abs(ts[1].y - 20) < 1e-9);
  assert.equal(ts[0].angle, 0);
  assert.ok(Math.abs(ts[1].angle - Math.PI) < 1e-9);

  const rotated = resolveComponentTransforms({ x: 30, y: 0, angle: Math.PI / 2 }, vehicle);
  // w1 local (-20,20) rotated +90 -> (-20,-(-20))? (x,y)->(-y,x): (-20,20) -> (-20, -20)... verify: -y=-20, x=-20 -> (-20,-20)
  assert.ok(Math.abs(rotated[0].x - 30 + 20) < 1e-9);
  assert.ok(Math.abs(rotated[0].y + 20) < 1e-9);
  assert.ok(Math.abs(rotated[0].angle - Math.PI / 2) < 1e-9);
});

test('resolveComponentTransforms skips components missing local transforms', () => {
  const ts = resolveComponentTransforms({ x: 0, y: 0, angle: 0 }, { components: [{ id: 'a' }] });
  assert.deepEqual(ts, []);
});
