import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWiring } from '../src/models/wiring.js';

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
