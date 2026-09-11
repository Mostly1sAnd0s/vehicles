/**
 * The heat model's physics contract (docs/heat-plan.md §A.1).
 *
 * These tests are the difference between "a sensor tuned with a magic formula" and "a
 * thermal model": each one asserts a consequence of a NAMED law (Stefan–Boltzmann,
 * inverse-square, Beer–Lambert, lumped capacitance / Newton cooling) against its closed
 * form, so the numbers cannot silently drift if someone retunes a constant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  heatConfig,
  radiantPower,
  radiantFlux,
  heatField,
  linearizedConductance,
  stepSensorTemperature,
  heatOutput,
  heatEffectiveRange,
  toKelvin,
  KELVIN,
} from '../src/sensors/heat.js';

// A config with an unbounded range so geometry, not clipping, decides the answers.
const cfg = () => heatConfig({ range: Infinity });
const source = (x, y, temperatureC) => ({ x, y, temperatureC });

/**
 * The equilibrium written out again from the physics, independently of the module:
 *     T_eq = (Σ Ĝ_i·T_s,i + T_a) / (Σ Ĝ_i + 1),  Ĝ_i = coupling·lin_i·(d0/d)²
 *     lin  = (T_s² + T_a²)(T_s + T_a) / (4·T_a³)            [kelvin]
 * Duplicating it here is deliberate: if the module's formula drifts, this fails.
 */
const eqClosedForm = (temperatureC, distance, c) => {
  const ts = toKelvin(temperatureC);
  const ta = toKelvin(c.ambientTemp);
  const lin = ((ts * ts + ta * ta) * (ts + ta)) / (4 * ta * ta * ta);
  const g = c.coupling * lin * (c.referenceDistance / Math.max(distance, c.minDistance)) ** 2;
  return (g * temperatureC + c.ambientTemp) / (g + 1);
};

// ---- the temperature scale ------------------------------------------------

test('emission uses KELVIN, not Celsius: 0 °C is not "off"', () => {
  const c = cfg();
  // 0 °C is 273.15 K — below a 20 °C room it is a net SINK, and it is not zero.
  assert.ok(radiantPower(0, c) < 0, 'a freezing body must still participate thermally');
  // Anything at exactly ambient exchanges nothing net: that is what "ambient" MEANS.
  assert.equal(radiantPower(20, c), 0);
  assert.equal(toKelvin(0), KELVIN);
});

test('a source colder than its environment is a net radiative sink', () => {
  const c = cfg();
  assert.ok(radiantPower(5, c) < 0);
  // ...and it cools a sensor below room temperature, which no light sensor can do.
  const field = heatField({ x: 0, y: 0 }, [source(100, 0, 5)], c);
  let s = stepSensorTemperature({ temperatureC: 20 }, field, 16.67, c);
  s = stepSensorTemperature(s, field, 4000, c);
  assert.ok(s.temperatureC < 20, 'a cold trap must read cold, not clamp to zero-and-forget');
  assert.ok(s.temperatureC > 5, 'and it must not fall BELOW the sink: a passive probe cannot ');
});

// ---- the bound (the bug this file exists to keep fixed) -------------------

test('THE BOUND: a probe can never read hotter than the hottest thing it sees', () => {
  // Regression: the first model wrote the equilibrium as `ambient + coupling·flux`, and flux
  // diverges as the probe closes on a source (1/r²), so a robot driving over a 220 °C furnace
  // reported ~4800 °C. That is not a tuning problem — flux is not heat, and a probe radiates
  // back. The equilibrium is a conductance-weighted MEAN, so this cannot happen at any
  // distance, for any coupling, or for any number of sources.
  const c = cfg();
  for (const temperature of [40, 60, 220, 800, 3000]) {
    for (const distance of [0.01, 1, 5, 12, 30, 100, 400, 5000]) {
      const field = heatField({ x: 0, y: 0 }, [source(distance, 0, temperature)], c);
      assert.ok(field.equilibriumC < temperature, `T=${temperature} d=${distance} read ${field.equilibriumC}`);
      assert.ok(field.equilibriumC > c.ambientTemp, 'and still above ambient, i.e. still a signal');
    }
  }
});

