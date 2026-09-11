/**
 * Co-op fleet organising: the admin-only `arrangeBots` command and the authoritative
 * `HeadlessWorld.arrangeAll` behind it.
 *
 * The properties that matter are (1) it moves EVERYONE's bots — that is the whole request,
 * (2) the layout survives a Reset because the seeds move too, (3) momentum is zeroed so a
 * fast bot does not simply fly back out of the line it was just placed in, and (4) a
 * participant cannot do it to somebody else's fleet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { Session } from '../src/session.js';
import { HeadlessWorld } from '../src/simulation/worldSim.js';

const configs = {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: {
    light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 },
    distance: { model: 'raycast', defaultRange: 150, output: 'normalized_inverse', inversionRef: 1 },
    vehicle_detection: { model: 'presence', defaultRange: 300, fov: Math.PI / 2 },
  },
  components: { components: [
    { id: 'light_sensor', category: 'sensor', size: 8 },
    { id: 'powered_wheel', category: 'actuator', size: 16 },
  ] },
};

const seeker = () => ({
  body: { shape: 'rect', width: 60, height: 30 },
  components: [
    { id: 'sL', type: 'light_sensor', local: { x: 10, y: 0 }, localRotation: 0, props: {} },
    { id: 'wR', type: 'powered_wheel', local: { x: 0, y: 12 }, localRotation: 0, props: {} },
  ],
  wires: [{ id: 'w1', from: { componentId: 'sL', port: 'out' }, to: { componentId: 'wR', port: 'drive' }, weight: 1 }],
});

/** A host plus `guests` participants, each deployed with `clones` bots, all messages recorded. */
function makeCoop({ guests = 1, clones = 1 } = {}) {
  const session = new Session({ Matter, configs, worldDoc: { elements: [], vehiclePrototypes: [] } });
  const seen = new Map();
  const host = session.join({ name: 'host', role: 'admin' });
  const inbox = [];
  session.bind(host.token, m => inbox.push(m));
  seen.set(host.token, inbox);
  session.handle(host.token, { type: 'deploy', vehicle: seeker() });
  const people = [{ ...host, name: 'host', role: 'admin' }];
  for (let i = 0; i < guests; i++) {
    const g = session.join({ name: `guest${i + 1}`, role: 'participant' });
    const box = [];
    session.bind(g.token, m => box.push(m));
    seen.set(g.token, box);
    session.handle(g.token, { type: 'deploy', vehicle: seeker() });
    if (clones > 1) session.handle(host.token, { type: 'setCount', protoId: g.protoId, count: clones });
    people.push({ ...g, name: `guest${i + 1}`, role: 'participant' });
  }
  if (clones > 1) session.handle(host.token, { type: 'setCount', protoId: host.protoId, count: clones });
  const out = { session, host, people, seen, inbox };
  out.boxes = seen;
  return out;
}

const of = (box, type) => box.filter(m => m.type === type);
const botsOf = (session, protoId) => session.world.instances.filter(i => i.protoId === protoId);

// ---- who may do it -------------------------------------------------------

test('a participant cannot arrange the shared fleet (it moves other people\'s bots)', () => {
  const { session, people, seen } = makeCoop();
  const guest = people[1];
  const before = session.world.instances.map(i => ({ x: i.body.position.x, y: i.body.position.y }));
  const reply = session.handle(guest.token, { type: 'arrangeBots', mode: 'line', center: { x: 0, y: 0 } });
  assert.equal(reply.type, 'error', 'must be refused, not ignored');
  assert.match(reply.error, /host/i);
  const after = session.world.instances.map(i => ({ x: i.body.position.x, y: i.body.position.y }));
  assert.deepEqual(after, before, 'refused means NOTHING moved');
  // The error is private to the actor — nobody else gets spammed with it.
  assert.equal(of(seen.get(people[0].token), 'error').length, 0);
});

test('an unknown formation is refused with a message that names the valid ones', () => {
  const { session, host } = makeCoop();
  const reply = session.handle(host.token, { type: 'arrangeBots', mode: 'spiral' });
  assert.equal(reply.type, 'error');
  assert.match(reply.error, /random.*line.*grid/, reply.error);
});

test('a non-finite centre is refused, not clamped: NaN into Matter is unrecoverable', () => {
  const { session, host } = makeCoop();
  for (const bad of [{ x: NaN, y: 0 }, { x: 0, y: 'here' }, { x: undefined, y: undefined }, {}]) {
    const reply = session.handle(host.token, { type: 'arrangeBots', mode: 'grid', center: bad });
    assert.equal(reply.type, 'error', `${JSON.stringify(bad)} should have been refused`);
    for (const inst of session.world.instances) {
      assert.ok(Number.isFinite(inst.body.position.x) && Number.isFinite(inst.body.position.y), 'a body went NaN');
    }
  }
});

