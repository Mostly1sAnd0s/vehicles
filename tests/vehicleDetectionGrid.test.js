import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectVehicle, buildVehicleGrid, detectVehicleGrid } from '../src/sensors/vehicleDetection.js';
import { evaluateVehicleSensors } from '../src/simulation/sampleSensors.js';

// The grid-backed detector must be the ARRAY detector's exact twin: same range semantics
// (hard cap, inclusive), same FOV gate, same self-exclusion, same nearest-wins. The only
// permitted divergence is the identity of the target among EXACTLY equal distances
// (candidate order differs); distance and detected may never differ.

const V = (id, x, y, angle = 0) => ({ id, x, y, angle });

test('grid: detects a vehicle in front, within range, inside the cone', () => {
  const g = buildVehicleGrid([V('B', 120, 0)], {});
  const r = detectVehicleGrid({ x: 0, y: 0 }, 0, 300, Math.PI, g, 'A');
  assert.equal(r.detected, true);
  assert.ok(Math.abs(r.distance - 120) < 1e-9);
  assert.equal(r.target.id, 'B');
});

test('grid: does not detect a vehicle behind a forward cone', () => {
  const g = buildVehicleGrid([V('B', -120, 0)], {});
  const r = detectVehicleGrid({ x: 0, y: 0 }, 0, 300, Math.PI, g, 'A');
  assert.equal(r.detected, false);
  assert.equal(r.distance, null);
  assert.equal(r.target, null);
});

test('grid: does not detect a vehicle beyond the range cap', () => {
  const g = buildVehicleGrid([V('B', 120, 0)], {});
  assert.equal(detectVehicleGrid({ x: 0, y: 0 }, 0, 100, Math.PI, g, 'A').detected, false);
});

test('grid: range is a hard cap, inclusive at the boundary', () => {
  const g = buildVehicleGrid([V('B', 100, 0), V('C', 100.001, 0)], {});
  const at = detectVehicleGrid({ x: 0, y: 0 }, 0, 100, Math.PI, g, 'A');
  assert.equal(at.detected, true);
  assert.equal(at.target.id, 'B'); // C is over the cap
});

test('grid: omnidirectional fov (omitted or 2π) sees all around', () => {
  const g = buildVehicleGrid([V('B', -120, 0), V('C', 0, -120)], {});
  assert.equal(detectVehicleGrid({ x: 0, y: 0 }, 0, 300, undefined, g, 'A').detected, true);
  assert.equal(detectVehicleGrid({ x: 0, y: 0 }, 0, 300, 2 * Math.PI, g, 'A').detected, true);
});

test('grid: a narrow cone excludes an off-axis vehicle even when in range', () => {
  const fov = Math.PI / 3;
  const g = buildVehicleGrid([V('B', 0, 120), V('C', 120, 0)], {});
  const up = detectVehicleGrid({ x: 0, y: 0 }, 0, 300, fov, g, 'A');
  // only dead-ahead C is inside the 60° cone
  assert.equal(up.detected, true);
  assert.equal(up.target.id, 'C');
});

test('grid: never detects itself (selfId is excluded)', () => {
  const g = buildVehicleGrid([V('A', 5, 0)], {});
  assert.equal(detectVehicleGrid({ x: 0, y: 0 }, 0, 300, Math.PI, g, 'A').detected, false);
});

test('grid: an empty world detects nothing', () => {
  const g = buildVehicleGrid([], {});
  const r = detectVehicleGrid({ x: 0, y: 0 }, 0, 300, undefined, g, 'A');
  assert.equal(r.detected, false);
});

test('grid: nearest wins across several cells', () => {
  const targets = [V('far', 900, 10), V('near', 60, -5), V('mid', 300, 0), V('out', 100000, 0)];
  const g = buildVehicleGrid(targets, { vehicle_detection: { gridCellSize: 100 } });
  const r = detectVehicleGrid({ x: 0, y: 0 }, 0, 1200, Math.PI * 0.9, g, 'A');
  assert.equal(r.detected, true);
  assert.equal(r.target.id, 'near');
});

