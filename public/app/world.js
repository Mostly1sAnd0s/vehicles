/**
 * World Simulator: Matter.js physics + tested sensor/actuator core.
 * Fixed-timestep loop, camera pan/zoom, element editing, instance tools.
 */

import { evaluateVehicleSensors } from '../src/simulation/sampleSensors.js';
import { worldElementsToSnapshot } from '../src/simulation/worldSnapshot.js';
import { computeActuation, actuatorPolaritySign, applyMotorPower, wheelFrictionAir } from '../src/actuators.js';
import { evaluateLogicGates, vehicleSignature, selectPropagationTargets, cloneVehicleForConversion } from '../src/simulation/logic.js';
import { findInstanceAt, componentSize } from '../src/models/hitTest.js';
import { drawWorld } from './worldDraw.js';
import { renderWorldInspector } from './worldInspector.js';
import { nextVehicleName, makePrototype, blankVehicle, removePrototype, nextVehicleColor } from './prototypes.js';
import { lightenHex, DEFAULT_BODY_COLOR } from './color.js';

// Matter.js is loaded as a classic script (public/vendor/matter.min.js)
const M = globalThis.Matter;

/** Max points kept per instance for the Paths overlay. Long runs stay O(1). */
const PATH_CAP = 2000;

export class WorldSim {
  constructor(canvas, ui, state, hooks) {
    this.canvas = canvas;
    this.ui = ui;
    this.state = state;
    this.hooks = hooks;
    this.M = window.Matter;

    this.view = { x: 0, y: 0, zoom: 1 };
    this.playing = false;
    // Co-op (M5): while connected, the World canvas IS the shared world. Local physics then
    // neither steps nor draws its own instances; everything rides on server snapshots.
    this.coopMode = false;
    this.coopPaths = new Map(); // bot.id -> [{x,y}] accumulated client-side from snapshots
    this.beams = true;
    this.selectedElement = null;
    this.selectedInstance = null;   // a running vehicle shown in the inspector (X/Y/Rot)
    this.stepCount = 0;        // monotonic sim-step counter (drives cooldownTicks)
    this.convertedCount = 0;   // total instances converted this run (reset on reset())
    this.instances = [];          // {id, protoId, body, seed:{x,y,rotation}}
    this.obstacleBodies = [];
    this.lastSamples = [];        // for beam drawing (per instance)
    this.showValues = true;       // on-body sensor/motor readouts
    this.paths = false;           // show motion trails behind each robot
    this.acc = 0;
    this.lastT = performance.now();

    this.engine = M.Engine.create({ gravity: { x: 0, y: 0 } });

    this.bindUI();
    this.bindCanvas();
    this.syncInstances();
    this.buildObstacles();
    this.renderPrototypes();
    this.loop();
  }

  get worldDoc() { return this.state.world; }
  get dtMs() { return this.state.configs.app.defaults.fixedTimestepMs; }
  timeScale() { return this.worldDoc.physics?.timeScale ?? 1; }

  // ---------------- physics ----------------
  buildObstacles() {
    const M = this.M;
    for (const b of this.obstacleBodies) M.Composite.remove(this.engine.world, b);
    this.obstacleBodies = [];
    for (const obs of worldElementsToSnapshot(this.worldDoc.elements).obstacles) {
      let body;
      if (obs.type === 'circle') body = M.Bodies.circle(obs.x, obs.y, obs.radius, { isStatic: true });
      else body = M.Bodies.rectangle(obs.x, obs.y, obs.width, obs.height, { isStatic: true, angle: obs.rotation });
      this.obstacleBodies.push(body);
      M.Composite.add(this.engine.world, body);
    }
  }

  makeInstanceBody(inst) {
    const M = this.M;
    const v = this.vehicleFor(inst);
    if (!v) return null;
    const parts = [M.Bodies.rectangle(0, 0, v.body.width, v.body.height, { density: 0.001 })];
    for (const c of v.components) {
      if (!c.local) continue;
      const def = this.componentDef(c.type);
      parts.push(M.Bodies.circle(c.local.x, c.local.y, def?.size ?? 8, { density: 0.002 }));
    }
    return M.Body.create({ parts });
  }

  syncInstances() {
    // Keep running instances in step with the current vehicle doc (call after
    // any editor change). Wire maps refresh on every wiring change (cheap);
    // physics bodies only rebuild when component geometry actually changed,
    // preserving pose AND velocity so edits never stop a moving car.
    for (const inst of this.instances) {
      const v = this.vehicleFor(inst);
      if (!v) continue;
      const wireSig = JSON.stringify(v.wires ?? []);
      if (wireSig !== inst.wireSig) {
        inst.wireSig = wireSig;
        this.instWireMap(inst);
      }
      const geoSig = JSON.stringify((v.components ?? []).map(c => [c.id, c.type, c.local?.x, c.local?.y]));
      if (inst.body && geoSig === inst.geoSig) continue;
      const old = inst.body;
      if (old) M.Composite.remove(this.engine.world, old);
      inst.body = null;
      const body = this.makeInstanceBody(inst);
      if (!body) continue;
      if (old) {
        // keep pose + momentum across the rebuild
        M.Body.setPosition(body, old.position);
        M.Body.setAngle(body, old.angle);
        M.Body.setVelocity(body, old.velocity);
        M.Body.setAngularVelocity(body, old.angularVelocity);
      } else {
        // new instances spawn at seed; existing keep their pose
        if (!inst.hasSpawned) {
          M.Body.setPosition(body, { x: inst.seed.x, y: inst.seed.y });
          M.Body.setAngle(body, inst.seed.rotation);
        }
      }
      inst.body = body;
      inst.hasSpawned = true;
      inst.geoSig = geoSig;
      M.Composite.add(this.engine.world, body);
    }
  }