// ---- what it does --------------------------------------------------------

test('arrangeBots moves EVERY bot in the world — every participant, not one design', () => {
  const { session, host, people } = makeCoop({ guests: 2, clones: 3 });
  assert.equal(session.world.instances.length, 9, '3 people × 3 clones');
  // Scatter them first, so "they all ended up on the line" cannot be an accident of where
  // they started (a fleet that spawns in a row would make this test pass while doing nothing).
  for (const inst of session.world.instances) {
    session.world.moveBot(inst.id, Math.round(-700 + Math.random() * 1400), Math.round(-700 + Math.random() * 1400));
  }
  session.handle(host.token, { type: 'arrangeBots', mode: 'line', center: { x: 0, y: 0 } });
  const ys = session.world.instances.map(i => i.body.position.y);
  assert.ok(ys.every(y => Math.abs(y) < 1e-6), 'every bot, from every participant, must be on the line: ' + ys.join(','));
  const xs = session.world.instances.map(i => i.body.position.x).sort((a, b) => a - b);
  assert.equal(xs.length, 9);
  assert.ok(xs[8] - xs[0] > 8 * 100, 'spread across 9 slots at the default spacing');
  for (const p of people) assert.ok(botsOf(session, p.protoId).length === 3, `${p.name}'s fleet was not placed`);
});

test('seeds move too: a Reset returns the fleet to the formation instead of undoing it', () => {
  const { session, host, people } = makeCoop({ guests: 1, clones: 4 });
  for (const inst of session.world.instances) session.world.moveBot(inst.id, 900, 900);
  session.handle(host.token, { type: 'arrangeBots', mode: 'grid', center: { x: 120, y: -40 } });
  const arranged = session.world.instances.map(i => ({ x: i.body.position.x, y: i.body.position.y, s: { ...i.seed } }));
  for (const a of arranged) {
    assert.ok(Math.abs(a.x - a.s.x) < 1e-6 && Math.abs(a.y - a.s.y) < 1e-6, 'live pose and seed must agree');
  }
  // Drive them about, then Reset: they come BACK to the formation, which is what makes the
  // layout a statement about the world rather than a momentary glimpse.
  for (const inst of session.world.instances) Matter.Body.setVelocity(inst.body, { x: 9, y: 4 });
  for (let i = 0; i < 60; i++) session.world.step();
  session.world.reset();
  for (const a of arranged) {
    const live = session.world.instances.find(i => Math.abs(i.seed.x - a.s.x) < 1e-6 && Math.abs(i.seed.y - a.s.y) < 1e-6);
    assert.ok(live, 'a seeded bot vanished on reset');
    assert.ok(Math.abs(live.body.position.x - a.s.x) < 1e-6 && Math.abs(live.body.position.y - a.s.y) < 1e-6,
      `reset left ${live.body.position.x.toFixed(1)},${live.body.position.y.toFixed(1)} instead of ${a.s.x},${a.s.y}`);
  }
});

test('momentum is zeroed, or a fast bot simply flies back out of the line', () => {
  const { session, host } = makeCoop({ guests: 1, clones: 2 });
  for (const inst of session.world.instances) Matter.Body.setVelocity(inst.body, { x: 12, y: -12 });
  session.handle(host.token, { type: 'arrangeBots', mode: 'line', center: { x: 0, y: 0 } });
  for (const inst of session.world.instances) {
    assert.ok(Math.abs(inst.body.velocity.x) < 1e-9 && Math.abs(inst.body.velocity.y) < 1e-9,
      `${inst.id} still moving at ${inst.body.velocity.x},${inst.body.velocity.y}`);
    assert.equal(inst.body.angularVelocity, 0);
  }
});

test('bots are grouped by participant, so each fleet owns one stretch of the line', () => {
  const { session, host, people } = makeCoop({ guests: 2, clones: 3 });
  session.handle(host.token, { type: 'arrangeBots', mode: 'line', center: { x: 0, y: 0 } });
  const row = [...session.world.instances].sort((a, b) => a.body.position.x - b.body.position.x);
  const order = row.map(i => i.protoId);
  // Each protoId appears in exactly one contiguous run.
  const runs = [];
  for (const id of order) if (runs[runs.length - 1] !== id) runs.push(id);
  assert.equal(new Set(runs).size, runs.length, 'a fleet was split across the line: ' + order.join(','));
});

test('no centre given → the fleet is laid out around its own middle, not teleported to the origin', () => {
  const { session, host } = makeCoop({ guests: 1, clones: 2 });
  for (const inst of session.world.instances) session.world.moveBot(inst.id, 1000, 800);
  session.handle(host.token, { type: 'arrangeBots', mode: 'line' });
  const ys = session.world.instances.map(i => i.body.position.y);
  const xs = session.world.instances.map(i => i.body.position.x);
  assert.ok(ys.every(y => Math.abs(y - 800) < 1e-6), 'kept its latitude: ' + ys.join(','));
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 1000) < 1e-6, 'centred where they were');
});

