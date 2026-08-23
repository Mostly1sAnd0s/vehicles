/**
 * Authoritative co-op session (PLAN.md §Multi-User; M5 is the current model).
 *
 * A Session owns one HeadlessWorld plus the participant registry and the permission model. It is
 * deliberately transport-agnostic: it never touches sockets. The gateway (net/gateway.js) hosts
 * many of them, one per 6-char world code, and binds a sender to each token. That split means the
 * whole session — join, deploy, ownership, admin-only controls, element edits, snapshotting — is
 * unit-testable with no network at all.
 *
 * Permission model (M5):
 *   - Identity: a display name + auto token per participant; no accounts.
 *   - The client that HOSTS a world becomes its **admin** who runs the session.
 *   - **deploy** is owner-only, enforced by construction: a deploy message carries no protoId, so a
 *     participant can only ever push their own bot. The server also drops any malformed/unknown one.
 *   - **setCount** and **controls** (start/pause/reset) are admin-only.
 */
import { HeadlessWorld } from './simulation/worldSim.js';

const DEFAULT_COUNT = 1; // clones a participant gets on their first deploy

/** Round a wire bot to keep snapshots compact (full precision is never needed on the wire). */
function roundBot(b) {
  return {
    ...b,
    x: +b.x.toFixed(3), y: +b.y.toFixed(3), angle: +b.angle.toFixed(4),
    vx: +b.vx.toFixed(3), vy: +b.vy.toFixed(3),
  };
}

export class Session {
  /**
   * @param {object} o
   * @param {object} o.Matter   matter-js namespace (headless world core).
   * @param {object} o.configs  merged config (app/actuators/sensors/components).
   * @param {object} o.worldDoc { elements, vehiclePrototypes:[] } — mutated to add participant protos.
   * @param {number} [o.dtMs]   fixed physics timestep in ms (default 1000/60 = 60Hz, ≤ matter-js's max).
   */
  constructor({ Matter, dtMs = 1000 / 60, configs, worldDoc }) {
    this.world = new HeadlessWorld({ Matter, dtMs, configs, worldDoc });
    const doc = (this.world.worldDoc ??= {});
    if (!Array.isArray(doc.vehiclePrototypes)) doc.vehiclePrototypes = [];
    this.participants = new Map(); // token -> {token,name,role,protoId,seed,deployed}
    this.senders = new Map();      // token -> (msg) => void  (injected by the transport)
    this.running = false;          // sim is paused until an admin sends controls:{start}
    this._seq = 0;
    this._protoSeq = 0;
    this.stats = { joined: 0, deploys: 0, adminCommands: 0 };
  }

  // ---- transport binding -------------------------------------------------
  /** Bind a send-message callback to an already-joined participant token. */
  bind(token, send) { this.senders.set(token, send); }
  unbind(token) { this.senders.delete(token); }

  _sendTo(token, msg) { const s = this.senders.get(token); if (s) s(msg); }
  /** Send to every joined participant that has a bound sender. */
  broadcast(msg) { for (const t of this.participants.keys()) this._sendTo(t, msg); }

  // ---- lifecycle ---------------------------------------------------------
  /**
   * Create a participant and reserve their bot proto in the world. Role is explicit (M5): the
   * gateway hosts the first client as 'admin', everyone else joins as 'participant'. No clone is
   * spawned until they deploy — so the world starts clean.
   */
  join({ name, role } = {}) {
    // The transport decides who runs a world (the gateway: host → admin, joiner → participant).
    // There is deliberately NO "first joiner becomes admin" fallback — guessing a role here was
    // the pre-M5 model and left two admins possible on a re-join after the first left.
    if (role !== 'admin' && role !== 'participant') {
      throw new TypeError(`Session.join: role must be 'admin' or 'participant' (got ${JSON.stringify(role ?? null)})`);
    }
    const idx = this.participants.size;
    const token = `t${++this._seq}-${Math.random().toString(36).slice(2, 8)}`;
    const protoId = `p${++this._protoSeq}`;
    const finalRole = role;
    const seed = { x: -360 + (idx % 6) * 120, y: ((idx / 6) | 0) * 90, rotation: 0 };
    const p = { token, name: String(name ?? `bot${idx + 1}`), role: finalRole, protoId, seed, deployed: false };
    this.participants.set(token, p);
    // Reserve the proto (no vehicle yet -> prototypeVehicle() is null -> no clones) so deploy() can find it.
    this.world.worldDoc.vehiclePrototypes.push({ id: protoId, name: p.name, vehicle: null, _vehicle: null, instances: [] });
    this.stats.joined++;
    const you = { name: p.name, role: finalRole, protoId };
    return { token, protoId, role: finalRole, you };
  }

