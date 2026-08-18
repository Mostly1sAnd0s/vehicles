/**
 * Vehicle Editor: snap-point based component placement + wiring.
 * Draws in vehicle-local coordinates centered on the canvas.
 */

export class VehicleEditor {
  constructor(canvas, ui, state, hooks) {
    this.canvas = canvas;
    this.ui = ui;
    this.state = state;
    this.hooks = hooks;
    this.placing = null;
    this.selectedComp = null;
    this.selectedWire = null;
    this.hoverSnap = -1;
    this.nextNum = 1;

    this.bindUI();
    this.bindCanvas();
    this.refresh();
    this.loop();
  }

  get componentsConfig() { return this.state.configs.components.components; }
  compDef(type) { return this.componentsConfig.find(c => c.id === type); }

  snapPoints() {
    const v = this.state.vehicle;
    const n = this.state.configs.app.defaults.snapPointCount;
    return generateSnapPoints(v.body, n);
  }

  bindUI() {
    const palette = this.ui.palette;
    for (const def of this.componentsConfig) {
      const b = document.createElement('button');
      b.textContent = `${def.name}  ·  ${def.category}`;
      b.onclick = () => {
        this.placing = this.placing === def.id ? null : def.id;
        palette.querySelectorAll('button').forEach(x => x.classList.remove('placing'));
        if (this.placing) b.classList.add('placing');
      };
      palette.appendChild(b);
    }

    this.ui.wireWeightRange.oninput = () => {
      this.ui.wireWeightVal.textContent = Number(this.ui.wireWeightRange.value).toFixed(2);
    };
    this.ui.addWire.onclick = () => this.addWire();
  }

