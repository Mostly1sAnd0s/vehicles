import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Transport test for the REAL `public/app/sim.worker.js`, run under node worker_threads
 * behind a minimal browser shim. The browser cannot run on this dev box (headless HTTP is
 * broken here — see PLAN M10 "environment findings"), and CI is `node --test`, so this is
 * the one place the actual worker script — importScripts order, dynamic import of the ESM
 * sim modules, message loop, error envelope — executes for real. The shim provides only
 * what that file touches: `self`, `importScripts` (loads the matter UMD into `self`),
 * `postMessage`, and an `onmessage` setter wired to the parent port.
 */

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const shimSrc = `
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
const APP = workerData.app;
globalThis.self = globalThis;
globalThis.importScripts = (p) => {
  // Resolve relative to the worker script's own URL, like the browser does.
  const resolved = new URL(p, 'file://' + APP + '/public/app/sim.worker.js').pathname;
  const text = fs.readFileSync(resolved, 'utf8');
  // Classic-script semantics: the repo's package.json says type=module, so require/import
  // would parse the matter UMD as ESM (where top-level 'this' is undefined and the UMD
  // global-assignment throws). importScripts in a browser ignores all that and runs it as
  // a classic script - indirect eval in global scope is the exact node-side equivalent
  // (sloppy-mode 'this' === globalThis, so the UMD lands on self.Matter).
  (0, eval)(text);
};
Object.defineProperty(globalThis, 'onmessage', {
  set(fn) { globalThis._onmessage = fn; },
  get() { return globalThis._onmessage; },
  configurable: true,
});
globalThis.postMessage = (m) => parentPort.postMessage(m);
parentPort.on('message', (data) => {
  const ev = { data };
  Promise.resolve().then(() => globalThis.onmessage(ev));
});
await import('file://' + APP + '/public/app/sim.worker.js');
parentPort.postMessage({ op: 'shim-ready' });
`;

const configs = {
  app: JSON.parse(readFileSync(path.join(APP, 'config/app.json'))),
  components: JSON.parse(readFileSync(path.join(APP, 'config/components.json'))),
  sensors: JSON.parse(readFileSync(path.join(APP, 'config/sensors.json'))),
  actuators: JSON.parse(readFileSync(path.join(APP, 'config/actuators.json'))),
};

const vehicle = {
  body: { width: 60, height: 40 },
  components: [
    { id: 'w1', type: 'powered_wheel', local: { x: -20, y: -22 } },
    { id: 'l1', type: 'light_sensor', local: { x: 25, y: 0 } },
  ],
  wires: [{ from: { componentId: 'l1' }, to: { componentId: 'w1' }, polarity: 1, weight: 1 }],
};

function spawnWorker() {
  const w = new Worker(shimSrc, { eval: true, workerData: { app: APP } });
  const send = msg => w.postMessage(msg);
  const next = () => new Promise((res, rej) => {
    const onMsg = m => { w.off('message', onMsg); w.off('error', onErr); res(m); };
    const onErr = e => { w.off('message', onMsg); w.off('error', onErr); rej(e); };
    w.on('message', onMsg);
    w.on('error', onErr);
  });
  return { w, send, next };
}

test('the real sim.worker.js boots matter via importScripts and answers init/step over real message ports', async () => {
  const { w, send, next } = spawnWorker();
  try {
    const ready = await next();
    assert.equal(ready.op, 'shim-ready');

    send({
      op: 'init', seq: 1, dtMs: 16.6, configs,
      elements: [],
      vehicles: [{ id: 'p1', name: 'A', vehicle }],
      instances: [{ id: 'i1', protoId: 'p1', seed: { x: 100, y: 50, rotation: 0.5 } }],
    });
    const init = await next();
    assert.equal(init.op, 'reply');
    assert.equal(init.ack, 'init');
    assert.equal(init.seq, 1);
    assert.equal(init.bots.length, 1);
    assert.equal(init.bots[0].x, 100);   // structured-clone round trip preserved the pose
    assert.equal(init.bots[0].angle, 0.5);

    send({ op: 'step', n: 3, detail: true, trackPaths: true });
    const step = await next();
    assert.equal(step.t, 3);
    assert.ok(Array.isArray(step.bots[0].samples), 'samples serialized across the port');
    assert.ok(step.path.i1.length === 3);

    // A second instance added via sync; the worker diffs, not rebuilds.
    send({ op: 'sync', instances: [
      { id: 'i1', protoId: 'p1', seed: { x: 100, y: 50, rotation: 0.5 } },
      { id: 'i2', protoId: 'p1', seed: { x: -80, y: -80, rotation: 0 } },
    ] });
    const sync = await next();
    assert.equal(sync.bots.length, 2);

    send({ op: 'reset', seeds: { i1: { x: 555, y: 555, rotation: 0 } } });
    const reset = await next();
    const b1 = reset.bots.find(b => b.id === 'i1');
    assert.equal(b1.x, 555);
    assert.ok(reset.path === undefined || Object.keys(reset.path).length === 0, 'reset cleared paths');
  } finally {
    await w.terminate();
  }
});

test('the worker answers snapshot without stepping and keeps reply ordering per command', async () => {
  const { w, send, next } = spawnWorker();
  try {
    assert.equal((await next()).op, 'shim-ready');
    send({ op: 'init', dtMs: 16.6, configs, elements: [], vehicles: [{ id: 'p1', vehicle }], instances: [{ id: 'i1', protoId: 'p1', seed: { x: 0, y: 0, rotation: 0 } }] });
    await next();
    send({ op: 'step', n: 2 });
    send({ op: 'snapshot' });
    const [a, b] = [await next(), await next()];
    assert.equal(a.ack, 'step'); assert.equal(a.t, 2);
    assert.equal(b.ack, 'snapshot'); assert.equal(b.t, 2); // ordering held
  } finally {
    await w.terminate();
  }
});
