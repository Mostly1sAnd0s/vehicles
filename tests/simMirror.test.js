import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReply, ensureMirror } from '../public/app/simMirror.js';

// The mirror is the page-side shadow of the engine: plain {position, angle, velocity,
// angularVelocity} bodies that the existing draw/hit-test code reads unchanged. It must
// apply poses, samples, motors, flash, converted docs and path points — and nothing else.

const inst = (id, over = {}) => ({ id, protoId: 'p1', seed: { x: 0, y: 0, rotation: 0 }, body: null, path: [], ...over });

test('poses land on mirror bodies with the exact body shape the renderers expect', () => {
  const instances = [inst('i1')];
  applyReply(instances, {
    op: 'reply', bots: [{ id: 'i1', x: 12.5, y: -3, angle: 0.25, vx: 1, vy: 2 }],
  });
  const b = instances[0].body;
  assert.equal(b.position.x, 12.5);
  assert.equal(b.position.y, -3);
  assert.equal(b.angle, 0.25);
  assert.equal(b.velocity.x, 1);
  assert.equal(b.velocity.y, 2);
  assert.ok('angularVelocity' in b);
});

test('bots absent from the page are ignored; page instances missing from the reply keep their last pose', () => {
  const instances = [inst('i1'), inst('gone')];
  applyReply(instances, { bots: [{ id: 'ghost', x: 1, y: 1, angle: 0, vx: 0, vy: 0 }] });
  assert.equal(instances[0].body, null); // ghost never materialises
  assert.equal(instances[1].body, null);
  applyReply(instances, { bots: [{ id: 'i1', x: 5, y: 5, angle: 0, vx: 0, vy: 0 }] });
  applyReply(instances, { bots: [] });
  assert.equal(instances[0].body.position.x, 5); // stable until told otherwise
});

test('samples and motors land per-instance; a detail=false reply leaves them untouched', () => {
  const instances = [inst('i1')];
  applyReply(instances, {
    bots: [{ id: 'i1', x: 0, y: 0, angle: 0, vx: 0, vy: 0, samples: [{ componentId: 's', value: 0.5 }], motors: [{ id: 'w', force: 1 }] }],
  });
  assert.equal(instances[0].lastSamples.length, 1);
  assert.equal(instances[0].lastMotors.length, 1);
  applyReply(instances, { bots: [{ id: 'i1', x: 1, y: 1, angle: 0, vx: 0, vy: 0 }] });
  assert.equal(instances[0].lastSamples.length, 1); // stale-but-intact: beams are off when detail is
});

test('flashUntil mirrors the engine value (same monotonic clock across threads)', () => {
  const instances = [inst('i1')];
  applyReply(instances, {
    bots: [{ id: 'i1', x: 0, y: 0, angle: 0, vx: 0, vy: 0, flashUntil: 12345 }],
  });
  assert.equal(instances[0].flashUntil, 12345);
});

test('conversion events swap in the vehicle override for drawing/inspector', () => {
  const instances = [inst('i1')];
  applyReply(instances, {
    bots: [{ id: 'i1', x: 0, y: 0, angle: 0, vx: 0, vy: 0 }],
    events: [{ type: 'converted', id: 'i1', vehicle: { body: { width: 9, height: 9 }, components: [] } }],
  });
  assert.equal(instances[0].vehicleOverride.body.width, 9);
});

test('path points append when pathsOn, cap enforced, and are skipped when off', () => {
  const instances = [inst('i1')];
  applyReply(instances, {
    bots: [{ id: 'i1', x: 0, y: 0, angle: 0, vx: 0, vy: 0 }],
    path: { i1: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
  }, { pathsOn: false });
  assert.equal(instances[0].path.length, 0);

  applyReply(instances, {
    bots: [{ id: 'i1', x: 2, y: 2, angle: 0, vx: 0, vy: 0 }],
    path: { i1: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] },
  }, { pathsOn: true });
  assert.equal(instances[0].path.length, 3);

  // cap: a giant delivery never exceeds the cap and keeps the NEWEST points
  const many = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: 0 }));
  applyReply(instances, {
    bots: [{ id: 'i1', x: 0, y: 0, angle: 0, vx: 0, vy: 0 }],
    path: { i1: many },
  }, { pathsOn: true, pathCap: 2000 });
  assert.equal(instances[0].path.length, 2000);
  assert.equal(instances[0].path[1999].x, 4999);
});

test('resolveBody (local transport) attaches the real engine body instead of a mirror copy', () => {
  const instances = [inst('i1')];
  const real = { position: { x: 42, y: 43 }, angle: 1, velocity: { x: 0, y: 0 }, angularVelocity: 0 };
  applyReply(instances, {
    bots: [{ id: 'i1', x: 42, y: 43, angle: 1, vx: 0, vy: 0 }],
  }, { resolveBody: id => (id === 'i1' ? real : null) });
  assert.equal(instances[0].body, real); // identity: direct writes (tests, probes) hit the engine
});

test('resetReply clears mirror-side per-run bookkeeping (paths, flash, overrides, samples)', () => {
  const instances = [inst('i1', {
    body: { position: { x: 9, y: 9 }, angle: 2, velocity: { x: 5, y: 5 }, angularVelocity: 3 },
    path: [{ x: 1, y: 1 }],
    flashUntil: 999,
    vehicleOverride: { body: {} },
    lastSamples: [{ x: 1 }],
    lastMotors: [{ x: 1 }],
  })];
  applyReply(instances, {
    bots: [{ id: 'i1', x: 0, y: 0, angle: 0, vx: 0, vy: 0 }],
  }, { reset: true });
  const i = instances[0];
  assert.equal(i.path.length, 0);
  assert.equal(i.flashUntil, 0);
  assert.equal(i.vehicleOverride, null);
  assert.deepEqual(i.lastSamples, []);
  assert.deepEqual(i.lastMotors, []);
  assert.equal(i.body.position.x, 0); // pose still applied
});

test('ensureMirror is idempotent and never drops an existing body object (identity stability)', () => {
  const i = inst('i1');
  ensureMirror(i);
  const b1 = i.body;
  ensureMirror(i);
  assert.equal(i.body, b1);
});
