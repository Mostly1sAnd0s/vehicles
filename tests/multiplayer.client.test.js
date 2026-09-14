/**
 * M2/M3 e2e — the client core (`src/net/client.js`) against a real co-op GATEWAY (the only
 * transport; the old single-world server was retired when M5 replaced it).
 *
 * Proves what the smoke test can't (browser only): the live client state machine — `you`,
 * ownership isolation across deploys, the authoritative running flag, snapshot tick advancing,
 * admin-only `setCount` refused over the wire for a participant, and reset restoring every bot to
 * its spawn with zero velocity. The host adds the light through the client's own `addElement`
 * (gateway worlds start empty), which also covers that command path end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { createCoopGateway } from '../src/net/gateway.js';
import CoopClient from '../src/net/client.js';

const configs = {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: { light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 } },
  components: { components: [{ id: 'light_sensor', category: 'sensor', size: 8 }, { id: 'powered_wheel', category: 'actuator', size: 16 }] },
};

test('isMine keys on the participant token; names are only the legacy fallback', () => {
  // Pure unit over the client state machine (the e2e below covers the wire itself).
  const c = new CoopClient();
  assert.equal(c.isMine({ owner: 'bob', ownerToken: 't9' }), false, 'unknown identity owns nothing');
  c.you = { name: 'bob', token: 't9' };
  assert.equal(c.isMine({ owner: 'bob', ownerToken: 't9' }), true);
  // same display name, different participant → NOT mine (the collision bug this fixes)
  assert.equal(c.isMine({ owner: 'bob', ownerToken: 't2' }), false, 'token beats a matching name');
  assert.equal(c.isMine({ owner: 'alice', ownerToken: 't9' }), true, 'token beats a mismatching name');
  // legacy sender without ownerToken falls back to the name
  assert.equal(c.isMine({ owner: 'bob' }), true, 'name fallback keeps old servers working');
  assert.equal(c.isMine({ owner: 'alice' }), false);
});

test('M2: client core against the gateway — join, deploy, live stream, admin-only setCount', async () => {
  const gw = createCoopGateway({ Matter, configs });
  const { url } = await gw.start();
  const alice = new CoopClient();
  const bob = new CoopClient();

  try {
    // Host → admin; the world starts empty, so the host plants the light through the client.
    await alice.connect(url, 'alice', { mode: 'host' });
    assert.equal(alice.status, 'connected');
    assert.equal(alice.you.role, 'admin');
    alice.addElement({ type: 'light', position: { x: -200, y: 0 }, properties: { intensity: 200 } });
    await waitFor(() => alice.elements.some((e) => e.type === 'light'), 1500, 'addElement to round-trip into client state');

    // Joiner: welcome carries identity AND the host-planted light.
    await bob.connect(url, 'bob', { mode: 'join', code: alice.code });
    assert.equal(bob.you.role, 'participant', 'joiner is a participant');
    assert.ok(bob.elements.some((e) => e.type === 'light'), 'welcome carried the light element');

    // Resizing the fleet is admin-only: participant bob is refused over the wire.
    let rej = null;
    bob.onMessage((m) => { if (m.type === 'error') rej = m; });
    bob.setCount(bob.you.protoId, 5);
    await waitFor(() => rej, 1500, 'setCount rejection for a non-admin');
    assert.equal(rej.error, 'setCount requires admin');

    // The owner deploys → their bot shows up in a shared snapshot.
    alice.onMessage((m) => { if (m.type === 'deployed') alice._deployed = m; });
    alice.deploy(seekerDoc());
    await waitFor(() => alice._deployed, 1500);
    await waitFor(() => bob.bots.length === 1, 2000, "bob's bot to appear in a snapshot");
    assert.ok(alice.bots.some((b) => b.owner === 'alice'), 'bot is owned by alice');

    // Live stream: the authoritative tick advances, and both participants observe the SAME world
    // (identical bot count) — the co-op invariant. (Tick, not pixels: motion depends on light
    // placement + sensor threshold; the stream is proven by the advancing authoritative tick.)
    const tBefore = bob.tick;
    alice.controls('start');
    await waitFor(() => bob.tick > tBefore, 3000, 'snapshot tick to advance after start');
    assert.equal(alice.bots.length, bob.bots.length, 'alice and bob share one world (same bot count)');

    // Admin setCount is honoured: the admin resizes the shared prototype's fleet, and every
    // participant's view updates to match.
    alice.setCount(alice.you.protoId, 3);
    await waitFor(() => bob.bots.length === 3, 2000, 'admin setCount(3) to expand the fleet in bob\u2019s view');
    assert.equal(bob.bots.length, 3);
  } finally {
    alice.close(); bob.close();
    await gw.close();
  }
});

test('M3: participant deploy (ownership isolation) + admin reset restores every bot to spawn', async () => {
  const gw = createCoopGateway({ Matter, configs });
  const { url } = await gw.start();
  const alice = new CoopClient(), bob = new CoopClient();
  try {
    // Light sits between the two spawn points (x=-360, x=-240) so BOTH light-seekers detect it
    // and drive hard — making the "reset restored them" check non-vacuous.
    await alice.connect(url, 'alice', { mode: 'host' });
    alice.addElement({ type: 'light', position: { x: -300, y: 0 }, properties: { intensity: 200 } });
    await waitFor(() => alice.elements.some((e) => e.type === 'light'), 1500, 'host light to plant');
    await bob.connect(url, 'bob', { mode: 'join', code: alice.code });

    // Both deploy their OWN design; the shared world holds two bots with distinct owners.
    alice.deploy(seekerDoc());
    await waitFor(() => bob.bots.length === 1, 2000, "alice's bot to appear");
    bob.deploy(seekerDoc());
    await waitFor(() => bob.bots.length === 2, 2000, 'both bots in the shared world');
    const owners = [...new Set(bob.bots.map((b) => b.owner))].sort();
    assert.deepEqual(owners, ['alice', 'bob'], 'ownership isolated: one distinct owner per deployed bot');
    assert.equal(bob.bots.filter((b) => b.owner === 'alice').length, 1, "bob's deploy did not touch alice's fleet");
    assert.equal(alice.bots.length, 2, 'alice observes the same shared world as bob');

    // Admin-only controls. Prove real motion first (both seekers drive toward the light), then
    // pause + reset and confirm every bot returns to its spawn point with zero velocity.
    const home = Object.fromEntries(bob.bots.map((b) => [b.id, { x: b.x, y: b.y }])); // == each proto's seed
    alice.controls('start');
    await waitFor(
      () => bob.bots.some((b) => { const h = home[b.id]; return h && Math.hypot(b.x - h.x, b.y - h.y) > 5; }),
      4000, 'a bot to drive away from its spawn while running',
    );
    alice.controls('pause');
    await waitFor(() => bob.running === false, 2000, 'pause to register (authoritative running=false)');
    alice.controls('reset');
    await waitFor(
      () => bob.bots.length === 2 &&
        bob.bots.every((b) => { const h = home[b.id]; return h && Math.hypot(b.x - h.x, b.y - h.y) < 1 && Math.hypot(b.vx, b.vy) < 0.01; }),
      2500, 'reset to restore every bot to its spawn with zero velocity',
    );
  } finally {
    alice.close(); bob.close();
    await gw.close();
  }
});

test('M5: host moveBot repositions a shared bot over the wire; a participant is refused', async () => {
  const gw = createCoopGateway({ Matter, configs });
  const { url } = await gw.start();
  const alice = new CoopClient(); // host -> admin
  const bob = new CoopClient();   // joiner -> participant
  try {
    await alice.connect(url, 'alice', { mode: 'host' });
    assert.equal(alice.you.role, 'admin');
    alice.deploy(seekerDoc());
    await waitFor(() => alice.bots.length === 1, 2000, "alice's bot to appear in a snapshot");

    await bob.connect(url, 'bob', { mode: 'join', code: alice.code });
    assert.equal(bob.you.role, 'participant');
    await waitFor(() => bob.bots.length === 1, 2000, 'bob to see the shared bot');
    const botId = bob.bots[0].id;

    // The sim is paused (no admin start), so a bot only moves when someone repositions it.
    // A participant's moveBot is refused over the wire — the server is the backstop, not just the UI.
    let rej = null;
    bob.onMessage((m) => { if (m.type === 'error' && /host|admin/i.test(m.error ?? '')) rej = m; });
    bob.moveBot(botId, 500, 300);
    await waitFor(() => rej, 1500, 'participant moveBot refusal over the wire');

    // The host's moveBot lands the bot at the new pose; the OTHER participant sees it in a snapshot.
    alice.moveBot(botId, 500, 300);
    await waitFor(
      () => { const b = bob.bots.find((x) => x.id === botId); return b && Math.abs(b.x - 500) < 1 && Math.abs(b.y - 300) < 1; },
      2500, 'the other participant to observe the host-repositioned bot',
    );
    const seen = bob.bots.find((x) => x.id === botId);
    assert.ok(Math.abs(seen.x - 500) < 1 && Math.abs(seen.y - 300) < 1, 'host moveBot must propagate to every participant');
  } finally {
    alice.close(); bob.close();
    await gw.close();
  }
});

test('M11: a Propagator conversion re-attributes a bot\u2019s lineage on the wire (both clients see it)', async () => {
  const gw = createCoopGateway({ Matter, configs });
  const { url } = await gw.start();
  const alice = new CoopClient();
  const bob = new CoopClient();
  try {
    await alice.connect(url, 'alice', { mode: 'host' });
    await bob.connect(url, 'bob', { mode: 'join', code: alice.code });
    // alice: the fittest design (carries a Propagator, 300 radius); bob: a plain one. The
    // default seeds are 120 apart, so starting the sim converts one of bob\u2019s bots at once.
    alice.deploy(propagatorDoc());
    bob.deploy(plainDoc());
    await waitFor(() => bob.bots.length === 2, 2000, 'both bots in the shared world');
    alice.controls('start');
    await waitFor(
      () => bob.bots.some((b) => b.protoId === bob.you.protoId && b.lineage === alice.you.protoId),
      4000, 'one of bob\u2019s bots to convert and ride the wire with alice\u2019s lineage',
    );
    const taken = bob.bots.find((b) => b.protoId === bob.you.protoId && b.lineage === alice.you.protoId);
    assert.ok(taken, 'bob\u2019s converted bot rides the wire with alice\u2019s lineage');
    assert.equal(taken.protoId, bob.you.protoId, 'the bot still BELONGS to bob \u2014 only the count moved');
    assert.equal(taken.owner, 'bob', 'the popup/ownership label is untouched');
    assert.equal(taken.ownerToken, bob.you.token, 'identity keys on the (unmoved) token');
    // alice\u2019s client sees the same re-attribution (one authoritative world).
    assert.ok(
      alice.bots.some((b) => b.protoId === bob.you.protoId && b.lineage === alice.you.protoId),
      'alice\u2019s client counts the converted bot the same way',
    );
  } finally {
    alice.close(); bob.close();
    await gw.close();
  }
});

function propagatorDoc() {
  const d = seekerDoc();
  d.components.push({ id: 'prop', type: 'propagate', local: { x: 0, y: 0 }, localRotation: 0, props: { threshold: 300 } });
  return d;
}

function plainDoc() {
  const d = seekerDoc();
  d.body.color = '#33cc33'; // a genuinely different configuration
  return d;
}

function seekerDoc() {
  return {
    body: { shape: 'rect', width: 80, height: 40, color: '#3aa0c0' },
    components: [
      { id: 'sL', type: 'light_sensor', local: { x: 10, y: 0 }, localRotation: 0, props: {} },
      { id: 'wR', type: 'powered_wheel', local: { x: 0, y: 12 }, localRotation: 0, props: {} },
    ],
    wires: [{ id: 'w1', from: { componentId: 'sL', port: 'out' }, to: { componentId: 'wR', port: 'drive' }, weight: 1 }],
  };
}

function waitFor(cond, ms = 2500, label = 'condition') {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let v; try { v = cond(); } catch { v = false; }
      if (v) { clearInterval(iv); res(v); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout waiting for: ' + label)); }
    }, 25);
  });
}
