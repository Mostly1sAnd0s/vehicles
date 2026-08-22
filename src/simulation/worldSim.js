/**
 * Headless world simulator — the authoritative multi-user world core (PLAN.md §Multi-User).
 *
 * This is a faithful extraction of the per-step loop from `public/app/world.js` so it can run
 * in Node with matter-js headless. A server drives one of these per session; thin clients render
 * its `snapshot()`. It reuses the exact same pure modules the browser uses (sensors, logic,
 * actuation, propagation), so single-player and multi-player behavior stay identical.
 *
 * The Matter namespace is injected (constructor arg) rather than imported, so the same module
 * works in Node (`import('matter-js')`) and, if ever needed, in the browser (`window.Matter`).
 */
import { evaluateVehicleSensors } from './sampleSensors.js';
import { worldElementsToSnapshot } from './worldSnapshot.js';
import { computeActuation, actuatorPolaritySign, applyMotorPower, wheelFrictionAir } from '../actuators.js';
import { evaluateLogicGates, vehicleSignature, selectPropagationTargets, cloneVehicleForConversion } from './logic.js';

const clone = v => JSON.parse(JSON.stringify(v));
const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class HeadlessWorld {
  /**
   * @param {object} opts
   * @param {object} opts.Matter   matter-js namespace (Engine, Bodies, Body, Composite).
   * @param {number} [opts.dtMs]   fixed physics timestep in ms (~16.6 for 60Hz).
   * @param {object} opts.configs  the resolved config bundle (app/actuators/sensors/components).
   * @param {object} [opts.worldDoc] { elements, vehiclePrototypes:[{id,name,vehicle|_vehicle,instances}] }
   * @param {object} [opts.gravity] default {x:0,y:0} (matches the top-down world).
   */
  constructor({ Matter, dtMs = 16.6, configs, worldDoc = {}, gravity = { x: 0, y: 0 } }) {
    this.M = Matter;
    this.dtMs = dtMs;
    this.configs = configs;
    this.worldDoc = worldDoc;
    this.engine = Matter.Engine.create({ gravity });
    this.instances = [];        // {id, protoId, owner, seed:{x,y,rotation}, body, wireMap, ...}
    this.obstacleBodies = [];
    this.tick = 0;
    this.stepCount = 0;
    this.convertedCount = 0;
    this.lastSamples = [];
    this.lastSnapshot = null;
    this._buildObstacles();
  }

  // ---------------- config / vehicle accessors ----------------
  componentDef(type) { return (this.configs.components?.components ?? []).find(c => c.id === type); }
  prototypes() { return this.worldDoc.vehiclePrototypes ?? []; }
  prototypeVehicle(protoId) { const p = this.prototypes().find(p => p.id === protoId); return p ? (p.vehicle ?? p._vehicle) : null; }
  vehicleFor(inst) { return inst?.vehicleOverride ?? this.prototypeVehicle(inst?.protoId); }

  _wireMap(v) {
    const map = {};
    for (const w of v.wires ?? []) (map[w.to.componentId] ??= []).push({ wire: w, sensorId: w.from.componentId });
    return map;
  }

  // ---------------- geometry / obstacles ----------------
  _buildObstacles() {
    const M = this.M;
    for (const b of this.obstacleBodies) M.Composite.remove(this.engine.world, b);
    this.obstacleBodies = [];
    const obs = worldElementsToSnapshot(this.worldDoc.elements ?? {}).obstacles ?? [];
    for (const o of obs) {
      const body = o.type === 'circle'
        ? M.Bodies.circle(o.x, o.y, o.radius, { isStatic: true })
        : M.Bodies.rectangle(o.x, o.y, o.width, o.height, { isStatic: true, angle: o.rotation ?? 0 });
      this.obstacleBodies.push(body);
      M.Composite.add(this.engine.world, body);
    }
  }

  _makeBody(v) {
    const M = this.M;
    if (!v?.body) return null;
    const parts = [M.Bodies.rectangle(0, 0, v.body.width, v.body.height, { density: 0.001 })];
    for (const c of v.components ?? []) {
      if (!c.local) continue;
      parts.push(M.Bodies.circle(c.local.x, c.local.y, this.componentDef(c.type)?.size ?? 8, { density: 0.002 }));
    }
    return M.Body.create({ parts });
  }

  // ---------------- instance lifecycle ----------------
  /** Add one clone of a deployed bot at `seed`. Returns the instance or null if no vehicle. */
  addInstance({ id, protoId, seed = { x: 0, y: 0, rotation: 0 }, owner }) {
    const v = this.prototypeVehicle(protoId);
    if (!v) return null;
    const inst = { id, protoId, owner, seed: { ...seed }, body: null, wireMap: this._wireMap(v), lastSamples: [], lastMotors: [] };
    const body = this._makeBody(v);
    if (!body) return null;
    M_BodySetPosition(this.M, body, { x: seed.x, y: seed.y });
    M_BodySetAngle(this.M, body, seed.rotation ?? 0);
    inst.body = body;
    inst.hasSpawned = true;
    this.M.Composite.add(this.engine.world, body);
    this.instances.push(inst);
    return inst;
  }

  instancesFor(protoId) { return this.instances.filter(i => i.protoId === protoId); }

  /** Remove one instance by id (owner/server-managed). */
  removeInstance(id) {
    const i = this.instances.findIndex(x => x.id === id);
    if (i < 0) return false;
    const [inst] = this.instances.splice(i, 1);
    M_CompositeRemove(this.M, this.engine.world, inst.body);
    return true;
  }

  /**
   * Ensure exactly `n` live clones of a proto exist (admin-controlled count). Adds new clones at
   * `spawnAt` (or spread in a row when omitted); removes the most recent extras. Existing clones
   * and their poses are left alone.
   */
  setCount(protoId, n, spawnAt) {
    const have = this.instancesFor(protoId);
    if (n < have.length) {
      for (let i = have.length - 1; i >= n; i--) this.removeInstance(have[i].id);
      return this.instancesFor(protoId).length;
    }
    let k = 0;
    while (this.instancesFor(protoId).length < n) {
      k++;
      const at = spawnAt ?? { x: (have.length ? have[have.length - 1].seed.x : 0) + 130, y: spawnAt?.y ?? have[have.length - 1]?.seed.y ?? 0, rotation: 0 };
      this.addInstance({ id: `${protoId}#${this.instancesFor(protoId).length + k}`, protoId, seed: { ...at }, owner: have[0]?.owner });
    }
    return this.instancesFor(protoId).length;
  }

  /**
   * Push a participant's newly-deployed bot doc into the world. Replaces the running vehicle and
   * rebuilds every clone's body in place, preserving each clone's pose AND momentum (so a deploy
   * never stops a moving car) — same "edit without stopping" logic as the single-player editor.
   */
  deploy(protoId, vehicleDoc) {
    const p = this.prototypes().find(p => p.id === protoId);
    if (!p) return false;
    p.vehicle = clone(vehicleDoc);          // server owns an independent copy
    p._vehicle = p.vehicle;                 // keep both shapes in sync (world.js reads either)
    this._syncInstances();
    return true;
  }

  /** Return every clone to its seed pose with zero velocity. */
  reset() {
    for (const inst of this.instances) {
      if (!inst.body) continue;
      M_BodySetPosition(this.M, inst.body, { x: inst.seed.x, y: inst.seed.y });
      M_BodySetAngle(this.M, inst.body, inst.seed.rotation ?? 0);
      M.Body.setVelocity(inst.body, { x: 0, y: 0 });
      M.Body.setAngularVelocity(inst.body, 0);
    }
  }

  // ---------------- per-step (ported from world.js) ----------------
  _applyWheelFriction(inst) {
    const v = this.vehicleFor(inst);
    const cfg = this.configs.actuators?.powered_wheel ?? {};
    const wheels = (v?.components ?? []).filter(c => this.componentDef(c.type)?.category === 'actuator' && c.local);
    let f = cfg.defaultFriction ?? 0.5;
    if (wheels.length) f = wheels.reduce((s, c) => s + (c.props?.friction ?? cfg.defaultFriction ?? 0.5), 0) / wheels.length;
    inst.body.frictionAir = wheelFrictionAir(f, cfg);
  }

  _stepPropagation() {
    this.stepCount++;
    const live = this.instances.filter(i => i.body);
    if (live.length < 2) return;
    const cand = live.map(i => ({ id: i.id, x: i.body.position.x, y: i.body.position.y, signature: vehicleSignature(this.vehicleFor(i)) }));
    const hosts = live.filter(i => (this.vehicleFor(i)?.components ?? []).some(c => c.type === 'propagate'));
    let anyConverted = 0;
    for (const inst of hosts) {
      const v = this.vehicleFor(inst);
      const prop = v.components.find(c => c.type === 'propagate');
      const p = prop.props ?? {};
      const threshold = p.threshold ?? 260;
      const cooldownTicks = p.cooldownTicks ?? 0;
      const maxConverted = (p.maxConverted == null || Number.isNaN(Number(p.maxConverted))) ? null : Math.max(0, Number(p.maxConverted));
      const eligible = inst.convertedAt == null || (this.stepCount - inst.convertedAt >= cooldownTicks);
      if (!eligible) continue;
      const hostSig = cand.find(c => c.id === inst.id)?.signature;
      const a = inst.body.angle;
      const lx = prop.local?.x ?? 0, ly = prop.local?.y ?? 0;
      const hx = inst.body.position.x + Math.cos(a) * lx - Math.sin(a) * ly;
      const hy = inst.body.position.y + Math.sin(a) * lx + Math.cos(a) * ly;
      const targets = selectPropagationTargets({ id: inst.id, x: hx, y: hy, signature: hostSig }, cand, { threshold, maxConverted, alreadyConverted: this.convertedCount });
      for (const t of targets) {
        const target = live.find(i => i.id === t.id);
        if (!target || target.vehicleOverride) continue;
        target.vehicleOverride = cloneVehicleForConversion(v, Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
        target.converted = true;
        target.convertedAt = this.stepCount;
        target.flashUntil = _now() + 700;
        this.convertedCount++;
        anyConverted++;
      }
    }
    if (anyConverted) this._syncInstances();
  }

  /** Rebuild bodies + wire maps when a vehicle's geometry/wiring changed (pose+velocity kept). */
  _syncInstances() {
    const M = this.M;
    for (const inst of this.instances) {
      const v = this.vehicleFor(inst);
      if (!v) continue;
      const wireSig = JSON.stringify(v.wires ?? []);
      if (wireSig !== inst.wireSig) { inst.wireSig = wireSig; inst.wireMap = this._wireMap(v); }
      const geoSig = JSON.stringify((v.components ?? []).map(c => [c.id, c.type, c.local?.x, c.local?.y]));
      if (inst.body && geoSig === inst.geoSig) continue;
      const old = inst.body;
      if (old) M_CompositeRemove(M, this.engine.world, old);
      inst.body = null;
      const body = this._makeBody(v);
      if (!body) continue;
      if (old) { M_BodySetPosition(M, body, old.position); M_BodySetAngle(M, body, old.angle); M.Body.setVelocity(body, old.velocity); M.Body.setAngularVelocity(body, old.angularVelocity); }
      else if (!inst.hasSpawned) { M_BodySetPosition(M, body, { x: inst.seed.x, y: inst.seed.y }); M_BodySetAngle(M, body, inst.seed.rotation ?? 0); }
      inst.body = body;
      inst.hasSpawned = true;
      inst.geoSig = geoSig;
      M.Composite.add(this.engine.world, body);
    }
  }

  /** Advance the world one fixed step. Returns a fresh snapshot. */
  step() {
    const M = this.M;
    for (const inst of this.instances) if (inst.body) this._applyWheelFriction(inst);
    M.Engine.update(this.engine, this.dtMs);      // matter-js physics — collisions/bumps happen here
    this._stepPropagation();

    const snapshot = worldElementsToSnapshot(this.worldDoc.elements ?? {});
    snapshot.vehicles = this.instances.filter(i => i.body).map(i => ({ id: i.id, x: i.body.position.x, y: i.body.position.y, angle: i.body.angle }));
    const thrustScale = this.configs.app.defaults.thrustScale ?? 0.25;
    const actCfg = this.configs.actuators.powered_wheel;
    const allSamples = [];

    for (const inst of this.instances) {
      const v = this.vehicleFor(inst);
      if (!v || !inst.body) continue;
      const pose = { x: inst.body.position.x, y: inst.body.position.y, angle: inst.body.angle };
      const samples = evaluateVehicleSensors({ ...v, pose, instanceId: inst.id }, snapshot, this.configs.sensors);
      inst.lastSamples = samples;
      allSamples.push(...samples.map(s => ({ ...s, instanceId: inst.id })));
      const sensorValue = id => samples.find(s => s.componentId === id)?.value ?? 0;
      const gateValues = evaluateLogicGates(v, sensorValue);
      inst.gateValues = gateValues;
      const gateIds = new Set((v.logicGates ?? []).map(g => g.id));
      inst.lastMotors = [];
      for (const c of v.components) {
        if (!c.local || this.componentDef(c.type)?.category !== 'actuator') continue;
        const feeders = inst.wireMap[c.id];
        let force = 0;
        for (const f of feeders ?? []) {
          const srcVal = gateIds.has(f.sensorId) ? (gateValues[f.sensorId] ?? 0) : sensorValue(f.sensorId);
          force += computeActuation(srcVal, [f.wire], actCfg);
        }
        force *= actuatorPolaritySign(c.polarity, actCfg);
        force = applyMotorPower(force, c.props?.motorPower ?? actCfg.defaultMotorPower);
        inst.lastMotors.push({ id: c.id, local: { ...c.local }, force });
        if (!feeders?.length) continue;
        const dir = pose.angle + (c.localRotation ?? 0);
        const fx = Math.cos(dir) * force * thrustScale;
        const fy = Math.sin(dir) * force * thrustScale;
        const pt = { x: inst.body.position.x + (Math.cos(pose.angle) * c.local.x - Math.sin(pose.angle) * c.local.y),
                     y: inst.body.position.y + (Math.sin(pose.angle) * c.local.x + Math.cos(pose.angle) * c.local.y) };
        M.Body.applyForce(inst.body, pt, { x: fx, y: fy });
      }
    }
    this.lastSamples = allSamples;
    this.tick++;
    this.lastSnapshot = this.snapshot();
    return this.lastSnapshot;
  }

  /**
   * Serializable state for broadcast to clients. Carries enough per bot to render it faithfully
   * (orientation + body size/color) without sending the whole vehicle doc — thin clients only need
   * geometry, not the sensor/logic graph. Full precision here; the transport rounds on the wire.
   */
  snapshot() {
    return {
      t: this.tick,
      bots: this.instances.filter(i => i.body).map(i => {
        const v = this.vehicleFor(i);
        return {
          id: i.id, protoId: i.protoId, owner: i.owner ?? null,
          x: i.body.position.x, y: i.body.position.y, angle: i.body.angle,
          vx: i.body.velocity.x, vy: i.body.velocity.y,
          w: v?.body?.width ?? 80, h: v?.body?.height ?? 40, color: v?.body?.color ?? '#cc3333',
        };
      }),
    };
  }
}

function M_BodySetPosition(M, body, p) { if (body) M.Body.setPosition(body, p); }
function M_BodySetAngle(M, body, a) { if (body) M.Body.setAngle(body, a); }
function M_CompositeRemove(M, world, body) { if (body) M.Composite.remove(world, body); }
