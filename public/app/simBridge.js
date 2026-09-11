/**
 * Sim transports (M10.2) — one protocol (src/simulation/simProtocol.js), two shapes:
 *
 *  - LocalSimBridge  runs the protocol synchronously on the main thread (same engine,
 *                    same code as the Worker). Replies are delivered before `send()`
 *                    returns, so the classic sync semantics (single `step()`, probes that
 *                    poke bodies directly) survive verbatim — and the real Matter bodies
 *                    are handed to the mirror by identity (`resolveBody`), zero copies.
 *  - WorkerSimBridge posts the same messages to a Worker; replies arrive async. The page
 *                    is written ONLY against the async shape, so this is the only place
 *                    asynchrony enters.
 *
 * Default is the Worker (stepping physics off the UI thread is the entire point);
 * `?worker=0` forces the local transport (tests, debugging). If the Worker fails to boot
 * or dies, the bridge degrades to the local transport and says so loudly — a slow page
 * beats a dead canvas. Seeds/docs are re-primed from the cached init+sync; live poses may
 * snap back to the last structural sync (documented, one-time, loud).
 */

import { HeadlessWorld } from '../src/simulation/worldSim.js';
import { createProtocolState, applyCommand } from '../src/simulation/simProtocol.js';

export function workerModeRequested() {
  try {
    const p = new URLSearchParams(location.search).get('worker');
    return p === null ? true : p !== '0'; // default ON; only worker=0 forces local
  } catch {
    return true;
  }
}

export function createSimBridge({ configs, dtMs, onReply }) {
  if (typeof Worker !== 'undefined' && workerModeRequested()) {
    try {
      return new DegradingBridge({ configs, dtMs, onReply });
    } catch (err) {
      console.error('sim worker failed to start; stepping on the main thread instead', err);
    }
  }
  return new LocalSimBridge({ configs, dtMs, onReply });
}

export class LocalSimBridge {
  constructor({ configs, dtMs, onReply }) {
    this.transport = 'local';
    this.onReply = onReply;
    this.world = new HeadlessWorld({
      Matter: globalThis.Matter,
      dtMs, configs,
      worldDoc: { elements: [], vehiclePrototypes: [] },
    });
    this.pstate = createProtocolState();
  }

  get busy() { return false; } // synchronous: never in flight

  // Read view over the engine's static bodies (local transport, same heap — probes and
  // inspection use `sim.obstacleBodies`). The Worker transport has none on this side.
  get obstacleBodies() { return this.world.obstacleBodies; }

  send(msg) {
    const reply = applyCommand(this.world, this.pstate, msg);
    if (!reply) return;
    // Same heap: hand the mirror the REAL bodies by identity. Draw reads are plain field
    // access, and direct writes (drags, probes) hit the engine — no marshalling at all.
    const idx = new Map(this.world.instances.map(i => [i.id, i]));
    this.onReply(reply, { resolveBody: id => idx.get(id)?.body ?? null });
  }

  dispose() {}
}

export class WorkerSimBridge {
  constructor({ configs, dtMs, onReply, onError }) {
    this.transport = 'worker';
    this._busy = false;
    this.w = new Worker(new URL('./sim.worker.js', import.meta.url), { name: 'bv-sim' });
    this.w.onmessage = e => {
      const r = e.data;
      if (!r) return;
      if (r.op === 'error') { onError?.(r); return; }
      if (r.ack === 'step') this._busy = false;
      onReply(r, { resolveBody: null });
    };
    this.w.onerror = e => onError?.(e);
  }

  get busy() { return this._busy; }

  get obstacleBodies() { return []; } // the bodies live on the Worker thread

  send(msg) {
    if (msg.op === 'step') this._busy = true;
    this.w.postMessage(msg);
  }

  dispose() {
    try { this.w.terminate(); } catch { /* already gone */ }
  }
}

/**
 * Worker bridge with a local fallback woven in. `init` and the latest `sync` are cached —
 * both are FULL desired state (the protocol diffs), so replaying them re-creates the
 * world on the local engine exactly; live poses snap back to the last structural sync.
 */
class DegradingBridge {
  constructor({ configs, dtMs, onReply }) {
    this.configs = configs;
    this.dtMs = dtMs;
    this.onReply = onReply;
    this.transport = 'worker';
    this._failed = false;
    this._cachedInit = null;
    this._cachedSync = null;
    this.inner = new WorkerSimBridge({
      configs, dtMs,
      onReply: (r, h) => this.onReply(r, h),
      onError: err => this._degrade(err),
    });
  }

  get busy() { return !this._failed && this.inner.busy; }

  get obstacleBodies() { return this.inner.obstacleBodies ?? []; }

  send(msg) {
    if (!this._failed) {
      if (msg.op === 'init') this._cachedInit = msg;
      if (msg.op === 'sync') this._cachedSync = msg;
    }
    this.inner.send(msg);
  }

  _degrade(err) {
    if (this._failed) return;
    this._failed = true;
    console.error('sim worker failed — falling back to main-thread stepping (poses may snap to their last placed position)', err);
    this.inner.dispose();
    this.transport = 'local';
    this.inner = new LocalSimBridge({ configs: this.configs, dtMs: this.dtMs, onReply: this.onReply });
    if (this._cachedInit) this.inner.send(this._cachedInit);
    if (this._cachedSync) this.inner.send(this._cachedSync);
    this.inner.send({ op: 'snapshot', detail: true });
  }
}
