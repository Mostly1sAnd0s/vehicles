import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, queryCircle } from '../src/simulation/spatialGrid.js';

// The grid is a candidate-superset index: `queryCircle` must return EVERY item that could be
// within r (cells whose bbox overlaps the circle) — the exact distance test stays with the
// caller. A missed candidate is a correctness bug; an extra one is only a perf cost. This is
// the ONLY contract the detection layer is allowed to rely on.

test('empty grid returns no candidates', () => {
  const g = buildGrid([], { cellSize: 100 });
  assert.deepEqual(queryCircle(g, 0, 0, 50), []);
});

test('returns a point inside the query as a candidate', () => {
  const g = buildGrid([{ id: 'a', x: 10, y: 0 }], { cellSize: 100 });
  const cands = queryCircle(g, 0, 0, 20);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].id, 'a');
});

test('boundary: candidate cell adjacent to the query centre is scanned (cross-cell search)', () => {
  // item sits in cell 0, query centre in cell 1, circle crosses the boundary
  const g = buildGrid([{ id: 'a', x: 99, y: 0 }], { cellSize: 100 });
  const cands = queryCircle(g, 101, 0, 3);
  assert.ok(cands.some(c => c.id === 'a'));
});

test('negative coordinates and the zero-cell boundary are handled', () => {
  const items = [
    { id: 'nw', x: -1000, y: -1000 },
    { id: 'se', x: 999, y: 999 },
    { id: 'origin', x: 0, y: 0 },
  ];
  const g = buildGrid(items, { cellSize: 256 });
  // floor-division: x=0 is in cell 0; x=-0.0001 is in cell -1. Query from each corner.
  assert.ok(queryCircle(g, -1000, -1000, 1).some(c => c.id === 'nw'));
  assert.ok(queryCircle(g, 999, 999, 1).some(c => c.id === 'se'));
  assert.ok(queryCircle(g, 0, 0, 1).some(c => c.id === 'origin'));
  assert.ok(queryCircle(g, -1, 0, 2).some(c => c.id === 'origin'));
});

test('superset property vs brute force over a randomised corpus (every true hit is a candidate)', () => {
  // deterministic LCG so failures are reproducible
  let s = 123456789;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const items = [];
  for (let i = 0; i < 2000; i++) {
    items.push({ id: i, x: (rnd() - 0.5) * 10000, y: (rnd() - 0.5) * 10000 });
  }
  const g = buildGrid(items, { cellSize: 256 });
  for (let q = 0; q < 400; q++) {
    const cx = (rnd() - 0.5) * 10000, cy = (rnd() - 0.5) * 10000, r = rnd() * 600;
    const cands = new Set(queryCircle(g, cx, cy, r));
    for (const it of items) {
      const hit = Math.hypot(it.x - cx, it.y - cy) <= r;
      if (hit && !cands.has(it)) {
        assert.fail(`missed true hit id=${it.id} at (${it.x},${it.y}) from (${cx},${cy}) r=${r}`);
      }
    }
  }
});

test('huge query radius stays correct (falls back to scanning occupied cells, finds everything)', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ id: i, x: i * 1e4, y: -i * 1e4 }));
  const g = buildGrid(items, { cellSize: 256 });
  const cands = queryCircle(g, 0, 0, 1e9);
  assert.equal(cands.length, items.length); // superset = all, without iterating a quadrillion cells
});

test('items with non-finite coordinates are skipped, never poison the grid', () => {
  const g = buildGrid([{ id: 'ok', x: 0, y: 0 }, { id: 'nan', x: NaN, y: 1 }, null, undefined], { cellSize: 100 });
  const cands = queryCircle(g, 0, 0, 1000);
  assert.deepEqual(cands.map(c => c.id), ['ok']);
});

test('query with non-finite centre or radius returns empty rather than throwing', () => {
  const g = buildGrid([{ id: 'a', x: 0, y: 0 }], { cellSize: 100 });
  assert.deepEqual(queryCircle(g, NaN, 0, 10), []);
  assert.deepEqual(queryCircle(g, 0, 0, Infinity), []); // huge-but-finite is fine; Infinity is not
  assert.deepEqual(queryCircle(g, 0, 0, -1), []);
});

test('r = 0 is a point query (boundary-inclusive)', () => {
  const g = buildGrid([{ id: 'a', x: 5, y: 5 }], { cellSize: 100 });
  assert.equal(queryCircle(g, 5, 5, 0).length, 1);
});

test('default cell size is applied when not configured', () => {
  const g = buildGrid([{ id: 'a', x: 0, y: 0 }]);
  assert.ok(Number.isFinite(g.cellSize) && g.cellSize > 0);
});
