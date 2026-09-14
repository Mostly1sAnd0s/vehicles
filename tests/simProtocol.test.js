import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { HeadlessWorld } from '../src/simulation/worldSim.js';
import { createProtocolState, applyCommand } from '../src/simulation/simProtocol.js';

// The protocol is the ONLY engine surface single-player will have (on the main thread via
// LocalBridge, off it via a Worker — one protocol, two transports). These tests drive a
// REAL HeadlessWorld with the exact messages the page sends, so worker semantics are
// tested in Node without a browser.

const baseConfigs = () => JSON.parse(JSON.stringify(globalThis.__cfgs));
import { readFileSync } from 'node:fs';
globalThis.__cfgs = {
  app: JSON.parse(readFileSync(new URL('../config/app.json', import.meta.url))),
  components: JSON.parse(readFileSync(new URL('../config/components.json', import.meta.url))),
  sensors: JSON.parse(readFileSync(new URL('../config/sensors.json', import.meta.url))),
  actuators: JSON.parse(readFileSync(new URL('../config/actuators.json', import.meta.url))),
};

const wheelVehicle = ({ detection = false, propagate = false } = {}) => ({
  body: { width: 60, height: 40 },
  components: [
    { id: 'w1', type: 'powered_wheel', local: { x: -20, y: -22 } },
    { id: 'w2', type: 'powered_wheel', local: { x: -20, y: 22 } },
    ...(detection ? [{ id: 'v1', type: 'vehicle_detection_sensor', local: { x: 0, y: 0 }, props: { range: 300 } }] : []),
    ...(propagate ? [{ id: 'pg', type: 'propagate', local: { x: 0, y: 0 }, props: { threshold: 260 } }] : []),
  ],
  wires: [
    { from: { componentId: 'w1' }, to: { componentId: 'w1' }, polarity: 1, weight: 1 },
  ],
});

function newWorld() {
  const world = new HeadlessWorld({ Matter, configs: baseConfigs(), worldDoc: { elements: [], vehiclePrototypes: [] } });
  return { world, pstate: createProtocolState() };
}

const initMsg = (over = {}) => ({
  op: 'init',
  seq: 1,
  dtMs: 16.6,
  elements: [],
  vehicles: [{ id: 'p1', name: 'A', vehicle: wheelVehicle() }],
  instances: [
    { id: 'i1', protoId: 'p1', seed: { x: 0, y: 0, rotation: 0 } },
    { id: 'i2', protoId: 'p1', seed: { x: 300, y: 0, rotation: Math.PI / 2 } },
  ],
  ...over,
});

test('init builds the world and replies with every bot at its seed pose', () => {
  const { world, pstate } = newWorld();
  const r = applyCommand(world, pstate, initMsg());
  assert.equal(r.op, 'reply');
  assert.equal(r.ack, 'init');
  assert.equal(r.seq, 1);
  assert.equal(r.bots.length, 2);
  const b1 = r.bots.find(b => b.id === 'i1');
  assert.equal(b1.x, 0); assert.equal(b1.y, 0); assert.equal(b1.angle, 0);
  const b2 = r.bots.find(b => b.id === 'i2');
  assert.equal(b2.x, 300); assert.equal(b2.angle, Math.PI / 2);
  assert.equal(world.instances.length, 2);
});

test('step advances the engine n times and replies with fresh poses', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  const r = applyCommand(world, pstate, { op: 'step', n: 5, detail: true });
  assert.equal(r.t, 5);
  // detail: sensor samples ride along for the beams/readout renderers
  assert.ok(Array.isArray(r.bots[0].samples));
  assert.ok(Array.isArray(r.bots[0].motors));
});

test('step with detail=false omits samples and motors (payload control at fleet scale)', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  const r = applyCommand(world, pstate, { op: 'step', n: 1, detail: false });
  assert.equal(r.bots[0].samples, undefined);
  assert.equal(r.bots[0].motors, undefined);
  // pose fields still arrive — the renderer always needs them
  assert.ok(Number.isFinite(r.bots[0].x));
});

test('step n is clamped: a runaway accumulator cannot melt the transport', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'step', n: 10_000_000 });
  assert.ok(world.tick <= 200, `tick should be clamped, got ${world.tick}`);
});

