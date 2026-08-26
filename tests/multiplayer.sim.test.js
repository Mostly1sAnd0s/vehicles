import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { HeadlessWorld } from '../src/simulation/worldSim.js';
import { Session } from '../src/session.js';

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

test('M5: snapshot carries each mounted component (comps) so thin clients can draw the real design', () => {
  const { sim } = makeWorld({ protos: { bot: seekerDoc() } });
  sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: 0, y: 0, rotation: 0 }, owner: 'alice' });
  sim.step();
  // Round-trip through JSON exactly as the transport does, then check the wire payload.
  const b = JSON.parse(JSON.stringify(sim.snapshot())).bots[0];
  assert.ok(Array.isArray(b.comps), 'snapshot bot must include a comps array');
  // seekerDoc mounts a light sensor at (10,0) and a powered wheel at (0,12).
  assert.deepEqual(b.comps,
    [{ id: 'sL', x: 10, y: 0, type: 'light_sensor' }, { id: 'wR', x: 0, y: 12, type: 'powered_wheel' }],
    'comps must list each local component with its body-local position and type');
});

test('M5: snapshot carries sensor samples + motor forces so thin clients draw shared bots like local ones', () => {
  // Light just ahead of the start: the front sensor must read high, drive its wheel, and BOTH
  // results must ride the wire — before this the client only got geometry and beams/values/paths
  // could never render for a deployed vehicle.
  const { sim } = makeWorld({
    elements: [{ type: 'light', position: { x: 0, y: 0 }, properties: { intensity: 200 } }],
    protos: { bot: seekerDoc() },
  });
  sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: -60, y: 0, rotation: 0 }, owner: 'alice' });
  sim.step();
  const b = JSON.parse(JSON.stringify(sim.snapshot())).bots[0]; // exactly what the transport sends
  assert.ok(Array.isArray(b.samples) && b.samples.length === 1, 'one light sensor -> one sample');
  const s = b.samples[0];
  assert.equal(s.componentId, 'sL');
  assert.ok(s.value > 0.5, `sensor should read high near the light (got ${s.value})`);
  assert.ok(s.lightLevel != null && s.lightLevel > 0, 'lightLevel rides the wire for beam brightness');
  assert.ok(s.effectiveRange > 0 && s.fov > 0, 'effectiveRange + fov ride the wire for the wedge shape');
  // samplePoint is world-space at the sensor: seed (-60,0) + local (10,0), rotation 0 — allow a
  // tick or two of drift, since physics steps before sensors sample.
  assert.ok(Math.abs(s.samplePoint.x - -50) < 3 && Math.abs(s.samplePoint.y) < 2,
    `samplePoint must be the sensor's world position (got ${JSON.stringify(s.samplePoint)})`);
  assert.ok(Number.isFinite(s.direction), 'direction rides the wire');
  assert.ok(Array.isArray(b.motors) && b.motors.length === 1, 'one wired wheel -> one motor reading');
  assert.equal(b.motors[0].id, 'wR');
  assert.ok(Math.abs(b.motors[0].force) > 0.5, `wired sensor should produce real force (got ${b.motors[0].force})`);
});

