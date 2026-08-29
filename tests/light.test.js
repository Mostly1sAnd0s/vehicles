import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleLight, lightLevelNormalized } from '../src/sensors/light.js';

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

// --- field of view (cone gating) ---
// sensor at origin, aim = 0 (points +x)
test('no fov -> omnidirectional (all sources counted)', () => {
  const v = sampleLight({ x: 0, y: 0 }, [{ x: 0, y: 10, intensity: 1 }], { range: 100, minDistance: 0 });
  assert.ok(v > 0); // source directly "behind" aim still counted when no fov
});
test('source within the FOV cone is counted', () => {
  const v = sampleLight(
    { x: 0, y: 0 }, [{ x: 10, y: 0, intensity: 1 }], // angle 0, on aim
    { range: 100, minDistance: 0 }, { aim: 0, fov: Math.PI / 2 }
  );
  assert.ok(v > 0);
});
test('source outside the FOV cone is excluded', () => {
  // source at angle 90deg from aim, fov 90deg (half 45deg) -> excluded
  const v = sampleLight(
    { x: 0, y: 0 }, [{ x: 0, y: 10, intensity: 1 }],
    { range: 100, minDistance: 0 }, { aim: 0, fov: Math.PI / 2 }
  );
  assert.equal(v, 0);
});
test('source inside a wide cone (180deg) but not in a narrow one is gated by half-angle', () => {
  const s = { x: 5, y: 8.66, intensity: 1 }; // ~60deg from +x
  const wide = sampleLight({ x: 0, y: 0 }, [s], { range: 100, minDistance: 0 }, { aim: 0, fov: Math.PI });
  const narrow = sampleLight({ x: 0, y: 0 }, [s], { range: 100, minDistance: 0 }, { aim: 0, fov: Math.PI / 2 });
  assert.ok(wide > 0);
  assert.equal(narrow, 0);
});
test('FOV is centered on the sensor aim angle', () => {
  // aim = +y (pi/2): source along +y counted, source along +x excluded
  const sAim = sampleLight({ x: 0, y: 0 }, [{ x: 0, y: 10, intensity: 1 }], { range: 100, minDistance: 0 }, { aim: Math.PI / 2, fov: Math.PI / 2 });
  const sOff = sampleLight({ x: 0, y: 0 }, [{ x: 10, y: 0, intensity: 1 }], { range: 100, minDistance: 0 }, { aim: Math.PI / 2, fov: Math.PI / 2 });
  assert.ok(sAim > 0);
  assert.equal(sOff, 0);
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

// (The old normalizeLightLevel band tests were removed with the function: the live pipeline
//  uses lightLevelNormalized — linear in DISTANCE — covered exhaustively below.)

// ---------------------------------------------------------------------------
// lightLevelNormalized: linear-in-DISTANCE mapping (the fix for "only moves
// when touching" + "exponential"). For a source of intensity I, falloff p,
// threshold T and full-scale F = T*K, the level sweeps 0->1 as the source
// approaches, linearly in distance, between the full-scale radius
// D_F = (I/F)^(1/p) and the threshold radius D_T = min(range,(I/T)^(1/p)).
// This is what makes a dim (intensity 800) source respond from a real distance
// and climb smoothly instead of in a cliff near the source.
// ---------------------------------------------------------------------------

test('lightLevelNormalized: linear in distance, 0 at threshold radius, 1 at full-scale radius', () => {
  const cfg = { range: 1000, minDistance: 0, falloffPower: 2, detectionThreshold: 0.1, fullScaleRatio: 100 };
  // I=1000, T=0.1, K=100 -> F=10. D_T=sqrt(1000/0.1)=100, D_F=sqrt(1000/10)=10.
  const src = [{ x: 55, y: 0, intensity: 1000 }];
  const at = d => lightLevelNormalized({ x: 0, y: 0 }, [{ x: d, y: 0, intensity: 1000 }], cfg).level;
  assert.ok(at(100) < 1e-9);        // at threshold radius -> 0
  assert.ok(Math.abs(at(10) - 1) < 1e-9); // at full-scale radius -> 1
  assert.ok(Math.abs(at(55) - 0.5) < 1e-9); // midpoint in distance -> exactly 0.5 (linear, not level-linear)
  assert.ok(at(20) > at(40) && at(40) > at(60)); // monotonic: closer = higher
  assert.ok(Math.abs(at(5) - 1) < 1e-9);        // inside full-scale radius clamps to 1
  assert.equal(at(120), 0);          // beyond threshold radius -> 0
  assert.ok(src.every(s => s.intensity === 1000));
});

test('lightLevelNormalized: reports distance to the source it reads', () => {
  const cfg = { range: 1000, minDistance: 0, falloffPower: 2, detectionThreshold: 0.1, fullScaleRatio: 100 };
  const r = lightLevelNormalized({ x: 0, y: 0 }, [{ x: 55, y: 0, intensity: 1000 }], cfg);
  assert.ok(Math.abs(r.distance - 55) < 1e-6);
  // nothing detectable (source beyond threshold radius) -> distance null
  const none = lightLevelNormalized({ x: 0, y: 0 }, [{ x: 500, y: 0, intensity: 10 }], cfg);
  assert.equal(none.level, 0);
  assert.equal(none.distance, null);
});

test('lightLevelNormalized: respects the per-sensor range as a hard cap', () => {
  const cfg = { range: 50, minDistance: 0, falloffPower: 2, detectionThreshold: 0.1, fullScaleRatio: 100 };
  // D_T would be 100 but range caps the band edge to 50; D_F=10.
  const near = lightLevelNormalized({ x: 0, y: 0 }, [{ x: 40, y: 0, intensity: 1000 }], cfg);
  assert.ok(Math.abs(near.level - (50 - 40) / (50 - 10)) < 1e-9); // 0.25
  const beyond = lightLevelNormalized({ x: 0, y: 0 }, [{ x: 60, y: 0, intensity: 1000 }], cfg);
  assert.equal(beyond.level, 0); // d > range -> not sensed at all
  assert.equal(beyond.distance, null);
});

test('lightLevelNormalized: max over sources; brighter-farther can dominate a dim-near one', () => {
  const cfg = { range: 1000, minDistance: 0, falloffPower: 2, detectionThreshold: 0.1, fullScaleRatio: 100 };
  const sources = [{ x: 20, y: 0, intensity: 100 }, { x: 60, y: 0, intensity: 10000 }];
  const r = lightLevelNormalized({ x: 0, y: 0 }, sources, cfg);
  // B (bright, farther): D_T=316.2,D_F=31.6 -> n=(316.2-60)/(316.2-31.6)=0.900
  assert.ok(Math.abs(r.level - 0.9003) < 0.01);
  assert.ok(Math.abs(r.distance - 60) < 1e-6); // distance is to the dominating source
});

test('lightLevelNormalized: a dim intensity-800 source is live well before "touching"', () => {
  // Mirrors the user's test: I=800, threshold lowered to 0.02 (new default).
  const cfg = { range: 900, minDistance: 0, falloffPower: 2, detectionThreshold: 0.02, fullScaleRatio: 16 };
  // D_T=sqrt(800/0.02)=200, D_F=sqrt(800/0.32)=50. At d=121 (the old "touching" point):
  const at = d => lightLevelNormalized({ x: 0, y: 0 }, [{ x: d, y: 0, intensity: 800 }], cfg).level;
  assert.ok(at(121) > 0.4);        // clearly responding at the distance it used to read ~0
  assert.ok(at(199) > 0 && at(199) < 1); // just inside the (capped) sensing radius
  assert.equal(at(250), 0);         // out of the ~200px sensing radius -> dark
  assert.ok(at(60) > at(121) && at(121) > at(180)); // monotonic approach
});
