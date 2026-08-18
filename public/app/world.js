/**
 * World Simulator: Matter.js physics + tested sensor/actuator core.
 * Fixed-timestep loop, camera pan/zoom, element editing, instance tools.
 */

import { evaluateVehicleSensors } from '../src/simulation/sampleSensors.js';
import { worldElementsToSnapshot } from '../src/simulation/worldSnapshot.js';
import { computeActuation } from '../src/actuators.js';
import { componentSize } from '../src/models/hitTest.js';

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
  step() {
    const M = this.M;
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
      for (const c of v.components) {
        if (!c.local || this.componentDef(c.type)?.category !== 'actuator') continue;
        const feeders = inst.wireMap[c.id];
        if (!feeders?.length) continue;
        let force = 0;
        for (const f of feeders) force += computeActuation(sensorValue(f.sensorId), [f.wire], actCfg);
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
      this.draw();
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
        <div class="row"><button data-act="edit">Edit Vehicle</button></div>`;
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
    // remove bodies of dropped instances
    for (const inst of this.instances) {
      if (!proto.instances.some(s => s.id === inst.id) && inst.body) {
        M_CompositeRemove(this.M, this.engine.world, inst.body);
        this.instances.splice(this.instances.indexOf(inst), 1);
      }
    }
    this.syncInstances();
    this.renderPrototypes();
  }

  // ---------------- inspector ----------------
  renderInspector() {
    const box = this.ui.worldInspector;
    const el = this.selectedElement ? this.worldDoc.elements.find(e => e.id === this.selectedElement) : null;
    if (!el) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    const isLight = el.type === 'light';
    box.innerHTML = `
      <h3 style="margin:0 0 6px">${isLight ? 'Light source' : 'Obstacle'}</h3>
      <label>X <input type="number" id="wi-x" value="${Math.round(el.position.x)}"></label>
      <label>Y <input type="number" id="wi-y" value="${Math.round(el.position.y)}"></label>
      <label>Rot° <input type="number" id="wi-rot" step="5" value="${Math.round(el.rotation * 180 / Math.PI)}"></label>
      <label>Scale <input type="number" id="wi-scale" step="0.1" value="${el.scale?.x ?? 1}"></label>
      ${isLight
        ? `<label>Intensity <input type="number" id="wi-int" step="100" value="${el.properties.intensity ?? 1}"></label>`
        : el.primitive === 'circle'
          ? `<label>Radius <input type="number" id="wi-rad" value="${el.properties.radius ?? 10}"></label>`
          : `<label>Width <input type="number" id="wi-w" value="${el.properties.width ?? 20}"></label>
             <label>Height <input type="number" id="wi-h" value="${el.properties.height ?? 20}"></label>`}
      <button id="wi-del">Delete element</button>`;
    const bind = (id, fn) => box.querySelector('#' + id)?.addEventListener('change', e => { fn(Number(e.target.value)); this.buildObstacles(); this.renderInspector(); });
    bind('wi-x', v => el.position.x = v);
    bind('wi-y', v => el.position.y = v);
    bind('wi-rot', v => el.rotation = v * Math.PI / 180);
    bind('wi-scale', v => { el.scale.x = v; el.scale.y = v; });
    bind('wi-int', v => el.properties.intensity = v);
    bind('wi-rad', v => el.properties.radius = v);
    bind('wi-w', v => el.properties.width = v);
    bind('wi-h', v => el.properties.height = v);
    box.querySelector('#wi-del').onclick = () => {
      this.worldDoc.elements = this.worldDoc.elements.filter(e => e.id !== el.id);
      this.selectedElement = null;
      this.buildObstacles();
      this.renderInspector();
    };
  }

  // ---------------- drawing ----------------
  draw() {
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== cv.clientWidth * dpr || cv.height !== cv.clientHeight * dpr) {
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.translate(cv.clientWidth / 2, cv.clientHeight / 2);
    ctx.scale(this.view.zoom, this.view.zoom);
    ctx.translate(-this.view.x, -this.view.y);

    const snap = worldElementsToSnapshot(this.worldDoc.elements);

    // lights: radial glow
    for (const l of snap.lights) {
      const r = 14 * Math.log2(2 + l.intensity);
      const g = ctx.createRadialGradient(l.x, l.y, 2, l.x, l.y, Math.max(r * 4, 60));
      g.addColorStop(0, 'rgba(255,230,150,.95)');
      g.addColorStop(0.25, 'rgba(255,200,90,.35)');
      g.addColorStop(1, 'rgba(255,200,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(l.x, l.y, Math.max(r * 4, 60), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath();
      ctx.arc(l.x, l.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // obstacles
    for (const obs of snap.obstacles) {
      ctx.fillStyle = '#3a4657';
      ctx.strokeStyle = '#55647a';
      ctx.lineWidth = 1.5;
      if (obs.type === 'circle') {
        ctx.beginPath();
        ctx.arc(obs.x, obs.y, obs.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.save();
        ctx.translate(obs.x, obs.y);
        ctx.rotate(obs.rotation);
        ctx.fillRect(-obs.width / 2, -obs.height / 2, obs.width, obs.height);
        ctx.strokeRect(-obs.width / 2, -obs.height / 2, obs.width, obs.height);
        ctx.restore();
      }
    }

    // instances
    for (const inst of this.instances) {
      const v = this.prototypeVehicle(inst.protoId);
      if (!v || !inst.body) continue;
      const b = inst.body;
      ctx.save();
      ctx.translate(b.position.x, b.position.y);
      ctx.rotate(b.angle);

      // body
      ctx.fillStyle = '#2b3a52';
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = 2;
      ctx.fillRect(-v.body.width / 2, -v.body.height / 2, v.body.width, v.body.height);
      ctx.strokeRect(-v.body.width / 2, -v.body.height / 2, v.body.width, v.body.height);

      for (const c of v.components) {
        if (!c.local) continue;
        const def = this.componentDef(c.type);
        const s = componentSize(c, def);
        ctx.beginPath();
        if (s.kind === 'rect') {
          ctx.save();
          ctx.translate(c.local.x, c.local.y);
          ctx.rotate(c.localRotation ?? 0);
          ctx.rect(-s.along / 2, -s.lateral / 2, s.along, s.lateral);
          ctx.restore();
        } else {
          ctx.arc(c.local.x, c.local.y, s.radius, 0, Math.PI * 2);
        }
        ctx.fillStyle = def?.category === 'actuator' ? '#35547a' : '#2f6b46';
        ctx.fill();
      }
      ctx.restore();
    }

    // sensor beams
    if (this.beams) {
      for (const s of this.lastSamples) {
        const range = this.prototypeVehicle(this.instances.find(i => i.id === s.instanceId)?.protoId)
          ?.components.find(c => c.id === s.componentId)?.props?.range ?? 150;
        const end = { x: s.samplePoint.x + Math.cos(s.direction) * range,
                      y: s.samplePoint.y + Math.sin(s.direction) * range };
        ctx.beginPath();
        ctx.moveTo(s.samplePoint.x, s.samplePoint.y);
        ctx.lineTo(end.x, end.y);
        ctx.strokeStyle = s.value > 0 ? 'rgba(255,180,90,.8)' : 'rgba(138,151,168,.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
}

function M_BodySetPosition(M, body, p) { M.Body.setPosition(body, p); }
function M_BodySetAngle(M, body, a) { M.Body.setAngle(body, a); }
function M_CompositeRemove(M, world, body) { if (body) M.Composite.remove(world, body); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