test('M5: controls echo the authoritative running flag and a reset marker', () => {
  const { session, p } = makeSession([]);
  const start = session.handle(p.token, { type: 'controls', command: 'start' });
  assert.deepEqual({ type: start.type, running: start.running, reset: start.reset }, { type: 'state', running: true, reset: false });
  const pause = session.handle(p.token, { type: 'controls', command: 'pause' });
  assert.equal(pause.running, false);
  const reset = session.handle(p.token, { type: 'controls', command: 'reset' });
  assert.deepEqual({ running: reset.running, reset: reset.reset }, { running: false, reset: true },
    'clients need the reset marker to clear client-side state (e.g. accumulated trails)');
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

// ---- M5 element sync: elements that arrive AFTER world construction must still be live ----
// Regression: co-op worlds start empty; the host seeds its whole local element list via
// setElements, and edits flow through add/move/remove. Before the fix those mutations only
// touched worldDoc.elements — no light was ever sampled and rocks were never physics bodies,
// so deployed bots ignored the shared world entirely.

function makeSession(elements = []) {
  const session = new Session({ Matter, configs, worldDoc: { elements, vehiclePrototypes: [] } });
  const p = session.join({ name: 'host', role: 'admin' });
  session.bind(p.token, () => {});
  return { session, p };
}

const staticBodies = session => Matter.Composite.allBodies(session.world.engine.world).filter(b => b.isStatic);

test('M5: setElements after construction seeds a light a deployed bot senses and drives toward', () => {
  const { session, p } = makeSession([]);
  session.handle(p.token, { type: 'deploy', vehicle: seekerDoc() });
  // Light sits ~60px ahead of the participant seed (-360,0) — the M0 drive-test geometry — but it
  // arrives post-construction through the co-op element channel.
  session.handle(p.token, { type: 'setElements', elements: [{ id: 'l1', type: 'light', primitive: 'circle', position: { x: -300, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, properties: { intensity: 200 } }] });
  const inst = session.world.instances[0];
  const start = { ...inst.body.position };
  for (let i = 0; i < 150; i++) session.world.step();
  const moved = Math.hypot(inst.body.position.x - start.x, inst.body.position.y - start.y);
  assert.ok(moved > 2, `bot should chase the seeded light, moved ${moved}`);
});

test('M5: setElements after construction makes rocks physical (a bot collides with them)', () => {
  const { session, p } = makeSession([]);
  session.handle(p.token, { type: 'setElements', elements: [{ id: 'w1', type: 'obstacle', primitive: 'rect', position: { x: 100, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, properties: { width: 20, height: 300 } }] });
  assert.equal(staticBodies(session).length, 1, 'the seeded wall must become a static matter body');
  session.handle(p.token, { type: 'deploy', vehicle: seekerDoc() });
  const inst = session.world.instances[0];
  // No light nearby -> motor ~0; clean initial velocity straight at the wall (M0 wall-test pattern).
  Matter.Body.setVelocity(inst.body, { x: 6, y: 0 });
  Matter.Body.setAngularVelocity(inst.body, 0);
  let maxFront = -Infinity;
  for (let i = 0; i < 120; i++) { session.world.step(); maxFront = Math.max(maxFront, inst.body.position.x + 40); }
  assert.ok(maxFront <= 92, `bot front reached ${maxFront.toFixed(1)}; a seeded wall at x=90 should have stopped it`);
});

test('M5: moveElement / addElement / removeElement keep obstacle bodies in sync', () => {
  const { session, p } = makeSession([]);
  session.handle(p.token, { type: 'setElements', elements: [{ id: 'r1', type: 'rock', primitive: 'circle', position: { x: 100, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, properties: { radius: 40 } }] });
  const at = (x) => staticBodies(session).some(b => Math.abs(b.position.x - x) < 1);
  assert.ok(at(100), 'rock body should sit at x=100');

  session.handle(p.token, { type: 'moveElement', id: 'r1', x: 250, y: 0 });
  assert.equal(staticBodies(session).length, 1, 'moving must not duplicate the body');
  assert.ok(staticBodies(session)[0].position.x === 250, `rock body should follow the element to x=250 (got ${staticBodies(session)[0].position.x})`);

  session.handle(p.token, { type: 'addElement', element: { id: 'r2', type: 'rock', primitive: 'circle', position: { x: -100, y: 0 }, properties: { radius: 20 } } });
  assert.equal(staticBodies(session).length, 2, 'added rock must appear as a second static body');

  const res = session.handle(p.token, { type: 'removeElement', id: 'r1' });
  assert.equal(res.type, 'elementRemoved');
  assert.equal(staticBodies(session).length, 1, 'removed rock body must be gone');
  assert.equal(staticBodies(session)[0].position.x, -100);
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

test('M5: moveBot repositions a shared bot, zeroes its momentum, and adopts the dropped pose as its seed', () => {
  const { sim } = makeWorld({ protos: { bot: seekerDoc() } });
  const inst = sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: -60, y: 0, rotation: 0 }, owner: 'alice' });
  // Give it momentum so we can prove moveBot cancels it (a flung bot would drift after the drop).
  Matter.Body.setVelocity(inst.body, { x: 8, y: -4 });
  Matter.Body.setAngularVelocity(inst.body, 0.2);

  const ok = sim.moveBot('bot#1', 150, -35);
  assert.equal(ok, true, 'moveBot should find and move the instance');
  assert.ok(Math.abs(inst.body.position.x - 150) < 1e-6, `x should be set to 150 (got ${inst.body.position.x})`);
  assert.ok(Math.abs(inst.body.position.y - (-35)) < 1e-6, `y should be set to -35 (got ${inst.body.position.y})`);
  assert.equal(inst.body.velocity.x, 0, 'linear momentum must be zeroed on x');
  assert.equal(inst.body.velocity.y, 0, 'linear momentum must be zeroed on y');
  assert.equal(inst.body.angularVelocity, 0, 'angular momentum must be zeroed');
  // Seed adopts the dropped pose so a later reset() restores it there (host-drag parity).
  assert.ok(Math.abs(inst.seed.x - 150) < 1e-6 && Math.abs(inst.seed.y - (-35)) < 1e-6, 'seed must adopt the dropped pose');
  // The authoritative snapshot reflects the new pose (this is what every client renders).
  const b = sim.snapshot().bots[0];
  assert.ok(Math.abs(b.x - 150) < 1e-6 && Math.abs(b.y - (-35)) < 1e-6, 'snapshot bot must carry the moved pose');
});

test('M5: moveBot on an unknown id is a no-op (returns false, no crash)', () => {
  const { sim } = makeWorld({ protos: { bot: seekerDoc() } });
  sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: 0, y: 0, rotation: 0 } });
  assert.equal(sim.moveBot('nope', 10, 10), false, 'unknown id returns false');
});

test('M5: moveBot applies an explicit rotation (inspector Rot field) and seeds it for reset parity', () => {
  const { sim } = makeWorld({ protos: { bot: seekerDoc() } });
  const inst = sim.addInstance({ id: 'bot#1', protoId: 'bot', seed: { x: 0, y: 0, rotation: 0 }, owner: 'alice' });

  assert.equal(sim.moveBot('bot#1', 40, -25, Math.PI / 2), true);
  assert.ok(Math.abs(inst.body.angle - Math.PI / 2) < 1e-9, 'body angle must be set');
  assert.ok(Math.abs(inst.seed.rotation - Math.PI / 2) < 1e-9, 'seed rotation must adopt the new pose (reset parity)');

  // Omitting rot must leave the heading untouched.
  sim.moveBot('bot#1', 50, 30);
  assert.ok(Math.abs(inst.body.angle - Math.PI / 2) < 1e-9, 'omitting rot must not change the angle');
});
