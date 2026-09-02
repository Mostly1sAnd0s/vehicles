import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { bumperProps, bumperAnchorsFor, bumperForce, bumperForceOnRing, applyBumperForces, BUMPER_DEFAULTS } from '../src/simulation/bumpers.js';
import { HeadlessWorld } from '../src/simulation/worldSim.js';

// ---------------- bumperProps ----------------

test('bumperProps: falls back to defaults when the component carries no props', () => {
  assert.deepEqual(bumperProps({ type: 'bumper' }), { radius: BUMPER_DEFAULTS.radius, density: BUMPER_DEFAULTS.density });
});

test('bumperProps: per-instance props win over the def defaults', () => {
  const c = { type: 'bumper', props: { radius: 70, density: 0.5 } };
  assert.deepEqual(bumperProps(c, { defaults: { radius: 25, density: 1 } }), { radius: 70, density: 0.5 });
});

test('bumperProps: clamps radius to a positive floor and density to >= 0', () => {
  assert.ok(bumperProps({ props: { radius: 0 } }).radius >= 0.1);
  assert.ok(bumperProps({ props: { radius: -5 } }).radius >= 0.1);
  assert.equal(bumperProps({ props: { density: -3 } }).density, 0);
  assert.ok(Number.isFinite(bumperProps({ props: { radius: 'x' } }).radius));
});

// ---------------- bumperAnchorsFor ----------------

test('bumperAnchorsFor: skips non-bumper components and parts without a local pos', () => {
  const v = { components: [
    { id: 'w', type: 'powered_wheel', local: { x: 0, y: 10 } },
    { id: 'b1', type: 'bumper' },                                   // no local
    { id: 'b2', type: 'bumper', local: { x: 0, y: 0 }, props: {} },
  ] };
  const body = { position: { x: 50, y: 20 }, angle: 0 };
  const anchors = bumperAnchorsFor(v, body);
  assert.equal(anchors.length, 1);
  assert.deepEqual(anchors[0].anchor, { x: 50, y: 20 });
  assert.equal(anchors[0].radius, BUMPER_DEFAULTS.radius);
  assert.equal(anchors[0].density, BUMPER_DEFAULTS.density);
});

test('bumperAnchorsFor: rotates the local offset by the body angle', () => {
  // bumper 10px "ahead" of a body rotated 90° -> 10px to the +y side in world space
  const v = { components: [{ id: 'b', type: 'bumper', local: { x: 10, y: 0 }, props: { radius: 40, density: 2 } }] };
  const body = { position: { x: 100, y: 50 }, angle: Math.PI / 2 };
  const [a] = bumperAnchorsFor(v, body);
  assert.ok(Math.abs(a.anchor.x - 100) < 1e-9, `anchor.x ${a.anchor.x}`);
  assert.ok(Math.abs(a.anchor.y - 60) < 1e-9, `anchor.y ${a.anchor.y}`);
  assert.equal(a.radius, 40);
  assert.equal(a.density, 2);
});

// ---------------- bumperForce (pure geometry) ----------------

const ring = (anchor = { x: 0, y: 0 }, radius = 50, density = 1) => ({ anchor, radius, density });
const boxBody = (cx, cy, hw = 10, hh = 5) => ({
  position: { x: cx, y: cy },
  vertices: [
    { x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh }, { x: cx - hw, y: cy + hh },
  ],
});

test('bumperForce: a body fully outside the ring feels nothing', () => {
  assert.equal(bumperForce(ring(), boxBody(120, 0)), null);
});

test('bumperForce: hollow — a body whose CENTER is inside the ring feels nothing', () => {
  // center at (10,0) is inside R=50; one vertex crosses the surface but the interior is passable
  assert.equal(bumperForce(ring(), boxBody(10, 0, 45, 5)), null);
  assert.equal(bumperForce(ring(), boxBody(0, 0, 60, 60)), null); // centered on the anchor
});

test('bumperForce: a crossing body is pushed outward, F = scale * density * penetration', () => {
  // body center (100,0) is outside R=50; nearest vertex (45,0) is 5px inside the surface
  const r = bumperForce(ring({ x: 0, y: 0 }, 50, 2), boxBody(100, 0, 55, 0));
  assert.ok(r, 'expected a force');
  assert.deepEqual(r.point, { x: 45, y: 0 });
  const want = 0.001 * 2 * 5;
  assert.ok(Math.abs(r.force.x - want) < 1e-12, `force.x ${r.force.x} (want ${want})`);
  assert.ok(Math.abs(r.force.y) < 1e-12);
});