  componentDef(type) { return this.state.configs.components.components.find(c => c.id === type); }

  prototypeVehicle(protoId) {
    const proto = this.worldDoc.vehiclePrototypes.find(p => p.id === protoId);
    return proto ? (proto.vehicle ?? proto._vehicle) : null;
  }

  // Effective vehicle doc for a running instance. Normally the shared prototype
  // doc; but once configuration propagation converts an instance it carries its
  // own deep-cloned doc in `inst.vehicleOverride` (pose/momentum untouched). All
  // per-instance reads route through here so a converted robot behaves as its new
  // config, while unconverted robots behave exactly as before.
  vehicleFor(inst) {
    return inst?.vehicleOverride ?? this.prototypeVehicle(inst?.protoId);
  }

  // wire map per instance: wheelId -> [{wire, sensorId}]
  instWireMap(inst) {
    const v = this.vehicleFor(inst);
    const map = {};
    for (const w of v.wires ?? []) {
      (map[w.to.componentId] ??= []).push({ wire: w, sensorId: w.from.componentId });
    }
    inst.wireMap = map;
  }

  // ---------------- simulation step ----------------
  // per-wheel grip -> top-down drag on each composite body; reads the
  // current wheel friction props every tick so inspector tuning applies at once.
  applyWheelFriction(inst) {
    const v = this.vehicleFor(inst);
    const cfg = this.state.configs.actuators?.powered_wheel ?? {};
    const wheels = (v?.components ?? []).filter(c => this.componentDef(c.type)?.category === 'actuator' && c.local);
    let f = cfg.defaultFriction ?? 0.5;
    if (wheels.length) {
      f = wheels.reduce((sum, c) => sum + (c.props?.friction ?? cfg.defaultFriction ?? 0.5), 0) / wheels.length;
    }
    inst.body.frictionAir = wheelFrictionAir(f, cfg);
  }

  // ---------------- configuration propagation ("replicate") ----------------
  // A host carrying a `propagate` component copies its whole vehicle doc onto
  // any nearby robot whose config differs (nearest first, within the shared cap),
  // producing a true clone that carries the component onward. Idempotent: a pair
  // whose configs already match never re-fires, so a single seed converges to
  // all-converted and stops. Converted instances get a brief flash; a status pill
  // reports converted/total. reset() clears all of it back to the initial mix.
  stepPropagation() {
    this.stepCount++;
    const live = this.instances.filter(i => i.body);
    if (live.length < 2) { this.updatePropagationStatus(); return; }
    // Pre-conversion snapshot of every live instance (positions + config sig).
    const cand = live.map(i => ({ id: i.id, x: i.body.position.x, y: i.body.position.y, signature: vehicleSignature(this.vehicleFor(i)) }));
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // Hosts are captured from PRE-conversion state: an instance that only acquires
    // the Propagator this step spreads on a LATER step, so a fresh clone can't
    // turn around and re-convert its own source within the same pass.
    const hosts = live.filter(i => (this.vehicleFor(i)?.components ?? []).some(c => c.type === 'propagate'));
    let anyConverted = 0;
    for (const inst of hosts) {
      const v = this.vehicleFor(inst);
      const prop = v.components.find(c => c.type === 'propagate');
      const p = prop.props ?? {};
      const threshold = p.threshold ?? 260;
      const cooldownTicks = p.cooldownTicks ?? 0;
      const maxConverted = (p.maxConverted == null || Number.isNaN(Number(p.maxConverted))) ? null : Math.max(0, Number(p.maxConverted));
      // Cooldown: a freshly-converted instance waits `cooldownTicks` steps before it
      // may itself propagate (bounds spread speed; 0 = immediate). A seed that
      // carried the component from the start is always eligible.
      const eligible = inst.convertedAt == null || (this.stepCount - inst.convertedAt >= cooldownTicks);
      if (!eligible) continue;
      const hostSig = cand.find(c => c.id === inst.id)?.signature;
      // The trigger radiates from the Propagator's OWN position (not the body
      // centre): a robot that bumps the side of the host carrying it is close
      // enough to convert, while one on the far side stays out of range.
      const a = inst.body.angle;
      const lx = prop.local?.x ?? 0, ly = prop.local?.y ?? 0;
      const hx = inst.body.position.x + Math.cos(a) * lx - Math.sin(a) * ly;
      const hy = inst.body.position.y + Math.sin(a) * lx + Math.cos(a) * ly;
      const targets = selectPropagationTargets(
        { id: inst.id, x: hx, y: hy, signature: hostSig },
        cand, { threshold, maxConverted, alreadyConverted: this.convertedCount });
      for (const t of targets) {
        const target = live.find(i => i.id === t.id);
        if (!target || target.vehicleOverride) continue; // guard same-step multi-source races
        const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        target.vehicleOverride = cloneVehicleForConversion(v, nonce);
        target.converted = true;
        target.convertedAt = this.stepCount;
        target.flashUntil = now() + 700;
        this.convertedCount++;
        anyConverted++;
      }
    }
    if (anyConverted) this.syncInstances(); // rebuild converted bodies + wire maps in place, pose preserved
    this.updatePropagationStatus();
  }