test('the bound holds when the probe sits ON a hot source with a huge coupling', () => {
  // Sensitivity is a user-facing slider; it must not be able to reach impossible numbers.
  const c = heatConfig({ range: Infinity, coupling: 1000 });
  const field = heatField({ x: 0, y: 0 }, [source(1, 0, 220)], c);
  assert.ok(field.equilibriumC < 220, `coupling 1000 read ${field.equilibriumC} from a 220 °C source`);
  assert.ok(field.equilibriumC > 219, 'it does approach the source temperature, which is correct');
});

test('several sources settle between them — never above the hottest, never below the coldest', () => {
  const c = cfg();
  const sources = [source(-300, 0, 500), source(300, 0, 30), source(0, 250, 5)];
  const field = heatField({ x: 0, y: 0 }, sources, c);
  assert.ok(field.equilibriumC < 500 && field.equilibriumC > 5,
    `expected something between 5 and 500, got ${field.equilibriumC}`);
});

test('stepSensorTemperature refuses a bare flux number instead of guessing a bound', () => {
  // The old signature took a flux and derived °C from it — the exact shape of the bug. A
  // silent fallback here would reintroduce it, so it is a hard error at the seam.
  const c = cfg();
  assert.throws(() => stepSensorTemperature({ temperatureC: 20 }, 1.5, 16.67, c), TypeError);
  assert.throws(() => stepSensorTemperature({ temperatureC: 20 }, { flux: 1.5 }, 16.67, c), TypeError);
});

test('Stefan–Boltzmann: net power is exactly k·((Ts/Ta)^4 − 1)', () => {
  const c = cfg();
  for (const t of [40, 60, 200, 600, 1200]) {
    const expected = Math.pow(toKelvin(t) / toKelvin(c.ambientTemp), 4) - 1;
    assert.ok(Math.abs(radiantPower(t, c) - expected) < 1e-12, `T=${t}`);
  }
});

test('the T^4 law is far steeper than linear "intensity" (this is what makes heat feel different)', () => {
  const c = cfg();
  // Linear would give 300/60 = 5x. Radiative net power gives far more, because it is the
  // FOURTH POWER of the absolute-temperature ratio minus one.
  const ratio = radiantPower(300, c) / radiantPower(60, c);
  assert.ok(ratio > 15, `expected a steep radiative ratio, got ${ratio}`);
  assert.ok(ratio < 100, `and not an absurd one, got ${ratio}`);
});

// ---- propagation ----------------------------------------------------------

test('inverse-square: doubling distance quarters the flux, exactly', () => {
  const c = cfg();
  const src = [source(0, 0, 200)];
  const e1 = radiantFlux({ x: 100, y: 0 }, src, c);
  assert.ok(Math.abs(radiantFlux({ x: 200, y: 0 }, src, c) - e1 / 4) < 1e-15);
  assert.ok(Math.abs(radiantFlux({ x: 400, y: 0 }, src, c) - e1 / 16) < 1e-17);
});

test('at the calibration radius the irradiance IS the source power', () => {
  const c = cfg();
  const src = [source(0, 0, 200)];
  const e = radiantFlux({ x: c.referenceDistance, y: 0 }, src, c);
  assert.ok(Math.abs(e - radiantPower(200, c)) < 1e-15, 'netPower means "irradiance at referenceDistance"');
});

test('air absorbs infrared (Beer–Lambert), and the reach shrinks accordingly', () => {
  const c = cfg();
  const src = [source(0, 0, 200)];
  const clear = radiantFlux({ x: 100, y: 0 }, src, c);
  const absorbed = radiantFlux({ x: 100, y: 0 }, src, { ...c, attenuationLength: 100 });
  assert.ok(Math.abs(absorbed - clear * Math.exp(-1)) < 1e-15);
  const rClear = heatEffectiveRange(src, { ...c, thresholdC: 4 }, { x: 0, y: 0 });
  const rAir = heatEffectiveRange(src, { ...c, thresholdC: 4, attenuationLength: 150 }, { x: 0, y: 0 });
  assert.ok(rAir > 0 && rAir < rClear, 'the same threshold is reached closer through absorbing air');
});

test('a range cap is a hard cutoff', () => {
  const c = heatConfig({ range: 150 });
  assert.equal(radiantFlux({ x: 0, y: 0 }, [source(200, 0, 400)], c), 0);
  assert.ok(radiantFlux({ x: 0, y: 0 }, [source(149, 0, 400)], c) > 0);
});

