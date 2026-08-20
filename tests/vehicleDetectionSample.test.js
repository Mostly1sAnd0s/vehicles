import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVehicleSensors } from '../src/simulation/sampleSensors.js';

// Integration coverage for the vehicle-detection sensor through the real sampler:
// it must be handed the other vehicles' poses (world.vehicles) plus its own
// instanceId, and emit a presence sample with the metadata the renderers need.

const sensorConfig = {
  vehicle_detection: { model: 'presence', defaultRange: 300, fov: Math.PI },
};

function veh(id, angle, comp) {
  return { pose: { x: 0, y: 0, angle }, instanceId: id, components: [comp] };
}
const vd = (id, props = {}, extra = {}) => ({ id, type: 'vehicle_detection_sensor', local: { x: 0, y: 0 }, aimAngle: 0, props, ...extra });
const fleet = arr => ({ lights: [], obstacles: [], vehicles: arr });

test('detects another vehicle in front, within range and cone', () => {
  const [s] = evaluateVehicleSensors(veh('A', 0, vd('vd', { range: 300, fov: Math.PI })),
    fleet([{ id: 'B', x: 120, y: 0, angle: 0 }]), sensorConfig);
  assert.equal(s.value, 1);
  assert.ok(Math.abs(s.detectedDistance - 120) < 1e-9);
  assert.deepEqual(s.detectedTarget, { id: 'B', x: 120, y: 0, angle: 0 });
});

test('does not detect a vehicle behind the cone or out of range', () => {
  const behind = evaluateVehicleSensors(veh('A', 0, vd('vd', { range: 300, fov: Math.PI })),
    fleet([{ id: 'B', x: -120, y: 0 }]), sensorConfig)[0];
  const far = evaluateVehicleSensors(veh('A', 0, vd('vd', { range: 50, fov: Math.PI })),
    fleet([{ id: 'B', x: 120, y: 0 }]), sensorConfig)[0];
  assert.equal(behind.value, 0);
  assert.equal(far.value, 0);
});

test('a lone vehicle never detects itself (selfId excluded)', () => {
  const [s] = evaluateVehicleSensors(veh('A', 0, vd('vd', { range: 300, fov: Math.PI })),
    fleet([{ id: 'A', x: 3, y: 0 }]), sensorConfig); // only itself in the fleet
  assert.equal(s.value, 0);
});

test('inverted polarity flips presence to absence (clear-path mode)', () => {
  const norm = evaluateVehicleSensors(veh('A', 0, vd('vd', { range: 300, fov: Math.PI })),
    fleet([{ id: 'B', x: 100, y: 0 }]), sensorConfig)[0];
  const inv = evaluateVehicleSensors(veh('A', 0, vd('vd', { range: 300, fov: Math.PI }, { polarity: 'inverted' })),
    fleet([{ id: 'B', x: 100, y: 0 }]), sensorConfig)[0];
  assert.equal(norm.value, 1);
  assert.equal(inv.value, 0); // inverted: active when NOTHING is detected
});

test('the sample carries render metadata (kind, range, fov, effectiveRange)', () => {
  const [s] = evaluateVehicleSensors(veh('A', 0, vd('vd', { range: 250, fov: Math.PI / 2 })),
    fleet([]), sensorConfig);
  assert.equal(s.kind, 'vehicle');
  assert.equal(s.range, 250);
  assert.ok(Math.abs(s.fov - Math.PI / 2) < 1e-9);
  assert.equal(s.effectiveRange, 250); // full cone drawn regardless of detection
});
