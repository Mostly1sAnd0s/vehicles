import Matter from 'matter-js';
import { HeadlessWorld } from '../src/simulation/worldSim.js';
import { readFileSync } from 'node:fs';

const configs = {
  app: JSON.parse(readFileSync('config/app.json')),
  components: JSON.parse(readFileSync('config/components.json')),
  sensors: JSON.parse(readFileSync('config/sensors.json')),
  actuators: JSON.parse(readFileSync('config/actuators.json')),
};
const N = 1000;
// minimal vehicle: 2 wheels + 2 light sensors + 1 vehicle-detection sensor
const vehicle = {
  body: { width: 60, height: 40 },
  components: [
    { id: 'w1', type: 'powered_wheel', local: { x: -20, y: -22 } },
    { id: 'w2', type: 'powered_wheel', local: { x: -20, y: 22 } },
    { id: 'l1', type: 'light_sensor', local: { x: 25, y: -12 } },
    { id: 'l2', type: 'light_sensor', local: { x: 25, y: 12 } },
    { id: 'v1', type: 'vehicle_detection_sensor', local: { x: 0, y: 0 }, props: { range: 300, fov: Math.PI } },
  ],
  wires: [
    { from: { componentId: 'l1' }, to: { componentId: 'w1' }, polarity: 1, weight: 1 },
    { from: { componentId: 'l2' }, to: { componentId: 'w2' }, polarity: 1, weight: 1 },
    { from: { componentId: 'v1' }, to: { componentId: 'w1' }, polarity: -1, weight: 0.5 },
  ],
};
const instances = Array.from({ length: N }, (_, i) => ({
  id: `i${i}`, protoId: 'p1',
  seed: { x: (i % 50) * 120 - 3000, y: Math.floor(i / 50) * 120 - 1200, rotation: (i % 13) * 0.5 },
}));
const w = new HeadlessWorld({ Matter, configs, worldDoc: { elements: [], vehiclePrototypes: [{ id: 'p1', _vehicle: vehicle, instances: [] }] } });
for (const inst of instances) w.addInstance(inst);
// warm up
for (let i = 0; i < 30; i++) w.step();
const t0 = process.hrtime.bigint();
for (let i = 0; i < 120; i++) w.step();
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 120;
console.log(`HeadlessWorld.step() @ ${N} vehicles, 1 detection sensor each: ${ms.toFixed(2)} ms/step (budget 16.6)`);