test('the field of view gates heat exactly as it gates light (same inFov)', () => {
  const c = cfg();
  const behind = [source(-100, 0, 400)];
  assert.equal(radiantFlux({ x: 0, y: 0 }, behind, c, { aim: 0, fov: 1 }), 0);
  assert.ok(radiantFlux({ x: 0, y: 0 }, behind, c, { aim: Math.PI, fov: 1 }) > 0);
  // No fov = omnidirectional, like the light sensor's default.
  assert.ok(radiantFlux({ x: 0, y: 0 }, behind, c, { aim: 0 }) > 0);
});

test('two sources superpose into one irradiance (two fires, one hotter equilibrium)', () => {
  const c = cfg();
  const a = source(0, 0, 200);
  const b = source(0, 500, 300);
  const p = { x: 100, y: 0 };
  const both = radiantFlux(p, [a, b], c);
  assert.ok(Math.abs(both - (radiantFlux(p, [a], c) + radiantFlux(p, [b], c))) < 1e-15);
});

test('an obstacle casts a thermal shadow only when occlusion is switched on', () => {
  const c = cfg();
  const src = [source(300, 0, 400)];
  const wall = [{ type: 'rect', x: 150, y: 0, rotation: 0, width: 20, height: 400 }];
  assert.ok(radiantFlux({ x: 0, y: 0 }, src, c) > 0, 'off by default: matches the light sensor');
  assert.equal(radiantFlux({ x: 0, y: 0 }, src, { ...c, occluded: true }, { obstacles: wall }), 0);
  // The wall must be BETWEEN them to matter — otherwise this test would pass for the wrong reason.
  assert.ok(radiantFlux({ x: 0, y: 0 }, src, { ...c, occluded: true }, { obstacles: [{ ...wall, x: -150 }] }) > 0);
});

// ---- the sensor's thermal mass -------------------------------------------

test('equilibrium is the conductance-weighted mean of source and ambient (steady state)', () => {
  const c = cfg();
  const field = heatField({ x: 100, y: 0 }, [source(0, 0, 200)], c);
  const teq = eqClosedForm(200, 100, c);
  let s = { temperatureC: c.ambientTemp };
  for (let i = 0; i < 5000; i++) s = stepSensorTemperature(s, field, 16.67, c);
  assert.ok(Math.abs(s.temperatureC - teq) < 1e-8, `${s.temperatureC} vs ${teq}`);
  assert.ok(Math.abs(s.equilibriumC - teq) < 1e-12, 'the analytic equilibrium is reported alongside');
  assert.ok(teq < 200 && teq > c.ambientTemp, 'which sits between the fire and the room');
});

test('the linearised conductance is 1 at ambient, 0 at absolute zero, and never negative', () => {
  const c = cfg();
  assert.ok(Math.abs(linearizedConductance(c.ambientTemp, c) - 1) < 1e-12, 'a body at ambient is unit conductance');
  assert.equal(linearizedConductance(-273.15, c), 0);
  for (const t of [-200, -50, 0, 20, 100, 2000]) {
    assert.ok(linearizedConductance(t, c) >= 0, `T=${t} — negative conductance would break the bound`);
  }
  assert.ok(linearizedConductance(220, c) > 2, 'a 220 °C body pulls more than twice as hard as an ambient one');
});

test('a source at ambient is invisible in steady state, however close', () => {
  const c = cfg();
  for (const d of [1, 20, 100, 500]) {
    const field = heatField({ x: 0, y: 0 }, [source(d, 0, c.ambientTemp)], c);
    assert.ok(Math.abs(field.equilibriumC - c.ambientTemp) < 1e-12, `d=${d} → ${field.equilibriumC}`);
  }
});

test('one time constant covers 63.2 % of the gap — the definition of τ', () => {
  const c = cfg();
  const field = heatField({ x: 100, y: 0 }, [source(0, 0, 200)], c);
  const teq = field.equilibriumC;
  const s = stepSensorTemperature({ temperatureC: c.ambientTemp }, field, c.timeConstantMs, c);
  const fraction = (s.temperatureC - c.ambientTemp) / (teq - c.ambientTemp);
  assert.ok(Math.abs(fraction - (1 - Math.exp(-1))) < 1e-12, `got ${fraction}`);
});

