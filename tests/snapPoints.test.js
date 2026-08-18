import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSnapPoints } from '../src/models/snapPoints.js';

const RECT = { width: 80, height: 40 };

test('n=4 yields exactly the four corners, starting top-left clockwise', () => {
  const pts = generateSnapPoints(RECT, 4);
  assert.equal(pts.length, 4);
  // canvas y-down: top-left is (-w/2, -h/2)
  assert.deepEqual(pts.map(p => [p.x, p.y]), [
    [-40, -20], [40, -20], [40, 20], [-40, 20],
  ]);
});

test('always returns n points and every point lies on the perimeter', () => {
  for (const n of [4, 5, 6, 7, 8, 12, 13, 20]) {
    const pts = generateSnapPoints(RECT, n);
    assert.equal(pts.length, n, `n=${n}`);
    for (const p of pts) {
      onPerimeter(p, RECT);
    }
  }
});

test('n=8 includes each edge midpoint', () => {
  const pts = generateSnapPoints(RECT, 8);
  const has = (x, y) => pts.some(p => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
  assert.ok(has(0, -20), 'top midpoint');
  assert.ok(has(40, 0), 'right midpoint');
  assert.ok(has(0, 20), 'bottom midpoint');
  assert.ok(has(-40, 0), 'left midpoint');
});

test('n=12 splits each edge into thirds (corners + 2 interior per edge)', () => {
  const pts = generateSnapPoints(RECT, 12);
  const has = (x, y) => pts.some(p => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
  assert.ok(has(-40 + 80 / 3, -20));
  assert.ok(has(-40 + 160 / 3, -20));
});

test('odd remainder points go to earlier edges (n=5: one extra interior point on top edge)', () => {
  const pts = generateSnapPoints(RECT, 5);
  const has = (x, y) => pts.some(p => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
  assert.ok(has(0, -20));
  assert.equal(pts.filter(p => p.y === -20).length, 3); // TL, mid-top, TR
});

test('each point has an outward normal (unit length)', () => {
  for (const n of [4, 8, 12]) {
    for (const p of generateSnapPoints(RECT, n)) {
      const len = Math.hypot(p.normalX, p.normalY);
      assert.ok(Math.abs(len - 1) < 1e-9, `normal not unit: ${JSON.stringify(p)}`);
      // outward: point + epsilon*normal must be outside (or on) the rect
      const ex = p.x + p.normalX * 1;
      const ey = p.y + p.normalY * 1;
      const inside = Math.abs(ex) < RECT.width / 2 - 1e-9 && Math.abs(ey) < RECT.height / 2 - 1e-9;
      assert.ok(!inside, `normal points inward: ${JSON.stringify(p)}`);
    }
  }
});

test('top edge normal is (0,-1)', () => {
  const p = generateSnapPoints(RECT, 8).find(p => p.x === 0 && p.y === -20);
  assert.deepEqual([p.normalX, p.normalY], [0, -1]);
});

test('corner normals are the normalized sum of adjacent edge normals', () => {
  const tl = generateSnapPoints(RECT, 4)[0];
  assert.ok(Math.abs(tl.normalX + 1 / Math.SQRT2) < 1e-9);
  assert.ok(Math.abs(tl.normalY + 1 / Math.SQRT2) < 1e-9);
});

function onPerimeter(p, { width: w, height: h }) {
  const hw = w / 2, hh = h / 2;
  const onTop = Math.abs(p.y + hh) < 1e-9 && Math.abs(p.x) <= hw + 1e-9;
  const onBottom = Math.abs(p.y - hh) < 1e-9 && Math.abs(p.x) <= hw + 1e-9;
  const onLeft = Math.abs(p.x + hw) < 1e-9 && Math.abs(p.y) <= hh + 1e-9;
  const onRight = Math.abs(p.x - hw) < 1e-9 && Math.abs(p.y) <= hh + 1e-9;
  assert.ok(onTop || onBottom || onLeft || onRight, `off perimeter: ${JSON.stringify(p)}`);
}
