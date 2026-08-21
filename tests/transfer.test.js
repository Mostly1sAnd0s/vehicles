import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transferOutput, normalizeSpline, isNeuron, NEURON_TYPE, TRANSFER_PRESETS,
} from '../src/simulation/transfer.js';

test('presets are bell / triangle / custom', () => {
  assert.deepEqual(TRANSFER_PRESETS, ['bell', 'triangle', 'custom']);
});

test('isNeuron matches only the neuron type', () => {
  assert.ok(isNeuron('neuron'));
  assert.ok(!isNeuron('gate_and'));
  assert.ok(!isNeuron(undefined));
  assert.equal(NEURON_TYPE, 'neuron');
});

// ---- bell ---------------------------------------------------------------
test('bell peaks (==1) at the threshold and is non-monotonic', () => {
  const p = { shape: 'bell', threshold: 0.5 };
  assert.ok(Math.abs(transferOutput(p, 0.5) - 1) < 1e-9, 'peak exactly 1 at threshold');
  // rises from 0 up to the peak, then falls again -> "seek then turn away"
  const lo = transferOutput(p, 0.2);
  const hi = transferOutput(p, 0.8);
  assert.ok(lo < 1 && hi < 1, 'below peak on both sides');
  assert.ok(transferOutput(p, 0.4) > lo, 'rising before the peak');
  assert.ok(transferOutput(p, 0.6) < 1, 'falling after the peak');
});

test('bell peak follows the threshold', () => {
  const p = { shape: 'bell', threshold: 0.3, sigma: 0.2 };
  assert.ok(Math.abs(transferOutput(p, 0.3) - 1) < 1e-9);
  assert.ok(transferOutput(p, 0.0) < transferOutput(p, 0.3));
  assert.ok(transferOutput(p, 0.6) < transferOutput(p, 0.3));
});

// ---- triangle -----------------------------------------------------------
test('triangle is 0 at the edges, 1 at the threshold, linear each side', () => {
  const p = { shape: 'triangle', threshold: 0.5 };
  assert.ok(Math.abs(transferOutput(p, 0) - 0) < 1e-9);
  assert.ok(Math.abs(transferOutput(p, 0.5) - 1) < 1e-9);
  assert.ok(Math.abs(transferOutput(p, 1) - 0) < 1e-9);
  assert.ok(Math.abs(transferOutput(p, 0.25) - 0.5) < 1e-9, 'linear rise');
  assert.ok(Math.abs(transferOutput(p, 0.75) - 0.5) < 1e-9, 'linear fall');
});

test('triangle degenerates to a ramp at the edges', () => {
  assert.ok(Math.abs(transferOutput({ shape: 'triangle', threshold: 1 }, 0.4) - 0.4) < 1e-9);
  assert.ok(Math.abs(transferOutput({ shape: 'triangle', threshold: 0 }, 0.4) - 0.6) < 1e-9);
});

// ---- custom spline ------------------------------------------------------
test('custom defaults to identity (neutral passthrough)', () => {
  const p = { shape: 'custom' }; // no spline yet
  for (const x of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(transferOutput(p, x) - x) < 1e-9, `identity at ${x}`);
  }
});

test('custom interpolates through user nodes and can be non-monotonic', () => {
  // rise to a peak at x=0.5 (y=1), fall to 0 at x=1 -> drawn "instinct"
  const p = { shape: 'custom', spline: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0 }] };
  assert.ok(Math.abs(transferOutput(p, 0) - 0) < 1e-9);
  assert.ok(Math.abs(transferOutput(p, 0.5) - 1) < 1e-9);
  assert.ok(Math.abs(transferOutput(p, 1) - 0) < 1e-9);
  assert.ok(Math.abs(transferOutput(p, 0.25) - 0.5) < 1e-9, 'midpoint of the rise');
  // multiple maxima are representable
  const w = { shape: 'custom', spline: [
    { x: 0, y: 0 }, { x: 0.25, y: 1 }, { x: 0.5, y: 0 }, { x: 0.75, y: 1 }, { x: 1, y: 0 }] };
  assert.ok(Math.abs(transferOutput(w, 0.25) - 1) < 1e-9);
  assert.ok(Math.abs(transferOutput(w, 0.5) - 0) < 1e-9);
  assert.ok(Math.abs(transferOutput(w, 0.75) - 1) < 1e-9);
});

test('normalizeSpline sorts, clamps, and falls back to identity', () => {
  const s = normalizeSpline([{ x: 1, y: 2 }, { x: 0, y: -1 }, { x: 0.5, y: 0.5 }]);
  assert.deepEqual(s.map(p => p.x), [0, 0.5, 1], 'sorted by x');
  assert.equal(s[0].y, 0, 'low value clamped up to 0 (was -1)');
  assert.equal(s[2].y, 1, 'high value clamped down to 1 (was 2)');
  assert.deepEqual(normalizeSpline([]), [{ x: 0, y: 0 }, { x: 1, y: 1 }], 'empty -> identity');
  assert.deepEqual(normalizeSpline([null]), [{ x: 0, y: 0 }, { x: 1, y: 1 }], 'junk -> identity');
});

// ---- gain + clamping ----------------------------------------------------
test('gain scales the response and is clamped to [0,1]', () => {
  // bell at the peak is 1; doubling it must clamp back to 1 (never exceed [0,1])
  assert.ok(Math.abs(transferOutput({ shape: 'bell', threshold: 0.5 }, 0.5) - 1) < 1e-9);
  assert.ok(Math.abs(transferOutput({ shape: 'bell', threshold: 0.5, gain: 2 }, 0.5) - 1) < 1e-9, 'clamped at 1');
  // below the peak the gain scales proportionally (until clamping kicks in)
  const base = transferOutput({ shape: 'bell', threshold: 0.5 }, 0.2);
  assert.ok(Math.abs(transferOutput({ shape: 'bell', threshold: 0.5, gain: 0.5 }, 0.2) - base * 0.5) < 1e-9, 'scaled down');
});

test('inputs outside [0,1] are handled and output stays in [0,1]', () => {
  const p = { shape: 'bell', threshold: 0.5 };
  for (const x of [-3, 0, 0.5, 1, 4]) {
    const v = transferOutput(p, x);
    assert.ok(v >= 0 && v <= 1, `in range for input ${x}`);
  }
  // unknown shape falls back to bell (never throws)
  assert.ok(typeof transferOutput({ shape: 'nope' }, 0.5) === 'number');
});
