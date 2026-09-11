/**
 * Heat sensing, end to end through the REAL seams:
 *   world JSON → worldElementsToSnapshot → evaluateVehicleSensors → sensor value
 * plus the engine-level lifecycle (per-instance thermal memory, Reset, clones).
 *
 * The headline property is the one the feature is named after: a heat source is a separate
 * field, so a light sensor cannot see it and a heat sensor cannot see a lamp. That must be
 * true because of how the data flows, and these tests fail if anyone ever merges the two
 * arrays "for convenience".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { worldElementsToSnapshot } from '../src/simulation/worldSnapshot.js';
import { evaluateVehicleSensors } from '../src/simulation/sampleSensors.js';
import { HeadlessWorld } from '../src/simulation/worldSim.js';

const SENSORS = {
  light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 },
  heat: { defaultRange: 600, fov: Math.PI * 2, ambientTemp: 20, referenceDistance: 100, radiationConstant: 1, coupling: 10, timeConstantMs: 400, minDistance: 12, outputSpanC: 40 },
  distance: { model: 'raycast', defaultRange: 150, output: 'normalized_inverse', inversionRef: 1 },
  vehicle_detection: { model: 'presence', defaultRange: 300, fov: Math.PI / 2 },
};

const heatElement = (x, y, temperatureC, props = {}) => ({
  id: 'h1', type: 'heat', primitive: 'circle', position: { x, y }, rotation: 0, scale: { x: 1, y: 1 },
  properties: { temperature: temperatureC, ...props },
});
const lightElement = (x, y, intensity = 3000) => ({
  id: 'l1', type: 'light', primitive: 'circle', position: { x, y }, rotation: 0, scale: { x: 1, y: 1 },
  properties: { intensity },
});

function vehicleDoc(type, id = 's1', props = {}, polarity) {
  return {
    body: { shape: 'rect', width: 80, height: 40 },
    components: [{ id, type, local: { x: 0, y: 0 }, localRotation: 0, props, ...(polarity ? { polarity } : {}) }],
    wires: [],
  };
}

/** Sample a one-component vehicle at `pose` in a snapshot, `n` times, with thermal state. */
function sampleN(world, vehicle, n = 1, dtMs = 1000 / 60, pose = { x: 0, y: 0, angle: 0 }) {
  const states = new Map();
  let out;
  for (let i = 0; i < n; i++) {
    out = evaluateVehicleSensors({ ...vehicle, pose, instanceId: 'i1' }, world, SENSORS, { sensorStates: states, dtMs });
  }
  return { sample: out[0], states, all: out };
}

// ---- the snapshot seam ----------------------------------------------------

test('a heat source becomes a thermal field, and does NOT appear in the light field', () => {
  const snap = worldElementsToSnapshot([heatElement(120, 0, 300)], {});
  assert.equal(snap.heats.length, 1);
  assert.deepEqual(snap.heats[0], { x: 120, y: 0, temperatureC: 300 });
  assert.equal(snap.lights.length, 0, 'a furnace is not a lamp');
});

test('a lamp does not appear in the thermal field either', () => {
  const snap = worldElementsToSnapshot([lightElement(50, 50)], {});
  assert.equal(snap.lights.length, 1);
  assert.equal(snap.heats.length, 0);
});

test('a SOLID heat source emits a rock-identical barrier, and the field is untouched', () => {
  const soft = worldElementsToSnapshot([heatElement(0, 0, 400)], {});
  const hard = worldElementsToSnapshot([heatElement(0, 0, 400, { solid: true, radius: 40 })], {});
  assert.deepEqual(hard.heats, soft.heats, 'solidity must never change what is emitted (the M8 invariant, applied to heat)');
  assert.equal(hard.obstacles.length, 1);
  assert.deepEqual(hard.obstacles[0], { type: 'circle', x: 0, y: 0, radius: 40 });
  // ...and that circle is indistinguishable from a rock's, which is what makes it just work.
  const rock = worldElementsToSnapshot([{ id: 'r', type: 'rock', primitive: 'circle', position: { x: 0, y: 0 }, properties: { radius: 40 } }], {});
  assert.deepEqual(hard.obstacles, rock.obstacles);
});

