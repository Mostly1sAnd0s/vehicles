import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSolidLight,
  solidLightRadius,
  authoredLightRadius,
  lightConfig,
  DEFAULT_LIGHT_RADIUS,
  DEFAULT_LIGHT_MIN_RADIUS,
  DEFAULT_LIGHT_MAX_RADIUS,
  pushOutOfCircle,
  solidLightCircles,
  pushClearance,
} from '../src/models/solidBody.js';

const light = (props, extra = {}) => ({ id: 'l1', type: 'light', primitive: 'circle', position: { x: 0, y: 0 }, ...extra, ...(props ? { properties: props } : {}) });

// ---- isSolidLight ---------------------------------------------------------

test('a light is solid only when properties.solid is true', () => {
  assert.equal(isSolidLight(light({ solid: true })), true);
  assert.equal(isSolidLight(light({ solid: false })), false);
  assert.equal(isSolidLight(light({ intensity: 3000 })), false, 'absent solid => not solid (existing worlds unchanged)');
  assert.equal(isSolidLight(light(null)), false, 'a light with no properties object at all');
});

test('isSolidLight accepts the by-hand JSON string "true" but nothing truthy-looking', () => {
  assert.equal(isSolidLight(light({ solid: 'true' })), true, 'hand-written JSON often carries the string');
  assert.equal(isSolidLight(light({ solid: 'false' })), false);
  assert.equal(isSolidLight(light({ solid: 1 })), false, '1 is NOT solid — only true/"true"');
  assert.equal(isSolidLight(light({ solid: 'yes' })), false);
  assert.equal(isSolidLight(light({ solid: null })), false);
});

test('isSolidLight is false for non-light elements even if they carry solid:true', () => {
  assert.equal(isSolidLight({ type: 'rock', properties: { solid: true } }), false);
  assert.equal(isSolidLight(null), false);
  assert.equal(isSolidLight(undefined), false);
});

test('config can turn solidity on by default, and an explicit element value wins', () => {
  const cfg = { world: { light: { solid: true } } };
  assert.equal(isSolidLight(light({ intensity: 100 }), cfg), true, 'config default applies when the element is silent');
  assert.equal(isSolidLight(light({ solid: false }), cfg), false, 'an explicit false on the element overrides the config default');
  assert.equal(isSolidLight(light({ solid: true }), { world: { light: { solid: false } } }), true);
});

// ---- solidLightRadius ----------------------------------------------------

test('radius falls back to the built-in default when nothing is configured', () => {
  assert.equal(solidLightRadius(light({}), {}), DEFAULT_LIGHT_RADIUS);
  assert.equal(solidLightRadius(light({ intensity: 5000 }), undefined), DEFAULT_LIGHT_RADIUS);
});

test('radius comes from properties.radius, then config, then the built-in', () => {
  assert.equal(solidLightRadius(light({ radius: 40 }), {}), 40);
  assert.equal(solidLightRadius(light({}), { world: { light: { radius: 33 } } }), 33);
  assert.equal(solidLightRadius(light({ radius: 40 }), { world: { light: { radius: 33 } } }), 40, 'element beats config');
});

test('radius is clamped into [minRadius, maxRadius] (config-provided bounds)', () => {
  const cfg = { world: { light: { minRadius: 10, maxRadius: 100 } } };
  assert.equal(solidLightRadius(light({ radius: 1 }), cfg), 10);
  assert.equal(solidLightRadius(light({ radius: 5000 }), cfg), 100);
  assert.equal(solidLightRadius(light({ radius: 50 }), cfg), 50);
});

test('radius is clamped into the built-in bounds when no config is present', () => {
  assert.equal(solidLightRadius(light({ radius: 0.001 }), {}), DEFAULT_LIGHT_MIN_RADIUS);
  assert.equal(solidLightRadius(light({ radius: 99999 }), {}), DEFAULT_LIGHT_MAX_RADIUS);
});

test('non-finite radius never reaches the physics engine — it falls back to the default', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'abc', {}, [], null]) {
    const r = solidLightRadius(light({ radius: bad }), {});
    assert.ok(Number.isFinite(r) && r > 0, `radius ${JSON.stringify(bad)} must resolve finite/positive, got ${r}`);
    assert.equal(r, DEFAULT_LIGHT_RADIUS);
  }
});

test('a maxRadius below minRadius cannot produce an inverted (impossible) range', () => {
  const cfg = { world: { light: { minRadius: 50, maxRadius: 10 } } };
  const r = solidLightRadius(light({ radius: 5 }), cfg);
  assert.ok(r >= 50, `clamped range must stay self-consistent, got ${r}`);
});

test('el.scale.x multiplies the solid radius, exactly like a rock circle', () => {
  assert.equal(solidLightRadius(light({ radius: 20 }, { scale: { x: 2, y: 2 } }), {}), 40);
  assert.equal(solidLightRadius(light({ radius: 20 }, { scale: { x: 0.5 } }), {}), 10);
  assert.equal(solidLightRadius(light({ radius: 20 }), {}), 20, 'no scale block => scale 1');
});

test('the scaled radius stays strictly positive (Matter rejects a zero-radius circle)', () => {
  const r = solidLightRadius(light({ radius: 8 }, { scale: { x: 0 } }), {});
  assert.ok(r > 0 && Number.isFinite(r), `radius must stay > 0, got ${r}`);
});

// ---- authoredLightRadius (what the slider binds to) ----------------------

