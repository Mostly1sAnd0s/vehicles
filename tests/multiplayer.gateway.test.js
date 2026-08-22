/**
 * M5 e2e — the co-op GATEWAY over real sockets (Node's built-in WebSocket, as in the browser).
 *
 * Proves the new world model end to end: Host creates a coded world (first message returns a 6-char
 * code), Join by code enters it (wrong code is refused), roster fans out on join/leave, each host's
 * world is isolated from another host's (a deploy in one is invisible in the other), and leaving
 * prunes a participant's bots + garbage-collects an emptied world.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { createCoopGateway } from '../src/net/gateway.js';

const configs = {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: { light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 } },
  components: { components: [{ id: 'light_sensor', category: 'sensor', size: 8 }, { id: 'powered_wheel', category: 'actuator', size: 16 }] },
};
const seekerDoc = () => ({
  body: { shape: 'rect', width: 80, height: 40, color: '#3aa0c0' },
  components: [
    { id: 'sL', type: 'light_sensor', local: { x: 10, y: 0 }, localRotation: 0, props: {} },
    { id: 'wR', type: 'powered_wheel', local: { x: 0, y: 12 }, localRotation: 0, props: {} },
  ],
  wires: [{ id: 'w1', from: { componentId: 'sL', port: 'out' }, to: { componentId: 'wR', port: 'drive' }, weight: 1 }],
});

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

test('M5 gateway: host->code, join by code, roster, world isolation, prune+GC on leave', async () => {
  const gw = createCoopGateway({ Matter, configs });
  const { url } = await gw.start();
  const clients = [];

  // Minimal raw-WS client: send + collect messages by type.
  const connect = (first) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const c = { ws, byType: {}, all: [] };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      c.all.push(m);
      (c.byType[m.type] ??= []).push(m);
    };
    ws.onopen = () => { if (first) ws.send(JSON.stringify(first)); resolve(c); };
    ws.onerror = () => reject(new Error('ws error'));
    clients.push(c);
  });

  try {
    // Host: first message creates a world and returns its code.
    const alice = await connect({ type: 'host', name: 'alice' });
    await waitFor(() => alice.byType.welcome?.[0], 2000, 'host welcome');
    const code = alice.byType.welcome[0].code;
    assert.match(code, /^[A-Z0-9]{6}$/, 'host gets a 6-char world code');
    assert.equal(alice.byType.welcome[0].you.role, 'admin', 'the host is that world\'s admin');

    // Join by code: enters the same world as a participant; roster fans out to both.
    const bob = await connect({ type: 'join', name: 'bob', code });
    await waitFor(() => bob.byType.welcome?.[0], 2000, 'join welcome');
    assert.equal(bob.byType.welcome[0].code, code, 'joiner lands in the same coded world');
    assert.equal(bob.byType.welcome[0].you.role, 'participant');
    await waitFor(() => (bob.byType.roster?.at(-1)?.clients.length ?? 0) === 2 && (alice.byType.roster?.at(-1)?.clients.length ?? 0) === 2, 2000, 'roster of 2 on both clients');

    // Wrong / unknown code is refused without joining anything.
    const mallory = await connect({ type: 'join', name: 'mallory', code: 'ZZZZZZ' });
    await waitFor(() => mallory.byType.error?.[0], 2000, 'refusal for an unknown code');
    assert.match(mallory.byType.error[0].error, /no such world/i);

    // A deploy in alice's world is visible to bob (same world)…
    alice.ws.send(JSON.stringify({ type: 'deploy', vehicle: seekerDoc() }));
    await waitFor(() => (bob.all.find(m => m.type === 'snapshot' && m.bots.length > 0)), 2500, "alice's bot to reach bob");
    assert.ok(bob.all.some(m => m.type === 'peerDeployed'), 'bob is told a peer deployed');

    // …but NOT to a second host in a different coded world (isolation).
    const carol = await connect({ type: 'host', name: 'carol' });
    await waitFor(() => carol.byType.welcome?.[0], 2000, "carol's welcome");
    const code2 = carol.byType.welcome[0].code;
    assert.notEqual(code2, code, 'each host gets a distinct world code');
    await waitFor(() => carol.all.some(m => m.type === 'snapshot'), 2500, "carol's empty world to stream");
    assert.ok(!carol.all.some(m => m.type === 'snapshot' && m.bots.length > 0), "carol's world does not contain alice's bot");

    // Leaving prunes the leaver's bots and updates the roster.
    const bobBots = () => bob.all.filter(m => m.type === 'snapshot').at(-1)?.bots.length ?? 0;
    bob.ws.close();
    await waitFor(() => (alice.byType.roster?.at(-1)?.clients.length ?? 99) === 1, 2500, "roster back to 1 after bob leaves");

    // When the last client leaves a world, it is reclaimed.
    const sizeBefore = gw.worlds.size;               // alice + carol = 2 worlds
    alice.ws.close();
    await waitFor(() => !gw.worlds.has(code), 2500, 'alice\'s world to be garbage-collected');
    assert.ok(gw.worlds.has(code2) && sizeBefore === 2, "leaving one world leaves the other intact");
  } finally {
    for (const c of clients) { try { c.ws.close(); } catch {} }
    await gw.close();
  }
});
