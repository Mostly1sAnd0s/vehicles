import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentSize, componentHits, nearestSnapIndex } from '../src/models/hitTest.js';

const wheel = { id: 'w1', type: 'powered_wheel', local: { x: 40, y: 0 }, localRotation: 0 };
const wheelDef = { size: 16, category: 'actuator' };
const sensor = { id: 's1', type: 'light_sensor', local: { x: 0, y: 0 }, localRotation: 0 };
const sensorDef = { size: 8, category: 'sensor' };

test('componentSize: actuator is a rect, short along travel axis, tall laterally', () => {
  const s = componentSize(wheel, wheelDef);
  assert.equal(s.kind, 'rect');
  assert.ok(Math.abs(s.along - 16 * 0.9) < 1e-9);
  assert.ok(Math.abs(s.lateral - 16 * 1.5) < 1e-9);
  assert.ok(s.lateral > s.along);
});

test('componentSize: sensor is a circle of radius = size', () => {
  const s = componentSize(sensor, sensorDef);
  assert.deepEqual(s, { kind: 'circle', radius: 8 });
});

test('componentHits: wheel hit works anywhere on the rect (not just near center)', () => {
  // near the corners/edges of the 14.4 x 24 rect at (40,0)
  for (const p of [
    { x: 40 - 7.1, y: -11.9 },
    { x: 40 + 7.1, y: 11.9 },
    { x: 40, y: 11.5 },   // edge, far from center (old 14px hit test still passes this one)
    { x: 40, y: -11.5 },
  ]) assert.ok(componentHits(p, wheel, wheelDef), `expected hit at ${JSON.stringify(p)}`);
});

test('componentHits: just outside the rect misses', () => {
  assert.ok(!componentHits({ x: 40, y: 12.5 }, wheel, wheelDef));
  assert.ok(!componentHits({ x: 47.5, y: 0 }, wheel, wheelDef));
  // far diagonal
  assert.ok(!componentHits({ x: 55, y: 0 }, wheel, wheelDef));
});

test('componentHits: rotated wheel frame follows localRotation', () => {
  const vert = { ...wheel, localRotation: Math.PI / 2 }; // travel along +y
  // now long axis is along x
  assert.ok(componentHits({ x: 40 + 11, y: 0 }, vert, wheelDef));
  assert.ok(!componentHits({ x: 40, y: 12 }, vert, wheelDef));
});

test('componentHits: circle sensors use radius hit', () => {
  assert.ok(componentHits({ x: 0, y: 7.9 }, sensor, sensorDef));
  assert.ok(!componentHits({ x: 0, y: 8.1 }, sensor, sensorDef));
});

test('nearestSnapIndex returns the closest snap point', () => {
  const snaps = [
    { x: 0, y: -20, normalX: 0, normalY: -1 },
    { x: 40, y: 6.7, normalX: 1, normalY: 0 },
    { x: -40, y: 6.7, normalX: -1, normalY: 0 },
  ];
  assert.equal(nearestSnapIndex(snaps, { x: 38, y: 8 }), 1);
  assert.equal(nearestSnapIndex(snaps, { x: -35, y: 2 }), 2);
  assert.equal(nearestSnapIndex(snaps, { x: 10, y: -15 }), 0);
});

test('nearestSnapIndex respects maxDist and returns -1 when none close enough', () => {
  const snaps = [{ x: 100, y: 100, normalX: 0, normalY: 0 }];
  assert.equal(nearestSnapIndex(snaps, { x: 0, y: 0 }, 50), -1);
  assert.equal(nearestSnapIndex(snaps, { x: 0, y: 0 }), 0); // no limit -> nearest anyway
});