test('bumperForce: force direction is radial from the ring anchor, not axis-aligned', () => {
  // vertices (60,25),(180,25),(180,35),(60,35); nearest to origin is (60,25), d≈65.0 < R=70
  const r = bumperForce(ring({ x: 0, y: 0 }, 70, 1), boxBody(120, 30, 60, 5));
  assert.ok(r);
  assert.deepEqual(r.point, { x: 60, y: 25 });
  assert.ok(Math.abs(r.force.x / 60 - r.force.y / 25) < 1e-9, 'force along the vertex radius');
  const d = Math.hypot(60, 25);
  assert.ok(Math.abs(Math.hypot(r.force.x, r.force.y) - 0.001 * (70 - d)) < 1e-12, 'magnitude = scale x density(1) x depth');
  assert.ok(r.force.x > 0 && r.force.y > 0);
});

// ---------------- applyBumperForces ----------------

test('bumperForceOnRing: non-overlapping rings feel nothing', () => {
  // target ring R=10 centred at (100,0): nearest point (90,0) is 90 away > R=50
  assert.equal(bumperForceOnRing(ring(), { anchor: { x: 100, y: 0 }, radius: 10 }, { x: 100, y: 0 }), null);
});

test('bumperForceOnRing: overlapping rings push the nearest ring point back outward', () => {
  // target ring R=10 centred at (55,0): nearest point (45,0) is 5px inside R=50
  const r = bumperForceOnRing(ring({ x: 0, y: 0 }, 50, 1), { anchor: { x: 55, y: 0 }, radius: 10 }, { x: 55, y: 0 });
  assert.ok(r, 'expected a force');
  assert.deepEqual(r.point, { x: 45, y: 0 });
  const want = 0.001 * 1 * 5;
  assert.ok(Math.abs(r.force.x - want) < 1e-12, `force.x ${r.force.x} (want ${want})`);
  assert.ok(Math.abs(r.force.y) < 1e-12);
});

test('bumperForceOnRing: hollow — no ring force while the target bot center is inside', () => {
  // target bot center (10,0) is inside R=50, even though its ring overlaps the source ring
  assert.equal(bumperForceOnRing(ring({ x: 0, y: 0 }, 50, 1), { anchor: { x: 10, y: 0 }, radius: 40 }, { x: 10, y: 0 }), null);
});

test('applyBumperForces: applies to other bodies, skips the owner and static bodies', () => {
  const owner = boxBody(0, 0);
  const other = boxBody(100, 0, 55, 0); // nearest vertex (45,0) crosses R=50
  const rock = { ...boxBody(100, 0, 55, 0), isStatic: true };
  const calls = [];
  const M = { Body: { applyForce: (b, pt, f) => calls.push({ b, pt, f }) } };
  applyBumperForces(M, [
    { body: owner, bumpers: [ring({ x: 0, y: 0 }, 50, 1)] },
    { body: other, bumpers: [] },
    { body: rock, bumpers: [] },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].b, other);
});

test('applyBumperForces: ring force lands on the target body at the ring point (no vertex contact)', () => {
  // target body far away (no vertex overlap); only its BUMPER ring crosses the source ring.
  // target ring R=10 at (40,0) spans 30..50: it pokes into R=50, but the source ring's
  // nearest point to the target ring (50,0) sits exactly ON R=10 — so only ONE ring-ring
  // force exists (owner R=50 pushes target), no reciprocal one.
  const owner = boxBody(0, 0);
  const other = boxBody(200, 0, 10, 5);
  const calls = [];
  const M = { Body: { applyForce: (b, pt, f) => calls.push({ b, pt, f }) } };
  applyBumperForces(M, [
    { body: owner, bumpers: [ring({ x: 0, y: 0 }, 50, 1)] },
    { body: other, bumpers: [{ anchor: { x: 40, y: 0 }, radius: 10, density: 1 }] },
  ]);
  assert.equal(calls.length, 1, 'exactly one force: the ring-ring interaction');
  assert.equal(calls[0].b, other);
  assert.deepEqual(calls[0].pt, { x: 30, y: 0 });
});

test('applyBumperForces: empty entries is a no-op', () => {
  const M = { Body: { applyForce: () => assert.fail('should not be called') } };
  applyBumperForces(M, []);
  applyBumperForces(M, [{ body: boxBody(10, 0), bumpers: [] }]);
});

// ---------------- real physics integration (matter-js) ----------------

const body80 = { shape: 'rect', width: 80, height: 40 };

