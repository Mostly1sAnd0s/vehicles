import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWiring, outputPorts, outputPortIds } from '../src/models/wiring.js';

// Component defs (the shape of components.json entries) with port kinds, so
// gate nodes resolve their ports the same way body components do.
const twoIn = { category: 'logic', ports: [{ id: 'in0', kind: 'logic_in' }, { id: 'in1', kind: 'logic_in' }, { id: 'out', kind: 'logic_out' }] };
const defs = {
  light_sensor: { category: 'sensor', ports: [{ id: 'out', kind: 'sensor_output' }] },
  powered_wheel: { category: 'actuator', ports: [{ id: 'drive', kind: 'actuator_input' }] },
  gate_and: twoIn,
  gate_or: twoIn,
  gate_nand: twoIn,
  gate_nor: twoIn,
  gate_xor: twoIn,
  gate_not: { category: 'logic', ports: [{ id: 'in0', kind: 'logic_in' }, { id: 'out', kind: 'logic_out' }] },
};

function veh({ components = [], logicGates = [], wires = [] } = {}) {
  return { components, logicGates, wires };
}
const codes = errs => new Set(errs.map(e => e.code));

test('existing sensor->motor wiring stays valid', () => {
  const v = veh({
    components: [{ id: 's1', type: 'light_sensor' }, { id: 'w1', type: 'powered_wheel' }],
    wires: [{ from: { componentId: 's1', port: 'out' }, to: { componentId: 'w1', port: 'drive' }, weight: 1 }],
  });
  assert.equal(validateWiring(v, defs).length, 0);
});

test('sensor -> gate input is valid', () => {
  const v = veh({
    components: [{ id: 's1', type: 'light_sensor' }],
    logicGates: [{ id: 'g1', type: 'gate_and' }],
    wires: [{ from: { componentId: 's1', port: 'out' }, to: { componentId: 'g1', port: 'in0' }, weight: 1 }],
  });
  assert.equal(validateWiring(v, defs).length, 0);
});

test('gate output -> actuator input is valid', () => {
  const v = veh({
    components: [{ id: 'w1', type: 'powered_wheel' }],
    logicGates: [{ id: 'g1', type: 'gate_not' }],
    wires: [
      { from: { componentId: 'g1', port: 'out' }, to: { componentId: 'w1', port: 'drive' }, weight: 1 },
    ],
  });
  assert.equal(validateWiring(v, defs).length, 0);
});

test('gate output -> gate input is valid (chaining)', () => {
  const v = veh({
    logicGates: [{ id: 'a', type: 'gate_not' }, { id: 'b', type: 'gate_and' }],
    wires: [
      { from: { componentId: 'a', port: 'out' }, to: { componentId: 'b', port: 'in0' }, weight: 1 },
    ],
  });
  assert.equal(validateWiring(v, defs).length, 0);
});

test('sensor -> sensor (and other non-logic pairs) is still a type mismatch', () => {
  const v = veh({
    components: [{ id: 's1', type: 'light_sensor' }, { id: 'w1', type: 'powered_wheel' }],
    wires: [
      // actuator input cannot be a source
      { from: { componentId: 'w1', port: 'drive' }, to: { componentId: 's1', port: 'out' }, weight: 1 },
    ],
  });
  assert.ok(codes(validateWiring(v, defs)).has('type_mismatch'));
});

test('a gate output may fan out to many targets (not a duplicate)', () => {
  const v = veh({
    components: [{ id: 'w1', type: 'powered_wheel' }],
    logicGates: [{ id: 'g1', type: 'gate_or' }, { id: 'g2', type: 'gate_and' }],
    wires: [
      { from: { componentId: 'g1', port: 'out' }, to: { componentId: 'w1', port: 'drive' }, weight: 1 },
      { from: { componentId: 'g1', port: 'out' }, to: { componentId: 'g2', port: 'in0' }, weight: 1 },
    ],
  });
  assert.equal(validateWiring(v, defs).length, 0);
});

test('two feeders into the SAME gate input port is rejected', () => {
  const v = veh({
    components: [{ id: 's1', type: 'light_sensor' }, { id: 's2', type: 'light_sensor' }],
    logicGates: [{ id: 'g1', type: 'gate_and' }],
    wires: [
      { from: { componentId: 's1', port: 'out' }, to: { componentId: 'g1', port: 'in0' }, weight: 1 },
      { from: { componentId: 's2', port: 'out' }, to: { componentId: 'g1', port: 'in0' }, weight: 1 }, // conflicts
    ],
  });
  assert.ok(codes(validateWiring(v, defs)).has('duplicate_input'));
});