test('buildVehicleGrid: cell size from config, with built-in fallback', () => {
  assert.equal(buildVehicleGrid([], { vehicle_detection: { gridCellSize: 50 } }).cellSize, 50);
  assert.equal(buildVehicleGrid([], {}).cellSize, 256);           // fallback default
  assert.equal(buildVehicleGrid([], undefined).cellSize, 256);
  // a junk value must not produce a broken grid (0/negative/NaN fall back)
  assert.equal(buildVehicleGrid([], { vehicle_detection: { gridCellSize: 0 } }).cellSize, 256);
  assert.equal(buildVehicleGrid([], { vehicle_detection: { gridCellSize: 'abc' } }).cellSize, 256);
});

test('grid and array detectors agree over a randomised corpus', () => {
  let s = 987654321;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const targets = [];
  for (let i = 0; i < 1500; i++) {
    targets.push(V('t' + i, (rnd() - 0.5) * 6000, (rnd() - 0.5) * 6000, rnd() * 6.283));
  }
  const g = buildVehicleGrid(targets, { vehicle_detection: { gridCellSize: 200 } });
  for (let q = 0; q < 600; q++) {
    const p = { x: (rnd() - 0.5) * 6000, y: (rnd() - 0.5) * 6000 };
    const dir = rnd() * Math.PI * 2;
    const range = rnd() * 800;
    const fov = rnd() < 0.3 ? undefined : rnd() * Math.PI * 2;
    const selfId = targets[Math.floor(rnd() * targets.length)].id;
    const a = detectVehicle(p, dir, range, fov, targets, selfId);
    const b = detectVehicleGrid(p, dir, range, fov, g, selfId);
    assert.equal(b.detected, a.detected, `detected mismatch at query ${q}`);
    if (!a.detected) continue;
    assert.ok(Math.abs(b.distance - a.distance) < 1e-9, `distance mismatch at query ${q}`);
    assert.equal(b.target.id, a.target.id, `target mismatch at query ${q}`); // random floats: ties are measure-zero
  }
});

test('sampleSensors: uses world.vehicleGrid when present, identical results to the array path', () => {
  const targets = [V('A', 0, 0, 0), V('B', 200, 40, 0), V('C', 900, 0, 0)];
  const grid = buildVehicleGrid(targets, {});
  const vehicle = {
    instanceId: 'A',
    components: [{ id: 's1', type: 'vehicle_detection_sensor', local: { x: 0, y: 0 }, props: { range: 400, fov: Math.PI / 2 } }],
    pose: { x: 0, y: 0, angle: 0 },
  };
  const cfg = { vehicle_detection: { defaultRange: 300, fov: Math.PI } };
  const viaArray = evaluateVehicleSensors(vehicle, { lights: [], vehicles: targets }, cfg)[0];
  const viaGrid = evaluateVehicleSensors(vehicle, { lights: [], vehicles: targets, vehicleGrid: grid }, cfg)[0];
  assert.equal(viaArray.detected, true);   // sanity: B is in the quarter-pi cone at ~204
  assert.equal(viaGrid.detected, viaArray.detected);
  assert.ok(Math.abs(viaGrid.detectedDistance - viaArray.detectedDistance) < 1e-12);
  assert.equal(viaGrid.detectedTarget.id, viaArray.detectedTarget.id);
  assert.equal(viaGrid.value, viaArray.value);
});

test('perf: grid-backed detection is dramatically cheaper at fleet scale (loose bound)', () => {
  const N = 2000;
  const targets = Array.from({ length: N }, (_, i) => V('t' + i, (i % 45) * 120 - 2700, Math.floor(i / 45) * 120 - 2700));
  const g = buildVehicleGrid(targets, {});
  const queries = Array.from({ length: 200 }, (_, i) => ({ p: { x: (i % 20) * 250 - 2500, y: Math.floor(i / 20) * 250 - 1200 }, dir: i * 0.31, range: 300, fov: Math.PI }));

  const t0 = process.hrtime.bigint();
  for (const q of queries) detectVehicle(q.p, q.dir, q.range, q.fov, targets, undefined);
  const bruteNs = Number(process.hrtime.bigint() - t0);

  const t1 = process.hrtime.bigint();
  for (const q of queries) detectVehicleGrid(q.p, q.dir, q.range, q.fov, g, undefined);
  const gridNs = Number(process.hrtime.bigint() - t1);

  console.log(`  (detection ${N} targets × ${queries.length} queries: brute ${(bruteNs / 1e6).toFixed(1)}ms vs grid ${(gridNs / 1e6).toFixed(1)}ms)`);
  assert.ok(gridNs < bruteNs / 4, `expected grid at least 4x faster, ratio ${(bruteNs / gridNs).toFixed(2)}`);
});
