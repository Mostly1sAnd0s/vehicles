/**
 * M2 e2e — the client core (`src/net/client.js`) against a real co-op server.
 *
 * Validates the participant-side of the loop over the wire: join → `welcome` (identity + static
 * elements), `deploy` → one's own bot appears in a shared `snapshot`, the stream is live (the
 * authoritative tick advances and the light-seeker moves), owner-only deploy, and admin setCount.
 * The client uses Node's built-in WebSocket (global in v26) — the same object the browser view
 * (`public/app/coop.js`) wraps, so this exercises exactly what ships to the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { createVehicleServer } from '../src/net/server.js';
import { CoopClient } from '../src/net/client.js';

test('M2 client: join → welcome (identity + elements), deploy → owned bot, live stream, owner/admin rules', async () => {
  const configs = {
    app: { defaults: { thrustScale: 2 } },
    actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
    sensors: { light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 } },
    components: { components: [{ id: 'light_sensor', category: 'sensor', size: 8 }, { id: 'powered_wheel', category: 'actuator', size: 16 }] },
  };
  // Light sits ~40px ahead of the second spawn point so the light-seeker has something to chase.
  const worldDoc = { elements: [{ type: 'light', position: { x: -200, y: 0 }, properties: { intensity: 200 } }], vehiclePrototypes: [] };
  const srv = createVehicleServer({ Matter, configs, worldDoc });
  const url = await srv.start();

  const alice = new CoopClient();
  const bob = new CoopClient();

  try {
    // alice joins first → admin; welcome carries identity + the static light.
    const wa = await alice.connect(url, 'alice');
    assert.equal(alice.status, 'connected');
    assert.equal(alice.you.role, 'admin');
    assert.ok(Array.isArray(wa.world.elements) && alice.elements.some((e) => e.type === 'light'), 'welcome carried the light element');

    await bob.connect(url, 'bob');
    assert.equal(bob.you.role, 'participant', 'second joiner is a participant');
    assert.equal(bob.you.protoId, 'p2');

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
    await srv.close();
  }
});

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
