/**
 * M1/M5 unit tests — the transport-agnostic `Session` (no sockets): participants, ownership,
 * admin-only controls + element edits, snapshotting, leave-prunes. The gateway (M5) is the only
 * transport, so roles are always passed explicitly: the host joins as 'admin', joiners as
 * 'participant'. These run fast and deterministically, which is why they live here rather than in
 * the socket-level e2e files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { Session } from '../src/session.js';

// ---- shared fixtures (mirror tests/multiplayer.sim.test.js) --------------
const configs = {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: { light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 } },
  components: { components: [{ id: 'light_sensor', category: 'sensor', size: 8 }, { id: 'powered_wheel', category: 'actuator', size: 16 }] },
};
const worldDoc = () => ({ elements: [], vehiclePrototypes: [] });
const seekerDoc = () => ({
  body: { shape: 'rect', width: 80, height: 40, color: '#cc3333' },
  components: [
    { id: 'sL', type: 'light_sensor', local: { x: 10, y: 0 }, localRotation: 0, props: {} },
    { id: 'wR', type: 'powered_wheel', local: { x: 0, y: 12 }, localRotation: 0, props: {} },
  ],
  wires: [{ id: 'w1', from: { componentId: 'sL', port: 'out' }, to: { componentId: 'wR', port: 'drive' }, weight: 1 }],
});

const makeSession = () => new Session({ Matter, configs, worldDoc: worldDoc() });
const capture = (s, token) => { const got = []; s.bind(token, (m) => got.push(m)); return got; };

test('roles are explicit — the transport decides, the session does not guess', () => {
  const s = makeSession();
  assert.equal(s.join({ name: 'alice', role: 'admin' }).role, 'admin', 'host joins as admin');
  assert.equal(s.join({ name: 'bob', role: 'participant' }).role, 'participant', 'joiner is a participant');
  assert.throws(() => s.join({ name: 'eve' }), /role must be/, 'no implicit "first joiner is admin" fallback');
  assert.throws(() => s.join({ name: 'eve', role: 'wizard' }), /role must be/);
});

test('deploy is owner-only & spawns a clone owned by the deployer', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice', role: 'admin' });
  const b = s.join({ name: 'bob', role: 'participant' });
  const gotA = capture(s, a.token);
  const gotB = capture(s, b.token);

  const res = s.handle(b.token, { type: 'deploy', vehicle: seekerDoc() });
  assert.equal(res.type, 'deployed');
  const bots = s.currentSnapshotWire().bots;
  assert.equal(bots.length, 1);
  assert.equal(bots[0].owner, 'bob');          // owned by whoever deployed
  assert.equal(bots[0].protoId, b.protoId);

  assert.ok(gotB.some(m => m.type === 'deployed'), 'deployer gets an ack');
  assert.ok(gotA.some(m => m.type === 'peerDeployed' && m.protoId === b.protoId), 'others get the peerDeployed broadcast');
  assert.equal(s.handle(b.token, { type: 'deploy', vehicle: {} }).type, 'error', 'malformed deploy is dropped, not a crash');
});

test('setCount & controls are admin-only; grown clones keep the owner', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice', role: 'admin' });
  const b = s.join({ name: 'bob', role: 'participant' });
  capture(s, a.token); capture(s, b.token);
  s.handle(b.token, { type: 'deploy', vehicle: seekerDoc() });

  assert.equal(s.handle(b.token, { type: 'setCount', protoId: b.protoId, count: 3 }).type, 'error', 'non-admin setCount rejected');
  assert.equal(s.handle(b.token, { type: 'controls', command: 'start' }).type, 'error', 'non-admin controls rejected');

  const sc = s.handle(a.token, { type: 'setCount', protoId: b.protoId, count: 3 });
  assert.equal(sc.type, 'countSet');
  assert.equal(s.world.instancesFor(b.protoId).length, 3);
  assert.ok(s.world.instancesFor(b.protoId).every(i => i.owner === 'bob'), 'admin-grown clones inherit the proto owner');

  const st = s.handle(a.token, { type: 'controls', command: 'start' });
  assert.equal(st.type, 'state');
  assert.equal(s.running, true);
});

test('stepOnce advances only when running; snapshot serializes', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice', role: 'admin' });
  capture(s, a.token);
  s.handle(a.token, { type: 'deploy', vehicle: seekerDoc() });
  assert.equal(s.stepOnce(), null, 'paused -> no snapshot');
  s.handle(a.token, { type: 'controls', command: 'start' });
  const snap = s.stepOnce();
  assert.ok(snap && snap.type === 'snapshot' && Array.isArray(snap.bots));
  JSON.parse(JSON.stringify(snap)); // must be wire-serializable
  s.handle(a.token, { type: 'controls', command: 'pause' });
  assert.equal(s.stepOnce(), null, 'paused again -> no snapshot');
});

test('leave removes a participant and all their clones', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice', role: 'admin' });
  capture(s, a.token);
  s.handle(a.token, { type: 'deploy', vehicle: seekerDoc() });
  assert.equal(s.world.instances.length, 1);
  s.leave(a.token);
  assert.equal(s.participants.has(a.token), false);
  assert.equal(s.world.instances.length, 0);
});

test('a late joiner\u2019s welcome includes the current world', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice', role: 'admin' });
  capture(s, a.token);
  s.handle(a.token, { type: 'deploy', vehicle: seekerDoc() });
  const late = s.join({ name: 'bob', role: 'participant' });
  const gotB = capture(s, late.token);
  s.sendWelcome(late.token);
  const w = gotB.find(m => m.type === 'welcome');
  assert.ok(w, 'late joiner receives a welcome');
  assert.equal(w.you.name, 'bob');
  assert.equal(w.you.role, 'participant');
  assert.equal(w.world.bots.length, 1, 'late joiner sees the existing bot');
});

test('shared elements are host-editable: add/move/remove broadcast the full list', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice', role: 'admin' });
  const b = s.join({ name: 'bob', role: 'participant' });
  const gotA = capture(s, a.token);
  const gotB = capture(s, b.token);

  // participants are refused (host-only); a centre-placed element is legal
  assert.equal(s.handle(b.token, { type: 'addElement', element: { type: 'rock', position: { x: 0, y: 0 } } }).type, 'error');
  const added = s.handle(a.token, { type: 'addElement', element: { type: 'light', position: { x: 0, y: 0 }, properties: { intensity: 500 } } });
  assert.equal(added.type, 'elementAdded');
  assert.ok(added.id, 'the host is told the assigned id');

  const moved = s.handle(a.token, { type: 'moveElement', id: added.id, x: -30, y: 70 });
  assert.equal(moved.type, 'elementMoved');
  assert.deepEqual(s.world.worldDoc.elements[0].position, { x: -30, y: 70 });

  const removed = s.handle(a.token, { type: 'removeElement', id: added.id });
  assert.equal(removed.type, 'elementRemoved');
  assert.equal(s.world.worldDoc.elements.length, 0);

  // every mutation reached EVERYONE (sender included; admin UI ignores its own echo)
  const lists = gotB.filter(m => m.type === 'elements').map(m => m.elements.length);
  assert.deepEqual(lists, [1, 1, 0], 'bob saw add (1), move (still 1), remove (0)');
  assert.equal(gotA.filter(m => m.type === 'elements').length, 3, 'host receives the same broadcasts');
});

test('setElements replaces the shared list (host seeds their world at host-time) and is host-only', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice', role: 'admin' });
  const b = s.join({ name: 'bob', role: 'participant' });
  const gotB = capture(s, b.token);
  capture(s, a.token);

  assert.equal(s.handle(b.token, { type: 'setElements', elements: [{ type: 'light', position: { x: 0, y: 0 } }] }).type, 'error', 'participants refused');
  const res = s.handle(a.token, { type: 'setElements', elements: [
    { id: 'l1', type: 'light', position: { x: -50, y: 0 }, properties: { intensity: 4000 } },
    { id: 'r1', type: 'rock', position: { x: 60, y: 20 }, properties: { radius: 40 } },
  ] });
  assert.equal(res.type, 'elementsSet');
  assert.equal(res.count, 2);
  assert.deepEqual(s.world.worldDoc.elements.map(e => e.id), ['l1', 'r1'], 'whole list replaced, not appended');
  const mirror = gotB.filter(m => m.type === 'elements').at(-1)?.elements;
  assert.equal(mirror.length, 2, 'joiner received the full seeded list');
  assert.deepEqual(s.handle(a.token, { type: 'setElements' }), { type: 'error', error: 'setElements requires an elements array' });
});

test('growing a fleet that has never deployed is refused (no ghost instances)', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice', role: 'admin' });
  const b = s.join({ name: 'bob', role: 'participant' });
  capture(s, a.token); capture(s, b.token);

  // bob has NOT deployed yet: the host cannot grow bob's fleet (it would mint null-vehicle bots)
  const rej = s.handle(a.token, { type: 'setCount', protoId: b.protoId, count: 2 });
  assert.equal(rej.type, 'error');
  assert.match(rej.error, /has not deployed a design yet/);
  assert.equal(s.world.instancesFor(b.protoId).length, 0, 'no instances minted');

  // once bob deploys, growing works as before
  s.handle(b.token, { type: 'deploy', vehicle: seekerDoc() });
  const ok = s.handle(a.token, { type: 'setCount', protoId: b.protoId, count: 2 });
  assert.equal(ok.type, 'countSet');
  assert.equal(s.world.instancesFor(b.protoId).length, 2);

  // shrinking never needs a deployed vehicle
  s.handle(a.token, { type: 'setCount', protoId: b.protoId, count: 0 });
  assert.equal(s.world.instancesFor(b.protoId).length, 0);
});
