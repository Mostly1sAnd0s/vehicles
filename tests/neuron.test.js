import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLogicGates } from '../src/simulation/logic.js';
import { computeActuation } from '../src/actuators.js';

const veh = (logicGates, components = [], wires = []) => ({ logicGates, components, wires });

/** A single bell Neuron fed by one (analog, non-digital) sensor. */
function bellVehicle(threshold = 0.5, sigma = 0.35) {
  return veh(
    [{ id: 'n1', type: 'neuron', props: { shape: 'bell', threshold, sigma } }],
    [{ id: 's1', type: 'light_sensor', props: {} }], // not digital -> raw passes through
    [{ from: { componentId: 's1', port: 'out' }, to: { componentId: 'n1', port: 'in0' }, weight: 1 }]
  );
}

test('a Neuron output is non-monotonic in its input (the Vehicle-4 law)', () => {
  const v = bellVehicle();
  const out = x => evaluateLogicGates(v, () => x).n1;
  // rises from 0 up to a peak at the threshold, then falls again
  assert.ok(out(0.1) < out(0.4), 'rising toward the peak');
  assert.ok(out(0.5) > out(0.4), 'still rising into the peak');
  assert.ok(Math.abs(out(0.5) - 1) < 1e-9, 'peaks at == 1 at the threshold');
  assert.ok(out(0.6) < out(0.5), 'falling after the peak');
  assert.ok(out(0.9) < out(0.6), 'keeps falling');
});

test('a Neuron passes analog values (not coerced to 0/1)', () => {
  const v = bellVehicle();
  const mid = evaluateLogicGates(v, () => 0.3).n1;
  assert.ok(mid > 0 && mid < 1, `interior value is fractional, got ${mid}`);
});

test('an unwired Neuron input evaluates finitely (transfer of 0)', () => {
  const v = veh([{ id: 'n1', type: 'neuron', props: { shape: 'bell' } }]);
  const out = evaluateLogicGates(v, () => 0).n1;
  assert.ok(Number.isFinite(out) && out >= 0 && out <= 1);
});

test('a gate can feed a Neuron (digital input is accepted)', () => {
  const v = veh(
    [
      { id: 'g1', type: 'gate_not' },
      { id: 'n1', type: 'neuron', props: { shape: 'triangle', threshold: 0.5 } },
    ],
    [{ id: 's1', type: 'light_sensor', props: { digital: true, threshold: 0.5 } }],
    [
      { from: { componentId: 's1', port: 'out' }, to: { componentId: 'g1', port: 'in0' }, weight: 1 },
      { from: { componentId: 'g1', port: 'out' }, to: { componentId: 'n1', port: 'in0' }, weight: 1 },
    ]
  );
  // s1 high -> g1 = NOT(1) = 0 -> triangle(0) = 0
  assert.ok(Math.abs(evaluateLogicGates(v, () => 0.9).n1 - 0) < 1e-9);
  // s1 low -> g1 = NOT(0) = 1 -> triangle(1) = 0 (peak is at 0.5, not the edges)
  assert.ok(Math.abs(evaluateLogicGates(v, () => 0.1).n1 - 0) < 1e-9);
});

test('Neurons can chain (a Neuron reads another Neuron\'s analog output)', () => {
  const v = veh(
    [
      { id: 'a', type: 'neuron', props: { shape: 'bell', threshold: 0.5 } },
      { id: 'b', type: 'neuron', props: { shape: 'custom', spline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }, // identity
    ],
    [{ id: 's1', type: 'light_sensor', props: {} }],
    [
      { from: { componentId: 's1', port: 'out' }, to: { componentId: 'a', port: 'in0' }, weight: 1 },
      { from: { componentId: 'a', port: 'out' }, to: { componentId: 'b', port: 'in0' }, weight: 1 },
    ]
  );
  // identity(b) == bell(a): at the peak both are 1, off-peak both < 1
  assert.ok(Math.abs(evaluateLogicGates(v, () => 0.5).b - 1) < 1e-9);
  assert.ok(evaluateLogicGates(v, () => 0.1).b < evaluateLogicGates(v, () => 0.5).b);
});

test('end-to-end: sensor -> Neuron -> actuator gives non-monotonic force', () => {
  const v = bellVehicle();
  const force = x => {
    const nv = evaluateLogicGates(v, () => x); // n1 = the neuron's [0,1] output
    return computeActuation(nv.n1, [{ polarity: 'excitatory', weight: 1 }], { maxForce: 1 });
  };
  assert.ok(force(0.5) > force(0.2), 'harder near the peak than well below it');
  assert.ok(force(0.5) > force(0.9), 'harder near the peak than when oversaturated');
  assert.ok(Math.abs(force(0.5) - 1) < 1e-9, 'full force at the peak');
});
