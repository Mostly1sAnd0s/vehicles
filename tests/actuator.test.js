import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeActuation } from '../src/actuators.js';

const cfg = { maxForce: 1.0 };

test('excitatory: value * weight', () => {
  const f = computeActuation(0.8, { polarity: 'excitatory', weight: 0.5 }, cfg);
  assert.ok(Math.abs(f - 0.4) < 1e-9);
});

test('inhibitory flips sign', () => {
  const f = computeActuation(0.8, { polarity: 'inhibitory', weight: 0.5 }, cfg);
  assert.ok(Math.abs(f + 0.4) < 1e-9);
});

test('output clamped to maxForce', () => {
  assert.equal(computeActuation(5, { polarity: 'excitatory', weight: 1 }, cfg), 1.0);
  assert.equal(computeActuation(5, { polarity: 'inhibitory', weight: 1 }, cfg), -1.0);
});

test('zero weight or zero sensor value gives zero force', () => {
  assert.equal(computeActuation(1, { polarity: 'excitatory', weight: 0 }, cfg), 0);
  assert.equal(computeActuation(0, { polarity: 'excitatory', weight: 1 }, cfg), 0);
});

test('multiple incoming wires are summed before clamping', () => {
  // wires: +0.5 and inhibitory -0.5 from same sensor value -> net 0
  const total = computeActuation(
    1.0,
    [
      { polarity: 'excitatory', weight: 0.5 },
      { polarity: 'inhibitory', weight: 0.5 },
    ],
    cfg
  );
  assert.ok(Math.abs(total) < 1e-9);
  // two excitatory wires sum and then clamp
  const clamped = computeActuation(1.0, [
    { polarity: 'excitatory', weight: 1 },
    { polarity: 'excitatory', weight: 1 },
  ], cfg);
  assert.equal(clamped, 1.0);
});
