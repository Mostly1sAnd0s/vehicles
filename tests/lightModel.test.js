import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightEffectiveRange, normalizeLightLevel } from '../src/sensors/light.js';

const cfg = { range: 900, detectionThreshold: 0.25, fullScaleRatio: 16, falloffPower: 2 };

// ---------- lightEffectiveRange ----------

test('effective range of a single source is sqrt(I/threshold) for square falloff', () => {
  const r = lightEffectiveRange([{ x: 100, y: 0, intensity: 6000 }], cfg);
  assert.ok(Math.abs(r - Math.sqrt(6000 / 0.25)) < 1e-6); // ~154.9
});

test('effective range is capped at the configured range', () => {
  const r = lightEffectiveRange([{ x: 100, y: 0, intensity: 1e8 }], cfg);
  assert.equal(r, 900);
});

test('a source farther than the sensor range contributes nothing', () => {
  // effective range is only considered for sources the sensor can currently see (<= range)
  const r = lightEffectiveRange([{ x: 5000, y: 0, intensity: 6000 }], cfg);
  assert.equal(r, 0);
});

test('multiple sources -> largest detectable radius wins', () => {
  const r = lightEffectiveRange(
    [
      { x: 100, y: 0, intensity: 800 }, // ~56.6
      { x: -100, y: 0, intensity: 6000 }, // ~154.9
    ],
    cfg
  );
  assert.ok(Math.abs(r - Math.sqrt(6000 / 0.25)) < 1e-6);
});

test('no sources -> 0', () => {
  assert.equal(lightEffectiveRange([], cfg), 0);
});

test('respects falloffPower (p=1 linear -> range = I/threshold)', () => {
  const r = lightEffectiveRange([{ x: 100, y: 0, intensity: 100 }], { ...cfg, falloffPower: 1 });
  assert.ok(Math.abs(r - 100 / 0.25) < 1e-6); // 400
});

// ---------- normalizeLightLevel ----------

test('level at or below the detection threshold -> 0', () => {
  assert.equal(normalizeLightLevel(0.25, cfg), 0);
  assert.equal(normalizeLightLevel(0, cfg), 0);
});

test('level at full scale (T * K) -> 1', () => {
  const full = 0.25 * 16; // 4.0
  assert.ok(Math.abs(normalizeLightLevel(full, cfg) - 1) < 1e-9);
});

test('level above full scale clamps to 1', () => {
  assert.equal(normalizeLightLevel(10, cfg), 1);
});

test('mid-band level is linear between threshold and full scale', () => {
  // raw = 2.0 -> (2.0 - 0.25) / (4.0 - 0.25) = 1.75/3.75
  const n = normalizeLightLevel(2.0, cfg);
  assert.ok(Math.abs(n - 1.75 / 3.75) < 1e-9);
});

test('defaults are safe when threshold/ratio missing (falls back to plain clamp)', () => {
  // no threshold -> treat full scale as 1, so n = clamp(raw,0,1)
  assert.ok(Math.abs(normalizeLightLevel(0.5, { falloffPower: 2 }) - 0.5) < 1e-9);
  assert.equal(normalizeLightLevel(3, { falloffPower: 2 }), 1);
});

// --- FOV gating in effective range ---
const o = { detectionThreshold: 0.25, falloffPower: 2, range: 500 };
test('effective range only counts sources inside the FOV cone', () => {
  // sensor origin, aim +x, fov 90deg. Source A on aim (det ~ sqrt(6000/0.25)=154),
  // source B directly off-axis (angle 90deg) with huge intensity -> excluded.
  const inCone = lightEffectiveRange([{ x: 200, y: 0, intensity: 6000 }], o, { x: 0, y: 0 }, { aim: 0, fov: Math.PI / 2 });
  const both = lightEffectiveRange(
    [{ x: 200, y: 0, intensity: 6000 }, { x: 0, y: 50, intensity: 1e6 }],
    o, { x: 0, y: 0 }, { aim: 0, fov: Math.PI / 2 }
  );
  assert.ok(Math.abs(inCone - Math.sqrt(6000 / 0.25)) < 1e-6);
  // B excluded -> same as in-cone only (B would have extended it to range cap otherwise)
  assert.ok(Math.abs(both - Math.sqrt(6000 / 0.25)) < 1e-6);
});
test('no fov -> omnidirectional effective range (unchanged)', () => {
  const v = lightEffectiveRange([{ x: 0, y: 50, intensity: 6000 }], o, { x: 0, y: 0 });
  assert.ok(Math.abs(v - Math.sqrt(6000 / 0.25)) < 1e-6);
});
