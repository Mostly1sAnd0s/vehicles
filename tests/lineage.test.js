/**
 * Propagation lineage — pure core (the "survival of the fittest" scoreboard).
 *
 * A Propagator conversion has always swapped the bot's DESIGN, but the bot was still COUNTED
 * under its own proto: the co-op fleet list tallied each participant's row from the clones they
 * deployed, so a fittest-survival run could never see who was winning. Lineage fixes the count:
 *
 *   1. Origin   — a bot's lineage starts as its own proto (the one its deployer seeded it under).
 *   2. Adoption — a converted bot adopts the CONVERTER's lineage (not merely the converter's
 *      proto), so attribution follows the configuration chain: A converts B, and B's clone
 *      converts C ⇒ C counts for A. The converter's lineage is already the head of the chain,
 *      so a single assignment IS the recursion.
 *   3. Reset    — the engine restores every lineage to its origin, so a Reset returns the
 *      scoreboard to the initial mix, exactly as it restores the designs.
 *
 * Lineage is deliberately NOT ownership. The converted bot keeps its protoId / owner /
 * ownerToken — deploy rebuilds, fleet −/+/✕ and prune-on-leave keep targeting the deployer.
 * Only the count moves. Every consumer (the engine, the wire, the page protocol reply, the
 * fleet UI) reads through `lineageOf`, so the scoreboard cannot drift from the simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineageOf, lineageCounts } from '../src/models/lineage.js';

test('lineageOf: a converted bot reports the proto it counts under', () => {
  assert.equal(lineageOf({ id: 'x', protoId: 'b', owner: 'bob', lineage: 'a' }), 'a');
});

test('lineageOf: an unconverted bot counts under its own proto', () => {
  assert.equal(lineageOf({ id: 'x', protoId: 'b', owner: 'bob' }), 'b');
});

test('lineageOf: a legacy wire bot with no lineage field falls back to protoId (old servers keep working)', () => {
  assert.equal(lineageOf({ protoId: 'b' }), 'b');
});

test('lineageOf: an explicit null lineage falls back to the proto, not to "counted nowhere"', () => {
  assert.equal(lineageOf({ protoId: 'b', lineage: null }), 'b');
});

test('lineageOf: nothing to read → null, never throws', () => {
  assert.equal(lineageOf(null), null);
  assert.equal(lineageOf(undefined), null);
  assert.equal(lineageOf({}), null);
});

test('lineageCounts: unconverted bots count under their own proto', () => {
  const bots = [
    { id: 'a1', protoId: 'a' },
    { id: 'a2', protoId: 'a' },
    { id: 'b1', protoId: 'b' },
  ];
  assert.deepEqual(lineageCounts(bots), { a: 2, b: 1 });
});

test('lineageCounts: a converted bot counts for the converter, not its deployer (the 11/9 case)', () => {
  // alice's proto `a` converted bob's bot b1 — b1 still carries its own protoId/owner; only the count moved.
  const bots = [
    { id: 'a1', protoId: 'a' },
    { id: 'a2', protoId: 'a' },
    { id: 'b1', protoId: 'b', lineage: 'a' },
    { id: 'b2', protoId: 'b' },
  ];
  assert.deepEqual(lineageCounts(bots), { a: 3, b: 1 });
});

test('lineageCounts: a transitive chain counts every bot for the original converter', () => {
  // a → b1 → c1: c1 adopted b1's lineage, which was already a.
  const bots = [
    { id: 'a1', protoId: 'a' },
    { id: 'b1', protoId: 'b', lineage: 'a' },
    { id: 'c1', protoId: 'c', lineage: 'a' },
  ];
  assert.deepEqual(lineageCounts(bots), { a: 3 }); // c has zero bots counting for it: absent, not 0
});

test('lineageCounts: legacy bots fall back and uncountable bots are skipped, not crashed on', () => {
  const bots = [
    { id: 'a1', protoId: 'a' },
    { id: 'old', protoId: 'z' }, // legacy wire bot: no lineage key at all → counts under z
    { id: 'orphan' },            // no protoId at all: nothing to count under → skipped
  ];
  assert.deepEqual(lineageCounts(bots), { a: 1, z: 1 });
});

test('lineageCounts: null/empty input yields an empty tally, not a throw', () => {
  assert.deepEqual(lineageCounts(null), {});
  assert.deepEqual(lineageCounts([]), {});
});
