import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateOutput, gateInputCount, toDigital, evaluateLogicGates } from '../src/simulation/logic.js';

// ---------------- gate truth tables ----------------

test('AND is high only when all inputs are high', () => {
  assert.equal(gateOutput('gate_and', [0, 0]), 0);
  assert.equal(gateOutput('gate_and', [1, 0]), 0);
  assert.equal(gateOutput('gate_and', [0, 1]), 0);
  assert.equal(gateOutput('gate_and', [1, 1]), 1);
});

test('OR is high when any input is high', () => {
  assert.equal(gateOutput('gate_or', [0, 0]), 0);
  assert.equal(gateOutput('gate_or', [1, 0]), 1);
  assert.equal(gateOutput('gate_or', [0, 1]), 1);
  assert.equal(gateOutput('gate_or', [1, 1]), 1);
});

test('NAND is the inverse of AND', () => {
  assert.equal(gateOutput('gate_nand', [0, 0]), 1);
  assert.equal(gateOutput('gate_nand', [1, 0]), 1);
  assert.equal(gateOutput('gate_nand', [0, 1]), 1);
  assert.equal(gateOutput('gate_nand', [1, 1]), 0);
});

test('NOR is the inverse of OR', () => {
  assert.equal(gateOutput('gate_nor', [0, 0]), 1);
  assert.equal(gateOutput('gate_nor', [1, 0]), 0);
  assert.equal(gateOutput('gate_nor', [0, 1]), 0);
  assert.equal(gateOutput('gate_nor', [1, 1]), 0);
});

test('XOR is high when the inputs differ (parity)', () => {
  assert.equal(gateOutput('gate_xor', [0, 0]), 0);
  assert.equal(gateOutput('gate_xor', [1, 0]), 1);
  assert.equal(gateOutput('gate_xor', [0, 1]), 1);
  assert.equal(gateOutput('gate_xor', [1, 1]), 0);
});

test('NOT is the single-input inverter', () => {
  assert.equal(gateInputCount('gate_not'), 1);
  assert.equal(gateOutput('gate_not', [0]), 1);
  assert.equal(gateOutput('gate_not', [1]), 0);
});

test('gateInputCount is 2 for the binary gates', () => {
  for (const t of ['gate_and', 'gate_or', 'gate_nand', 'gate_nor', 'gate_xor']) {
    assert.equal(gateInputCount(t), 2);
  }
});

// ---------------- digital coercion ----------------

test('toDigital leaves an analog sensor as-is when digital is off', () => {
  assert.equal(toDigital(0.3, {}), 0.3);
  assert.equal(toDigital(0.3, { props: {} }), 0.3);
});

test('toDigital maps to 1 at/above the threshold, else 0', () => {
  const c = { props: { digital: true } }; // default threshold 0.5
  assert.equal(toDigital(0, c), 0);
  assert.equal(toDigital(0.49, c), 0);
  assert.equal(toDigital(0.5, c), 1);
  assert.equal(toDigital(1, c), 1);
});

test('toDigital honours a custom threshold', () => {
  const c = { props: { digital: true, threshold: 0.8 } };
  assert.equal(toDigital(0.79, c), 0);
  assert.equal(toDigital(0.8, c), 1);
});

// ---------------- graph evaluation ----------------

function veh(logicGates, components = [], wires = []) {
  return { logicGates, components, wires };
}

test('a gate fed by two digital sensors computes its table', () => {
  const v = veh(
    [{ id: 'g1', type: 'gate_and' }],
    [
      { id: 's1', type: 'light_sensor', props: { digital: true, threshold: 0.5 } },
      { id: 's2', type: 'light_sensor', props: { digital: true, threshold: 0.5 } },
    ],
    [
      { from: { componentId: 's1', port: 'out' }, to: { componentId: 'g1', port: 'in0' }, weight: 1 },
      { from: { componentId: 's2', port: 'out' }, to: { componentId: 'g1', port: 'in1' }, weight: 1 },
    ]
  );
  const raw = { s1: 0.9, s2: 0.9 }; // both high after digital
  assert.equal(evaluateLogicGates(v, id => raw[id]).g1, 1);
  raw.s1 = 0.1; // s1 low
  assert.equal(evaluateLogicGates(v, id => raw[id]).g1, 0);
});

test('an unwired gate input is LOW', () => {
  const v = veh(
    [{ id: 'g1', type: 'gate_or' }],
    [{ id: 's1', type: 'light_sensor', props: { digital: true, threshold: 0.5 } }],
    [{ from: { componentId: 's1', port: 'out' }, to: { componentId: 'g1', port: 'in0' }, weight: 1 }]
  );
  assert.equal(evaluateLogicGates(v, () => 0.9).g1, 1); // in0 high, in1 unwired(low) -> OR=1
});

test('gate outputs can feed other gates (multi-level)', () => {
  const v = veh(
    [
      { id: 'a', type: 'gate_not' },
      { id: 'b', type: 'gate_and' },
    ],
    [{ id: 's1', type: 'light_sensor', props: { digital: true, threshold: 0.5 } }],
    [
      { from: { componentId: 's1', port: 'out' }, to: { componentId: 'a', port: 'in0' }, weight: 1 },
      { from: { componentId: 'a', port: 'out' }, to: { componentId: 'b', port: 'in0' }, weight: 1 },
      { from: { componentId: 's1', port: 'out' }, to: { componentId: 'b', port: 'in1' }, weight: 1 },
    ]
  );
  // s1 high: a=NOT(1)=0, b=AND(0,1)=0
  assert.equal(evaluateLogicGates(v, () => 0.9).b, 0);
  // s1 low: a=NOT(0)=1, b=AND(1,0)=0
  assert.equal(evaluateLogicGates(v, () => 0.1).b, 0);
});

test('a wiring cycle is safe and evaluates LOW (no infinite loop)', () => {
  const v = veh(
    [
      { id: 'x', type: 'gate_or' },
      { id: 'y', type: 'gate_or' },
    ],
    [],
    [
      { from: { componentId: 'x', port: 'out' }, to: { componentId: 'y', port: 'in0' }, weight: 1 },
      { from: { componentId: 'y', port: 'out' }, to: { componentId: 'x', port: 'in0' }, weight: 1 },
    ]
  );
  const out = evaluateLogicGates(v, () => 0);
  assert.equal(out.x, 0);
  assert.equal(out.y, 0);
});

test('no gates -> empty result', () => {
  assert.deepEqual(evaluateLogicGates(veh([], [{ id: 's1' }]), () => 1), {});
});