  /** Remove a participant and all of their clones. Idempotent. */
  leave(token) {
    const p = this.participants.get(token);
    if (!p) return;
    for (const inst of this.world.instancesFor(p.protoId)) this.world.removeInstance(inst.id);
    this.participants.delete(token);
    this.senders.delete(token);
  }

  /** Initial state push for a freshly-joined client (current world + their identity). */
  sendWelcome(token) {
    const p = this.participants.get(token);
    if (!p) return;
    this._sendTo(token, {
      type: 'welcome',
      code: this.code, // set by the gateway (world code); omitted on the wire when undefined
      running: this.running,
      you: { name: p.name, role: p.role, protoId: p.protoId },
      world: { elements: this._elementsWire(), bots: this._wireBots() },
    });
  }

  // ---- message handling --------------------------------------------------
  /** Central dispatcher. `token` is the authenticated source (set by the transport on handshake). */
  handle(token, msg) {
    const p = this.participants.get(token);
    if (!p) return { type: 'error', error: 'not joined' };
    let reply;
    switch (msg?.type) {
      case 'deploy':        reply = this._deploy(p, msg); break;
      case 'setCount':      reply = this._setCount(p, msg); break;
      case 'controls':      reply = this._controls(p, msg); break;
      case 'addElement':    reply = this._addElement(p, msg); break;
      case 'moveElement':   reply = this._moveElement(p, msg); break;
      case 'removeElement': reply = this._removeElement(p, msg); break;
      default:         reply = { type: 'error', error: `unknown message type: ${msg?.type}` };
    }
    // Errors are private feedback to the actor; world-affecting successes already broadcast themselves.
    if (reply?.type === 'error') this._sendTo(p.token, reply);
    return reply;
  }

  _deploy(p, msg) {
    const vehicle = msg.vehicle;
    if (!vehicle || !Array.isArray(vehicle.components)) return { type: 'error', error: 'deploy requires a vehicle doc with components' };
    if (!this.world.deploy(p.protoId, vehicle)) return { type: 'error', error: 'proto not found' };
    // First deploy gives them their clones; later deploys rebuild in place (pose + momentum preserved).
    if (this.world.instancesFor(p.protoId).length === 0) this.world.setCount(p.protoId, DEFAULT_COUNT, p.seed);
    this._tagOwner(p.protoId, p.name); // the world core doesn't know who a participant is; we do.
    p.deployed = true;
    this.stats.deploys++;
    const res = { type: 'deployed', protoId: p.protoId, count: this.world.instancesFor(p.protoId).length };
    this._sendTo(p.token, res);                       // ack to the deployer
    this.broadcast({ type: 'peerDeployed', protoId: p.protoId, name: p.name }); // let everyone see it land
    return res;
  }

  _setCount(p, msg) {
    if (p.role !== 'admin') return { type: 'error', error: 'setCount requires admin' };
    const protoId = msg.protoId ?? p.protoId;
    const owner = [...this.participants.values()].find(x => x.protoId === protoId);
    if (!owner) return { type: 'error', error: `unknown protoId: ${protoId}` };
    const n = Math.max(0, Math.min(50, Math.trunc(Number(msg.count)) || 0));
    const count = this.world.setCount(protoId, n, owner.seed);
    this._tagOwner(protoId, owner.name); // admin-grown clones inherit the proto's owner
    this.stats.adminCommands++;
    const res = { type: 'countSet', protoId, count };
    this.broadcast(res);
    return res;
  }

  _controls(p, msg) {
    if (p.role !== 'admin') return { type: 'error', error: 'controls require admin' };
    const cmd = msg.command;
    if (cmd === 'start') this.running = true;
    else if (cmd === 'pause') this.running = false;
    else if (cmd === 'reset') this.world.reset();
    else return { type: 'error', error: `unknown command: ${cmd}` };
    this.stats.adminCommands++;
    const res = { type: 'state', running: this.running };
    this.broadcast(res);
    return res;
  }

