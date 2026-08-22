import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import Matter from 'matter-js';
import { Session } from '../src/session.js';
import { createVehicleServer } from '../src/net/server.js';

// ---- shared fixtures (mirror tests/multiplayer.sim.test.js) --------------
const configs = {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: {
    light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 },
    distance: { model: 'raycast', defaultRange: 150, beamWidthDeg: 4, showBeam: true, output: 'normalized_inverse', inversionRef: 1 },
  },
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

// ---------------------------------------------------------------------------
// PART A — transport-agnostic Session (no sockets): fast, deterministic.
// ---------------------------------------------------------------------------
const makeSession = () => new Session({ Matter, configs, worldDoc: worldDoc() });
const capture = (s, token) => { const got = []; s.bind(token, (m) => got.push(m)); return got; };

test('M1 unit: first joiner is admin, others are participants', () => {
  const s = makeSession();
  assert.equal(s.join({ name: 'alice' }).role, 'admin');
  assert.equal(s.join({ name: 'bob' }).role, 'participant');
});

test('M1 unit: deploy is owner-only & spawns a clone owned by the deployer', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice' });
  const b = s.join({ name: 'bob' });
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

test('M1 unit: setCount & controls are admin-only; grown clones keep the owner', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice' });   // admin
  const b = s.join({ name: 'bob' });     // participant
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

test('M1 unit: stepOnce advances only when running; snapshot serializes', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice' }); capture(s, a.token);
  s.handle(a.token, { type: 'deploy', vehicle: seekerDoc() });
  assert.equal(s.stepOnce(), null, 'paused -> no snapshot');
  s.handle(a.token, { type: 'controls', command: 'start' });
  const snap = s.stepOnce();
  assert.ok(snap && snap.type === 'snapshot' && Array.isArray(snap.bots));
  JSON.parse(JSON.stringify(snap)); // must be wire-serializable
  s.handle(a.token, { type: 'controls', command: 'pause' });
  assert.equal(s.stepOnce(), null, 'paused again -> no snapshot');
});

test('M1 unit: leave removes a participant and all their clones', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice' }); capture(s, a.token);
  s.handle(a.token, { type: 'deploy', vehicle: seekerDoc() });
  assert.equal(s.world.instances.length, 1);
  s.leave(a.token);
  assert.equal(s.participants.has(a.token), false);
  assert.equal(s.world.instances.length, 0);
});

test('M1 unit: a late joiner\u2019s welcome includes the current world', () => {
  const s = makeSession();
  const a = s.join({ name: 'alice' }); capture(s, a.token);
  s.handle(a.token, { type: 'deploy', vehicle: seekerDoc() });
  const late = s.join({ name: 'bob' });
  const gotB = capture(s, late.token);
  s.sendWelcome(late.token);
  const w = gotB.find(m => m.type === 'welcome');
  assert.ok(w, 'late joiner receives a welcome');
  assert.equal(w.you.name, 'bob');
  assert.equal(w.you.role, 'participant');
  assert.equal(w.world.bots.length, 1, 'late joiner sees the existing bot');
});

// ---------------------------------------------------------------------------
// PART B — real WebSocket e2e: two participants over the wire.
// ---------------------------------------------------------------------------
const waitFor = (cond, what, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const id = setInterval(() => {
    if (cond()) { clearInterval(id); resolve(); }
    else if (Date.now() - t0 > ms) { clearInterval(id); reject(new Error(`timeout waiting for ${what}`)); }
  }, 20);
});

test('M1 e2e: two participants share one world over WebSocket', async () => {
  const srv = createVehicleServer({ Matter, configs, worldDoc: worldDoc() });
  const url = await srv.start();
  const clients = [];

  // Minimal client on Node's built-in WebSocket (browser-WebSocket spec).
  const connect = (name) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const c = { name, ws, got: [], welcome: null, deployed: null, snapshots: [], errors: [] };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      c.got.push(m);
      if (m.type === 'welcome') c.welcome = m;
      else if (m.type === 'deployed') c.deployed = m;
      else if (m.type === 'snapshot') c.snapshots.push(m);
      else if (m.type === 'error') c.errors.push(m);
    };
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'join', name })); resolve(c); };
    ws.onerror = () => reject(new Error('ws error'));
    clients.push(c);
  });

  try {
    const a = await connect('alice');   // first joiner -> admin
    const b = await connect('bob');     // participant
    await waitFor(() => a.welcome && b.welcome, 'both welcomes');
    assert.equal(a.welcome.you.role, 'admin');
    assert.equal(b.welcome.you.role, 'participant');

    // bob deploys; he gets an ack and alice learns via the broadcast.
    b.ws.send(JSON.stringify({ type: 'deploy', vehicle: seekerDoc() }));
    await waitFor(() => b.deployed && a.got.some(m => m.type === 'peerDeployed'), 'deploy visible to both');
    assert.equal(b.deployed.protoId, b.welcome.you.protoId);

    // admin starts the sim; both then receive a continuous stream of live snapshots.
    a.ws.send(JSON.stringify({ type: 'controls', command: 'start' }));
    await waitFor(() => a.snapshots.length >= 3 && b.snapshots.length >= 3, 'live snapshots to both clients');

    const bots = b.snapshots[b.snapshots.length - 1].bots;
    assert.equal(bots.length, 1, 'the shared world holds bob\u2019s one bot');
    assert.ok(bots[0].owner === 'bob');
    const t0 = b.snapshots[0].t, t1 = b.snapshots[b.snapshots.length - 1].t;
    assert.ok(t1 > t0, `snapshot tick advances over time (t ${t0} -> ${t1})`);
    // co-op = one shared world: both clients observe the same bot count.
    assert.equal(a.snapshots[a.snapshots.length - 1].bots.length, b.snapshots[b.snapshots.length - 1].bots.length);

    // permission enforced over the wire: bob (non-admin) cannot pause.
    b.ws.send(JSON.stringify({ type: 'controls', command: 'pause' }));
    await waitFor(() => b.errors.some(m => /admin/i.test(m.error)), 'bob gets a rejection for admin-only controls');
  } finally {
    for (const c of clients) c.ws.close();
    await srv.close();
  }
});