test('move teleports a bot, zeroes momentum, and the reply carries just the moved bot', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'step', n: 30 });
  // give i2 some speed first
  const body = world.instances.find(i => i.id === 'i2').body;
  Matter.Body.setVelocity(body, { x: 4, y: 0 });
  const r = applyCommand(world, pstate, { op: 'move', id: 'i2', x: -500, y: 250 });
  assert.equal(r.bots.length, 1);
  assert.equal(r.bots[0].id, 'i2');
  assert.equal(r.bots[0].x, -500);
  assert.equal(r.bots[0].vx, 0); // momentum zeroed — a dragged bot must not fling
});

test('move then reset returns the bot to the MOVED pose (the drop becomes the seed)', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'move', id: 'i1', x: 111, y: 222, rot: 0.5 });
  applyCommand(world, pstate, { op: 'step', n: 20 });
  applyCommand(world, pstate, { op: 'reset' });
  const b1 = world.instances.find(i => i.id === 'i1');
  assert.equal(b1.body.position.x, 111);
  assert.equal(b1.body.position.y, 222);
  assert.equal(b1.body.angle, 0.5);
});

test('move for an unknown id is a no-op, not a throw', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  const r = applyCommand(world, pstate, { op: 'move', id: 'ghost', x: 1, y: 1 });
  assert.equal(r.ack, 'move');
});

test('sync adds and removes instances while untouched bots keep their pose', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'step', n: 10 });
  const before = world.instances.find(i => i.id === 'i2').body.position;
  const bx = before.x, by = before.y;
  const r = applyCommand(world, pstate, {
    op: 'sync',
    instances: [
      { id: 'i1', protoId: 'p1', seed: { x: 0, y: 0, rotation: 0 } },
      { id: 'i2', protoId: 'p1', seed: { x: 300, y: 0, rotation: Math.PI / 2 } },
      { id: 'i3', protoId: 'p1', seed: { x: 777, y: 33, rotation: 0 } }, // NEW
      // i1 removal tested next; here: i2 untouched
    ],
  });
  assert.equal(r.bots.length, 3);
  const b2 = world.instances.find(i => i.id === 'i2');
  assert.equal(b2.body.position.x, bx); // pose preserved — sync is a diff, not a rebuild
  assert.equal(b2.body.position.y, by);
  const b3 = world.instances.find(i => i.id === 'i3');
  assert.equal(b3.body.position.x, 777); // new bot spawns at its seed
});

test('sync removes instances that left the page (and their path history)', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'step', n: 3, trackPaths: true });
  applyCommand(world, pstate, { op: 'sync', instances: [{ id: 'i1', protoId: 'p1', seed: { x: 0, y: 0, rotation: 0 } }] });
  assert.equal(world.instances.length, 1);
  assert.equal(world.instances[0].id, 'i1');
  assert.equal(pstate.paths.has('i2'), false); // bookkeeping went with the body
});

test('sync swaps a vehicle doc and running bots rebuild with momentum preserved', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  const body = world.instances.find(i => i.id === 'i1').body;
  Matter.Body.setVelocity(body, { x: 3, y: 1 });
  const movedVehicle = wheelVehicle({ detection: true }); // geometry change -> rebuild
  applyCommand(world, pstate, { op: 'sync', vehicles: [{ id: 'p1', vehicle: movedVehicle }] });
  const nb = world.instances.find(i => i.id === 'i1').body;
  assert.notEqual(nb, body); // rebuilt
  assert.ok(Math.abs(nb.velocity.x - 3) < 1e-9); // edits never stop a moving car
  assert.ok(nb.position); // and the pose carried over
  assert.equal(world.vehicleFor(world.instances.find(i => i.id === 'i1')).components.length, movedVehicle.components.length);
});

test('sync replaces elements and rebuilds obstacle bodies', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'sync', elements: [{ id: 'e1', type: 'rock', primitive: 'circle', position: { x: 10, y: 10 }, properties: { radius: 30 } }] });
  assert.equal(world.obstacleBodies.length, 1);
});

test('paths: step records per-bot points and delivers each point exactly once', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  const r1 = applyCommand(world, pstate, { op: 'step', n: 3, trackPaths: true });
  assert.ok(r1.path.i1, 'path points expected for i1');
  assert.equal(r1.path.i1.length, 3);
  const r2 = applyCommand(world, pstate, { op: 'step', n: 2, trackPaths: true });
  assert.equal(r2.path.i1.length, 2, 'only NEW points ride the next reply');
});