function physicsRun({ bumperRadius = 60, bumperDensity = 10, speed = 2, steps = 300, bHasBumper = true } = {}) {
  const engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
  // frictionAir 0: pure ballistics so arrival speed is the set speed (Matter's default
  // 0.01 bleeds a slow bot to a halt before it reaches the ring).
  const make = (withBumper) => {
    // frictionAir must be set on the PARENT (the integrated body) — part options don't
    // propagate, and Matter's default 0.01 would bleed a slow bot to a halt pre-ring.
    const body = Matter.Body.create({ parts: [
      Matter.Bodies.rectangle(0, 0, 80, 40, { density: 0.001 }),
      ...(withBumper ? [Matter.Bodies.circle(0, 0, 10, { density: 0.002 })] : []), // a "wheel"
    ]});
    Matter.Body.set(body, { frictionAir: 0 });
    return body;
  };
  const a = make(true), b = make(bHasBumper); // a always bumps; b is plain when bHasBumper is false
  Matter.Body.setPosition(a, { x: 0, y: 0 });
  Matter.Body.setPosition(b, { x: 400, y: 0 });
  Matter.Body.setVelocity(b, { x: -speed, y: 0 });
  Matter.Composite.add(engine.world, [a, b]);
  // The ring FOLLOWS its body — as in the real sim, where the anchor is the body pose
  // + the component offset.
  const ringOf = body => ({ anchor: body.position, radius: bumperRadius, density: bumperDensity });
  let minRel = Infinity;
  for (let i = 0; i < steps; i++) {
    Matter.Engine.update(engine, 16.6);
    applyBumperForces(Matter, [
      { body: a, bumpers: [ringOf(a)] },
      { body: b, bumpers: bHasBumper ? [ringOf(b)] : [] },
    ]);
    minRel = Math.min(minRel, Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y));
  }
  return { a, b, minRel };
}

test('physics: bumpers interact with bumpers — bots are held at ring distance, not body contact', () => {
  // Body-only contact would stop the bots at 80 (2× half-width). With R=60 rings the
  // ring-ring force engages at 120 (2R) and holds them there, well before the bodies touch.
  const { b, minRel } = physicsRun({ bumperRadius: 60, bumperDensity: 10, speed: 2 });
  assert.ok(minRel > 95, `rings held the bots apart before body contact (min rel ${minRel.toFixed(1)}, body contact = 80)`);
  assert.ok(minRel > 60, `b's center never entered a's R=60 ring (min rel ${minRel.toFixed(1)})`);
  // frictionAir is 0 here, so the ring is a lossless spring: b bounces back out
  // (in the real game, friction damps it to rest against the ring).
  assert.ok(b.position.x > 60, `b is back outside the ring, not carried through (x=${b.position.x.toFixed(1)})`);
});

test('physics: a low-density ring is ploughable — a fast bot crosses into the interior', () => {
  // R=100 so the ring surface (100) sits OUTSIDE body contact (80): the interior is
  // geometrically reachable. b carries no bumper of its own, so a's ring is the only
  // soft barrier — v=10 has enough energy to carry b's center across R=100 before the
  // bodies meet (a slower bot is squashed back by the ring spring).
  const { minRel } = physicsRun({ bumperRadius: 100, bumperDensity: 0.1, speed: 10, steps: 200, bHasBumper: false });
  assert.ok(minRel < 100, `b crossed the ring (min rel center dist ${minRel.toFixed(1)} < 100)`);
});

test('physics: a swarm ploughing into one ring holds — no bot center enters the ring', () => {
  const engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
  const make = (y) => {
    const b = Matter.Body.create({ parts: [
      Matter.Bodies.rectangle(0, 0, 80, 40, { density: 0.001 }),
      Matter.Bodies.circle(0, 0, 10, { density: 0.002 }),
    ]});
    Matter.Body.set(b, { frictionAir: 0.02 });
    Matter.Body.setPosition(b, { x: 400, y });
    Matter.Body.setVelocity(b, { x: -3, y: 0 });
    return b;
  };
  const anchor = Matter.Body.create({ parts: [Matter.Bodies.rectangle(0, 0, 80, 40, { density: 0.001 })] });
  Matter.Body.set(anchor, { frictionAir: 0.02 });
  Matter.Body.setPosition(anchor, { x: 0, y: 0 });
  const swarm = [make(-120), make(-40), make(40), make(120)];
  Matter.Composite.add(engine.world, [anchor, ...swarm]);
  // Every bot carries the same bumper; rings follow their bodies (the anchor bot is free,
  // so the swarm's rings push it too — measured relative to its live position).
  const ringOf = body => ({ anchor: body.position, radius: 60, density: 10 });
  const mins = swarm.map(() => Infinity);
  for (let i = 0; i < 300; i++) {
    Matter.Engine.update(engine, 16.6);
    applyBumperForces(Matter, [{ body: anchor, bumpers: [ringOf(anchor)] }, ...swarm.map(b => ({ body: b, bumpers: [ringOf(b)] }))]);
    swarm.forEach((b, k) => { mins[k] = Math.min(mins[k], Math.hypot(b.position.x - anchor.position.x, b.position.y - anchor.position.y)); });
  }
  swarm.forEach((b, k) => assert.ok(mins[k] > 60, `swarm bot ${k} center never entered the ring (min ${mins[k].toFixed(1)})`));
});