test('integration is subdivision-consistent: 100 tiny steps land exactly where one big step does', () => {
  const c = cfg();
  const field = heatField({ x: 100, y: 0 }, [source(0, 0, 200)], c);
  // The signature of EXACT exponential integration (the semi-group property), and the reason a
  // heat reading does not depend on frame rate or the Time slider. A naive Euler step
  // (T += (T_eq−T)·dt/τ) does NOT have it: one dt=τ step gives 63.2 %, two dt=τ/2 steps give
  // 75 %, so 30 fps and 60 fps would disagree about how hot the world is.
  const one = stepSensorTemperature({ temperatureC: 20 }, field, c.timeConstantMs, c).temperatureC;
  let many = { temperatureC: 20 };
  for (let i = 0; i < 100; i++) many = stepSensorTemperature(many, field, c.timeConstantMs / 100, c);
  assert.ok(Math.abs(one - many.temperatureC) < 1e-9, `${one} vs ${many.temperatureC}`);
  // And the naive form really would disagree — the assertion is only meaningful if the contrast holds.
  const teq = field.equilibriumC;
  const eulerOne = 20 + (teq - 20) * 1; // dt/τ = 1 → Euler jumps straight to T_eq
  assert.ok(Math.abs(eulerOne - one) > 1e-3, 'if these ever match, the integrator has stopped being exact');
});

test('EXACT at dt > τ: the Time slider cannot make the sensor oscillate or overshoot', () => {
  const c = cfg();
  const field = heatField({ x: 100, y: 0 }, [source(0, 0, 200)], c);
  const teq = field.equilibriumC;
  let s = { temperatureC: c.ambientTemp };
  for (let i = 0; i < 200; i++) s = stepSensorTemperature(s, field, 1000, c); // dt = 2.5τ
  assert.ok(s.temperatureC >= c.ambientTemp - 1e-12, 'never undershoots ambient');
  assert.ok(s.temperatureC <= teq + 1e-12, 'never overshoots equilibrium');
  // A naive Euler step (T += (T_eq-T)·dt/τ) with dt=2.5τ flies to −1500 % instead.
});

test('ring-down: sources removed decays back to ambient from above, and stays there', () => {
  const c = cfg();
  const clear = heatField({ x: 0, y: 0 }, [], c); // no sources: equilibrium IS the room
  let s = { temperatureC: 80 };
  for (let i = 0; i < 2000; i++) s = stepSensorTemperature(s, clear, 16.67, c); // 33 s ≫ τ
  assert.ok(Math.abs(s.temperatureC - c.ambientTemp) < 1e-6, s.temperatureC);
  assert.ok(s.temperatureC >= c.ambientTemp, 'passive cooling cannot go below ambient with no sink');
});

test('τ = 0 degrades the model to an instantaneous radiative probe', () => {
  const c = heatConfig({ timeConstantMs: 0, range: Infinity });
  const field = heatField({ x: 100, y: 0 }, [source(0, 0, 200)], c);
  const s = stepSensorTemperature({ temperatureC: -500 }, field, 16.67, c);
  assert.ok(Math.abs(s.temperatureC - eqClosedForm(200, 100, c)) < 1e-12);
  assert.ok(s.temperatureC < 200, 'even a massless probe stays below its source');
});

test('a short exposure accumulates: repeated passes warm a sensor a single pass would not', () => {
  const c = cfg();
  const hot = heatField({ x: 0, y: 0 }, [source(60, 0, 400)], c);
  const clear = heatField({ x: 0, y: 0 }, [], c);
  let cold = { temperatureC: c.ambientTemp };
  for (let i = 0; i < 6; i++) {
    cold = stepSensorTemperature(cold, hot, 20, c);    // brief exposure
    cold = stepSensorTemperature(cold, clear, 60, c);  // cool between passes
  }
  assert.ok(cold.temperatureC > c.ambientTemp, 'residual heat must survive between passes');
});

// ---- output mapping -------------------------------------------------------

test('output: ambient reads 0, a span above ambient reads 1, and it is clamped inside [0,1]', () => {
  const c = cfg();
  assert.equal(heatOutput(c.ambientTemp, c), 0);
  assert.equal(heatOutput(c.ambientTemp + c.outputSpanC, c), 1);
  assert.equal(heatOutput(9009, c), 1);
  assert.equal(heatOutput(-200, c), 0);
  // Linear in degrees between the two — a thermometer, not a logarithm.
  assert.ok(Math.abs(heatOutput(c.ambientTemp + c.outputSpanC / 2, c) - 0.5) < 1e-12);
});

