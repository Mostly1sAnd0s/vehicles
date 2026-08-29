import test from 'node:test';
import assert from 'node:assert/strict';
import { vehicleSignature, selectPropagationTargets, cloneVehicleForConversion } from '../src/simulation/logic.js';

// A representative host: two sensors/mounts + a wheel, an AND gate, wires that
// feed the gate then the wheel, and a Propagator. Body color is part of config.
function baseDoc() {
  return {
    body: { shape: 'rect', width: 80, height: 40, color: '#cc3333' },
    components: [
      { id: 'sL', type: 'light_sensor', snapIndex: 1, local: { x: 20, y: -10 }, localRotation: 0, props: { digital: true } },
      { id: 'wR', type: 'powered_wheel', snapIndex: 3, local: { x: 0, y: 20 }, localRotation: 0, props: {} },
      { id: 'prop', type: 'propagate', snapIndex: 0, local: { x: 0, y: 0 }, localRotation: 0, props: { threshold: 260 } },
    ],
    logicGates: [{ id: 'and1', type: 'gate_and', pos: { x: 30, y: 0 } }],
    wires: [
      { id: 'w1', from: { componentId: 'sL', port: 'out' }, to: { componentId: 'and1', port: 'in0' }, weight: 1 },
      { id: 'w2', from: { componentId: 'and1', port: 'out' }, to: { componentId: 'wR', port: 'drive' }, weight: 0.8 },
    ],
  };
}

// ---------------- vehicleSignature ----------------

test('vehicleSignature: renaming component + gate ids does not change it', () => {
  const a = baseDoc();
  const b = JSON.parse(JSON.stringify(a));
  // rename every id to something else, keep the same order/structure
  b.components[0].id = 'alpha'; b.components[1].id = 'beta'; b.components[2].id = 'gamma';
  b.logicGates[0].id = 'g9';
  b.wires[0].from.componentId = 'alpha'; b.wires[0].to.componentId = 'g9';
  b.wires[1].from.componentId = 'g9'; b.wires[1].to.componentId = 'beta';
  assert.equal(vehicleSignature(a), vehicleSignature(b));
});

test('vehicleSignature: a clone (cloneVehicleForConversion) keeps the same signature', () => {
  const a = baseDoc();
  const c = cloneVehicleForConversion(a, 'z1');
  assert.equal(vehicleSignature(a), vehicleSignature(c)); // the idempotency invariant
});

test('vehicleSignature: changing a component type changes it', () => {
  const a = baseDoc();
  const b = JSON.parse(JSON.stringify(a));
  b.components[0].type = 'distance_sensor';
  assert.notEqual(vehicleSignature(a), vehicleSignature(b));
});

test('vehicleSignature: changing a component prop changes it', () => {
  const a = baseDoc();
  const b = JSON.parse(JSON.stringify(a));
  b.components[2].props.threshold = 999; // the Propagator's own tuning
  assert.notEqual(vehicleSignature(a), vehicleSignature(b));
});

test('vehicleSignature: changing body color changes it', () => {
  const a = baseDoc();
  const b = JSON.parse(JSON.stringify(a));
  b.body.color = '#3399cc';
  assert.notEqual(vehicleSignature(a), vehicleSignature(b));
});

test('vehicleSignature: rewiring (which part feeds which) changes it', () => {
  const a = baseDoc();
  const b = JSON.parse(JSON.stringify(a));
  b.wires[0].to.componentId = 'wR'; // sL now feeds the wheel directly, not the gate
  assert.notEqual(vehicleSignature(a), vehicleSignature(b));
});

// Wire POLARITY and PORTS and per-instance output taps are genuine configuration — omitting
// them let a pair that actually differs be skipped as "configs already match".
test('vehicleSignature: wire from-port (output tap) changes it', () => {
  const a = baseDoc();
  const b = JSON.parse(JSON.stringify(a));
  b.wires[0].from.port = 'out1'; // same source, different tap
  assert.notEqual(vehicleSignature(a), vehicleSignature(b));
});

test('vehicleSignature: wire to-port changes it', () => {
  const a = baseDoc();
  const b = JSON.parse(JSON.stringify(a));
  b.wires[1].to.port = 'drive2';
  assert.notEqual(vehicleSignature(a), vehicleSignature(b));
});

test('vehicleSignature: wire polarity (excitatory/inhibitory) changes it', () => {
  const a = baseDoc();
  const b = JSON.parse(JSON.stringify(a));
  b.wires[1].polarity = 'inhibitory';
  assert.notEqual(vehicleSignature(a), vehicleSignature(b));
});

test('vehicleSignature: per-instance output taps and component polarity change it', () => {
  const a = baseDoc();
  const b = JSON.parse(JSON.stringify(a));
  b.components[0].outputs = ['out', 'out1']; // an "Add Output" tap grown on the sensor
  assert.notEqual(vehicleSignature(a), vehicleSignature(b));
  const c = JSON.parse(JSON.stringify(a));
  c.components[0].polarity = 'inverted';
  assert.notEqual(vehicleSignature(a), vehicleSignature(c));
});