test('paths: recording only runs while trackPaths is on (no hidden work by default)', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'step', n: 5 }); // trackPaths omitted
  assert.equal(pstate.paths.size, 0);
  const r = applyCommand(world, pstate, { op: 'step', n: 1, trackPaths: true });
  assert.equal(r.path.i1.length, 1, 'recording starts when the page flips the toggle on');
});

test('paths: pending history is capped (a week-long run cannot mint unbounded points)', () => {
  const { world } = newWorld();
  const pstate = createProtocolState({ pathCap: 10 });
  applyCommand(world, pstate, initMsg());
  const r = applyCommand(world, pstate, { op: 'step', n: 50, trackPaths: true });
  assert.equal(r.path.i1.length, 10);
});

test('reset clears path bookkeeping', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'step', n: 3, trackPaths: true });
  applyCommand(world, pstate, { op: 'reset' });
  assert.equal(pstate.paths.size, 0);
  const r = applyCommand(world, pstate, { op: 'step', n: 1, trackPaths: true });
  assert.equal(r.path.i1.length, 1); // a fresh trail, not a continuation
});

test('conversion events: a Propagator host converts a neighbour and the reply names it', () => {
  const world = new HeadlessWorld({
    Matter, configs: baseConfigs(),
    worldDoc: {
      elements: [],
      vehiclePrototypes: [
        { id: 'host', name: 'H', vehicle: wheelVehicle({ propagate: true }), instances: [] },
        { id: 'plain', name: 'P', vehicle: wheelVehicle(), instances: [] },
      ],
    },
  });
  const pstate = createProtocolState();
  applyCommand(world, pstate, {
    op: 'init',
    vehicles: [
      { id: 'host', vehicle: wheelVehicle({ propagate: true }) },
      { id: 'plain', vehicle: wheelVehicle() },
    ],
    instances: [
      { id: 'h1', protoId: 'host', seed: { x: 0, y: 0, rotation: 0 } },
      { id: 'p1', protoId: 'plain', seed: { x: 60, y: 0, rotation: 0 } },
    ],
  });
  const r = applyCommand(world, pstate, { op: 'step', n: 1 });
  const ev = r.events.find(e => e.id === 'p1');
  assert.ok(ev, 'expected a converted event for p1');
  assert.ok(ev.vehicle, 'the event carries the full converted vehicle doc for the page to mirror');
  assert.equal(r.convertedCount, 1);
  // events drain exactly once: the next reply must not repeat them
  const r2 = applyCommand(world, pstate, { op: 'step', n: 1 });
  assert.equal(r2.events.find(e => e.id === 'p1'), undefined);
});

test('reset drains conversion events and zeroes the converted counter', () => {
  const world = new HeadlessWorld({
    Matter, configs: baseConfigs(),
    worldDoc: {
      elements: [],
      vehiclePrototypes: [
        { id: 'host', name: 'H', vehicle: wheelVehicle({ propagate: true }), instances: [] },
        { id: 'plain', name: 'P', vehicle: wheelVehicle(), instances: [] },
      ],
    },
  });
  const pstate = createProtocolState();
  applyCommand(world, pstate, {
    op: 'init',
    vehicles: [
      { id: 'host', vehicle: wheelVehicle({ propagate: true }) },
      { id: 'plain', vehicle: wheelVehicle() },
    ],
    instances: [
      { id: 'h1', protoId: 'host', seed: { x: 0, y: 0, rotation: 0 } },
      { id: 'p1', protoId: 'plain', seed: { x: 60, y: 0, rotation: 0 } },
    ],
  });
  applyCommand(world, pstate, { op: 'step', n: 1 });
  const r = applyCommand(world, pstate, { op: 'reset' });
  assert.equal(r.convertedCount, 0);
  assert.equal(r.events.length, 0, 'a pre-reset conversion must not replay onto the fresh world');
});

test('snapshot replies with current poses and no tick advance', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'step', n: 4 });
  const r = applyCommand(world, pstate, { op: 'snapshot', detail: true });
  assert.equal(r.t, 4);
  assert.equal(r.bots.length, 2);
  assert.equal(world.tick, 4);
});

test('unknown ops are ignored, not fatal', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  const r = applyCommand(world, pstate, { op: 'what-is-this' });
  assert.equal(r, null);
});