// ---------------- HeadlessWorld (co-op authoritative path) ----------------

const configs = {
  app: { defaults: { thrustScale: 2 } },
  // frictionAir zeroed so the initial velocity stays ballistic (the real tuning damps it
  // to a crawl within ~60px, which would never reach the ring from the spawn distance).
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0, frictionAirScale: 0 } },
  sensors: {},
  components: { components: [
    { id: 'powered_wheel', category: 'actuator', size: 16 },
    { id: 'bumper', category: 'passive', size: 25, defaults: { radius: 25, density: 10 } },
  ] },
};

function bumperDoc(radius, density = 10) {
  return {
    body: body80,
    components: [
      { id: 'w', type: 'powered_wheel', local: { x: 0, y: 12 }, localRotation: 0, props: {} },
      { id: 'b', type: 'bumper', local: { x: 0, y: 0 }, localRotation: 0, props: { radius, density } },
    ],
    wires: [],
  };
}

function makeSim(protos) {
  const worldDoc = {
    elements: [],
    vehiclePrototypes: Object.entries(protos).map(([id, v]) => ({ id, name: id, vehicle: v, _vehicle: v, instances: [] })),
  };
  return new HeadlessWorld({ Matter, dtMs: 16.6, configs, worldDoc });
}

test('HeadlessWorld: a bumper is NOT a part of the vehicle body (force field, not solid part)', () => {
  const sim = makeSim({ a: bumperDoc(40, 1) });
  const inst = sim.addInstance({ id: 'a#1', protoId: 'a', seed: { x: 0, y: 0, rotation: 0 } });
  // body.parts includes the parent body itself: parent + rect + wheel only — the bumper must not be a part
  assert.equal(inst.body.parts.length, 3, 'body rect + wheel only — the bumper must not be a part');
});

test('HeadlessWorld: step() deflects another bot at a bumper ring; hollow interior is passable', () => {
  const sim = makeSim({ a: bumperDoc(60, 10), b: bumperDoc(60, 10) });
  const a = sim.addInstance({ id: 'a#1', protoId: 'a', seed: { x: 0, y: 0, rotation: 0 } });
  const b = sim.addInstance({ id: 'b#1', protoId: 'b', seed: { x: 400, y: 0, rotation: 0 } });
  Matter.Body.setVelocity(b.body, { x: -2, y: 0 });
  let minDist = Infinity;
  for (let i = 0; i < 300; i++) {
    sim.step();
    minDist = Math.min(minDist, Math.hypot(b.body.position.x, b.body.position.y));
  }
  assert.ok(minDist > 60, `b's center stayed outside a's R=60 ring (min ${minDist.toFixed(1)})`);
  // deflected, not pushed through: b is still in front of the ring, or slid around it
  assert.ok(b.body.position.x > 60 || Math.abs(b.body.position.y) > 10, 'b was deflected at the ring, not ploughed through');
});

test('HeadlessWorld: with a low-density bumper a fast bot passes through', () => {
  // R=100 sits outside body contact (80), so the interior is reachable; b has no bumper
  // of its own, so only a's soft ring resists it.
  const plainDoc = { body: body80, components: [{ id: 'w', type: 'powered_wheel', local: { x: 0, y: 12 }, localRotation: 0, props: {} }], wires: [] };
  const sim = makeSim({ a: bumperDoc(100, 0.1), b: plainDoc });
  const a = sim.addInstance({ id: 'a#1', protoId: 'a', seed: { x: 0, y: 0, rotation: 0 } });
  const b = sim.addInstance({ id: 'b#1', protoId: 'b', seed: { x: 400, y: 0, rotation: 0 } });
  Matter.Body.setVelocity(b.body, { x: -10, y: 0 });
  let minDist = Infinity;
  for (let i = 0; i < 200; i++) {
    sim.step();
    minDist = Math.min(minDist, Math.hypot(b.body.position.x - a.body.position.x, b.body.position.y - a.body.position.y));
  }
  assert.ok(minDist < 100, `b ploughed through the soft ring (min rel ${minDist.toFixed(1)} < 100)`);
});
