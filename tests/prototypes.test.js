// Pure-logic tests for vehicle-type CRUD helpers (public/app/prototypes.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextVehicleName,
  makePrototype,
  removePrototype,
  blankVehicle,
  vehicleColor,
  nextVehicleColor,
  VEHICLE_COLORS,
} from '../public/app/prototypes.js';

const NAMES = names => names.map(n => ({ name: n }));

// ---------------- nextVehicleName ----------------

test('nextVehicleName picks first unused letter starting at A', () => {
  assert.equal(nextVehicleName(NAMES([])), 'Vehicle A');
  assert.equal(nextVehicleName(NAMES(['Vehicle A'])), 'Vehicle B');
  assert.equal(nextVehicleName(NAMES(['Vehicle B', 'Vehicle D'])), 'Vehicle A');
});

test('nextVehicleName fills gaps before advancing past the tail', () => {
  assert.equal(
    nextVehicleName(NAMES(['Vehicle A', 'Vehicle B', 'Vehicle C'])),
    'Vehicle D',
  );
});

test('nextVehicleName wraps to double letters after Z and keeps scanning for gaps', () => {
  const used = [];
  for (let i = 0; i < 26; i++) used.push(`Vehicle ${String.fromCharCode(65 + i)}`);
  assert.equal(nextVehicleName(NAMES(used)), 'Vehicle AA');
  used.push('Vehicle AA');
  assert.equal(nextVehicleName(NAMES(used)), 'Vehicle AB');
  used.push('Vehicle AB', 'Vehicle AC'); // gap at AD
  assert.equal(nextVehicleName(NAMES(used)), 'Vehicle AD');
});

test('nextVehicleName ignores unrelated names', () => {
  assert.equal(nextVehicleName(NAMES(['Sun Chaser', 'Vehicle A'])), 'Vehicle B');
});

// ---------------- vehicle color ----------------

const protoWithColor = c => ({ _vehicle: { body: c == null ? {} : { color: c } } });

test('vehicleColor returns the body color, falling back to the default for legacy docs', () => {
  assert.equal(vehicleColor({ _vehicle: { body: { color: '#ff0000' } } }), '#ff0000');
  assert.equal(vehicleColor({ vehicle: { body: { color: '#00ff00' } } }), '#00ff00');
  assert.equal(vehicleColor(protoWithColor(null)), VEHICLE_COLORS[0]); // legacy: no explicit color
  assert.equal(vehicleColor(null), VEHICLE_COLORS[0]);
});

test('nextVehicleColor returns the first unused palette color', () => {
  assert.equal(nextVehicleColor([]), VEHICLE_COLORS[0]);
  assert.equal(nextVehicleColor([protoWithColor(VEHICLE_COLORS[0])]), VEHICLE_COLORS[1]);
  assert.equal(
    nextVehicleColor([protoWithColor(VEHICLE_COLORS[0]), protoWithColor(VEHICLE_COLORS[2])]),
    VEHICLE_COLORS[1],
  ); // fills the gap at index 1 rather than advancing past it
});

test('nextVehicleColor treats a legacy (colorless) proto as using the default color', () => {
  assert.equal(nextVehicleColor([protoWithColor(null)]), VEHICLE_COLORS[1]);
});

test('nextVehicleColor falls back to the first palette color when every color is in use', () => {
  const all = VEHICLE_COLORS.map(c => protoWithColor(c));
  assert.equal(nextVehicleColor(all), VEHICLE_COLORS[0]);
});

// ---------------- makePrototype ----------------

test('makePrototype builds a proto with unique id, requested name and seed instances', () => {
  const template = blankVehicle();
  const p = makePrototype({ name: 'Vehicle B', vehicle: template, count: 3 });
  assert.match(p.id, /^proto_/);
  assert.equal(p.name, 'Vehicle B');
  assert.equal(p.instances.length, 3);
  for (const s of p.instances) {
    assert.ok(s.id);
    assert.equal(typeof s.position.x, 'number');
    assert.equal(typeof s.position.y, 'number');
    assert.equal(typeof s.rotation, 'number');
  }
  const ids = new Set(p.instances.map(s => s.id));
  assert.equal(ids.size, 3, 'instance ids must be unique');
});

test('makePrototype clones the template vehicle (no shared references)', () => {
  const template = blankVehicle();
  const p = makePrototype({ name: 'Vehicle C', vehicle: template, count: 1 });
  assert.notEqual(p._vehicle, template);
  assert.deepEqual(p._vehicle, template);
  p._vehicle.body.width = 999;
  assert.equal(template.body.width, 80);
});

test('makePrototype supports zero instances and a caller-provided id', () => {
  const p = makePrototype({ id: 'proto_fixed', name: 'Vehicle D', vehicle: blankVehicle(), count: 0 });
  assert.equal(p.id, 'proto_fixed');
  assert.deepEqual(p.instances, []);
});

test('makePrototype accepts an injected rng for deterministic seeds', () => {
  const seededRng = s => () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const mk = seed => makePrototype({ name: 'Vehicle E', vehicle: blankVehicle(), count: 2, rng: seededRng(seed) });
  const a = mk(0.25);
  const b = mk(0.25);
  assert.deepEqual(a.instances.map(s => [s.position, s.rotation]),
                   b.instances.map(s => [s.position, s.rotation]));
});

// ---------------- removePrototype ----------------

test('removePrototype returns a new doc without the proto and leaves the input untouched', () => {
  const doc = {
    vehiclePrototypes: [
      { id: 'p1', name: 'Vehicle A' },
      { id: 'p2', name: 'Vehicle B' },
    ],
  };
  const out = removePrototype(doc, 'p1');
  assert.notEqual(out, doc);
  assert.deepEqual(out.vehiclePrototypes.map(p => p.id), ['p2']);
  assert.equal(doc.vehiclePrototypes.length, 2);
});

test('removePrototype throws for an unknown id', () => {
  assert.throws(() => removePrototype({ vehiclePrototypes: [] }, 'nope'));
});

// ---------------- blankVehicle ----------------

test('blankVehicle is a drivable-default chassis with no components or wires', () => {
  const v = blankVehicle();
  assert.equal(v.schemaVersion, 1);
  assert.ok(v.body && v.body.width > 0 && v.body.height > 0);
  assert.deepEqual(v.components, []);
  assert.deepEqual(v.wires, []);
});

test('blankVehicle body carries the default color', () => {
  assert.equal(blankVehicle().body.color, VEHICLE_COLORS[0]);
});
