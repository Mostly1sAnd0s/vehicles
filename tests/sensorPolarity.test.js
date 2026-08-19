import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySensorPolarity } from '../src/sensors/polarity.js';

test('normal (or unspecified) polarity passes the value through', () => {
  assert.equal(applySensorPolarity(0.7, 'normal', 2), 0.7);
  assert.equal(applySensorPolarity(0.7, undefined, 2), 0.7);
});

test('inverted sensor outputs refMax - value (active in absence of signal)', () => {
  assert.ok(Math.abs(applySensorPolarity(0.5, 'inverted', 2) - 1.5) < 1e-9);
  // no signal -> fully active
  assert.equal(applySensorPolarity(0, 'inverted', 2), 2);
  // saturated signal -> inactive
  assert.equal(applySensorPolarity(2, 'inverted', 2), 0);
});

test('inverted output never goes negative when value exceeds refMax', () => {
  assert.equal(applySensorPolarity(5, 'inverted', 2), 0);
});

test('refMax defaults to 1 when not provided', () => {
  assert.ok(Math.abs(applySensorPolarity(0.25, 'inverted') - 0.75) < 1e-9);
});