test('a junk temperature cannot poison the sim: clamped, or inert — never NaN', () => {
  const clamped = worldElementsToSnapshot([heatElement(0, 0, 9e9)], { world: { heat: { maxTemperature: 1500, minTemperature: -50 } } });
  assert.equal(clamped.heats[0].temperatureC, 1500);
  const below = worldElementsToSnapshot([heatElement(0, 0, -9e9)], { world: { heat: { maxTemperature: 1500, minTemperature: -50 } } });
  assert.equal(below.heats[0].temperatureC, -50);
  const junk = worldElementsToSnapshot([heatElement(0, 0, 'scorching')], {});
  assert.ok(junk.heats[0].temperatureC === null || Number.isFinite(junk.heats[0].temperatureC), String(junk.heats[0].temperatureC));
  // Whatever it resolved to, sensing it must stay finite.
  const { sample } = sampleN(junk.heats.length ? { heats: junk.heats, obstacles: [] } : { heats: [], obstacles: [] }, vehicleDoc('heat_sensor'), 5);
  assert.ok(Number.isFinite(sample.value));
});

test('temperature defaults come from config, not from a hard-coded number in the seam', () => {
  const el = { id: 'h', type: 'heat', primitive: 'circle', position: { x: 0, y: 0 }, properties: {} };
  const snap = worldElementsToSnapshot([el], { world: { heat: { temperature: 777 } } });
  assert.equal(snap.heats[0].temperatureC, 777);
});

// ---- sensing: the two fields are separate --------------------------------

test('a heat sensor senses a heat source', () => {
  const world = worldElementsToSnapshot([heatElement(100, 0, 400)], {});
  const { sample, states } = sampleN(world, vehicleDoc('heat_sensor'), 2000);
  assert.ok(sample.value > 0.9, `close to a furnace should saturate, got ${sample.value}`);
  assert.ok(sample.heatTemperatureC > 100, `the probe itself gets hot, got ${sample.heatTemperatureC}`);
  assert.equal(sample.kind, 'heat');
  assert.ok(states.size === 1, 'its thermal state is kept');
  assert.equal(sample.ambientC, 20);
});

test('A LIGHT SENSOR IS BLIND TO HEAT — the headline property, by construction', () => {
  const world = worldElementsToSnapshot([heatElement(30, 0, 3000)], {});
  const { sample } = sampleN(world, vehicleDoc('light_sensor'), 10);
  assert.equal(sample.value, 0, 'a light sensor reading a furnace means the fields got merged');
  assert.equal(sample.lightLevel, 0);
});

test('a heat sensor is blind to light, and reads ambient (not zero-signal-from-nothing)', () => {
  const world = worldElementsToSnapshot([lightElement(20, 0, 100000)], {});
  const { sample } = sampleN(world, vehicleDoc('heat_sensor'), 500);
  assert.equal(sample.value, 0);
  assert.equal(sample.heatTemperatureC, 20, 'no source means the room temperature, which is a real reading');
  assert.equal(sample.heatFlux, 0);
});

test('heat sensor output rises monotonically as it closes on a source (and saturates)', () => {
  const world = worldElementsToSnapshot([heatElement(0, 0, 200)], {});
  const levels = [];
  for (const d of [800, 500, 350, 250, 150, 80]) {
    const { sample } = sampleN(world, vehicleDoc('heat_sensor'), 4000, 1000 / 60, { x: d, y: 0, angle: Math.PI });
    levels.push({ d, v: sample.value });
  }
  for (let i = 1; i < levels.length; i++) {
    assert.ok(levels[i].v >= levels[i - 1].v - 1e-12, `closer must not read cooler: ${JSON.stringify(levels)}`);
  }
  assert.ok(levels[0].v < levels[levels.length - 1].v, 'and the range must actually span something');
});

test('thermal lag: the first sample is far below equilibrium and the last one reaches it', () => {
  const world = worldElementsToSnapshot([heatElement(100, 0, 200)], {});
  const first = sampleN(world, vehicleDoc('heat_sensor'), 1).sample;
  const settled = sampleN(world, vehicleDoc('heat_sensor'), 6000).sample;
  assert.ok(first.value < settled.value, 'a probe with thermal mass cannot read the field instantly');
  assert.ok(Math.abs(settled.heatTemperatureC - settled.heatEquilibriumC) < 1e-6, 'and it does converge to the analytic equilibrium');
});

