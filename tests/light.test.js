import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleLight } from '../src/sensors/light.js';

const cfg = { range: 300, minDistance: 5, falloffPower: 2 };

test('single source at distance 1 with intensity 1 and no min clamp gives value 1', () => {
  const v = sampleLight({ x: 0, y: 0 }, [{ x: 1, y: 0, intensity: 1 }], { range: 300, minDistance: 0 });
  assert.ok(Math.abs(v - 1) < 1e-9);
});

test('inverse-square falloff: value at 2x distance is 1/4', () => {
  const near = sampleLight({ x: 0, y: 0 }, [{ x: 10, y: 0, intensity: 1 }], cfg);
  const far = sampleLight({ x: 0, y: 0 }, [{ x: 20, y: 0, intensity: 1 }], cfg);
  assert.ok(Math.abs(near / far - 4) < 1e-9);
});

test('source beyond range contributes nothing', () => {
  const v = sampleLight({ x: 0, y: 0 }, [{ x: 500, y: 0, intensity: 1 }], cfg);
  assert.equal(v, 0);
});

test('multiple sources are summed', () => {
  const one = sampleLight({ x: 0, y: 0 }, [{ x: 10, y: 0, intensity: 1 }], cfg);
  const two = sampleLight(
    { x: 0, y: 0 },
    [
      { x: 10, y: 0, intensity: 1 },
      { x: 0, y: 10, intensity: 1 },
    ],
    cfg
  );
  assert.ok(Math.abs(two - 2 * one) < 1e-9);
});

test('minDistance clamps the falloff denominator', () => {
  // source at distance 1 < minDistance 5 -> value = intensity / 5^2
  const v = sampleLight({ x: 0, y: 0 }, [{ x: 1, y: 0, intensity: 1 }], cfg);
  assert.ok(Math.abs(v - 1 / 25) < 1e-9);
});

test('no sources gives 0', () => {
  assert.equal(sampleLight({ x: 0, y: 0 }, [], cfg), 0);
});

test('saturation caps the output when configured', () => {
  const v = sampleLight(
    { x: 0, y: 0 },
    [{ x: 6, y: 0, intensity: 10 }], // raw = 10/36 ~ 0.28? no: dist 6 -> 10/36
    { ...cfg, saturation: 1.0 }
  );
  const strong = sampleLight(
    { x: 0, y: 0 },
    [{ x: 6, y: 0, intensity: 1e5 }],
    { ...cfg, saturation: 1.0 }
  );
  assert.ok(v <= 1.0 + 1e-9);
  assert.equal(strong, 1.0);
});
