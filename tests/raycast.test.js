import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castRay } from '../src/sensors/raycast.js';

test('hits a circle at the expected distance', () => {
  const r = castRay({ x: 0, y: 0 }, 0, 100, [{ type: 'circle', x: 10, y: 0, radius: 2 }]);
  assert.equal(r.hit, true);
  assert.ok(Math.abs(r.distance - 8) < 1e-9);
});

test('returns maxRange with hit=false when nothing is in the way', () => {
  const r = castRay({ x: 0, y: 0 }, 0, 50, [{ type: 'circle', x: 100, y: 0, radius: 2 }]);
  assert.equal(r.hit, false);
  assert.equal(r.distance, 50);
});

test('ignores obstacles behind the ray', () => {
  const r = castRay({ x: 0, y: 0 }, Math.PI, 100, [{ type: 'circle', x: 10, y: 0, radius: 2 }]);
  assert.equal(r.hit, false);
});

test('ignores obstacles to the side of the ray', () => {
  const r = castRay({ x: 0, y: 0 }, 0, 100, [{ type: 'circle', x: 10, y: 5, radius: 2 }]);
  assert.equal(r.hit, false);
});

test('clips a hit beyond maxRange', () => {
  const r = castRay({ x: 0, y: 0 }, 0, 5, [{ type: 'circle', x: 10, y: 0, radius: 2 }]);
  assert.equal(r.hit, false);
  assert.equal(r.distance, 5);
});

test('picks the nearest of several obstacles', () => {
  const r = castRay(
    { x: 0, y: 0 },
    0,
    100,
    [
      { type: 'circle', x: 30, y: 0, radius: 2 },
      { type: 'circle', x: 10, y: 0, radius: 2 },
    ]
  );
  assert.ok(Math.abs(r.distance - 8) < 1e-9);
});

test('hits an axis-aligned rectangle at its face', () => {
  const r = castRay(
    { x: 0, y: 0 },
    0,
    100,
    [{ type: 'rect', x: 10, y: 0, width: 8, height: 2 }]
  );
  assert.equal(r.hit, true);
  assert.ok(Math.abs(r.distance - 6) < 1e-9);
});

test('rotation swaps a rectangle extents along the ray', () => {
  const unrotated = castRay(
    { x: 0, y: 0 },
    0,
    100,
    [{ type: 'rect', x: 10, y: 0, width: 8, height: 2, rotation: 0 }]
  );
  const rotated = castRay(
    { x: 0, y: 0 },
    0,
    100,
    [{ type: 'rect', x: 10, y: 0, width: 8, height: 2, rotation: Math.PI / 2 }]
  );
  assert.ok(Math.abs(unrotated.distance - 6) < 1e-9);
  assert.ok(Math.abs(rotated.distance - 9) < 1e-9);
});

test('grazes a rectangle corner correctly', () => {
  // box center (5,3), half-extents (2,1): nearest corner on x-axis path is at y=2..4, not hit
  const miss = castRay({ x: 0, y: 0 }, 0, 100, [{ type: 'rect', x: 5, y: 3, width: 4, height: 1 }]);
  assert.equal(miss.hit, false);
  // aim directly at the box's bottom-left corner (3, 2.5): hit exactly at that point
  const angle = Math.atan2(2.5, 3);
  const hit = castRay({ x: 0, y: 0 }, angle, 100, [{ type: 'rect', x: 5, y: 3, width: 4, height: 1 }]);
  assert.equal(hit.hit, true);
  assert.ok(Math.abs(hit.distance - Math.hypot(3, 2.5)) < 1e-9);
});

test('obstacle containing the ray origin still counts a front-facing hit', () => {
  const r = castRay({ x: 10, y: 0 }, 0, 100, [{ type: 'circle', x: 10, y: 0, radius: 2 }]);
  assert.equal(r.hit, true);
  assert.ok(Math.abs(r.distance - 2) < 1e-9);
});