test('ring-down is observable: leave the furnace and the reading fades rather than snapping to 0', () => {
  const near = worldElementsToSnapshot([heatElement(100, 0, 300)], {});
  const far = worldElementsToSnapshot([heatElement(9000, 0, 300)], {});
  const states = new Map();
  for (let i = 0; i < 4000; i++) evaluateVehicleSensors({ ...vehicleDoc('heat_sensor'), pose: { x: 0, y: 0, angle: 0 }, instanceId: 'i' }, near, SENSORS, { sensorStates: states, dtMs: 1000 / 60 });
  const hot = states.get('s1').temperatureC;
  const after1 = evaluateVehicleSensors({ ...vehicleDoc('heat_sensor'), pose: { x: 0, y: 0, angle: 0 }, instanceId: 'i' }, far, SENSORS, { sensorStates: states, dtMs: 1000 / 60 })[0];
  assert.ok(after1.heatTemperatureC > 20, 'one step out of the fire cannot cool a real probe instantly');
  assert.ok(after1.heatTemperatureC < hot);
  for (let i = 0; i < 6000; i++) evaluateVehicleSensors({ ...vehicleDoc('heat_sensor'), pose: { x: 0, y: 0, angle: 0 }, instanceId: 'i' }, far, SENSORS, { sensorStates: states, dtMs: 1000 / 60 });
  assert.ok(Math.abs(states.get('s1').temperatureC - 20) < 1e-3, 'given time it does come back to ambient');
});

test('per-sensor sensitivity and lag override the model scale without replacing the model', () => {
  const world = worldElementsToSnapshot([heatElement(200, 0, 150)], {});
  const base = sampleN(world, vehicleDoc('heat_sensor'), 1, 1000 / 60).sample;
  const sensitive = sampleN(world, vehicleDoc('heat_sensor', 's1', { sensitivity: 4 }), 1, 1000 / 60).sample;
  assert.ok(sensitive.value > base.value, 'a sensitive probe must read hotter at the same place and time');
  const fast = sampleN(world, vehicleDoc('heat_sensor', 's1', { lagMs: 0 }), 1).sample;
  const slow = sampleN(world, vehicleDoc('heat_sensor', 's1', { lagMs: 100000 }), 1).sample;
  assert.ok(fast.heatTemperatureC > slow.heatTemperatureC, 'lagMs=0 tracks instantly; a huge τ barely moves');
});

test('inverted polarity works on heat like every other sensor', () => {
  const world = worldElementsToSnapshot([heatElement(100, 0, 300)], {});
  const inv = sampleN(world, vehicleDoc('heat_sensor', 's1', {}, 'inverted'), 4000).sample;
  assert.ok(inv.value < 0.05, 'an inverted sensor reads cold next to a furnace: ' + inv.value);
});

test('FOV applies: a furnace behind a narrow sensor is not sensed', () => {
  const world = worldElementsToSnapshot([heatElement(-200, 0, 800)], {});
  const facing = sampleN(world, vehicleDoc('heat_sensor', 's1', { fov: 0.6 }), 200).sample;
  assert.equal(facing.value, 0, 'sensor faces +x, source is at -x');
  const turned = sampleN(world, vehicleDoc('heat_sensor', 's1', { fov: 0.6 }), 2000, 1000 / 60, { x: 0, y: 0, angle: Math.PI }).sample;
  assert.ok(turned.value > 0, 'turning toward it must sense it');
});

test('a removed sensor cannot leave heat behind for its replacement', () => {
  const world = worldElementsToSnapshot([heatElement(100, 0, 400)], {});
  const states = new Map();
  const hot = { ...vehicleDoc('heat_sensor', 's1'), pose: { x: 0, y: 0, angle: 0 }, instanceId: 'i' };
  for (let i = 0; i < 2000; i++) evaluateVehicleSensors(hot, world, SENSORS, { sensorStates: states, dtMs: 1000 / 60 });
  assert.ok(states.get('s1').temperatureC > 50);
  // The design now has a different sensor; the old id must not survive in the map.
  evaluateVehicleSensors({ ...vehicleDoc('light_sensor', 's2'), pose: { x: 0, y: 0, angle: 0 }, instanceId: 'i' }, world, SENSORS, { sensorStates: states, dtMs: 1000 / 60 });
  assert.equal(states.has('s1'), false, 'stale thermal state would boot the next sensor hot');
});