test('vehicleSignature: a clone with taps/polarity/ports still matches its host (idempotency holds)', () => {
  const a = baseDoc();
  a.components[0].outputs = ['out', 'out1'];
  a.components[0].polarity = 'inverted';
  a.wires[0].from.port = 'out1';
  a.wires[0].polarity = 'inhibitory';
  const c = cloneVehicleForConversion(a, 'n7');
  assert.equal(vehicleSignature(a), vehicleSignature(c));
});

// ---------------- selectPropagationTargets ----------------

test('selectPropagationTargets: excludes self, out-of-range, and same-config', () => {
  const hostSig = 'A';
  const host = { id: 'host', x: 0, y: 0, signature: hostSig };
  const cands = [
    { id: 'host', x: 0, y: 0, signature: 'B' },            // self (id === host.id) -> excluded
    { id: 'far', x: 999, y: 0, signature: 'B' },           // out of range -> excluded
    { id: 'same', x: 10, y: 0, signature: hostSig },       // same config -> excluded (idempotent)
    { id: 'near', x: 50, y: 0, signature: 'B' },           // in range + differs -> converted
  ];
  const got = selectPropagationTargets(host, cands, { threshold: 100 });
  assert.deepEqual(got.map(t => t.id), ['near']);
});

test('selectPropagationTargets: orders nearest-first with deterministic tie-break', () => {
  const host = { id: 'h', x: 0, y: 0, signature: 'A' };
  const cands = [
    { id: 'z-far', x: 80, y: 0, signature: 'B' },
    { id: 'a-mid', x: 40, y: 0, signature: 'B' },
    { id: 'z-close', x: 10, y: 0, signature: 'B' },
    { id: 'a-tie', x: 10, y: 0, signature: 'B' }, // same distance as z-close -> id tie-break (a before z)
  ];
  const got = selectPropagationTargets(host, cands, { threshold: 100 });
  assert.deepEqual(got.map(t => t.id), ['a-tie', 'z-close', 'a-mid', 'z-far']);
});

test('selectPropagationTargets: respects maxConverted cap minus already-converted', () => {
  const host = { id: 'h', x: 0, y: 0, signature: 'A' };
  const cands = [
    { id: 'c1', x: 10, y: 0, signature: 'B' },
    { id: 'c2', x: 20, y: 0, signature: 'B' },
    { id: 'c3', x: 30, y: 0, signature: 'B' },
  ];
  // cap 2 total, 1 already done this run -> only 1 more this step
  const got = selectPropagationTargets(host, cands, { threshold: 100, maxConverted: 2, alreadyConverted: 1 });
  assert.deepEqual(got.map(t => t.id), ['c1']);
  // cap reached -> nothing left
  assert.deepEqual(selectPropagationTargets(host, cands, { threshold: 100, maxConverted: 2, alreadyConverted: 2 }).length, 0);
  // no cap -> all in range
  assert.equal(selectPropagationTargets(host, cands, { threshold: 100 }).length, 3);
});

// ---------------- cloneVehicleForConversion ----------------

test('cloneVehicleForConversion: deep clone — mutating the source does not affect the clone', () => {
  const a = baseDoc();
  const c = cloneVehicleForConversion(a, 'x');
  a.components[0].props.digital = false;
  a.body.color = '#000000';
  assert.equal(c.components[0].props.digital, true);
  assert.equal(c.body.color, '#cc3333');
});

test('cloneVehicleForConversion: renames ids, preserves the Propagator + props', () => {
  const a = baseDoc();
  const c = cloneVehicleForConversion(a, 'k7');
  // every id changed and no overlap with source ids
  const srcIds = new Set([...a.components.map(x => x.id), ...a.logicGates.map(x => x.id)]);
  for (const comp of c.components) assert.ok(!srcIds.has(comp.id), `id ${comp.id} collides with source`);
  assert.deepEqual(c.components.map(x => x.id), ['sL_k7', 'wR_k7', 'prop_k7']);
  // the Propagator is preserved, still typed propagate, tuning intact
  const prop = c.components.find(x => x.type === 'propagate');
  assert.ok(prop);
  assert.equal(prop.id, 'prop_k7');
  assert.equal(prop.props.threshold, 260);
});

test('cloneVehicleForConversion: rewires references to the renamed ids and they resolve', () => {
  const a = baseDoc();
  const c = cloneVehicleForConversion(a, 'k7');
  const ids = new Set([...c.components.map(x => x.id), ...c.logicGates.map(x => x.id)]);
  for (const w of c.wires) {
    assert.ok(ids.has(w.from.componentId), `dangling from ${w.from.componentId}`);
    assert.ok(ids.has(w.to.componentId), `dangling to ${w.to.componentId}`);
  }
  // topology preserved: the gate is still fed by a sensor and still feeds the wheel
  const w1 = c.wires.find(w => w.from.componentId === 'sL_k7');
  assert.equal(w1.to.componentId, 'and1_k7');
  const w2 = c.wires.find(w => w.from.componentId === 'and1_k7');
  assert.equal(w2.to.componentId, 'wR_k7');
});

test('cloneVehicleForConversion: preserves body geometry + color and gate positions', () => {
  const a = baseDoc();
  const c = cloneVehicleForConversion(a, 'k7');
  assert.deepEqual(c.body, a.body);
  assert.equal(c.logicGates[0].pos.x, 30);
  assert.equal(c.logicGates[0].pos.y, 0);
});
