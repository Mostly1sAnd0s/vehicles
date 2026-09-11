'use strict';
/**
 * The single-player simulation Worker (M10.2). Deliberately dumb: it is a TRANSPORT shell
 * around the exact same protocol + engine the main thread runs locally —
 * src/simulation/simProtocol.js + HeadlessWorld — so there is one engine, one command
 * semantics, two threads.
 *
 * Why a CLASSIC worker: the vendored matter-js is a UMD build keyed off `this`, which
 * cannot be imported as an ES module; `importScripts` loads it as a classic script (where
 * `this` is the worker global), and the sim modules stay ESM via dynamic `import()`.
 * The protocol is loaded dynamically too — it shares source files with the page, and
 * classic workers support `import()`.
 */

importScripts('../vendor/matter.min.js');

let mods = null;      // { HeadlessWorld, createProtocolState, applyCommand }
let world = null;
let pstate = null;

const ready = Promise.all([
  import('../src/simulation/worldSim.js'),
  import('../src/simulation/simProtocol.js'),
]).then(([w, p]) => {
  mods = { HeadlessWorld: w.HeadlessWorld, createProtocolState: p.createProtocolState, applyCommand: p.applyCommand };
});

self.onmessage = async (e) => {
  try {
    const msg = e.data || {};
    if (msg.op === 'init') {
      await ready;
      world = new mods.HeadlessWorld({
        Matter: self.Matter,
        dtMs: Number(msg.dtMs) || 16.6,
        configs: msg.configs,
        worldDoc: { elements: [], vehiclePrototypes: [] },
      });
      pstate = mods.createProtocolState();
    }
    if (!world) return; // a command raced boot; the bridge's init is always sent first
    const reply = mods.applyCommand(world, pstate, msg);
    if (reply) self.postMessage(reply);
  } catch (err) {
    self.postMessage({ op: 'error', message: String(err && err.message || err), stack: String(err && err.stack || err) });
  }
};
