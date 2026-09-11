/**
 * A uniform spatial hash grid — a candidate SUPERSET index for radius queries.
 *
 * `queryCircle` returns every item that COULD be within `r` (all items in cells whose
 * bounding box overlaps the query circle). The exact distance test stays with the caller.
 * That is the whole contract: a missed candidate would be a correctness bug, an extra one
 * is only a perf cost, and both directions are tested
 * (`tests/spatialGrid.test.js`, superset property vs brute force).
 *
 * Why this exists: vehicle-detection sensors are queried once per sensor per physics step,
 * and the array scan is O(N) per query — O(N²) per step across a fleet (1000 vehicles ≈
 * 60M distance checks/second). Cell bucketing makes each query proportional to the items
 * NEAR the sensor instead of the whole world, with zero tuning required for correctness:
 * any `cellSize` is fast-or-slower, none is wrong.
 *
 * Deliberately dumb: no deletion (rebuild per step — the fleet moves every step anyway),
 * no rebalancing, no dependency on Matter or the DOM. Items are opaque objects with `x`/`y`.
 */

export const DEFAULT_CELL_SIZE = 256;

/**
 * Bucket items into cells by floor(x/cell). Items without finite coordinates are DROPPED —
 * a NaN handed to a Matter body poisons the whole world; a NaN handed to the grid must at
 * least stay out of the index (the array fallback path still sees them).
 *
 * @param {Array<{x:number,y:number}>} items
 * @param {{cellSize?: number}} [opts]
 * @returns {{cellSize:number, cells:Map<string,{cx:number,cy:number,items:array}>}}
 */
export function buildGrid(items = [], { cellSize = DEFAULT_CELL_SIZE } = {}) {
  const cs = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : DEFAULT_CELL_SIZE;
  const cells = new Map();
  for (const it of items) {
    if (!it || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
    const cx = Math.floor(it.x / cs);
    const cy = Math.floor(it.y / cs);
    const k = cx + ',' + cy;
    let cell = cells.get(k);
    if (!cell) { cell = { cx, cy, items: [] }; cells.set(k, cell); }
    cell.items.push(it);
  }
  return { cellSize: cs, cells };
}

/**
 * Candidate superset for the circle (x, y, r): every true hit IS in the result.
 *
 * Two traversal strategies, chosen by which set is smaller:
 *  - a small query walks the bbox's cells directly (O(cells-overlapped), typically 1..9);
 *  - a huge query (whose bbox spans more cells than the grid OCCUPIES) iterates the
 *    occupied cells and filters by bbox — O(occupied) ≤ O(N), so an absurd radius
 *    degrades to a brute-force-ish scan but never to a quadrillion empty-cell lookups.
 *
 * @returns {array} the candidate items (insertion order within a cell; no cross-cell order
 *                  guarantee — callers must not depend on it)
 */
export function queryCircle(grid, x, y, r) {
  const out = [];
  if (!grid || !grid.cells || !Number.isFinite(x) || !Number.isFinite(y)) return out;
  if (!Number.isFinite(r) || r < 0) return out;
  const cs = grid.cellSize;
  const x0 = Math.floor((x - r) / cs), x1 = Math.floor((x + r) / cs);
  const y0 = Math.floor((y - r) / cs), y1 = Math.floor((y + r) / cs);
  const span = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (span <= grid.cells.size) {
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = grid.cells.get(cx + ',' + cy);
        if (cell) for (const it of cell.items) out.push(it);
      }
    }
  } else {
    for (const cell of grid.cells.values()) {
      if (cell.cx < x0 || cell.cx > x1 || cell.cy < y0 || cell.cy > y1) continue;
      for (const it of cell.items) out.push(it);
    }
  }
  return out;
}