  /** Stamp the human owner onto a proto's clones (first-deploy & admin-grown ones start untagged). */
  _tagOwner(protoId, name) { for (const inst of this.world.instancesFor(protoId)) if (inst.owner == null) inst.owner = name; }

  // ---- shared-world elements (PLAN.md §Multi-User, M5 phase 3) ---------------
  /**
   * The HOST's World canvas is the source of truth for static elements. These admin-only commands
   * mirror an add / drag-drop / delete out so every joiner renders the same world; each success
   * broadcasts the FULL element list (coarse, but the list is small and changes are rare) as
   * `{type:'elements', elements}` — the welcome message carries the same field for fresh joiners.
   */
  _sharedElements() { return (this.world.worldDoc.elements ??= []); }
  /** Wire-safe copy: broadcasts must carry a SNAPSHOT, never the live array (an in-process
   *  subscriber — or a test — would see its captured message mutated by later edits). */
  _elementsWire() { return structuredClone(this._sharedElements()); }

  _addElement(p, msg) {
    if (p.role !== 'admin') return { type: 'error', error: 'only the host edits shared elements' };
    const e = msg?.element;
    // Number.isFinite, NOT truthiness: a light dropped at the canvas centre is {x:0, y:0}.
    if (!e || !e.type || !Number.isFinite(Number(e.position?.x)) || !Number.isFinite(Number(e.position?.y)))
      return { type: 'error', error: 'addElement requires element:{type,position}' };
    const el = {
      id: String(e.id ?? `el_${Date.now().toString(36)}`),
      type: e.type, primitive: e.primitive ?? (e.type === 'obstacle' ? 'rect' : 'circle'),
      position: { x: Math.round(Number(e.position.x)), y: Math.round(Number(e.position.y)) },
      rotation: Number(e.rotation) || 0, scale: e.scale ?? { x: 1, y: 1 }, properties: e.properties ?? {},
    };
    this._sharedElements().push(el);
    const res = { type: 'elementAdded', id: el.id, count: this._sharedElements().length };
    this._sendTo(p.token, res); // ack so the host learns the assigned id (handle() only echoes errors)
    this.broadcast({ type: 'elements', elements: this._elementsWire() }); // everyone (incl. sender; admin UI ignores its own echo)
    return res;
  }

  _moveElement(p, msg) {
    if (p.role !== 'admin') return { type: 'error', error: 'only the host edits shared elements' };
    const el = this._sharedElements().find(x => x.id === msg?.id);
    if (!el) return { type: 'error', error: `no such element: ${msg?.id}` };
    el.position.x = Math.round(Number(msg?.x)); el.position.y = Math.round(Number(msg?.y));
    const res = { type: 'elementMoved', id: el.id, x: el.position.x, y: el.position.y };
    this._sendTo(p.token, res);
    this.broadcast({ type: 'elements', elements: this._elementsWire() });
    return res;
  }

  _removeElement(p, msg) {
    if (p.role !== 'admin') return { type: 'error', error: 'only the host edits shared elements' };
    const els = this._sharedElements();
    const i = els.findIndex(x => x.id === msg?.id);
    if (i < 0) return { type: 'error', error: `no such element: ${msg?.id}` };
    els.splice(i, 1);
    const res = { type: 'elementRemoved', id: msg.id, count: els.length };
    this._sendTo(p.token, res);
    this.broadcast({ type: 'elements', elements: this._elementsWire() });
    return res;
  }

  // ---- stepping / snapshotting ------------------------------------------
  _wireBots() { return this.world.snapshot().bots.map(roundBot); }

  /**
   * Advance one fixed physics step if running. Returns the broadcastable snapshot (rounded bots) or
   * null while paused. The transport calls this on a fixed-dt timer.
   */
  stepOnce() {
    if (!this.running) return null;
    const snap = this.world.step();
    return { type: 'snapshot', t: snap.t, bots: this._wireBots() };
  }

  /** Current world state as a wire snapshot (used for periodic broadcast + fresh joiners). */
  currentSnapshotWire() {
    const snap = this.world.snapshot();
    return { type: 'snapshot', t: snap.t, bots: this._wireBots() };
  }
}
