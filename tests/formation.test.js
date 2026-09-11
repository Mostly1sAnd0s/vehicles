/**
 * The formation layouts — one definition now serving BOTH the single-player per-prototype
 * buttons and the co-op "arrange every bot" command, so the two can never mean different
 * things. These pin the geometry the user judges by eye: centred, evenly spaced, count
 * preserved, and deterministic when the rng is fixed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formationPoses, centroid, isFormationMode, FORMATION_MODES, DEFAULT_SPACING } from '../src/models/formation.js';

// A tiny deterministic rng (LCG) so "random" is reproducible without importing a PRNG.
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const center = { x: 0, y: 0 };

// ---- the contract --------------------------------------------------------

test('all three modes return exactly n poses', () => {
  for (const mode of FORMATION_MODES) {
    for (const n of [1, 2, 3, 7, 16, 50]) {
      const p = formationPoses(n, mode, center, { rng: rng(n) });
      assert.equal(p.length, n, `${mode} n=${n}`);
      for (const q of p) {
        assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.rotation), `${mode} produced a non-finite pose`);
      }
    }
  }
});

test('an unknown mode returns null, not a silent empty layout', () => {
  // null is what lets the session answer "unknown formation" instead of doing nothing at all.
  assert.equal(formationPoses(4, 'spiral', center), null);
  assert.equal(formationPoses(4, undefined, center), null);
  assert.equal(formationPoses(4, '', center), null);
  assert.ok(isFormationMode('grid') && !isFormationMode('spiral'));
});

test('n < 1 (or garbage) yields no poses rather than one bogus pose', () => {
  for (const bad of [0, -3, NaN, undefined, null, 'six', 0.4]) {
    assert.deepEqual(formationPoses(bad, 'line', center), [], String(bad));
  }
});

test('a missing or broken centre still produces a usable layout', () => {
  for (const c of [undefined, null, {}, { x: NaN, y: 5 }, { x: 'a', y: 'b' }]) {
    const p = formationPoses(4, 'grid', c);
    assert.equal(p.length, 4);
    assert.ok(p.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)));
  }
});

// ---- line ---------------------------------------------------------------

test('line: evenly spaced at the default 130px, centred on the given point, all facing 0', () => {
  const p = formationPoses(5, 'line', center);
  assert.deepEqual(p.map(q => q.x), [-260, -130, 0, 130, 260]);
  assert.ok(p.every(q => q.y === 0));
  assert.ok(p.every(q => q.rotation === 0));
  assert.equal(DEFAULT_SPACING, 130, 'the number the single-player buttons have always used');
});

test('line: the centroid of the fleet is the centre — it does not slide away as it grows', () => {
  for (const n of [1, 2, 5, 12]) {
    const p = formationPoses(n, 'line', center);
    const mean = p.reduce((a, q) => a + q.x, 0) / n;
    assert.ok(Math.abs(mean) < 1e-9, `n=${n} drifted to ${mean}`);
  }
});

test('line: honours a custom spacing and an off-origin centre', () => {
  const p = formationPoses(3, 'line', { x: 1000, y: -500 }, { spacing: 40 });
  assert.deepEqual(p.map(q => Math.round(q.x)), [960, 1000, 1040]);
  assert.ok(p.every(q => q.y === -500));
});

// ---- grid ---------------------------------------------------------------

test('grid: square-ish, centred, no duplicates, spacing respected', () => {
  const p = formationPoses(9, 'grid', center);
  const xs = new Set(p.map(q => q.x));
  const ys = new Set(p.map(q => q.y));
  assert.equal(xs.size, 3, '3x3 for nine bots');
  assert.equal(ys.size, 3);
  assert.equal(new Set(p.map(q => `${q.x},${q.y}`)).size, 9, 'every bot gets its own cell');
  const meanX = p.reduce((a, q) => a + q.x, 0) / 9;
  const meanY = p.reduce((a, q) => a + q.y, 0) / 9;
  assert.ok(Math.abs(meanX) < 1e-9 && Math.abs(meanY) < 1e-9, 'centred');
  assert.ok(Math.max(...p.map(q => q.x)) - Math.min(...p.map(q => q.x)) === 2 * DEFAULT_SPACING);
});

test('grid: non-square counts still place everyone without overlap', () => {
  for (const n of [2, 5, 7, 10, 17, 26]) {
    const p = formationPoses(n, 'grid', center);
    assert.equal(new Set(p.map(q => `${q.x},${q.y}`)).size, n, `n=${n} had overlapping cells`);
    // ceil(sqrt(n)) columns: never wider than it is tall by more than one column's worth.
    const cols = new Set(p.map(q => q.x)).size;
    const rows = new Set(p.map(q => q.y)).size;
    assert.ok(cols === Math.ceil(Math.sqrt(n)), `n=${n} used ${cols} columns`);
    assert.ok(cols * rows >= n);
  }
});

// ---- random -------------------------------------------------------------

test('random: deterministic for a fixed rng (so a seeded layout is reproducible)', () => {
  const a = formationPoses(10, 'random', center, { rng: rng(42) });
  const b = formationPoses(10, 'random', center, { rng: rng(42) });
  assert.deepEqual(a, b);
  const c = formationPoses(10, 'random', center, { rng: rng(43) });
  assert.notDeepEqual(a, c, 'a different seed must give a different layout');
});

test('random: stays inside the requested spread around the centre', () => {
  const spread = 300;
  const p = formationPoses(60, 'random', { x: 20, y: -30 }, { rng: rng(7), spread, minSeparation: 0 });
  assert.ok(p.every(q => Math.abs(q.x - 20) <= spread + 1e-9), 'x within the box');
  assert.ok(p.every(q => Math.abs(q.y + 30) <= spread + 1e-9), 'y within the box');
  assert.ok(p.some(q => q.rotation > 0.1), 'orientations are actually randomised');
});

test('random: keeps its distance when there is room, so a grid-to-random swap is not a pile-up', () => {
  const p = formationPoses(12, 'random', center, { rng: rng(3), spread: 900, spacing: 130, minSeparation: 117 });
  let closest = Infinity;
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) closest = Math.min(closest, Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y));
  }
  assert.ok(closest >= 117 - 1e-9, `bots overlapped at ${closest.toFixed(1)}px apart`);
});

test('random: a world with no room still places every bot (bounded rejection, never a drop)', () => {
  // 20 bots in a 60px box with a 100px separation requirement: unsatisfiable by construction.
  const p = formationPoses(20, 'random', center, { rng: rng(5), spread: 60, minSeparation: 100 });
  assert.equal(p.length, 20);
  assert.ok(p.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)));
});

test('random: spread defaults grow with the fleet instead of squeezing everyone into one box', () => {
  const few = formationPoses(2, 'random', center, { rng: rng(11), minSeparation: 0 });
  const many = formationPoses(40, 'random', center, { rng: rng(11), minSeparation: 0 });
  const extent = a => Math.max(...a.map(q => Math.abs(q.x)));
  assert.ok(extent(many) > extent(few), 'a bigger fleet gets a bigger area');
});

// ---- centroid ----------------------------------------------------------

test('centroid: where the bots already are, so arranging does not teleport the world', () => {
  assert.deepEqual(centroid([{ x: 100, y: 0 }, { x: 300, y: 200 }]), { x: 200, y: 100 });
  assert.deepEqual(centroid([]), { x: 0, y: 0 });
  assert.deepEqual(centroid(null), { x: 0, y: 0 });
  // Junk entries are skipped rather than poisoning the mean with NaN.
  assert.deepEqual(centroid([{ x: 100, y: 100 }, { x: NaN, y: 0 }, null, {}]), { x: 100, y: 100 });
});

test('centroid feeds a sane default centre when the caller has no camera', () => {
  const bots = [{ x: -400, y: 300 }, { x: 600, y: 300 }, { x: 100, y: 900 }];
  const p = formationPoses(3, 'line', centroid(bots));
  // centroid = (300/3, 1500/3) = (100, 500); the middle bot of a line sits ON the centre.
  assert.ok(Math.abs(p[1].x - 100) < 1e-9 && Math.abs(p[1].y - 500) < 1e-9,
    `the line is laid down where the fleet is, not at the origin: got ${p[1].x},${p[1].y}`);
});