test('authoredLightRadius is the UNSCALED value, so a slider bound to it cannot creep', () => {
  const el = light({ radius: 20 }, { scale: { x: 2 } });
  assert.equal(authoredLightRadius(el, {}), 20, 'slider reads 20...');
  assert.equal(solidLightRadius(el, {}), 40, '...while the body is 40');
  // Re-reading after a slider edit must not compound the scale.
  el.properties.radius = authoredLightRadius(el, {});
  assert.equal(authoredLightRadius(el, {}), 20, 'unchanged on re-read (no compounding)');
  assert.equal(solidLightRadius(el, {}), 40);
});

test('authoredLightRadius clamps and defaults exactly like the body radius, minus the scale', () => {
  const cfg = { world: { light: { minRadius: 12, maxRadius: 90, radius: 50 } } };
  assert.equal(authoredLightRadius(light({ radius: 1 }), cfg), 12);
  assert.equal(authoredLightRadius(light({ radius: 500 }), cfg), 90);
  assert.equal(authoredLightRadius(light({}), cfg), 50);
  assert.equal(authoredLightRadius(light({ radius: NaN }), {}), DEFAULT_LIGHT_RADIUS);
});

// ---- lightConfig ---------------------------------------------------------

test('lightConfig tolerates a config bundle with no world key at all', () => {
  assert.deepEqual(lightConfig({ app: {}, components: {} }), {});
  assert.deepEqual(lightConfig(undefined), {});
  assert.deepEqual(lightConfig(null), {});
});

// ---- pushOutOfCircle ----------------------------------------------------

test('poses outside the clearance ring are untouched', () => {
  const out = pushOutOfCircle({ x: 0, y: 0 }, 10, [{ id: 'a', x: 100, y: 0 }, { id: 'b', x: 0, y: 20 }], 4);
  assert.deepEqual(out, []);
});

test('an overlapping pose is pushed straight out to radius + clearance along the light→pose vector', () => {
  const out = pushOutOfCircle({ x: 0, y: 0 }, 10, [{ id: 'a', x: 3, y: 4 }], 4); // d = 5, target 14
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
  assert.ok(Math.abs(Math.hypot(out[0].x, out[0].y) - 14) < 1e-9, 'lands exactly on the clearance circle');
  assert.ok(Math.abs(out[0].x - 8.4) < 1e-9 && Math.abs(out[0].y - 11.2) < 1e-9, 'same bearing, not a new direction');
  assert.ok(Math.abs(out[0].distance - 9) < 1e-9, 'distance reports how far it had to travel');
});

test('the concentric (zero-vector) case is deterministic, not NaN', () => {
  const out = pushOutOfCircle({ x: 5, y: 5 }, 10, [{ id: 'c', x: 5, y: 5 }], 0);
  assert.equal(out.length, 1);
  assert.ok(Number.isFinite(out[0].x) && Number.isFinite(out[0].y));
  assert.deepEqual({ x: out[0].x, y: out[0].y }, { x: 15, y: 5 }, 'pushes along +x by convention');
});

test('only the overlapping poses are returned, in input order', () => {
  const poses = [{ id: 'far', x: 500, y: 0 }, { id: 'near', x: 2, y: 0 }, { id: 'edge', x: 14, y: 0 }];
  const out = pushOutOfCircle({ x: 0, y: 0 }, 10, poses, 4);
  assert.deepEqual(out.map(p => p.id), ['near'], 'exactly-on-the-ring is not an overlap');
});

test('malformed poses are skipped rather than throwing', () => {
  const out = pushOutOfCircle({ x: 0, y: 0 }, 10, [null, { id: 'nan', x: NaN, y: 0 }, { id: 'ok', x: 1, y: 0 }], 0);
  assert.deepEqual(out.map(p => p.id), ['ok']);
});

test('a missing poses list is a no-op', () => {
  assert.deepEqual(pushOutOfCircle({ x: 0, y: 0 }, 10, undefined), []);
});

// ---- solidLightCircles / pushClearance ----------------------------------

test('solidLightCircles returns only the solid lights, scaled and defaulted', () => {
  const els = [
    light({ solid: true, radius: 30 }, { position: { x: 5, y: -7 } }),
    light({ intensity: 99 }),
    { id: 'r', type: 'rock', primitive: 'circle', position: { x: 1, y: 1 }, properties: { radius: 9 } },
    light({ solid: true, radius: 10 }, { scale: { x: 2 } }),
  ];
  assert.deepEqual(solidLightCircles(els, {}), [
    { id: 'l1', x: 5, y: -7, r: 30 },
    { id: 'l1', x: 0, y: 0, r: 20 },
  ]);
  assert.deepEqual(solidLightCircles([], {}), []);
  assert.deepEqual(solidLightCircles(undefined, undefined), []);
});

test('solidLightCircles skips a solid light with no position (nothing to place)', () => {
  const els = [{ id: 'ghost', type: 'light', properties: { solid: true, radius: 20 } }];
  assert.deepEqual(solidLightCircles(els, {}), []);
});

test('pushClearance reads config and falls back to 6 (never negative)', () => {
  assert.equal(pushClearance({}), 6);
  assert.equal(pushClearance(undefined), 6);
  assert.equal(pushClearance({ world: { light: { pushClearance: 12 } } }), 12);
  assert.equal(pushClearance({ world: { light: { pushClearance: -5 } } }), 0);
  assert.equal(pushClearance({ world: { light: { pushClearance: 'nope' } } }), 6);
});
