import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWiring } from '../src/models/wiring.js';

function vehicle(wires) {
  return {
    components: [
      { id: 's1', type: 'light_sensor', ports: [{ id: 'out', kind: 'sensor_output' }] },
      { id: 's2', type: 'distance_sensor', ports: [{ id: 'out', kind: 'sensor_output' }] },
      { id: 'w1', type: 'powered_wheel', ports: [{ id: 'drive', kind: 'actuator_input' }] },
      { id: 'w2', type: 'powered_wheel', ports: [{ id: 'drive', kind: 'actuator_input' }] },
    ],
    wires,
  };
}

const wire = (overrides = {}) => ({
  from: { componentId: 's1', port: 'out' },
  to: { componentId: 'w1', port: 'drive' },
  polarity: 'excitatory',
  weight: 0.5,
  ...overrides,
});

test('valid wire is accepted', () => {
  assert.deepEqual(validateWiring(vehicle([wire()])), []);
});

test('rejects duplicate connections (same from+to)', () => {
  const errs = validateWiring(vehicle([wire(), wire()]));
  assert.ok(errs.some(e => e.code === 'duplicate_connection'));
});

test('rejects sensor-to-sensor', () => {
  const errs = validateWiring(vehicle([wire({ to: { componentId: 's2', port: 'out' } })]));
  assert.ok(errs.some(e => e.code === 'type_mismatch'));
});

test('rejects actuator-to-actuator', () => {
  const errs = validateWiring(vehicle([wire({ from: { componentId: 'w1', port: 'drive' }, to: { componentId: 'w2', port: 'drive' } })]));
  assert.ok(errs.some(e => e.code === 'type_mismatch'));
});

test('rejects unknown component ids', () => {
  const errs = validateWiring(vehicle([wire({ to: { componentId: 'nope', port: 'drive' } })]));
  assert.ok(errs.some(e => e.code === 'unknown_component'));
});

test('rejects unknown port names', () => {
  const errs = validateWiring(vehicle([wire({ from: { componentId: 's1', port: 'bogus' } })]));
  assert.ok(errs.some(e => e.code === 'unknown_port'));
});

test('rejects out-of-range weight', () => {
  assert.ok(validateWiring(vehicle([wire({ weight: -0.1 })])).some(e => e.code === 'bad_weight'));
  assert.ok(validateWiring(vehicle([wire({ weight: 1.5 })])).some(e => e.code === 'bad_weight'));
});

test('rejects invalid polarity', () => {
  assert.ok(validateWiring(vehicle([wire({ polarity: 'sideways' })])).some(e => e.code === 'bad_polarity'));
});

test('errors reference the offending wire index', () => {
  const errs = validateWiring(vehicle([wire(), wire({ to: { componentId: 'w2', port: 'drive' } }), wire()]));
  // wire index 2 duplicates wire 0
  assert.ok(errs.some(e => e.code === 'duplicate_connection' && e.wireIndex === 2));
});

test('no wires is valid', () => {
  assert.deepEqual(validateWiring(vehicle([])), []);
});

const defs = {
  light_sensor: { ports: [{ id: 'out', kind: 'sensor_output' }] },
  powered_wheel: { ports: [{ id: 'drive', kind: 'actuator_input' }] },
};

test('port kinds fall back to component defs when components omit ports', () => {
  const v = {
    components: [
      { id: 's1', type: 'light_sensor' },
      { id: 'w1', type: 'powered_wheel' },
    ],
    wires: [
      { from: { componentId: 's1', port: 'out' }, to: { componentId: 'w1', port: 'drive' }, polarity: 'excitatory', weight: 1 },
    ],
  };
  assert.deepEqual(validateWiring(v, defs), []);
});

test('defs fallback also detects type mismatches and unknown ports', () => {
  const v = {
    components: [{ id: 'w1', type: 'powered_wheel' }, { id: 'w2', type: 'powered_wheel' }],
    wires: [
      { from: { componentId: 'w1', port: 'drive' }, to: { componentId: 'w2', port: 'drive' }, polarity: 'excitatory', weight: 1 },
      { from: { componentId: 'w1', port: 'nope' }, to: { componentId: 'w2', port: 'drive' }, polarity: 'excitatory', weight: 1 },
    ],
  };
  const errs = validateWiring(v, defs);
  assert.ok(errs.some(e => e.code === 'type_mismatch'));
  assert.ok(errs.some(e => e.code === 'unknown_port' && e.wireIndex === 1));
});