test('documented instance seeds are updated, so a saved world exports what the screen showed', () => {
  // Only the host's OWN imported prototype carries documented instances; participant protos
  // have none on the server, which is why this is asserted separately.
  const world = new HeadlessWorld({ Matter, configs, worldDoc: {
    elements: [],
    vehiclePrototypes: [{ id: 'p1', name: 'A', vehicle: seeker(), instances: [
      { id: 'p1#1', position: { x: -500, y: -500 }, rotation: 0 },
      { id: 'p1#2', position: { x: -450, y: -500 }, rotation: 0 },
    ] }],
  } });
  world.addInstance({ id: 'p1#1', protoId: 'p1', seed: { x: -500, y: -500, rotation: 0 } });
  world.addInstance({ id: 'p1#2', protoId: 'p1', seed: { x: -450, y: -500, rotation: 0 } });
  const n = world.arrangeAll('line', { x: 0, y: 0 });
  assert.equal(n, 2);
  const doc = world.worldDoc.vehiclePrototypes[0].instances;
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(doc[i].position.x - world.instances[i].seed.x) < 1e-6, 'doc x disagrees');
    assert.ok(Math.abs(doc[i].position.y - world.instances[i].seed.y) < 1e-6, 'doc y disagrees');
  }
  assert.ok(Math.abs(doc[0].position.y) < 1e-6 && Math.abs(doc[1].position.y) < 1e-6);
});

// ---- what everyone sees --------------------------------------------------

test('success broadcasts botsArranged to everyone, then an authoritative snapshot', () => {
  const { session, host, people, seen } = makeCoop({ guests: 2, clones: 1 });
  for (const box of seen.values()) box.length = 0; // ignore the deploy chatter
  session.handle(host.token, { type: 'arrangeBots', mode: 'grid', center: { x: 10, y: 20 } });
  for (const p of people) {
    const box = seen.get(p.token);
    const announced = of(box, 'botsArranged');
    assert.equal(announced.length, 1, `${p.name} did not hear about the rearrange`);
    assert.equal(announced[0].mode, 'grid');
    assert.equal(announced[0].count, 3);
    // The snapshot is what actually puts the bots in their new places on a joiner's screen —
    // without it a paused world would show the OLD positions until something else moved.
    assert.ok(of(box, 'snapshot').length >= 1, `${p.name} got no authoritative poses`);
    const snap = of(box, 'snapshot').at(-1);
    assert.equal(snap.bots.length, 3);
  }
});

test('the admin command counter records it (the world was changed by an admin, and says so)', () => {
  const { session, host } = makeCoop();
  const before = session.stats.adminCommands;
  session.handle(host.token, { type: 'arrangeBots', mode: 'random' });
  assert.equal(session.stats.adminCommands, before + 1);
});

test('an empty world is arranged without error (nothing to place is not a failure)', () => {
  const session = new Session({ Matter, configs, worldDoc: { elements: [], vehiclePrototypes: [] } });
  const host = session.join({ name: 'host', role: 'admin' });
  session.bind(host.token, () => {});
  const reply = session.handle(host.token, { type: 'arrangeBots', mode: 'grid', center: { x: 0, y: 0 } });
  assert.equal(reply.type, 'botsArranged');
  assert.equal(reply.count, 0);
});

test('a bot whose body failed to build is skipped rather than thrown over', () => {
  const world = new HeadlessWorld({ Matter, configs, worldDoc: { elements: [], vehiclePrototypes: [{ id: 'p', name: 'P', vehicle: seeker(), instances: [] }] } });
  world.instances.push({ id: 'ghost', protoId: 'p', seed: { x: 0, y: 0, rotation: 0 }, body: null });
  world.addInstance({ id: 'real', protoId: 'p', seed: { x: 0, y: 0, rotation: 0 } });
  const n = world.arrangeAll('line', { x: 0, y: 0 });
  assert.equal(n, 1, 'only the body-backed instance is placed');
});

test('an unknown mode reaching the engine (bypassing the session check) places nothing', () => {
  const world = new HeadlessWorld({ Matter, configs, worldDoc: { elements: [], vehiclePrototypes: [{ id: 'p', name: 'P', vehicle: seeker(), instances: [] }] } });
  const inst = world.addInstance({ id: 'p#1', protoId: 'p', seed: { x: 33, y: 44, rotation: 0 } });
  assert.equal(world.arrangeAll('hexagon', { x: 0, y: 0 }), null);
  assert.equal(inst.body.position.x, 33);
  assert.equal(inst.body.position.y, 44);
});
