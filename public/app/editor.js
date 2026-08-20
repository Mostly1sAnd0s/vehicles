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
      // press-drag onto a snap node; plain click keeps toggle-placing mode
      b.addEventListener('pointerdown', e => {
        this.paletteDrag = { def, startX: e.clientX, startY: e.clientY, moved: false, pos: e };
      });
      b.addEventListener('click', () => {
        this.setPlacing(this.placing === def.id ? null : def.id);
      });
      palette.appendChild(b);
    }

    this.ui.wireWeightRange.oninput = () => {
      this.ui.wireWeightVal.textContent = Number(this.ui.wireWeightRange.value).toFixed(2);
    };
    this.ui.addWire.onclick = () => this.addWire();
  }

  bindCanvas() {
    this.canvas.addEventListener('mousemove', e => {
      if (!this.drag && !this.paletteDrag) {
        this.hoverSnap = nearestSnapIndex(this.snapPoints(), this.toLocal(e), 16);
      }
    });

    // grab a placed component anywhere on its footprint (full element size)
    this.canvas.addEventListener('mousedown', e => {
      if (this.placing) return; // click handler handles placing mode
      const c = this.hitComponent(this.toLocal(e));
      if (c) {
        // last-clicked element takes priority over overlapping ones -> move to front
        const arr = this.state.vehicle.components;
        arr.splice(arr.indexOf(c), 1);
        arr.push(c);
        this.drag = { c, moved: false, target: -1 };
      }
    });

    window.addEventListener('mousemove', e => {
      if (this.paletteDrag) {
        this.paletteDrag.moved = this.paletteDrag.moved ||
          Math.hypot(e.clientX - this.paletteDrag.startX, e.clientY - this.paletteDrag.startY) > 4;
        this.paletteDrag.pos = e;
        return;
      }
      if (!this.drag) return;
      const p = this.toLocal(e);
      if (!this.drag.moved && Math.hypot(p.x - this.drag.c.local.x, p.y - this.drag.c.local.y) > 3) {
        this.drag.moved = true;
      }
      if (this.drag.moved) {
        // moving the component moves its wire endpoints too (wires reference it)
        this.drag.c.local = { x: p.x, y: p.y };
        this.drag.target = nearestSnapIndex(this.snapPoints(), p);
      }
    });

    window.addEventListener('mouseup', e => {
      if (this.paletteDrag) {
        const d = this.paletteDrag;
        this.paletteDrag = null;
        if (d.moved) {
          // dropped over the canvas near a node -> place; otherwise cancel.
          // (no drag = plain click, handled by the button's own click event)
          const r = this.canvas.getBoundingClientRect();
          const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (over) {
            const idx = nearestSnapIndex(this.snapPoints(), this.toLocal(e), 34);
            if (idx >= 0) this.placeComponent(d.def.id, idx);
          }
        }
      }
      if (this.drag) {
        const d = this.drag;
        this.drag = null;
        this.dragConsumed = true; // suppress the follow-up click event
        if (d.moved) this.snapInPlace(d.c, d.target);
        this.selectedComp = d.c.id;
        this.selectedWire = null;
        this.refresh();
      }
    });

    this.canvas.addEventListener('click', e => {
      if (this.dragConsumed) { this.dragConsumed = false; return; }
      const p = this.toLocal(e);
      if (this.placing) {
        const idx = nearestSnapIndex(this.snapPoints(), p, 45);
        if (idx >= 0) {
          this.placeComponent(this.placing, idx);
          this.setPlacing(null); // one placement per click; drag-drop is the other mode
        }
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

  setPlacing(type) {
    this.placing = type;
    this.ui.palette.querySelectorAll('button').forEach((b, i) =>
      b.classList.toggle('placing', type === this.componentsConfig[i].id));
  }

  _scale() { return this._viewScale || 1; }

  toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    const s = this._scale();
    return { x: (e.clientX - r.left - r.width / 2) / s, y: (e.clientY - r.top - r.height / 2) / s };
  }

  // snap a dragged component onto a node: center offset along the node normal
  snapInPlace(c, idx) {
    const def = this.compDef(c.type);
    const snap = this.snapPoints()[idx];
    const n = Math.hypot(snap.normalX, snap.normalY) || 1;
    const off = (def?.size ?? 8) + 3;
    c.snapIndex = idx;
    c.local = { x: snap.x + (snap.normalX / n) * off, y: snap.y + (snap.normalY / n) * off };
    if (def?.category === 'sensor') c.aimAngle = Math.atan2(snap.normalY, snap.normalX);
    else c.localRotation = 0; // wheels roll along body forward
  }

  hitComponent(p) {
    // topmost first: later in the array (and most recently clicked) wins
    const arr = this.state.vehicle.components;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (componentHits(p, arr[i], this.compDef(arr[i].type))) return arr[i];
    }
    return null;
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
      li.innerHTML = `<span>${w.from.componentId} → ${w.to.componentId} ×${w.weight}</span><button class="del">✕</button>`;
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
    const v = this.state.vehicle;
    const c = this.selectedComp ? this.comp(this.selectedComp) : null;

    // Vehicle-level row: body color — always shown so it's visible even when
    // nothing is selected (and so the motion trail matches the vehicle). A static
    // 4x4 palette (no native <input type="color">) means clicking a swatch just
    // sets the color and re-renders; there's no popup that closes on click.
    let html = `<h3>Body</h3><label>Body color</label><div class="color-palette">${colorPaletteHtml(v.body.color)}</div>`;

    if (!c) {
      box.innerHTML = html;
      this._bindBodyColor(box, v);
      return;
    }

    // Build the whole panel as one string and assign innerHTML ONCE, then bind
    // handlers. (Incremental `box.innerHTML += …` replaces the DOM each time
    // and silently drops any event handler bound to an earlier node — this is
    // what used to clobber the Range input's onchange.)
    html += `<h3>Selected</h3>`;
    if (typeof c.aimAngle === 'number') {
      html += `<label>Aim (rad) <input type="number" id="ins-aim" step="0.1" value="${c.aimAngle.toFixed(2)}"></label>`;
    }
    if (typeof c.props?.range === 'number') {
      html += `<label>Range <input type="number" id="ins-range" min="1" value="${c.props.range}"></label>`;
    }
    const fovSensor = c.type === 'light_sensor' || c.type === 'vehicle_detection_sensor';
    if (fovSensor) {
      const modelKey = c.type === 'light_sensor' ? 'light' : 'vehicle_detection';
      const cfgFov = this.state.configs?.sensors?.[modelKey]?.fov ?? 2 * Math.PI;
      const fovRad = c.props?.fov ?? cfgFov;
      html += `<label>FOV (&deg;) <input type="number" id="ins-fov" min="0" max="360" step="5" value="${Math.round(fovRad * 180 / Math.PI)}"></label>`;
    }
    if (c.type === 'light_sensor') {
      const lightCfg = this.state.configs?.sensors?.light ?? {};
      const thresh = c.props?.threshold ?? lightCfg.detectionThreshold ?? 0.02;
      html += `<label>Threshold <input type="number" id="ins-thresh" min="0.001" step="0.005" value="${thresh}"></label>`;
      html += `<div class="hint">reach &asymp; &radic;(intensity / threshold) &mdash; lower to sense from farther</div>`;
    }
    if (c.type === 'powered_wheel') {
      const aCfg = this.state.configs.actuators?.powered_wheel ?? {};
      const mp = c.props?.motorPower ?? aCfg.defaultMotorPower ?? 1;
      const fr = c.props?.friction ?? aCfg.defaultFriction ?? 0.5;
      html += `<label>Motor power <input type="range" id="ins-mp" min="0" max="3" step="0.05" value="${mp}"> <span id="ins-mp-v">${(+mp).toFixed(2)}</span></label>`;
      html += `<label>Wheel friction <input type="range" id="ins-fr" min="0" max="1" step="0.05" value="${fr}"> <span id="ins-fr-v">${(+fr).toFixed(2)}</span></label>`;
      html += `<div class="hint">more power = faster; more friction = grip &amp; less coasting (0 = ice)</div>`;
    }
    const cat = this.compDef(c.type)?.category;
    if (cat === 'sensor' || cat === 'actuator') {
      const opts = cat === 'sensor'
        ? [['normal', 'Normal'], ['inverted', 'Inverted']]
        : [['forward', 'Forward'], ['reverse', 'Reverse']];
      const cur = c.polarity ?? (cat === 'sensor' ? 'normal' : this.state.configs.actuators[c.type]?.defaultPolarity ?? 'forward');
      html += `<label>${cat === 'sensor' ? 'Sensor polarity' : 'Motor polarity'} <select id="ins-pol">
          ${opts.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select></label>`;
    }
    box.innerHTML = html;
    this._bindBodyColor(box, v);

    // Now bind — every control still exists because the DOM wasn't rebuilt.
    box.querySelector('#ins-aim')?.addEventListener('change', e => { c.aimAngle = Number(e.target.value); this.refresh(); });
    box.querySelector('#ins-range')?.addEventListener('change', e => { c.props.range = Math.max(1, Number(e.target.value) || 1); this.refresh(); });
    box.querySelector('#ins-fov')?.addEventListener('change', e => { c.props.fov = (Math.min(360, Math.max(0, Number(e.target.value) || 0))) * Math.PI / 180; this.refresh(); });
    box.querySelector('#ins-thresh')?.addEventListener('change', e => { c.props.threshold = Math.max(0.001, Number(e.target.value) || 0.001); this.refresh(); });
    box.querySelector('#ins-pol')?.addEventListener('change', e => { c.polarity = e.target.value; this.refresh(); });
    const mpEl = box.querySelector('#ins-mp');
    if (mpEl) {
      mpEl.addEventListener('input', e => { c.props.motorPower = Number(e.target.value); box.querySelector('#ins-mp-v').textContent = (+e.target.value).toFixed(2); });
      mpEl.addEventListener('change', () => this.refresh());
    }
    const frEl = box.querySelector('#ins-fr');
    if (frEl) {
      frEl.addEventListener('input', e => { c.props.friction = Number(e.target.value); box.querySelector('#ins-fr-v').textContent = (+e.target.value).toFixed(2); });
      frEl.addEventListener('change', () => this.refresh());
    }

  }

  _bindBodyColor(box, v) {
    box.querySelectorAll('.color-palette .swatch').forEach(btn => {
      btn.addEventListener('click', () => { v.body.color = btn.dataset.color; this.refresh(); });
    });
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
    this._viewScale = Math.min(cv.clientWidth / (v.body.width * 4), cv.clientHeight / (v.body.height * 6));
    const scale = this._viewScale;
    ctx.scale(scale, scale);

    // body — the fill IS the chosen color (matching the world view); the outline
    // is a few shades lighter so it still reads against the fill. Falls back to
    // the default blue when the vehicle has no explicit color set.
    const bodyColor = v.body.color ?? DEFAULT_BODY_COLOR;
    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = lightenHex(bodyColor);
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

    // snap points (the drop target lights up while dragging)
    const dragTarget = this.drag?.moved ? this.drag.target : -1;
    this.snapPoints().forEach((s, i) => {
      ctx.beginPath();
      ctx.arc(s.x, s.y, i === dragTarget ? 8 : i === this.hoverSnap ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === dragTarget ? '#46d17a' : i === this.hoverSnap ? '#4da3ff' : 'rgba(138,151,168,.7)';
      ctx.fill();
      if (i === dragTarget) {
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(this.drag.c.local.x, this.drag.c.local.y);
        ctx.strokeStyle = 'rgba(70,209,122,.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });

    // components (wheels draw as top-down rects; sensors/mounts as circles)
    for (const c of v.components) {
      const def = this.compDef(c.type);
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
      // inverted sensors / reverse motors are tinted red (was the wire polarity color)
      const inverted = c.polarity === 'inverted' || c.polarity === 'reverse';
      ctx.fillStyle = inverted ? '#6e2b3a'
        : def?.category === 'actuator' ? '#35547a'
        : def?.category === 'sensor' ? '#2f6b46' : 'rgba(138,151,168,.6)';
      if (c.id === this.selectedComp) ctx.strokeStyle = '#ffffff'; else ctx.strokeStyle = inverted ? '#ff5d5d' : '#10141a';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();

      if (typeof c.aimAngle === 'number') {
        const r = s.kind === 'circle' ? s.radius : Math.max(s.along, s.lateral) / 2;
        drawArrow(ctx, c.local.x + Math.cos(c.aimAngle) * (r + 10), c.local.y + Math.sin(c.aimAngle) * (r + 10), c.aimAngle);
      }

      // FOV cone preview for cone sensors (vehicle detection by default; any
      // sensor the user narrows below omni). Shows the aiming arc while placing.
      // Omni sensors (e.g. the default light sensor) draw nothing, as before.
      if (typeof c.aimAngle === 'number' && def?.category === 'sensor') {
        const fov = c.props?.fov;
        if (Number.isFinite(fov) && fov < 2 * Math.PI - 1e-3) {
          const reach = Math.max(40, Math.min(c.props?.range ?? 120, v.body.width * 1.6));
          const half = Math.min(fov / 2, Math.PI);
          const cx = c.local.x, cy = c.local.y;
          ctx.beginPath();
          if (half >= Math.PI - 1e-3) {
            ctx.arc(cx, cy, reach, 0, 2 * Math.PI);
          } else {
            const a1 = c.aimAngle - half, a2 = c.aimAngle + half;
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(a1) * reach, cy + Math.sin(a1) * reach);
            ctx.arc(cx, cy, reach, a1, a2);
          }
          ctx.closePath();
          ctx.fillStyle = 'rgba(90,240,170,0.12)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(90,240,170,0.5)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    // palette drag ghost
    if (this.paletteDrag?.moved) {
      const def = this.paletteDrag.def;
      const p = this.toLocal(this.paletteDrag.pos);
      const r = this.canvas.getBoundingClientRect();
      const over = this.paletteDrag.pos.clientX >= r.left && this.paletteDrag.pos.clientX <= r.right &&
                   this.paletteDrag.pos.clientY >= r.top && this.paletteDrag.pos.clientY <= r.bottom;
      if (over) {
        const s = componentSize({ local: p, localRotation: 0 }, def);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        if (s.kind === 'rect') {
          ctx.rect(p.x - s.along / 2, p.y - s.lateral / 2, s.along, s.lateral);
        } else {
          ctx.arc(p.x, p.y, s.radius, 0, Math.PI * 2);
        }
        ctx.fillStyle = '#4da3ff';
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // wires: arcing lines (polarity now lives on the components)
    for (const w of v.wires) {
      const a = this.comp(w.from.componentId)?.local;
      const b = this.comp(w.to.componentId)?.local;
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 28;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.strokeStyle = '#7d94ad';
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
import { componentSize, componentHits, nearestSnapIndex } from '../src/models/hitTest.js';
import { colorPaletteHtml, lightenHex, DEFAULT_BODY_COLOR } from './color.js';
