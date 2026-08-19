import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeActuation, applyMotorPower, wheelFrictionAir } from '../src/actuators.js';

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

test('powerCurve sqrt boosts low signals (extra torque at low sensor values)', () => {
  const cfg = { maxForce: 1.0, powerCurve: 'sqrt' };
  assert.ok(Math.abs(computeActuation(0.25, { polarity: 'excitatory', weight: 1 }, cfg) - 0.5) < 1e-9);
  assert.ok(Math.abs(computeActuation(0.01, { polarity: 'excitatory', weight: 1 }, cfg) - 0.1) < 1e-9);
  // full-scale unchanged
  assert.ok(Math.abs(computeActuation(1.0, { polarity: 'excitatory', weight: 1 }, cfg) - 1.0) < 1e-9);
  assert.equal(computeActuation(0, { polarity: 'excitatory', weight: 1 }, cfg), 0);
});

test('powerCurve sqrt still clamps at maxForce', () => {
  const cfg = { maxForce: 1.0, powerCurve: 'sqrt' };
  // sqrt(1)=1 x weight 2 = 2 -> clamped to 1
  assert.equal(computeActuation(1.0, [{ polarity: 'excitatory', weight: 2 }], cfg), 1.0);
});

test('powerCurve default is linear (existing behavior unchanged)', () => {
  const cfg = { maxForce: 2.0 };
  assert.ok(Math.abs(computeActuation(0.5, { polarity: 'excitatory', weight: 1 }, cfg) - 0.5) < 1e-9);
});

import { actuatorPolaritySign } from '../src/actuators.js';

test('actuatorPolaritySign defaults to +1 (forward) when unspecified', () => {
  assert.equal(actuatorPolaritySign(undefined, {}), 1);
  assert.equal(actuatorPolaritySign(undefined, undefined), 1);
  assert.equal(actuatorPolaritySign('forward', {}), 1);
});

test('actuatorPolaritySign maps reverse to -1', () => {
  assert.equal(actuatorPolaritySign('reverse', {}), -1);
});

test('actuatorPolaritySign falls back to config defaultPolarity', () => {
  assert.equal(actuatorPolaritySign(undefined, { defaultPolarity: 'reverse' }), -1);
  assert.equal(actuatorPolaritySign('forward', { defaultPolarity: 'reverse' }), 1); // explicit wins
});

test('actuatorPolaritySign treats unknown values as default (defensive)', () => {
  assert.equal(actuatorPolaritySign('sideways', {}), 1);
  assert.equal(actuatorPolaritySign('REVERSE', {}), 1); // case-sensitive; only exact 'reverse' flips
});

// --- per-wheel motor power & wheel friction (top-down drag) ----------------

test('applyMotorPower scales force linearly; defaults to neutral 1 when unset', () => {
  assert.equal(applyMotorPower(0.5, 2), 1);
  assert.ok(Math.abs(applyMotorPower(0.5, 0.4) - 0.2) < 1e-9);
  assert.equal(applyMotorPower(-0.5, 2), -1); // sign preserved
  assert.equal(applyMotorPower(0.5, undefined), 0.5); // no prop -> neutral
  assert.equal(applyMotorPower(0.5, null), 0.5);
});

test('wheelFrictionAir maps friction 0..1 to drag (ice -> grippy), clamped + defaulted', () => {
  // friction 0 -> base (near-ice), friction 1 -> base + scale (heavy drag)
  assert.ok(wheelFrictionAir(0, {}) > 0);
  assert.ok(wheelFrictionAir(1, {}) > wheelFrictionAir(0.5, {}));
  assert.ok(wheelFrictionAir(0.5, {}) > wheelFrictionAir(0, {})); // monotonic increasing
  // clamped to [0,1]
  assert.equal(wheelFrictionAir(-3, {}), wheelFrictionAir(0, {}));
  assert.equal(wheelFrictionAir(5, {}), wheelFrictionAir(1, {}));
  // falls back to config default when no value given
  assert.equal(wheelFrictionAir(undefined, { defaultFriction: 0.25 }), wheelFrictionAir(0.25, { defaultFriction: 0.25 }));
});
