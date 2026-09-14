/**
 * Propagation lineage — engine + session integration.
 *
 * The pure rules are unit-tested in tests/lineage.test.js; here we prove the WIRING:
 * HeadlessWorld adopts the converter's lineage when a conversion fires, carries it on the
 * snapshot, and restores it on reset — and the Session puts it on the wire (unchanged by
 * roundBot, tagged beside ownerToken) so the fleet scoreboard (lineageCounts over the wire
 * bots) moves when — and only when — the simulation converts a bot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { HeadlessWorld } from '../src/simulation/worldSim.js';
import { Session } from '../src/session.js';
import { lineageOf, lineageCounts } from '../src/models/lineage.js';

// Test-only config (same shape as tests/multiplayer.sim.test.js). No light elements in these
// worlds, so the light sensors read 0 and every bot stays parked — conversions fire purely on
// proximity, which is what makes the assertions deterministic.
const configs = {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: {
    light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 },
  },
  components: { components: [
    { id: 'light_sensor', category: 'sensor', size: 8 },
    { id: 'powered_wheel', category: 'actuator', size: 16 },
  ] },
};

// The "fittest" design: a light-seeker that also carries a Propagator (radius 300, no cap).
function propagatorDoc() {
  return {
    body: { shape: 'rect', width: 80, height: 40, color: '#cc3333' },
    components: [
      { id: 'sL', type: 'light_sensor', local: { x: 10, y: 0 }, localRotation: 0, props: {} },
      { id: 'wR', type: 'powered_wheel', local: { x: 0, y: 12 }, localRotation: 0, props: {} },
      { id: 'prop', type: 'propagate', local: { x: 0, y: 0 }, localRotation: 0, props: { threshold: 300 } },
    ],
    wires: [{ id: 'w1', from: { componentId: 'sL', port: 'out' }, to: { componentId: 'wR', port: 'drive' }, weight: 1 }],
  };
}

// The "prey": the same seeker without the Propagator (a genuinely different signature).
function plainDoc() {
  return {
    body: { shape: 'rect', width: 80, height: 40, color: '#33cc33' },
    components: [
      { id: 'sL', type: 'light_sensor', local: { x: 10, y: 0 }, localRotation: 0, props: {} },
      { id: 'wR', type: 'powered_wheel', local: { x: 0, y: 12 }, localRotation: 0, props: {} },
    ],
    wires: [{ id: 'w1', from: { componentId: 'sL', port: 'out' }, to: { componentId: 'wR', port: 'drive' }, weight: 1 }],
  };
}

function makeWorld(protos) {
  const worldDoc = {
    elements: [],
    vehiclePrototypes: Object.entries(protos).map(([id, v]) => ({ id, name: id, vehicle: v, _vehicle: v, instances: [] })),
  };
  return new HeadlessWorld({ Matter, dtMs: 16.6, configs, worldDoc });
}

const byId = sim => Object.fromEntries(sim.instances.map(i => [i.id, i]));
const snapBots = sim => JSON.parse(JSON.stringify(sim.snapshot())).bots;

test('lineage starts as the bot\u2019s own proto and rides the snapshot', () => {
  const sim = makeWorld({ a: propagatorDoc(), b: plainDoc() });
  sim.addInstance({ id: 'a1', protoId: 'a', seed: { x: 0, y: 0, rotation: 0 }, owner: 'alice' });
  sim.addInstance({ id: 'b1', protoId: 'b', seed: { x: 500, y: 0, rotation: 0 }, owner: 'bob' });
  assert.equal(lineageOf(sim.instances[0]), 'a');
  assert.equal(lineageOf(sim.instances[1]), 'b');
  assert.deepEqual(snapBots(sim).map(b => b.lineage).sort(), ['a', 'b'], 'unconverted bots ride the wire with their own proto');
});

test('a conversion re-attributes the bot to the converter\u2019s proto \u2014 and only that bot', () => {
  const sim = makeWorld({ a: propagatorDoc(), b: plainDoc() });
  sim.addInstance({ id: 'a1', protoId: 'a', seed: { x: 0, y: 0, rotation: 0 }, owner: 'alice' });
  sim.addInstance({ id: 'a2', protoId: 'a', seed: { x: 3000, y: 0, rotation: 0 }, owner: 'alice' });
  sim.addInstance({ id: 'b1', protoId: 'b', seed: { x: 60, y: 0, rotation: 0 }, owner: 'bob' });   // in range
  sim.addInstance({ id: 'b2', protoId: 'b', seed: { x: 7000, y: 0, rotation: 0 }, owner: 'bob' }); // out of range of BOTH propagators
  sim.step();
  const i = byId(sim);
  assert.equal(i.b1.converted, true, 'the in-range prey converts on the first step');
  assert.equal(lineageOf(i.b1), 'a', 'the converted bot now counts for the converter');
  assert.equal(i.b1.protoId, 'b', 'ownership did NOT move: the protoId stays with the deployer');
  assert.equal(i.b1.owner, 'bob', '…and neither does the owner tag (popups/deploy/prune keep working)');
  assert.equal(lineageOf(i.b2), 'b', 'the out-of-range prey is untouched');
  assert.equal(lineageOf(i.a1), 'a');
  assert.equal(lineageOf(i.a2), 'a');
  // The scoreboard: alice 2 → 3, bob 2 → 1 (the user's 11/9 case, at test scale).
  assert.deepEqual(lineageCounts(snapBots(sim)), { a: 3, b: 1 });
});

test('lineage is transitive: the chain A→B→C counts for A, not for the middle bot', () => {
  const sim = makeWorld({ a: propagatorDoc(), b: plainDoc(), c: plainDoc() });
  sim.addInstance({ id: 'a1', protoId: 'a', seed: { x: 0, y: 0, rotation: 0 } });
  sim.addInstance({ id: 'b1', protoId: 'b', seed: { x: 250, y: 0, rotation: 0 } }); // 250 < 300 from a1
  sim.addInstance({ id: 'c1', protoId: 'c', seed: { x: 500, y: 0, rotation: 0 } }); // 500 from a1 (out of range), 250 from b1
  for (let k = 0; k < 10 && !byId(sim).c1.converted; k++) sim.step();
  const i = byId(sim);
  assert.equal(i.c1.converted, true, 'the chain reached c1 within ten steps');
  assert.equal(lineageOf(i.c1), 'a', 'c1 counts for A — not for b1, which was itself a converted clone');
  assert.deepEqual(lineageCounts(snapBots(sim)), { a: 3 });
});

test('reset restores the origin lineage (the scoreboard returns to the initial mix)', () => {
  const sim = makeWorld({ a: propagatorDoc(), b: plainDoc() });
  sim.addInstance({ id: 'a1', protoId: 'a', seed: { x: 0, y: 0, rotation: 0 } });
  sim.addInstance({ id: 'b1', protoId: 'b', seed: { x: 60, y: 0, rotation: 0 } });
  sim.step();
  assert.equal(lineageOf(byId(sim).b1), 'a');
  sim.reset();
  const i = byId(sim);
  assert.equal(i.b1.converted, false);
  assert.equal(i.b1.vehicleOverride, null);
  assert.equal(lineageOf(i.b1), 'b', 'lineage restores exactly as the design override does');
  assert.deepEqual(lineageCounts(snapBots(sim)), { a: 1, b: 1 });
});

// ---- Session: the wire ------------------------------------------------------

function makeSession() {
  const session = new Session({ Matter, configs, worldDoc: { elements: [], vehiclePrototypes: [] } });
  const alice = session.join({ name: 'Alice', role: 'admin' });
  const bob = session.join({ name: 'Bob', role: 'participant' });
  return { session, alice, bob };
}

test('session: a conversion rides the wire and moves the fleet count (the 11/9 case, over the protocol)', () => {
  const { session, alice, bob } = makeSession();
  assert.equal(session.handle(alice.token, { type: 'deploy', vehicle: propagatorDoc() }).type, 'deployed');
  assert.equal(session.handle(bob.token, { type: 'deploy', vehicle: plainDoc() }).type, 'deployed');
  // Grow both fleets to 2 (the user's 10v10, at test scale).
  session.handle(alice.token, { type: 'setCount', protoId: alice.protoId, count: 2 });
  session.handle(alice.token, { type: 'setCount', protoId: bob.protoId, count: 2 });
  let wire = session.currentSnapshotWire();
  assert.deepEqual(lineageCounts(wire.bots), { [alice.protoId]: 2, [bob.protoId]: 2 });

  // setCount stacks the second clone on the first (same seed), so park bob's spare far away:
  // exactly ONE of bob's bots sits inside the Propagator's 300 radius of alice's (the seeds are
  // 120 apart), which is what makes the final scoreboard 3/1 instead of 4/0.
  const bobBots = wire.bots.filter(b => b.protoId === bob.protoId);
  assert.equal(bobBots.length, 2);
  session.handle(alice.token, { type: 'moveBot', id: bobBots[1].id, x: 2000, y: 0 });
  wire = session.currentSnapshotWire();

  session.handle(alice.token, { type: 'controls', command: 'start' });
  for (let k = 0; k < 30 && lineageCounts(session.currentSnapshotWire().bots)[bob.protoId] >= 2; k++) {
    session.stepOnce();
  }
  wire = session.currentSnapshotWire();
  const counts = lineageCounts(wire.bots);
  assert.equal(counts[bob.protoId], 1, 'one of bob\u2019s bots converted away');
  assert.equal(counts[alice.protoId], 3, 'alice\u2019s row gained it (2 → 3)');
  const taken = wire.bots.find(b => b.protoId === bob.protoId && b.lineage === alice.protoId);
  assert.ok(taken, 'the converted bot carries the converter\u2019s lineage on the wire');
  assert.equal(taken.ownerToken, bob.token, 'ownership (token) did NOT move with the count');
  assert.equal(taken.owner, 'Bob');
  // roundBot spreads the bot: the lineage string must survive the wire rounding intact.
  assert.equal(typeof taken.lineage, 'string');

  // A Reset (the world is running; pause first, as the UI does) restores the scoreboard.
  session.handle(alice.token, { type: 'controls', command: 'pause' });
  session.handle(alice.token, { type: 'controls', command: 'reset' });
  const restored = lineageCounts(session.currentSnapshotWire().bots);
  assert.deepEqual(restored, { [alice.protoId]: 2, [bob.protoId]: 2 }, 'reset restores the initial mix');
});