test('a heat sensor with no state container still works (older callers do not break)', () => {
  const world = worldElementsToSnapshot([heatElement(100, 0, 400)], {});
  const out = evaluateVehicleSensors({ ...vehicleDoc('heat_sensor'), pose: { x: 0, y: 0, angle: 0 }, instanceId: 'i' }, world, SENSORS);
  assert.ok(Number.isFinite(out[0].value) && Number.isFinite(out[0].heatTemperatureC));
});

// ---- engine lifecycle -----------------------------------------------------

function heatWorld(elements, props = {}) {
  const configs = {
    app: { defaults: { thrustScale: 2 } },
    actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
    sensors: SENSORS,
    components: { components: [{ id: 'heat_sensor', category: 'sensor', size: 8 }, { id: 'light_sensor', category: 'sensor', size: 8 }] },
    world: {},
  };
  const worldDoc = {
    elements,
    vehiclePrototypes: [{
      id: 'p1', name: 'Thermometer', vehicle: { ...vehicleDoc('heat_sensor', 's1', props), body: { shape: 'rect', width: 60, height: 30 } },
      instances: [],
    }],
  };
  const w = new HeadlessWorld({ Matter, configs, worldDoc });
  // HeadlessWorld does NOT spawn bodies from documented instances (that is Session/deploy's
  // job), so the fixture parks its robot explicitly.
  w.addInstance({ id: 'p1#1', protoId: 'p1', seed: { x: 0, y: 0, rotation: 0 }, owner: 'tester' });
  return w;
}

test('engine: a robot sitting next to a furnace heats up over real steps', () => {
  const w = heatWorld([heatElement(150, 0, 500)]);
  const inst = w.instances[0];
  assert.ok(inst.sensorStates instanceof Map, 'instances carry their own thermal memory');
  w.step();
  const cold = inst.lastSamples[0]?.heatTemperatureC;
  for (let i = 0; i < 3000; i++) w.step();
  const hot = inst.lastSamples[0]?.heatTemperatureC;
  assert.ok(hot > cold, `${cold} -> ${hot}`);
  assert.ok(hot > 40, `a robot this close to 500 C must read warm, got ${hot}`);
});

test('engine: Reset cools the sensors back to ambient', () => {
  const w = heatWorld([heatElement(150, 0, 500)]);
  for (let i = 0; i < 3000; i++) w.step();
  const inst = w.instances[0];
  assert.ok(inst.sensorStates.get('s1').temperatureC > 40);
  w.reset();
  assert.equal(inst.sensorStates.size, 0, 'reset must clear thermal state');
  w.step();
  const after = inst.lastSamples[0].heatTemperatureC;
  assert.ok(Math.abs(after - 20) < 20, `the first post-reset sample cannot already be hot, got ${after}`);
});

test('engine: two clones of one design have independent temperatures', () => {
  // One furnace, two robots: the one beside it heats, its twin (identical design, identical
  // component ids) must not, because the state map is per instance.
  const w = heatWorld([heatElement(150, 0, 500)]);
  const second = w.addInstance({ id: 'p1#2', protoId: 'p1', seed: { x: 0, y: 3000, rotation: 0 }, owner: 'x' });
  for (let i = 0; i < 3000; i++) w.step();
  const near = w.instances[0].sensorStates.get('s1').temperatureC;
  const far = second.sensorStates.get('s1').temperatureC;
  assert.ok(near > far + 20, `the far twin must stay cool: near=${near} far=${far}`);
  assert.ok(Math.abs(far - 20) < 2, 'ambient for the one that is nowhere near it');
});

test('engine: a solid furnace blocks a robot while a soft one does not', () => {
  const solid = heatWorld([heatElement(150, 0, 300, { solid: true, radius: 60 })]);
  const soft = heatWorld([heatElement(150, 0, 300)]);
  for (const w of [solid, soft]) {
    // Give the bot a shove toward the source and step; the solid one must be stopped by it.
    const b = w.instances[0].body;
    w.M.Body.setVelocity(b, { x: 6, y: 0 });
    for (let i = 0; i < 240; i++) { w.step(); w.M.Body.setVelocity(w.instances[0].body, { x: 6, y: 0 }); }
  }
  const solidX = solid.instances[0].body.position.x;
  const softX = soft.instances[0].body.position.x;
  assert.ok(solidX < 150 - 55, `the solid barrier should have stopped it well short, x=${solidX}`);
  assert.ok(softX > 150, `the soft one should have driven straight through, x=${softX}`);
});