test('two feeders into the SAME actuator are still allowed (motor sums them)', () => {
  const v = veh({
    components: [
      { id: 's1', type: 'light_sensor' }, { id: 's2', type: 'light_sensor' }, { id: 'w1', type: 'powered_wheel' },
    ],
    wires: [
      { from: { componentId: 's1', port: 'out' }, to: { componentId: 'w1', port: 'drive' }, weight: 1 },
      { from: { componentId: 's2', port: 'out' }, to: { componentId: 'w1', port: 'drive' }, weight: 1 },
    ],
  });
  assert.equal(validateWiring(v, defs).length, 0);
});

test('a wire referencing an unknown gate id is an unknown_component', () => {
  const v = veh({
    components: [{ id: 's1', type: 'light_sensor' }],
    logicGates: [],
    wires: [{ from: { componentId: 's1', port: 'out' }, to: { componentId: 'nope', port: 'in0' }, weight: 1 }],
  });
  assert.ok(codes(validateWiring(v, defs)).has('unknown_component'));
});

test('a wire into a non-existent gate input port is an unknown_port', () => {
  const v = veh({
    components: [{ id: 's1', type: 'light_sensor' }],
    logicGates: [{ id: 'g1', type: 'gate_and' }],
    wires: [{ from: { componentId: 's1', port: 'out' }, to: { componentId: 'g1', port: 'in7' }, weight: 1 }],
  });
  assert.ok(codes(validateWiring(v, defs)).has('unknown_port'));
});

// ---- Multi-output ports (PLAN.md §4.2) -----------------------------------
test('outputPorts: base port when the instance has no added outputs', () => {
  assert.deepEqual(outputPorts({ id: 's1', type: 'light_sensor' }, defs.light_sensor).map(p => p.id), ['out']);
});

test('outputPorts: an added tap inherits the base output kind', () => {
  const s = { id: 's1', type: 'light_sensor', outputs: ['out', 'out1'] };
  assert.deepEqual(outputPorts(s, defs.light_sensor).map(p => p.id), ['out', 'out1']);
  assert.ok(outputPorts(s, defs.light_sensor).every(p => p.kind === 'sensor_output'));
  assert.deepEqual(outputPortIds(s, defs.light_sensor), ['out', 'out1']);
});

test('outputPorts: a component with no output ports yields none', () => {
  assert.deepEqual(outputPorts({ id: 'w1', type: 'powered_wheel' }, defs.powered_wheel), []);
});

test('a wire from a sensor\'s added tap (out1) to a motor is valid', () => {
  const v = veh({
    components: [{ id: 's1', type: 'light_sensor', outputs: ['out', 'out1'] }, { id: 'w1', type: 'powered_wheel' }],
    wires: [{ from: { componentId: 's1', port: 'out1' }, to: { componentId: 'w1', port: 'drive' }, weight: 1 }],
  });
  assert.equal(validateWiring(v, defs).length, 0);
});

test('a sensor can drive two different motors from two taps of itself', () => {
  const v = veh({
    components: [{ id: 's1', type: 'light_sensor', outputs: ['out', 'out1'] }, { id: 'wL', type: 'powered_wheel' }, { id: 'wR', type: 'powered_wheel' }],
    wires: [
      { from: { componentId: 's1', port: 'out' }, to: { componentId: 'wL', port: 'drive' }, weight: 1 },
      { from: { componentId: 's1', port: 'out1' }, to: { componentId: 'wR', port: 'drive' }, weight: 1 },
    ],
  });
  assert.equal(validateWiring(v, defs).length, 0);
});

test('a wire from a tap the sensor does not have is an unknown_port', () => {
  const v = veh({
    components: [{ id: 's1', type: 'light_sensor', outputs: ['out'] }, { id: 'w1', type: 'powered_wheel' }],
    wires: [{ from: { componentId: 's1', port: 'out2' }, to: { componentId: 'w1', port: 'drive' }, weight: 1 }],
  });
  assert.ok(codes(validateWiring(v, defs)).has('unknown_port'));
});

test('a Neuron node supports added outputs (logic_out taps)', () => {
  const n = { id: 'n1', type: 'neuron', outputs: ['out', 'out1'] };
  assert.deepEqual(outputPortIds(n, defs.neuron ?? { ports: [{ id: 'in0', kind: 'logic_in' }, { id: 'out', kind: 'logic_out' }] }), ['out', 'out1']);
  const v = veh({
    components: [{ id: 'w1', type: 'powered_wheel' }],
    logicGates: [n],
    wires: [{ from: { componentId: 'n1', port: 'out1' }, to: { componentId: 'w1', port: 'drive' }, weight: 1 }],
  });
  const d2 = { ...defs, neuron: { category: 'logic', ports: [{ id: 'in0', kind: 'logic_in' }, { id: 'out', kind: 'logic_out' }] } };
  assert.equal(validateWiring(v, d2).length, 0);
});
