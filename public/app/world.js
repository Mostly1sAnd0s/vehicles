/**
 * World Simulator: Matter.js physics + tested sensor/actuator core.
 * Fixed-timestep loop, camera pan/zoom, element editing, instance tools.
 */

import { evaluateVehicleSensors } from '../src/simulation/sampleSensors.js';
import { worldElementsToSnapshot } from '../src/simulation/worldSnapshot.js';
import { computeActuation, actuatorPolaritySign, applyMotorPower, wheelFrictionAir } from '../src/actuators.js';
import { componentSize } from '../src/models/hitTest.js';
import { drawWorld } from './worldDraw.js';
import { renderWorldInspector } from './worldInspector.js';
import { nextVehicleName, makePrototype, blankVehicle, removePrototype } from './prototypes.js';

// Matter.js is loaded as a classic script (public/vendor/matter.min.js)
const M = globalThis.Matter;

export class WorldSim {
  constructor(canvas, ui, state, hooks) {
    this.canvas = canvas;
    this.ui = ui;
    this.state = state;
    this.hooks = hooks;
    this.M = window.Matter;

    this.view = { x: 0, y: 0, zoom: 1 };
    this.playing = false;
    this.beams = true;
    this.selectedElement = null;
    this.instances = [];          // {id, protoId, body, seed:{x,y,rotation}}
    this.obstacleBodies = [];
    this.lastSamples = [];        // for beam drawing (per instance)
    this.showValues = true;       // on-body sensor/motor readouts
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
    const v = this.prototypeVehicle(inst.protoId);
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
      const v = this.prototypeVehicle(inst.protoId);
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

  // wire map per instance: wheelId -> [{wire, sensorId}]
  instWireMap(inst) {
    const v = this.prototypeVehicle(inst.protoId);
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
    const v = this.prototypeVehicle(inst.protoId);
    const cfg = this.state.configs.actuators?.powered_wheel ?? {};
    const wheels = (v?.components ?? []).filter(c => this.componentDef(c.type)?.category === 'actuator' && c.local);
    let f = cfg.defaultFriction ?? 0.5;
    if (wheels.length) {
      f = wheels.reduce((sum, c) => sum + (c.props?.friction ?? cfg.defaultFriction ?? 0.5), 0) / wheels.length;
    }
    inst.body.frictionAir = wheelFrictionAir(f, cfg);
  }

  step() {
    const M = this.M;
    for (const inst of this.instances) if (inst.body) this.applyWheelFriction(inst);
    M.Engine.update(this.engine, this.dtMs);

    const snapshot = worldElementsToSnapshot(this.worldDoc.elements);
    const thrustScale = this.state.configs.app.defaults.thrustScale ?? 0.25;
    const actCfg = this.state.configs.actuators.powered_wheel;
    const allSamples = [];

    for (const inst of this.instances) {
      const v = this.prototypeVehicle(inst.protoId);
      const pose = { x: inst.body.position.x, y: inst.body.position.y, angle: inst.body.angle };
      const samples = evaluateVehicleSensors({ ...v, pose }, snapshot, this.state.configs.sensors);
      inst.lastSamples = samples;
      allSamples.push(...samples.map(s => ({ ...s, instanceId: inst.id })));

      const sensorValue = id => samples.find(s => s.componentId === id)?.value ?? 0;
      inst.lastMotors = []; // per-wheel signed force (for on-body readout)
      for (const c of v.components) {
        if (!c.local || this.componentDef(c.type)?.category !== 'actuator') continue;
        const feeders = inst.wireMap[c.id];
        let force = 0;
        for (const f of feeders ?? []) force += computeActuation(sensorValue(f.sensorId), [f.wire], actCfg);
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
      if (this.playing) {
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
      const el = this.hitElement(w);
      if (el) {
        this.selectedElement = el.id;
        drag = { mode: 'element', el, started: { x: el.position.x, y: el.position.y }, mouse: w };
        this.renderInspector();
      } else {
        this.selectedElement = null;
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
      } else {
        this.view.x = drag.view0.x - (e.clientX - drag.e0.x) / this.view.zoom;
        this.view.y = drag.view0.y - (e.clientY - drag.e0.y) / this.view.zoom;
      }
    });
    window.addEventListener('mouseup', () => { drag = null; });
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const before = this.toWorld(e);
      this.view.zoom = Math.max(0.2, Math.min(3, this.view.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
      const after = this.toWorld(e);
      this.view.x += before.x - after.x;
      this.view.y += before.y - after.y;
    }, { passive: false });
  }

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

    this.ui.btnPlay.onclick = () => { this.playing = !this.playing; this.ui.btnPlay.textContent = this.playing ? '⏸ Pause' : '▶ Play'; };
    this.ui.btnStep.onclick = () => this.step();
    this.ui.btnReset.onclick = () => this.reset();
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

    const kb = this.state.configs.ui.keybindings ?? {};
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (!this.hooks.isWorldTabActive()) return;
      if (kb.playPause === e.code) this.ui.btnPlay.onclick();
      if (kb.step === e.code) this.step();
      if (kb.reset === e.code) this.reset();
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
  }

  reset() {
    for (const inst of this.instances) {
      M_BodySetPosition(this.M, inst.body, { x: inst.seed.x, y: inst.seed.y });
      M_BodySetAngle(this.M, inst.body, inst.seed.rotation);
      inst.body.velocity = { x: 0, y: 0 };
      inst.body.angularVelocity = 0;
    }
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
    if (act === 'here') {
      this.ensureCount(proto, proto.instances.length + 1, center);
    } else if (act === 'random') {
      const r = this.viewRadius();
      for (const inst of proto.instances) {
        inst.seed.x = center.x + (Math.random() - 0.5) * 2 * r;
        inst.seed.y = center.y + (Math.random() - 0.5) * 2 * r;
        inst.seed.rotation = Math.random() * Math.PI * 2;
      }
      this.reset();
    } else if (act === 'line') {
      const n = proto.instances.length;
      proto.instances.forEach((inst, i) => {
        inst.seed.x = center.x + (i - (n - 1) / 2) * 130;
        inst.seed.y = center.y;
        inst.seed.rotation = 0;
      });
      this.reset();
    } else if (act === 'grid') {
      const n = proto.instances.length;
      const cols = Math.ceil(Math.sqrt(n));
      proto.instances.forEach((inst, i) => {
        inst.seed.x = center.x + (i % cols - (cols - 1) / 2) * 130;
        inst.seed.y = center.y + (Math.floor(i / cols) - (Math.ceil(n / cols) - 1) / 2) * 130;
        inst.seed.rotation = 0;
      });
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
        position: at ?? { x: this.view.x + (Math.random() - 0.5) * 100, y: this.view.y + (Math.random() - 0.5) * 100 },
        rotation: Math.random() * Math.PI * 2,
      });
    }
    while (insts.length > n) insts.pop();
    // sync running instances with seeds (add/remove)
    const existing = this.instances.filter(i => i.protoId === proto.id);
    for (let i = 0; i < insts.length; i++) {
      if (!existing[i]) {
        const seed = insts[i];
        existing.push({ id: seed.id, protoId: proto.id, seed: { ...seed.position, rotation: seed.rotation }, body: null });
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
  draw() { drawWorld(this); }
}

function M_BodySetPosition(M, body, p) { M.Body.setPosition(body, p); }
function M_BodySetAngle(M, body, a) { M.Body.setAngle(body, a); }
function M_CompositeRemove(M, world, body) { if (body) M.Composite.remove(world, body); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