  updatePropagationStatus() {
    const hostProp = inst => (this.vehicleFor(inst)?.components ?? []).find(c => c.type === 'propagate');
    const hasHost = this.instances.some(hostProp);
    let el = document.getElementById('propagation-status');
    if (!hasHost) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'propagation-status';
      el.style.cssText = 'position:absolute;top:10px;left:10px;z-index:5;padding:3px 8px;font:11px/1.4 monospace;background:rgba(20,28,44,.9);color:#8dffbe;border:1px solid #35547a;border-radius:6px;pointer-events:none;';
      const parent = this.canvas?.parentElement;
      if (parent) parent.appendChild(el);
    }
    let cap = null;
    for (const i of this.instances) {
      const pp = hostProp(i);
      if (pp && pp.props?.maxConverted != null && !Number.isNaN(Number(pp.props.maxConverted))) { cap = Math.max(0, Number(pp.props.maxConverted)); break; }
    }
    el.style.display = 'block';
    el.textContent = `Propagation ${this.convertedCount}/${cap ?? this.instances.length} converted`;
  }

  step() {
    const M = this.M;
    for (const inst of this.instances) if (inst.body) this.applyWheelFriction(inst);
    M.Engine.update(this.engine, this.dtMs);

    // Record trajectory points for the Paths overlay. Capped; cleared on reset().
    for (const inst of this.instances) {
      if (!inst.body) continue;
      if (!Array.isArray(inst.path)) inst.path = [];
      inst.path.push({ x: Math.round(inst.body.position.x), y: Math.round(inst.body.position.y) });
      if (inst.path.length > PATH_CAP) inst.path.shift();
    }

    // Configuration propagation: any `propagate` component copies its host's
    // vehicle doc onto nearby robots whose config differs (before actuation, so
    // a freshly-converted robot drives with its new config this same step).
    this.stepPropagation();

    const snapshot = worldElementsToSnapshot(this.worldDoc.elements);
    // Fleet poses for vehicle-detection sensors: every instance's current world
    // pose. Each sensor excludes itself by instanceId (see sampleSensors).
    snapshot.vehicles = this.instances
      .filter(i => i.body)
      .map(i => ({ id: i.id, x: i.body.position.x, y: i.body.position.y, angle: i.body.angle }));
    const thrustScale = this.state.configs.app.defaults.thrustScale ?? 0.25;
    const actCfg = this.state.configs.actuators.powered_wheel;
    const allSamples = [];

    for (const inst of this.instances) {
      const v = this.vehicleFor(inst);
      if (!v) continue; // proto removed mid-run: skip rather than crash the loop
      const pose = { x: inst.body.position.x, y: inst.body.position.y, angle: inst.body.angle };
      const samples = evaluateVehicleSensors({ ...v, pose, instanceId: inst.id }, snapshot, this.state.configs.sensors);
      inst.lastSamples = samples;
      allSamples.push(...samples.map(s => ({ ...s, instanceId: inst.id })));

      const sensorValue = id => samples.find(s => s.componentId === id)?.value ?? 0;
      // Resolve combinational logic gates (topological; a sensor reading is
      // coerced to digital when its 'digital' toggle is on). Gate outputs feed
      // actuators or other gates through the same wires graph.
      const gateValues = evaluateLogicGates(v, sensorValue);
      inst.gateValues = gateValues;
      const gateIds = new Set((v.logicGates ?? []).map(g => g.id));
      inst.lastMotors = []; // per-wheel signed force (for on-body readout)
      for (const c of v.components) {
        if (!c.local || this.componentDef(c.type)?.category !== 'actuator') continue;
        const feeders = inst.wireMap[c.id];
        let force = 0;
        for (const f of feeders ?? []) {
          // A feeder may come from a raw sensor OR a logic gate output.
          const srcVal = gateIds.has(f.sensorId) ? (gateValues[f.sensorId] ?? 0) : sensorValue(f.sensorId);
          force += computeActuation(srcVal, [f.wire], actCfg);
        }
        force *= actuatorPolaritySign(c.polarity, actCfg); // per-motor forward/reverse
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
  }

  loop() {
    const frame = t => {
      const timeScale = this.timeScale();
      // Single-player only: the shared world is stepped authoritatively on the server.
      if (this.playing && !this.coopMode) {
        this.acc += Math.min(t - this.lastT, 100) * timeScale;
        while (this.acc >= this.dtMs) {
          this.step();
          this.acc -= this.dtMs;
        }
      }
      this.lastT = t;
      try { this.draw(); } catch (err) { console.error('draw failed:', err); } // never kill the rAF chain
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ---------------- camera ----------------
  toWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - r.width / 2) / this.view.zoom + this.view.x,
      y: (e.clientY - r.top - r.height / 2) / this.view.zoom + this.view.y,
    };
  }

  bindCanvas() {
    let drag = null;
    this.canvas.addEventListener('mousedown', e => {
      const w = this.toWorld(e);
      // instance drag takes precedence: a robot on top of an element gets grabbed first
      const inst = findInstanceAt(this.instances, pid => this.prototypeVehicle(pid), w, this.view.zoom);
      if (inst) {
        // Grab the robot AND surface it in the inspector (X/Y/Rot), like elements.
        this.selectedInstance = inst;
        this.selectedElement = null;
        this.renderInspector();
        drag = { mode: 'instance', inst };
        return;
      }
      const el = this.hitElement(w);
      if (el) {
        this.selectedElement = el.id;
        this.selectedInstance = null;
        drag = { mode: 'element', el, started: { x: el.position.x, y: el.position.y }, mouse: w };
        this.renderInspector();
      } else {
        this.selectedElement = null;
        this.selectedInstance = null;
        this.renderInspector();
        drag = { mode: 'pan', view0: { ...this.view }, e0: { x: e.clientX, y: e.clientY } };
      }
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      if (drag.mode === 'element') {
        const w = this.toWorld(e);
        drag.el.position.x = drag.started.x + (w.x - drag.mouse.x);
        drag.el.position.y = drag.started.y + (w.y - drag.mouse.y);
        this.buildObstacles();
        this.renderInspector();
      } else if (drag.mode === 'instance') {
        // setting position each move wins per-frame; zero momentum so it doesn't fling
        const w = this.toWorld(e);
        M_BodySetPosition(this.M, drag.inst.body, w);
        M.Body.setVelocity(drag.inst.body, { x: 0, y: 0 });
        M.Body.setAngularVelocity(drag.inst.body, 0);
      } else {
        this.view.x = drag.view0.x - (e.clientX - drag.e0.x) / this.view.zoom;
        this.view.y = drag.view0.y - (e.clientY - drag.e0.y) / this.view.zoom;
      }
    });
    window.addEventListener('mouseup', () => {
      if (drag?.mode === 'instance' && drag.inst.body) {
        // adopt the dropped pose as the seed so Reset restores it
        drag.inst.seed = { x: drag.inst.body.position.x, y: drag.inst.body.position.y, rotation: drag.inst.body.angle };
      }
      // Co-op (M5 p3): a dropped element lands at its final pose — sync the move out once.
      if (drag?.mode === 'element') {
        this.hooks?.onElementChange?.({ op: 'move', id: drag.el.id, x: Math.round(drag.el.position.x), y: Math.round(drag.el.position.y) });
      }
      drag = null;
    });
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const before = this.toWorld(e);
      this.view.zoom = Math.max(0.2, Math.min(3, this.view.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
      const after = this.toWorld(e);
      this.view.x += before.x - after.x;
      this.view.y += before.y - after.y;
    }, { passive: false });
  }

  // ---------------- co-op (M5): the canvas is the shared world ----------------
  /** Connected (host or joiner): stop local stepping/drawing of home-world instances. */
  setCoop(on) {
    if (this.coopMode === !!on) return;
    this.coopMode = !!on;
    this.coopPaths.clear();
    if (this.ui?.btnStep) this.ui.btnStep.disabled = on; // a local single step would mislead
  }

  /** The server's authoritative running flag also drives the local Play/Pause label. */
  setRunning(running) {
    this.playing = !!running;
    if (this.ui?.btnPlay) this.ui.btnPlay.textContent = this.playing ? '⏸ Pause' : '▶ Play';
  }

  /** Called per received snapshot: accrue one trail point per bot (paths toggle reads it). */
  onCoopSnapshot() {
    if (!this.coopMode) return;
    const bots = this.hooks?.remoteBots?.() ?? [];
    const live = new Set();
    for (const b of bots) {
      live.add(b.id);
      let pts = this.coopPaths.get(b.id);
      if (!pts) { pts = []; this.coopPaths.set(b.id, pts); }
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(b.x - last.x, b.y - last.y) > 0.25) {
        pts.push({ x: b.x, y: b.y });
        if (pts.length > 2000) pts.shift(); // same cap as the local Paths trail
      }
    }
    for (const id of [...this.coopPaths.keys()]) if (!live.has(id)) this.coopPaths.delete(id);
  }

  clearCoopPaths() { this.coopPaths.clear(); }

  hitElement(w) {
    for (const el of this.worldDoc.elements) {
      const dx = w.x - el.position.x, dy = w.y - el.position.y;
      let r = 12;
      if (el.primitive === 'circle') r = (el.properties?.radius ?? 10) * (el.scale?.x ?? 1);
      else r = Math.max(el.properties?.width ?? 20, el.properties?.height ?? 20) / 2;
      if (Math.hypot(dx, dy) <= r + 4 / this.view.zoom) return el;
    }
    return null;
  }

  // ---------------- UI ----------------
  bindUI() {
    const mkEl = () => this.toWorld({ clientX: this.canvas.getBoundingClientRect().left + this.canvas.clientWidth / 2,
                                       clientY: this.canvas.getBoundingClientRect().top + this.canvas.clientHeight / 2 });

    this.ui.addLight.onclick = () => this.addElement({ type: 'light', primitive: 'circle', properties: { intensity: 3000 } }, mkEl());
    this.ui.addRock.onclick = () => this.addElement({ type: 'rock', primitive: 'circle', properties: { radius: 40 } }, mkEl());
    this.ui.addWall.onclick = () => this.addElement({ type: 'obstacle', primitive: 'rect', properties: { width: 200, height: 24 } }, mkEl());

    this.ui.addVehicle.onclick = () => this.addVehicle();

    // In co-op mode the sim runs on the server: forward start/pause/reset to the session and let
    // the authoritative `state` message flip the button (setRunning). Joiners never get here —
    // the panel hides these buttons for non-admins.
    this.ui.btnPlay.onclick = () => {
      if (this.coopMode) { this.hooks?.onSharedControl?.(this.playing ? 'pause' : 'start'); return; }
      this.playing = !this.playing;
      this.ui.btnPlay.textContent = this.playing ? '⏸ Pause' : '▶ Play';
    };
    this.ui.btnStep.onclick = () => this.step(); // no single-step on the shared world
    this.ui.btnReset.onclick = () => {
      if (this.coopMode) { this.hooks?.onSharedControl?.('reset'); this.clearCoopPaths(); return; }
      this.reset();
    };
    this.ui.timescale.oninput = e => {
      this.worldDoc.physics.timeScale = Number(e.target.value);
      this.ui.timescaleVal.textContent = Number(e.target.value).toFixed(1) + '×';
    };
    this.ui.btnBeams.onclick = () => {
      this.beams = !this.beams;
      this.ui.btnBeams.textContent = `Beams: ${this.beams ? 'on' : 'off'}`;
    };
    this.ui.btnValues.onclick = () => {
      this.showValues = !this.showValues;
      this.ui.btnValues.textContent = `Values: ${this.showValues ? 'on' : 'off'}`;
    };
    this.ui.btnPaths.onclick = () => {
      this.paths = !this.paths;
      this.ui.btnPaths.textContent = `Paths: ${this.paths ? 'on' : 'off'}`;
    };

    const kb = this.state.configs.ui.keybindings ?? {};
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (!this.hooks.isWorldTabActive()) return;
      // Route through the button handlers so co-op mode forwards to the shared session.
      if (kb.playPause === e.code) this.ui.btnPlay.onclick();
      if (kb.step === e.code && !this.coopMode) this.step();
      if (kb.reset === e.code) this.ui.btnReset.onclick();
      if (kb.toggleBeams === e.code) this.ui.btnBeams.onclick();
    });
  }

  addElement(partial, at) {
    const el = {
      id: `el_${Date.now().toString(36)}`,
      type: 'obstacle', primitive: 'circle',
      position: { x: Math.round(at.x), y: Math.round(at.y) },
      rotation: 0, scale: { x: 1, y: 1 }, properties: {},
      ...partial,
    };
    this.worldDoc.elements.push(el);
    this.selectedElement = el.id;
    this.buildObstacles();
    this.renderInspector();
    // Co-op (M5 p3): the host's canvas is the shared world — mirror the add out to joiners.
    this.hooks?.onElementChange?.({ op: 'add', element: el });
  }

  // Move a running vehicle to an explicit pose (used by the inspector) and adopt
  // it as the seed so Reset restores that exact placement.
  setInstancePose(inst, x, y, rot) {
    if (!inst || !inst.body) return;
    M_BodySetPosition(this.M, inst.body, { x, y });
    M_BodySetAngle(this.M, inst.body, rot);
    inst.body.velocity = { x: 0, y: 0 };
    inst.body.angularVelocity = 0;
    inst.seed = { x, y, rotation: rot };
  }

  reset() {
    let hadPropagation = false;
    for (const inst of this.instances) {
      M_BodySetPosition(this.M, inst.body, { x: inst.seed.x, y: inst.seed.y });
      M_BodySetAngle(this.M, inst.body, inst.seed.rotation);
      inst.body.velocity = { x: 0, y: 0 };
      inst.body.angularVelocity = 0;
      inst.path = []; // fresh trail after a reset
      // Restore the initial mix: drop any propagated clone + bookkeeping.
      if (inst.vehicleOverride || inst.converted) hadPropagation = true;
      inst.vehicleOverride = null;
      inst.converted = false;
      inst.convertedAt = null;
      inst.flashUntil = 0;
    }
    this.convertedCount = 0;
    if (hadPropagation) this.syncInstances(); // convert clone bodies back to the prototype doc
    this.updatePropagationStatus();
    this.acc = 0;
  }

  // ---------------- prototypes / instances ----------------
  renderPrototypes() {
    const box = this.ui.prototypes;
    box.innerHTML = '';
    for (const proto of this.worldDoc.vehiclePrototypes) {
      const div = document.createElement('div');
      div.className = 'proto-block';
      div.innerHTML = `
        <h4><span>${escapeHtml(proto.name)}</span><span class="count">${proto.instances.length}</span></h4>
        <div class="row">
          <input type="number" min="0" max="32" value="${proto.instances.length}" class="count-input">
        </div>
        <div class="row">
          <button data-act="here">Add Here</button>
          <button data-act="random">Random</button>
          <button data-act="line">Line Up</button>
          <button data-act="grid">Grid</button>
        </div>
        <div class="row">
          <button data-act="edit">Edit Vehicle</button>
          <button data-act="remove" class="danger">Remove</button>
        </div>`;
      const countInput = div.querySelector('.count-input');
      countInput.onchange = () => { this.ensureCount(proto, Number(countInput.value)); };
      div.querySelectorAll('[data-act]').forEach(b => b.onclick = () => this.protoAction(proto, b.dataset.act));
      box.appendChild(div);
    }
    // keep running instances in sync with documented seeds (initial load)
    if (!this._syncing) {
      this._syncing = true;
      try { for (const p of this.worldDoc.vehiclePrototypes) this.ensureCount(p, p.instances.length); }
      finally { this._syncing = false; }
    }
  }

  protoAction(proto, act) {
    const center = this.toWorld({ clientX: this.canvas.getBoundingClientRect().left + this.canvas.clientWidth / 2,
                                  clientY: this.canvas.getBoundingClientRect().top + this.canvas.clientHeight / 2 });
    // Documented seeds (proto.instances[i].position/.rotation) and the running
    // mirror (this.instances[i].seed) must BOTH move: reset() re-seats bodies from
    // the running .seed, while saves export the documented position. Previously
    // only `.seed` was written on the documented object (which has none), so these
    // buttons threw and appeared to do nothing.
    const runs = this.instances.filter(i => i.protoId === proto.id);
    const setSeed = (i, x, y, rot) => {
      const d = proto.instances[i];
      if (!d) return;
      d.position = { x, y };
      d.rotation = rot;
      if (runs[i]) runs[i].seed = { x, y, rotation: rot };
    };
    if (act === 'here') {
      this.ensureCount(proto, proto.instances.length + 1, center);
    } else if (act === 'random') {
      const r = this.viewRadius();
      proto.instances.forEach((_, i) => setSeed(i,
        center.x + (Math.random() - 0.5) * 2 * r,
        center.y + (Math.random() - 0.5) * 2 * r,
        Math.random() * Math.PI * 2));
      this.reset();
    } else if (act === 'line') {
      const n = proto.instances.length;
      proto.instances.forEach((_, i) => setSeed(i, center.x + (i - (n - 1) / 2) * 130, center.y, 0));
      this.reset();
    } else if (act === 'grid') {
      const n = proto.instances.length;
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      const rows = Math.max(1, Math.ceil(n / cols));
      proto.instances.forEach((_, i) => setSeed(i,
        center.x + (i % cols - (cols - 1) / 2) * 130,
        center.y + (Math.floor(i / cols) - (rows - 1) / 2) * 130,
        0));
      this.reset();
    } else if (act === 'edit') {
      this.hooks.openEditor(proto);
    } else if (act === 'remove') {
      this.removeVehicle(proto);
    }
    this.renderPrototypes();
  }

  viewRadius() { return Math.max(this.canvas.clientWidth, this.canvas.clientHeight) / this.view.zoom * 0.4; }

  ensureCount(proto, n, at) {
    const insts = proto.instances;
    while (insts.length < n) {
      insts.push({
        id: `inst_${Date.now().toString(36)}_${insts.length}`,
        // No explicit drop point: spread across the visible area (not a tight ±50
        // cluster at the origin, which read as "a pile at center").
        position: at ?? { x: this.view.x + (Math.random() - 0.5) * this.viewRadius(),
                          y: this.view.y + (Math.random() - 0.5) * this.viewRadius() },
        rotation: Math.random() * Math.PI * 2,
      });
    }
    while (insts.length > n) insts.pop();
    // sync running instances with seeds (add/remove)
    const existing = this.instances.filter(i => i.protoId === proto.id);
    for (let i = 0; i < insts.length; i++) {
      if (!existing[i]) {
        const seed = insts[i];
        existing.push({ id: seed.id, protoId: proto.id, seed: { ...seed.position, rotation: seed.rotation }, body: null, path: [] });
      } else {
        existing[i].seed = { x: insts[i].position.x, y: insts[i].position.y, rotation: insts[i].rotation };
      }
    }
    for (let i = insts.length; i < existing.length; i++) {
      M_CompositeRemove(this.M, this.engine.world, existing[i].body);
    }
    this.instances = this.instances.filter(i => i.protoId !== proto.id).concat(existing);
    // remove bodies of dropped instances (only this proto: other vehicle
    // types share this.instances and their ids are not in proto.instances)
    for (const inst of this.instances) {
      if (inst.protoId === proto.id && !proto.instances.some(s => s.id === inst.id) && inst.body) {
        M_CompositeRemove(this.M, this.engine.world, inst.body);
        this.instances.splice(this.instances.indexOf(inst), 1);
      }
    }
    this.syncInstances();
    this.renderPrototypes();
  }

  /** Create a new vehicle type: next unused name, vehicle cloned from an
   *  existing prototype (or the blank chassis), with a few live instances. */
  addVehicle() {
    const protos = this.worldDoc.vehiclePrototypes;
    const donor = protos.find(p => p._vehicle ?? p.vehicle);
    const proto = makePrototype({
      name: nextVehicleName(protos),
      vehicle: donor ? (donor._vehicle ?? donor.vehicle) : blankVehicle(),
      count: 3,
    });
    // Give the new type a body color no existing type uses so they read apart.
    proto._vehicle.body.color = nextVehicleColor(protos);
    protos.push(proto);
    this.ensureCount(proto, proto.instances.length); // spawns instances + re-renders
  }

  /** Delete a vehicle type after confirm: drop its running bodies, then the doc entry. */
  removeVehicle(proto) {
    if (!confirm(`Remove \u201c${proto.name}\u201d and all of its instances?`)) return;
    this.dropInstancesOf(proto.id);
    const { vehiclePrototypes } = removePrototype(this.worldDoc, proto.id);
    this.worldDoc.vehiclePrototypes = vehiclePrototypes;
    if (this.state.vehicleOwner === proto) this.state.vehicleOwner = null;
    this.renderPrototypes();
  }

  /** Remove one prototype's running instances from physics + bookkeeping. */
  dropInstancesOf(protoId) {
    for (const inst of [...this.instances]) {
      if (inst.protoId !== protoId) continue;
      M_CompositeRemove(this.M, this.engine.world, inst.body);
      this.instances.splice(this.instances.indexOf(inst), 1);
    }
  }

  // ---------------- inspector ----------------
  renderInspector() { renderWorldInspector(this); }

  // ---------------- drawing ----------------
  draw() {
    drawWorld(this);
    // Co-op (M5 p3): shared-world bots ride on top of the local render. The ctx transform is
    // still world-space here (drawWorld leaves it that way), so we can draw straight in world coords.
    if (!this.hooks?.remoteBots) return;
    const bots = this.hooks.remoteBots();
    if (!bots?.length) return;
    const ctx = this.canvas.getContext('2d');
    // Motion trails UNDER the bodies (Paths toggle), accrued client-side from snapshots.
    if (this.paths) {
      for (const b of bots) {
        const pts = this.coopPaths.get(b.id);
        if (!pts || pts.length < 2) continue;
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = b.color ?? '#4da3ff'; // the vehicle's own body color, like local trails
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    bots.forEach((b) => {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.angle ?? 0);
      // The body IS the vehicle's editor color: the server snapshot carries body.color (set in
      // the editor's swatch palette), so a shared bot reads exactly like its local twin. Mine
      // vs others is told by alpha, not hue.
      const bodyColor = b.color ?? DEFAULT_BODY_COLOR;
      ctx.globalAlpha = b.mine ? 1 : 0.85;
      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = lightenHex(bodyColor);
      ctx.lineWidth = 2 / this.view.zoom;
      ctx.beginPath();
      ctx.rect(-(b.w ?? 80) / 2, -(b.h ?? 40) / 2, b.w ?? 80, b.h ?? 40);
      ctx.fill();
      ctx.stroke();
      // Co-op (M5 p3): draw the deployed vehicle's parts so a shared bot reads as its actual
      // design, not a blank body. componentSize only needs the type's config definition.
      if (Array.isArray(b.comps)) {
        for (const comp of b.comps) {
          const def = this.componentDef(comp.type);
          const s = componentSize({ local: { x: comp.x, y: comp.y } }, def);
          ctx.fillStyle = def?.category === 'actuator' ? '#35547a' : '#2f6b46';
          if (s.kind === 'rect') {
            ctx.save();
            ctx.translate(comp.x, comp.y);
            ctx.rect(-s.along / 2, -s.lateral / 2, s.along, s.lateral);
            ctx.fill();
            ctx.restore();
          } else {
            ctx.beginPath();
            ctx.arc(comp.x, comp.y, s.radius, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.fillStyle = '#fff'; // heading notch at the front edge
      ctx.fillRect((b.w ?? 80) / 2 - 8, -2, 8, 4);
      ctx.restore();
    });
    ctx.globalAlpha = 1;
    // Sensor beams + on-body readouts from the server's samples (same toggles as local bots).
    for (const b of bots) {
      if (this.beams) this.drawCoopBeams(ctx, b);
      if (this.showValues) this.drawCoopValues(ctx, b);
    }
  }

  /**
   * Shared-bot sensor beams, mirroring the local renderer's conventions (worldDraw.js): a light
   * sensor draws a FOV wedge whose length IS its current sensing radius and whose brightness
   * tracks level; vehicle-detection draws its FOV cone (lit when something is in it); distance
   * sensors draw a thin full-range ray. The samples already carry world-space samplePoint/direction
   * computed by the server at the bot's live pose.
   */
  drawCoopBeams(ctx, b) {
    for (const s of b.samples ?? []) {
      if (!s.samplePoint || s.direction == null) continue;
      const { x: sx, y: sy } = s.samplePoint;
      // Light sensor
      if (s.lightLevel != null && s.effectiveRange != null) {
        const fov = (s.fov == null || !Number.isFinite(s.fov)) ? 2 * Math.PI : s.fov;
        const lvl = Math.min(Math.max(s.lightLevel, 0), 1);
        const reach = s.effectiveRange ?? 0;
        if (reach <= 0) {
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, 2 * Math.PI);
          ctx.strokeStyle = 'rgba(255,180,90,0.25)';
          ctx.lineWidth = 1;
          ctx.stroke();
          continue;
        }
        const half = Math.min(fov / 2, Math.PI);
        const alpha = 0.06 + 0.8 * lvl;
        ctx.beginPath();
        if (half >= Math.PI - 1e-3) {
          ctx.arc(sx, sy, reach, 0, 2 * Math.PI); // omni: full circle
        } else {
          const a1 = s.direction - half, a2 = s.direction + half;
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + Math.cos(a1) * reach, sy + Math.sin(a1) * reach);
          ctx.arc(sx, sy, reach, a1, a2); // edge -> arc -> other edge = wedge
        }
        ctx.closePath();
        ctx.fillStyle = `rgba(255,180,90,${(alpha * 0.22).toFixed(3)})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255,180,90,${alpha.toFixed(3)})`;
        ctx.lineWidth = 1 + 1.5 * lvl;
        ctx.stroke();
        continue;
      }
      // Vehicle-detection sensor: a cone whose aperture IS its FOV
      if (s.detected !== undefined && s.fov != null) {
        const range = s.range ?? 150;
        const half = Math.min(s.fov / 2, Math.PI);
        ctx.beginPath();
        if (half >= Math.PI - 1e-3) {
          ctx.arc(sx, sy, range, 0, 2 * Math.PI);
        } else {
          const a1 = s.direction - half, a2 = s.direction + half;
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + Math.cos(a1) * range, sy + Math.sin(a1) * range);
          ctx.arc(sx, sy, range, a1, a2);
        }
        ctx.closePath();
        ctx.fillStyle = s.detected ? 'rgba(141,255,190,0.18)' : 'rgba(141,255,190,0.06)';
        ctx.fill();
        ctx.strokeStyle = s.detected ? 'rgba(141,255,190,0.9)' : 'rgba(141,255,190,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
        continue;
      }
      // Distance sensor: thin full-range ray; the component's configured range is per-comp.
      const comp = (b.comps ?? []).find(c => c.id === s.componentId);
      const len = comp?.range ?? 150;
      if (!len) continue;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(s.direction) * len, sy + Math.sin(s.direction) * len);
      ctx.strokeStyle = 'rgba(140,200,255,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /** Shared-bot readouts: world X/Y above the body, level→output per sensor, signed force per wheel. */
  drawCoopValues(ctx, b) {
    const label = (x, y, text, color) => {
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    };
    label(b.x - 34, b.y - ((b.h ?? 40) / 2 + 12), `x ${Math.round(b.x)}  y ${Math.round(b.y)}`, '#e8f0ff');
    for (const s of b.samples ?? []) {
      if (!s.samplePoint) continue;
      let txt;
      let col = '#ffd479';
      if (s.lightLevel != null) {
        const dTxt = s.lightDistance != null ? ` d\u2248${Math.round(s.lightDistance)}` : '';
        txt = `L ${s.lightLevel.toFixed(2)}\u2192${s.value.toFixed(2)}${dTxt}`;
      } else if (s.detected !== undefined) {
        const dTxt = s.detected && s.detectedDistance != null ? ` d\u2248${Math.round(s.detectedDistance)}` : '';
        txt = `V ${s.detected ? 1 : 0}${dTxt}`;
        if (s.detected) col = '#8dffbe';
      } else {
        txt = `D ${s.value.toFixed(2)}`;
      }
      label(s.samplePoint.x + 8, s.samplePoint.y - 9, txt, col);
    }
    for (const m of b.motors ?? []) {
      if (!m.local) continue;
      const a = b.angle ?? 0; // component local -> world at the bot's live pose
      const px = b.x + Math.cos(a) * m.local.x - Math.sin(a) * m.local.y;
      const py = b.y + Math.sin(a) * m.local.x + Math.cos(a) * m.local.y;
      const txt = m.force < 0 ? `M -${Math.abs(m.force).toFixed(2)}` : `M +${m.force.toFixed(2)}`;
      label(px + 8, py + 9, txt, m.force < 0 ? '#ff9d9d' : '#9ad0ff');
    }
  }
}

function M_BodySetPosition(M, body, p) { M.Body.setPosition(body, p); }
function M_BodySetAngle(M, body, a) { M.Body.setAngle(body, a); }
function M_CompositeRemove(M, world, body) { if (body) M.Composite.remove(world, body); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
