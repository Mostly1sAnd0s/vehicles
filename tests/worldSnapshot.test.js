import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldElementsToSnapshot } from '../src/simulation/worldSnapshot.js';
import { DEFAULT_LIGHT_RADIUS } from '../src/models/solidBody.js';

test('maps lights to {x,y,intensity} using properties.intensity with default 1', () => {
  const snap = worldElementsToSnapshot([
    { id: 'l1', type: 'light', primitive: 'circle', position: { x: 10, y: 20 } },
    { id: 'l2', type: 'light', primitive: 'circle', position: { x: 5, y: 5 }, properties: { intensity: 4 } },
  ]);
  assert.deepEqual(snap.lights, [
    { x: 10, y: 20, intensity: 1 },
    { x: 5, y: 5, intensity: 4 },
  ]);
});

test('maps circle obstacles with rotation and scale', () => {
  const snap = worldElementsToSnapshot([
    { id: 'o1', type: 'obstacle', primitive: 'circle', position: { x: 3, y: 4 }, rotation: 0.5, scale: { x: 2, y: 2 }, properties: { radius: 7 } },
  ]);
  assert.deepEqual(snap.obstacles, [{ type: 'circle', x: 3, y: 4, radius: 14 }]);
});

test('maps rect obstacles; scale multiplies width/height', () => {
  const snap = worldElementsToSnapshot([
    { id: 'o1', type: 'rock', primitive: 'rect', position: { x: 0, y: 0 }, rotation: Math.PI / 4, scale: { x: 1, y: 2 }, properties: { width: 10, height: 4 } },
  ]);
  assert.deepEqual(snap.obstacles, [{ type: 'rect', x: 0, y: 0, rotation: Math.PI / 4, width: 10, height: 8 }]);
});

test('unknown primitives and types are ignored', () => {
  const snap = worldElementsToSnapshot([
    { id: 'p1', type: 'obstacle', primitive: 'polygon', position: { x: 0, y: 0 }, properties: {} },
    { id: 'x1', type: 'mystery', primitive: 'circle', position: { x: 0, y: 0 }, properties: { radius: 1 } },
  ]);
  assert.deepEqual(snap.lights, []);
  assert.deepEqual(snap.obstacles, []);
});

test('empty element list yields empty snapshot', () => {
  assert.deepEqual(worldElementsToSnapshot([]), { lights: [], obstacles: [] });
});

// ---------------- solid light sources ----------------
// A light can be made collidable. The snapshot is the SINGLE seam that makes that
// true for both physics engines (WorldSim.buildObstacles and HeadlessWorld's), so
// the light must emit BOTH its emitter entry and a rock-identical obstacle entry.

test('a solid light emits BOTH a light entry and a circle obstacle at the same position', () => {
  const snap = worldElementsToSnapshot([
    { id: 'l1', type: 'light', primitive: 'circle', position: { x: -120, y: 40 }, properties: { intensity: 3000, solid: true, radius: 30 } },
  ]);
  assert.deepEqual(snap.lights, [{ x: -120, y: 40, intensity: 3000 }], 'the emitter entry is unchanged by solidity');
  assert.deepEqual(snap.obstacles, [{ type: 'circle', x: -120, y: 40, radius: 30 }]);
});

test('a non-solid light emits no obstacle (the default keeps every existing world identical)', () => {
  const snap = worldElementsToSnapshot([
    { id: 'l1', type: 'light', primitive: 'circle', position: { x: 10, y: 20 }, properties: { intensity: 3000 } },
    { id: 'l2', type: 'light', primitive: 'circle', position: { x: 0, y: 0 }, properties: { intensity: 1, solid: false } },
  ]);
  assert.equal(snap.lights.length, 2);
  assert.deepEqual(snap.obstacles, []);
});

test('a solid light with no explicit radius uses the config default', () => {
  const snap = worldElementsToSnapshot(
    [{ id: 'l1', type: 'light', position: { x: 0, y: 0 }, properties: { solid: true } }],
    { world: { light: { radius: 44 } } },
  );
  assert.equal(snap.obstacles[0].radius, 44);
});

test('with no configs argument at all the built-in default radius is used (never undefined/NaN)', () => {
  const snap = worldElementsToSnapshot([{ id: 'l1', type: 'light', position: { x: 0, y: 0 }, properties: { solid: true } }]);
  assert.equal(snap.obstacles.length, 1);
  assert.equal(snap.obstacles[0].radius, DEFAULT_LIGHT_RADIUS);
  assert.ok(Number.isFinite(snap.obstacles[0].radius) && snap.obstacles[0].radius > 0);
});

test('a solid light radius is scaled by el.scale.x, exactly like a rock', () => {
  const snap = worldElementsToSnapshot([
    { id: 'l1', type: 'light', position: { x: 5, y: 6 }, scale: { x: 3, y: 1 }, properties: { solid: true, radius: 12 } },
  ]);
  assert.equal(snap.obstacles[0].radius, 36);
});

test('a solid light obstacle is shape-identical to a rock obstacle (nothing downstream can tell them apart)', () => {
  const snap = worldElementsToSnapshot([
    { id: 'rock', type: 'rock', primitive: 'circle', position: { x: 1, y: 2 }, properties: { radius: 30 } },
    { id: 'lamp', type: 'light', primitive: 'circle', position: { x: 1, y: 2 }, properties: { intensity: 9, solid: true, radius: 30 } },
  ]);
  const [r, l] = snap.obstacles;
  assert.deepEqual(Object.keys(l).sort(), Object.keys(r).sort());
  assert.deepEqual({ ...l }, { ...r });
});

test('a light made solid by config default still emits the obstacle', () => {
  const snap = worldElementsToSnapshot(
    [{ id: 'l1', type: 'light', position: { x: 0, y: 0 }, properties: { intensity: 100 } }],
    { world: { light: { solid: true, radius: 20 } } },
  );
  assert.deepEqual(snap.obstacles, [{ type: 'circle', x: 0, y: 0, radius: 20 }]);
});

test('an element with no position is skipped entirely, solid or not', () => {
  const snap = worldElementsToSnapshot([{ id: 'ghost', type: 'light', properties: { solid: true, radius: 20 } }]);
  assert.deepEqual(snap, { lights: [], obstacles: [] });
});

test('lights and obstacles keep their independent order in the two arrays', () => {
  const snap = worldElementsToSnapshot([
    { id: 'a', type: 'light', position: { x: 0, y: 0 }, properties: { intensity: 1, solid: true, radius: 10 } },
    { id: 'b', type: 'rock', primitive: 'circle', position: { x: 50, y: 0 }, properties: { radius: 5 } },
    { id: 'c', type: 'light', position: { x: 90, y: 0 }, properties: { intensity: 2 } },
  ]);
  assert.deepEqual(snap.lights.map(l => l.x), [0, 90]);
  assert.deepEqual(snap.obstacles.map(o => o.x), [0, 50]);
});