test('sync refreshes engine seeds WITHOUT moving live bodies (reset target follows the page)', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'step', n: 5 });
  const body = world.instances.find(i => i.id === 'i1').body;
  const px = body.position.x, py = body.position.y;
  applyCommand(world, pstate, {
    op: 'sync',
    instances: [
      { id: 'i1', protoId: 'p1', seed: { x: -400, y: -400, rotation: 1 } }, // seed moved (arrange buttons)
      { id: 'i2', protoId: 'p1', seed: { x: 300, y: 0, rotation: Math.PI / 2 } },
    ],
  });
  assert.equal(world.instances.find(i => i.id === 'i1').body.position.x, px); // NOT teleported
  assert.equal(world.instances.find(i => i.id === 'i1').seed.x, -400);        // reset target updated
  applyCommand(world, pstate, { op: 'reset' });
  assert.equal(world.instances.find(i => i.id === 'i1').body.position.x, -400); // lands where the page says
});

test('reset can carry seeds directly (arrange-then-reset in one round trip)', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  applyCommand(world, pstate, { op: 'step', n: 10 });
  applyCommand(world, pstate, { op: 'reset', seeds: { i1: { x: 900, y: 900, rotation: 0 } } });
  const b1 = world.instances.find(i => i.id === 'i1');
  assert.equal(b1.body.position.x, 900);
  assert.equal(b1.seed.x, 900);
  // untouched instance returns to its own seed
  assert.equal(world.instances.find(i => i.id === 'i2').body.position.x, 300);
});

test('sync with a prop-driven geometry change (collisionRadius via props) rebuilds the body', () => {
  const { world, pstate } = newWorld();
  applyCommand(world, pstate, initMsg());
  const withProps = wheelVehicle();
  withProps.components.push({ id: 'cs', type: 'sensor_mount', local: { x: 10, y: 0 }, props: { radius: 30 } });
  applyCommand(world, pstate, { op: 'sync', vehicles: [{ id: 'p1', vehicle: withProps }] });
  const geoSig = world.instances.find(i => i.id === 'i1').geoSig;
  assert.ok(geoSig.includes('30'), 'props must be part of the geometry signature (the browser engine had this; the headless one must not regress it)');
  // and shrinking back rebuilds again
  withProps.components.find(c => c.id === 'cs').props.radius = 5;
  applyCommand(world, pstate, { op: 'sync', vehicles: [{ id: 'p1', vehicle: withProps }] });
  assert.ok(world.instances.find(i => i.id === 'i1').geoSig.includes('5'));
});

test('reply bots carry their lineage, and a conversion re-attributes it (single-player scoreboard parity)', () => {
  const { world, pstate } = newWorld();
  const ri = applyCommand(world, pstate, {
    op: 'init', seq: 1, dtMs: 16.6, elements: [],
    vehicles: [
      { id: 'p1', name: 'A', vehicle: wheelVehicle({ propagate: true }) },
      { id: 'p2', name: 'B', vehicle: wheelVehicle() },
    ],
    instances: [
      { id: 'i1', protoId: 'p1', seed: { x: 0, y: 0, rotation: 0 } },
      { id: 'i2', protoId: 'p2', seed: { x: 80, y: 0, rotation: 0 } }, // inside the 260 threshold
    ],
  });
  // Origin: the init reply (before any step) reports each bot under its own proto.
  assert.equal(ri.bots.find(b => b.id === 'i1').lineage, 'p1', 'unconverted bot reports its own proto');
  assert.equal(ri.bots.find(b => b.id === 'i2').lineage, 'p2');
  let r = applyCommand(world, pstate, { op: 'step', n: 1, detail: false });
  for (let k = 0; k < 5 && r.bots.find(b => b.id === 'i2')?.lineage !== 'p1'; k++) {
    r = applyCommand(world, pstate, { op: 'step', n: 1, detail: false });
  }
  assert.equal(r.bots.find(b => b.id === 'i2').lineage, 'p1', 'the converted bot\u2019s reply lineage follows the converter');
  assert.equal(r.bots.find(b => b.id === 'i2').protoId, 'p2', 'protoId is the protocol\u2019s identity field: it never moves');
  // a reset reply restores the origin lineage, like the engine does.
  const rr = applyCommand(world, pstate, { op: 'reset', detail: false });
  assert.equal(rr.bots.find(b => b.id === 'i2').lineage, 'p2');
});
