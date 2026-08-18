import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldElementsToSnapshot } from '../src/simulation/worldSnapshot.js';

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