// ---- robustness (the same lesson as the solid-light radius) ---------------

test('garbage cannot produce NaN: sensors feed motors, and NaN silently freezes a robot', () => {
  const c = cfg();
  const junk = [
    source(1, 0, NaN), source(2, 0, undefined), source(3, 0, 'hot'), source(4, 0, []),
    source(NaN, NaN, 300), null, undefined, { temperatureC: -273.15 }, { temperatureC: -5000 },
    { temperatureC: Infinity },
  ];
  for (const p of [[0, 0], [50, 50]]) {
    const f = radiantFlux({ x: p[0], y: p[1] }, junk, c);
    assert.ok(Number.isFinite(f), `flux ${f}`);
  }
  // A field built from the same junk: the equilibrium must stay finite AND inside the range
  // the junk spans, because a NaN reaching a motor freezes the robot silently.
  const junkField = heatField({ x: 0, y: 0 }, junk, c);
  assert.ok(Number.isFinite(junkField.equilibriumC), `equilibrium ${junkField.equilibriumC}`);
  assert.ok(junkField.equilibriumC >= -273.15 && junkField.equilibriumC < 3000, `bounded, got ${junkField.equilibriumC}`);
  for (const st of [undefined, {}, { temperatureC: NaN }, { temperatureC: 'x' }, { temperatureC: Infinity }, { warmMs: NaN }]) {
    for (const dt of [NaN, -5, undefined, 16.67, 1e9]) {
      const s = stepSensorTemperature(st, junkField, dt, c);
      assert.ok(Number.isFinite(s.temperatureC), `state ${JSON.stringify(st)} dt ${dt} -> ${s.temperatureC}`);
      assert.ok(Number.isFinite(heatOutput(s.temperatureC, c)));
    }
  }
  // A source whose temperature is Infinity must not produce an Infinity equilibrium: the
  // guard has to sanitise the value used for WEIGHTING, not only the one used for emission.
  const inf = heatField({ x: 0, y: 0 }, [source(50, 0, Infinity), source(-50, 0, 900)], c);
  assert.ok(Number.isFinite(inf.equilibriumC), `Infinity source leaked into the mean: ${inf.equilibriumC}`);
  // Below absolute zero is unphysical: emits nothing rather than a negative-fourth-power number.
  assert.equal(radiantPower(-300, c), 0);
});

test('config fallbacks: an empty or hostile bundle still gives a usable, sane model', () => {
  for (const raw of [undefined, null, {}, { ambientTemp: 'x' }, { coupling: -5 }, { attenuationLength: 0 }, { timeConstantMs: -1 }, { outputSpanC: 0 }, { minDistance: 0 }, { referenceDistance: 0 }]) {
    const c = heatConfig(raw);
    assert.ok(Number.isFinite(c.ambientTemp));
    assert.ok(c.coupling >= 0, 'negative coupling would make heat cold');
    assert.ok(c.timeConstantMs >= 0);
    assert.ok(c.outputSpanC > 0);
    assert.ok(c.minDistance > 0, 'a zero min-distance is a divide-by-zero at the source centre');
    assert.ok(c.referenceDistance > 0);
    assert.ok(c.attenuationLength > 0);
  }
});

test('minDistance floors the singularity: standing at the centre of a source gives a large finite reading', () => {
  const c = cfg();
  const at = radiantFlux({ x: 0, y: 0 }, [source(0, 0, 400)], c);
  assert.ok(Number.isFinite(at) && at > 0);
  const justOutside = radiantFlux({ x: 0.001, y: 0 }, [source(0, 0, 400)], c);
  assert.ok(Math.abs(at - justOutside) < 1e-9, 'clamped, so the reading does not spike between two near-identical positions');
});

// ---- beam drawing ---------------------------------------------------------

test('effective range inverts the closed form when air is transparent', () => {
  const c = cfg();
  const src = [source(0, 0, 200)];
  const reach = heatEffectiveRange(src, { ...c, thresholdC: 4 }, { x: 0, y: 0 });
  // Derived from the BOUNDED equilibrium, not from flux: ΔT = Ĝ(Ts−Ta)/(Ĝ+1) ⟹
  // Ĝ_req = ΔT/((Ts−Ta)−ΔT), and Ĝ = coupling·lin·(d0/r)².
  const required = 4 / ((200 - c.ambientTemp) - 4);
  const expected = c.referenceDistance * Math.sqrt((c.coupling * linearizedConductance(200, c)) / required);
  assert.ok(Math.abs(reach - expected) < 1e-9, `${reach} vs ${expected}`);
  assert.ok(Number.isFinite(reach) && reach > 0);
});

