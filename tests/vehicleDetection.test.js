import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectVehicle } from '../src/sensors/vehicleDetection.js';

// The detection model mirrors the light sensor's geometry (a cone of aperture
// `fov` centred on `direction`, capped at `range`) but the targets are other
// vehicles' poses rather than light sources, and the answer is presence.

test('detects a vehicle in front, within range, inside the cone', () => {
  const r = detectVehicle({ x: 0, y: 0 }, 0, 300, Math.PI, [{ id: 'B', x: 120, y: 0 }], 'A');
  assert.equal(r.detected, true);
  assert.ok(Math.abs(r.distance - 120) < 1e-9);
  assert.equal(r.target.id, 'B');
});

test('does not detect a vehicle behind a forward cone', () => {
  const r = detectVehicle({ x: 0, y: 0 }, 0, 300, Math.PI, [{ id: 'B', x: -120, y: 0 }], 'A');
  assert.equal(r.detected, false);
  assert.equal(r.distance, null);
  assert.equal(r.target, null);
});

test('does not detect a vehicle beyond the range cap', () => {
  const r = detectVehicle({ x: 0, y: 0 }, 0, 100, Math.PI, [{ id: 'B', x: 120, y: 0 }], 'A');
  assert.equal(r.detected, false);
});

test('range is a hard cap, inclusive at the boundary', () => {
  const at = detectVehicle({ x: 0, y: 0 }, 0, 100, Math.PI, [{ id: 'B', x: 100, y: 0 }], 'A');
  const justOver = detectVehicle({ x: 0, y: 0 }, 0, 100, Math.PI, [{ id: 'B', x: 100.001, y: 0 }], 'A');
  assert.equal(at.detected, true);
  assert.equal(justOver.detected, false);
});

test('omnidirectional fov (omitted or 2π) sees all around', () => {
  assert.equal(detectVehicle({ x: 0, y: 0 }, 0, 300, undefined, [{ id: 'B', x: -120, y: 0 }], 'A').detected, true);
  assert.equal(detectVehicle({ x: 0, y: 0 }, 0, 300, 2 * Math.PI, [{ id: 'B', x: 0, y: -120 }], 'A').detected, true);
});

test('a narrow cone excludes an off-axis vehicle even when in range', () => {
  const fov = Math.PI / 3; // 60 degrees
  assert.equal(detectVehicle({ x: 0, y: 0 }, 0, 300, fov, [{ id: 'B', x: 0, y: 120 }], 'A').detected, false); // straight up = 90 deg off
  assert.equal(detectVehicle({ x: 0, y: 0 }, 0, 300, fov, [{ id: 'B', x: 120, y: 0 }], 'A').detected, true); // dead ahead
});

test('never detects itself (selfId is excluded)', () => {
  const r = detectVehicle({ x: 0, y: 0 }, 0, 300, Math.PI, [{ id: 'A', x: 5, y: 0 }], 'A');
  assert.equal(r.detected, false);
});

test('picks the NEAREST target among several in view', () => {
  const r = detectVehicle({ x: 0, y: 0 }, 0, 300, Math.PI, [{ id: 'far', x: 200, y: 0 }, { id: 'near', x: 50, y: 10 }], 'A');
  assert.equal(r.target.id, 'near');
  assert.ok(Math.abs(r.distance - Math.hypot(50, 10)) < 1e-9);
});

test('no targets -> not detected', () => {
  const r = detectVehicle({ x: 0, y: 0 }, 0, 300, Math.PI, [], 'A');
  assert.equal(r.detected, false);
  assert.equal(r.distance, null);
  assert.equal(r.target, null);
});

test('the aim direction rotates the cone', () => {
  // Aim straight down (+y); a target below is now dead ahead -> detected.
  const r = detectVehicle({ x: 0, y: 0 }, Math.PI / 2, 300, Math.PI / 3, [{ id: 'B', x: 0, y: 120 }], 'A');
  assert.equal(r.detected, true);
});
