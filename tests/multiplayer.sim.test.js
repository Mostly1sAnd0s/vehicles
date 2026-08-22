import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { HeadlessWorld } from '../src/simulation/worldSim.js';

// Test-only config (exaggerated thrust/power so motion is unambiguous in a few
// ticks — the shipped tuning lives in config/*.json). Shape mirrors the real files.
const configs = {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: {
    light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 },
    vehicle_detection: { model: 'presence', defaultRange: 300, fov: Math.PI / 2, showCone: true },
    distance: { model: 'raycast', defaultRange: 150, beamWidthDeg: 4, showBeam: true, output: 'normalized_inverse', inversionRef: 1 },
  },
  components: { components: [
    { id: 'light_sensor', category: 'sensor', size: 8 },
    { id: 'powered_wheel', category: 'actuator', size: 16 },
    { id: 'caster_wheel', category: 'passive', size: 10 },
    { id: 'vehicle_detection_sensor', category: 'sensor', size: 8 },
  ] },
};

// A classic light "seeker": one front sensor drives one wheel (forward thrust).
function seekerDoc() {
  return {
    body: { shape: 'rect', width: 80, height: 40, color: '#cc3333' },
    components: [
      { id: 'sL', type: 'light_sensor', local: { x: 10, y: 0 }, localRotation: 0, props: {} },
      { id: 'wR', type: 'powered_wheel', local: { x: 0, y: 12 }, localRotation: 0, props: {} },
    ],
    wires: [{ id: 'w1', from: { componentId: 'sL', port: 'out' }, to: { componentId: 'wR', port: 'drive' }, weight: 1 }],
  };
}

function makeWorld({ elements = [], protos = {} } = {}) {
  const worldDoc = {
    elements,
    vehiclePrototypes: Object.entries(protos).map(([id, v]) => ({ id, name: id, vehicle: v, _vehicle: v, instances: [] })),
  };
  return { sim: new HeadlessWorld({ Matter, dtMs: 16.6, configs, worldDoc }), worldDoc };
}

test('M0: a light-seeker drives (sensor→logic→actuation produces headless motion)', () => {
  // Light sits just ahead of the start so the front sensor reads high (intensity/d² above threshold).
  const { sim } = makeWorld({ elements: [{ type: 'light', position: { x: 0, y: 0 }, properties: { intensity: 200 } }], protos: { bot: seekerDoc() } });
  const inst = sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: -60, y: 0, rotation: 0 }, owner: 'alice' });
  assert.ok(inst && inst.body, 'instance should have a matter body');
  const start = { ...inst.body.position };
  for (let i = 0; i < 150; i++) sim.step();
  const moved = Math.hypot(inst.body.position.x - start.x, inst.body.position.y - start.y);
  assert.ok(moved > 2, `expected the bot to move >2px over 150 steps, moved ${moved}`);
  assert.ok(inst.lastSamples.some(s => s.componentId === 'sL'), 'the light sensor should have produced a sample');
});

test('M0: bots are stopped by a static wall (matter-js collisions run headlessly)', () => {
  const { sim } = makeWorld({ elements: [{ type: 'obstacle', primitive: 'rect', position: { x: 100, y: 0 }, rotation: 0, properties: { width: 20, height: 300 } }] , protos: { bot: seekerDoc() } });
  const inst = sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: -100, y: 0, rotation: 0 } });
  // No light nearby -> the motor is ~0; give it a clean initial velocity straight at the wall.
  Matter.Body.setVelocity(inst.body, { x: 6, y: 0 });
  Matter.Body.setAngularVelocity(inst.body, 0);
  let maxFront = -Infinity;
  for (let i = 0; i < 120; i++) { sim.step(); maxFront = Math.max(maxFront, inst.body.position.x + 40); }
  // Wall face is at x = 90. The bot's front (x+40) must never pass through it.
  assert.ok(inst.body.position.x > -100, 'bot should have traveled toward the wall');
  assert.ok(maxFront <= 92, `bot front reached ${maxFront.toFixed(1)}; a wall at x=90 should have stopped it`);
});

test('M0: snapshot is JSON-serializable with a stable shape', () => {
  const { sim } = makeWorld({ protos: { bot: seekerDoc() } });
  sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: 0, y: 0, rotation: 0 }, owner: 'alice' });
  sim.step();
  const snap = sim.snapshot();
  const roundTrip = JSON.parse(JSON.stringify(snap));
  assert.equal(roundTrip.bots.length, 1);
  const b = roundTrip.bots[0];
  for (const k of ['id', 'protoId', 'x', 'y', 'angle', 'vx', 'vy']) assert.ok(k in b, `snapshot bot missing ${k}`);
  assert.equal(b.owner, 'alice');
});

test('M0: deploy swaps the running vehicle but preserves each clone\u2019s pose & momentum', () => {
  const { sim } = makeWorld({ protos: { bot: seekerDoc() } });
  const inst = sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: 50, y: 0, rotation: 0.3 } });
  for (let i = 0; i < 20; i++) sim.step();               // let it acquire pose + velocity
  const before = { x: inst.body.position.x, y: inst.body.position.y, angle: inst.body.angle, vx: inst.body.velocity.x };
  // A different design (taller body + an extra sensor) for the same proto.
  const v2 = { ...seekerDoc(), body: { shape: 'rect', width: 80, height: 60, color: '#33cc33' } };
  sim.deploy('bot', v2);
  assert.equal(sim.prototypeVehicle('bot').body.height, 60, 'deployed doc should be in effect');
  const drift = Math.hypot(inst.body.position.x - before.x, inst.body.position.y - before.y);
  assert.ok(drift < 1e-6, `deploy rebuilt the body in place; pose must not move (drifted ${drift})`);
  assert.ok(Math.abs(inst.body.velocity.x - before.vx) < 1e-6, 'deploy must preserve momentum');
});

test('M0: setCount is admin-controlled and adds/removes clones around the survivors', () => {
  const { sim } = makeWorld({ protos: { bot: seekerDoc() } });
  const first = sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: 0, y: 0, rotation: 0 }, owner: 'alice' });
  assert.equal(sim.setCount('bot', 3), 3, 'admin can grow to 3 clones');
  assert.equal(sim.instancesFor('bot').length, 3);
  const survivorPose = { ...first.body.position };
  assert.equal(sim.setCount('bot', 1), 1, 'admin can shrink back to 1');
  assert.equal(sim.instancesFor('bot').length, 1);
  assert.equal(first.body, sim.instancesFor('bot')[0].body, 'the original clone must survive the trim');
  assert.deepEqual({ x: first.body.position.x, y: first.body.position.y }, survivorPose, 'survivor pose is untouched by setCount');
});