test('a threshold at or above the source\u2019s own rise has NO reach, not an infinite one', () => {
  // Only possible under the old flux-gain model, where any flux could buy any temperature.
  const c = cfg();
  assert.equal(heatEffectiveRange([source(0, 0, 24)], { ...c, thresholdC: 10 }, { x: 0, y: 0 }), 0,
    'a 24 °C source cannot hold a probe 10 °C above a 20 °C room at any distance');
  assert.ok(heatEffectiveRange([source(0, 0, 200)], { ...c, thresholdC: 10 }, { x: 0, y: 0 }) > 0,
    'while a real fire still can');
});

test('effective range: nothing detectable is 0, and a cold sink draws no beam', () => {
  const c = cfg();
  assert.equal(heatEffectiveRange([], { ...c, thresholdC: 4 }, { x: 0, y: 0 }), 0);
  assert.equal(heatEffectiveRange([source(0, 0, 20)], { ...c, thresholdC: 4 }, { x: 0, y: 0 }), 0);
  assert.equal(heatEffectiveRange([source(0, 0, 5)], { ...c, thresholdC: 4 }, { x: 0, y: 0 }), 0);
});

test('effective range respects the range cap and the FOV, and takes the strongest source', () => {
  const c = heatConfig({ range: 200 });
  const far = [source(5000, 0, 4000)];
  assert.equal(heatEffectiveRange(far, c, { x: 0, y: 0 }), 0, 'out of range is out of range');
  const two = [source(100, 0, 100), source(0, 100, 900)];
  const r = heatEffectiveRange(two, { ...c, thresholdC: 2 }, { x: 0, y: 0 });
  const onlyHot = heatEffectiveRange([two[1]], { ...c, thresholdC: 2 }, { x: 0, y: 0 });
  assert.ok(Math.abs(r - Math.max(onlyHot, heatEffectiveRange([two[0]], { ...c, thresholdC: 2 }, { x: 0, y: 0 }))) < 1e-9);
  assert.equal(heatEffectiveRange([source(-100, 0, 900)], { ...c, thresholdC: 2 }, { x: 0, y: 0 }, { aim: 0, fov: 0.5 }), 0);
});

test('the bisection path agrees with the closed form as the air turns transparent', () => {
  const c = cfg();
  const src = [source(0, 0, 200)];
  const analytic = heatEffectiveRange(src, { ...c, thresholdC: 4 }, { x: 0, y: 0 });
  const bisected = heatEffectiveRange(src, { ...c, thresholdC: 4, attenuationLength: 1e9 }, { x: 0, y: 0 });
  assert.ok(Math.abs(bisected - analytic) / analytic < 1e-3, `${bisected} vs ${analytic}`);
});

// ---- calibration sanity (so a config edit that breaks usability is caught) --

test('the default calibration gives a robot something real to sense', () => {
  const c = cfg();
  const p = { x: 0, y: 0 };
  const riseAt = (r, t) => heatField(p, [source(r, 0, t)], c).equilibriumC - c.ambientTemp;
  assert.ok(riseAt(100, 200) > 20, `close to a fire must be dramatic, got ${riseAt(100, 200)}`);
  assert.ok(riseAt(400, 200) > 1 && riseAt(400, 200) < 20, 'and still faintly detectable far away');
  assert.ok(riseAt(100, 60) < riseAt(100, 200), 'a cooler source must read cooler at the same distance');
  assert.ok(riseAt(100, 60) > 10, `a warm source at the calibration radius must still register, got ${riseAt(100, 60)}`);
  assert.ok(riseAt(20, 220) < 220 - c.ambientTemp, 'and even parked on a furnace, below the furnace');
  const reach = heatEffectiveRange([source(0, 0, 200)], { ...c, thresholdC: c.outputSpanC / 10 }, p);
  assert.ok(reach > 100 && reach < 1200, `beam reach should be a sane on-screen distance, got ${reach}`);
});