  bindCanvas() {
    this.canvas.addEventListener('mousemove', e => {
      const p = this.toLocal(e);
      this.hoverSnap = this.nearestSnap(p, 14);
    });
    this.canvas.addEventListener('click', e => {
      const p = this.toLocal(e);
      if (this.placing) {
        const idx = this.nearestSnap(p, 20);
        if (idx >= 0) this.placeComponent(this.placing, idx);
        return;
      }
      // select component or wire
      const c = this.hitComponent(p);
      this.selectedComp = c ? c.id : null;
      if (!c) {
        this.selectedWire = this.hitWire(p);
      } else {
        this.selectedWire = null;
      }
      this.refresh();
    });
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        if (this.selectedComp) this.removeComponent(this.selectedComp);
        else if (this.selectedWire !== null) this.state.vehicle.wires.splice(this.selectedWire, 1);
        this.refresh();
      }
    });
  }

  toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  }

  nearestSnap(p, maxDist) {
    let best = -1, bd = maxDist;
    this.snapPoints().forEach((s, i) => {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  hitComponent(p) {
    let best = null, bd = 14;
    for (const c of this.state.vehicle.components) {
      const d = Math.hypot(c.local.x - p.x, c.local.y - p.y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  hitWire(p) {
    // rough hit test: distance from point to the wire's midpoint region
    let best = -1, bd = 12;
    this.state.vehicle.wires.forEach((w, i) => {
      const a = this.comp(w.from.componentId)?.local;
      const b = this.comp(w.to.componentId)?.local;
      if (!a || !b) return;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 24;
      const d = Math.hypot(mx - p.x, my - p.y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  comp(id) { return this.state.vehicle.components.find(c => c.id === id); }

  placeComponent(type, snapIndex) {
    const def = this.compDef(type);
    const snap = this.snapPoints()[snapIndex];
    const n = Math.hypot(snap.normalX, snap.normalY) || 1;
    const off = def.size + 3;
    const isSensor = def.category === 'sensor';
    const c = {
      id: `${type.replace(/_.*$/, '')}_${this.nextNum++}`,
      type,
      snapIndex,
      local: { x: snap.x + (snap.normalX / n) * off, y: snap.y + (snap.normalY / n) * off },
      localRotation: 0,
      props: isSensor ? JSON.parse(JSON.stringify(def.defaults)) : {},
    };
    if (isSensor) {
      c.aimAngle = Math.atan2(snap.normalY, snap.normalX);
      c.props.range = def.defaults.range;
    }
    this.state.vehicle.components.push(c);
    this.selectedComp = c.id;
    this.refresh();
  }

  removeComponent(id) {
    const v = this.state.vehicle;
    v.components = v.components.filter(c => c.id !== id);
    v.wires = v.wires.filter(w => w.from.componentId !== id && w.to.componentId !== id);
    this.selectedComp = null;
    this.refresh();
  }

  addWire() {
    const fromId = this.ui.wireFrom.value;
    const toId = this.ui.wireTo.value;
    if (!fromId || !toId) return;
    this.state.vehicle.wires.push({
      id: `wire_${Date.now().toString(36)}`,
      from: { componentId: fromId, port: 'out' },
      to: { componentId: toId, port: 'drive' },
      polarity: this.ui.wirePolarity.value,
      weight: Number(this.ui.wireWeightRange.value),
    });
    this.refresh();
  }

  refresh() {
    const v = this.state.vehicle;

    // palette dropdowns for wiring
    const sensors = v.components.filter(c => this.compDef(c.type)?.category === 'sensor');
    const wheels = v.components.filter(c => this.compDef(c.type)?.category === 'actuator');
    fillSelect(this.ui.wireFrom, sensors, c => `${c.id} (${c.type})`);
    fillSelect(this.ui.wireTo, wheels, c => `${c.id} (${c.type})`);

    // placed list
    const pl = this.ui.placedList;
    pl.innerHTML = '';
    for (const c of v.components) {
      const li = document.createElement('li');
      if (c.id === this.selectedComp) li.classList.add('sel');
      li.innerHTML = `<span>${c.id} · ${this.compDef(c.type)?.name}</span><button class="del" title="remove">✕</button>`;
      li.onclick = () => { this.selectedComp = c.id; this.selectedWire = null; this.refresh(); };
      li.querySelector('.del').onclick = e => { e.stopPropagation(); this.removeComponent(c.id); };
      pl.appendChild(li);
    }

    // wire list
    const wl = this.ui.wireList;
    wl.innerHTML = '';
    v.wires.forEach((w, i) => {
      const li = document.createElement('li');
      if (i === this.selectedWire) li.classList.add('sel');
      li.innerHTML = `<span>${w.from.componentId} → ${w.to.componentId} (${w.polarity[0]} ${w.weight})</span><button class="del">✕</button>`;
      li.onclick = () => { this.selectedWire = i; this.refresh(); };
      li.querySelector('.del').onclick = e => { e.stopPropagation(); v.wires.splice(i, 1); this.selectedWire = null; this.refresh(); };
      wl.appendChild(li);
    });

    // validation (port kinds fall back to component defs from components.json)
    const defs = Object.fromEntries(this.componentsConfig.map(d => [d.id, d]));
    const errs = validateWiring(v, defs);
    this.ui.wiringErrors.textContent = errs.map(e => e.message).join('\n');

    // inspector
    this.renderInspector();
    if (this.hooks.onVehicleChanged) this.hooks.onVehicleChanged(v);
  }

  renderInspector() {
    const box = this.ui.inspector;
    const c = this.selectedComp ? this.comp(this.selectedComp) : null;
    if (!c) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3>Selected</h3>`;
    if (typeof c.aimAngle === 'number') {
      box.innerHTML += `<label>Aim (rad) <input type="number" id="ins-aim" step="0.1" value="${c.aimAngle.toFixed(2)}"></label>`;
      box.querySelector('#ins-aim').onchange = e => { c.aimAngle = Number(e.target.value); this.refresh(); };
    }
    const rangeDef = this.compDef(c.type)?.defaults?.range;
    if (typeof c.props?.range === 'number') {
      box.innerHTML += `<label>Range <input type="number" id="ins-range" value="${c.props.range}"></label>`;
      box.querySelector('#ins-range').onchange = e => { c.props.range = Number(e.target.value); this.refresh(); };
    }
  }

  // ---------- drawing ----------
  loop() {
    const draw = () => {
      this.draw();
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  draw() {
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== cv.clientWidth * dpr || cv.height !== cv.clientHeight * dpr) {
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.translate(cv.clientWidth / 2, cv.clientHeight / 2);

    const v = this.state.vehicle;
    const scale = Math.min(cv.clientWidth / (v.body.width * 4), cv.clientHeight / (v.body.height * 6));
    ctx.scale(scale, scale);

    // body
    ctx.fillStyle = '#2b3a52';
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(-v.body.width / 2, -v.body.height / 2, v.body.width, v.body.height);
    ctx.fill();
    ctx.stroke();

    // heading arrow
    ctx.strokeStyle = '#8a97a8';
    ctx.beginPath();
    ctx.moveTo(0, -4); ctx.lineTo(0, 4);
    ctx.moveTo(-5, 0); ctx.lineTo(5, 0);
    ctx.stroke();
    drawArrow(ctx, v.body.width / 2 + 4, 0, 0);

    // snap points
    this.snapPoints().forEach((s, i) => {
      ctx.beginPath();
      ctx.arc(s.x, s.y, i === this.hoverSnap ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === this.hoverSnap ? '#4da3ff' : 'rgba(138,151,168,.7)';
      ctx.fill();
    });

    // components
    for (const c of v.components) {
      const def = this.compDef(c.type);
      const r = def?.size ?? 8;
      ctx.beginPath();
      ctx.arc(c.local.x, c.local.y, r, 0, Math.PI * 2);
      ctx.fillStyle =
        def?.category === 'actuator' ? '#35547a' :
        def?.category === 'sensor' ? '#2f6b46' : 'rgba(138,151,168,.6)';
      if (c.id === this.selectedComp) ctx.strokeStyle = '#ffffff'; else ctx.strokeStyle = '#10141a';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();

      if (typeof c.aimAngle === 'number') {
        drawArrow(ctx, c.local.x + Math.cos(c.aimAngle) * (r + 10), c.local.y + Math.sin(c.aimAngle) * (r + 10), c.aimAngle);
      }
    }

    // wires: arcing lines, green excitatory / red inhibitory
    for (const w of v.wires) {
      const a = this.comp(w.from.componentId)?.local;
      const b = this.comp(w.to.componentId)?.local;
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 28;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.strokeStyle = w.polarity === 'excitatory' ? '#46d17a' : '#ff5d5d';
      ctx.lineWidth = 3 * (0.5 + 0.5 * w.weight);
      ctx.globalAlpha = this.selectedWire !== null && w.id ? true : 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function drawArrow(ctx, x, y, angle) {
  const s = 8;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(-s, -s / 2);
  ctx.lineTo(0, 0);
  ctx.lineTo(-s, s / 2);
  ctx.strokeStyle = '#dce3ec';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function fillSelect(sel, items, label) {
  const prev = sel.value;
  sel.innerHTML = '<option value="">—</option>';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = label(it);
    sel.appendChild(o);
  }
  if (items.some(i => i.id === prev)) sel.value = prev;
}

import { generateSnapPoints } from '../src/models/snapPoints.js';
import { validateWiring } from '../src/models/wiring.js';
