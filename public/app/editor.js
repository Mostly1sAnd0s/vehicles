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
    this.placingGate = null;
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
    // Perimeter snaps plus a body-CENTRE attachment point (index n). Dropping or
    // clicking near the middle of the robot places there — handy for mounting a
    // Propagator at the core so it radiates evenly in every direction.
    return [...generateSnapPoints(v.body, n), { x: 0, y: 0, normalX: 1, normalY: 0, center: true }];
  }

  bindUI() {
    const palette = this.ui.palette;
    for (const def of this.componentsConfig.filter(d => d.category !== 'logic')) {
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

    // Logic gates: a separate, non-snapping palette. Click a gate to arm it,
    // then click anywhere on the canvas to drop it at that local position.
    const gatePalette = this.ui.gatePalette;
    if (gatePalette) {
      for (const def of this.componentsConfig.filter(d => d.category === 'logic')) {
        const b = document.createElement('button');
        b.textContent = def.name;
        b.addEventListener('click', () => {
          this.setPlacingGate(this.placingGate === def.id ? null : def.id);
        });
        gatePalette.appendChild(b);
      }
    }

  }

  bindCanvas() {
    this.canvas.addEventListener('mousemove', e => {
      if (!this.drag && !this.paletteDrag) {
        this.hoverSnap = nearestSnapIndex(this.snapPoints(), this.toLocal(e), 16);
      }
    });

    // grab a placed component anywhere on its footprint (full element size)
    this.canvas.addEventListener('mousedown', e => {
      if (this.placing || this.placingGate) return; // click handler handles placing mode
      const g = this.hitGate(this.toLocal(e));
      if (g) { this.drag = { c: g, moved: false, target: -1, isGate: true }; return; }
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
      const anchor = this.drag.isGate ? 'pos' : 'local';
      if (!this.drag.moved && Math.hypot(p.x - this.drag.c[anchor].x, p.y - this.drag.c[anchor].y) > 3) {
        this.drag.moved = true;
      }
      if (this.drag.moved) {
        // moving the node moves its wire endpoints too (wires reference it)
        this.drag.c[anchor] = { x: p.x, y: p.y };
        if (!this.drag.isGate) this.drag.target = nearestSnapIndex(this.snapPoints(), p);
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
        if (d.moved && !d.isGate) this.snapInPlace(d.c, d.target); // gates float free
        this.selectedComp = d.c.id;
        this.selectedWire = null;
        this.refresh();
      }
    });

    this.canvas.addEventListener('click', e => {
      if (this.dragConsumed) { this.dragConsumed = false; return; }
      const p = this.toLocal(e);
      if (this.placingGate) {
        this.placeGate(this.placingGate, p); // one placement per click, free position
        return;
      }
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
      if (c) {
        this.selectedComp = c.id;
        this.selectedWire = null;
      } else {
        const g = this.hitGate(p);
        this.selectedComp = g ? g.id : null;
        this.selectedWire = g ? null : this.hitWire(p);
      }
      this.refresh();
    });
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        if (this.selectedComp) {
          this.removeComponent(this.selectedComp);
        } else if (this.selectedWire != null && this.selectedWire >= 0 &&
                   this.selectedWire < this.state.vehicle.wires.length) {
          // hitWire reports "no wire" as -1; only a real in-range index deletes.
          this.state.vehicle.wires.splice(this.selectedWire, 1);
          this.selectedWire = null; // don't let the next press hit the shifted index
        }
        this.refresh();
      }
    });
  }

  setPlacing(type) {
    this.placing = type;
    const mainDefs = this.componentsConfig.filter(d => d.category !== 'logic');
    this.ui.palette.querySelectorAll('button').forEach((b, i) =>
      b.classList.toggle('placing', type === mainDefs[i]?.id));
  }

  setPlacingGate(type) {
    this.placingGate = type;
    const gateDefs = this.componentsConfig.filter(d => d.category === 'logic');
    (this.ui.gatePalette?.querySelectorAll('button') ?? []).forEach((b, i) =>
      b.classList.toggle('placing', type === gateDefs[i]?.id));
  }

  _scale() { return this._viewScale || 1; }

  toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    const s = this._scale();
    // Centre on clientWidth/Height exactly as draw() does (ctx.translate + buffer
    // sizing both use those). getBoundingClientRect can differ slightly under
    // fractional flex layouts, which would otherwise desync pointer<->world coords.
    return { x: (e.clientX - r.left - this.canvas.clientWidth / 2) / s,
             y: (e.clientY - r.top - this.canvas.clientHeight / 2) / s };
  }

  // snap a dragged component onto a node: center offset along the node normal
  snapInPlace(c, idx) {
    const def = this.compDef(c.type);
    const snap = this.snapPoints()[idx];
    const n = Math.hypot(snap.normalX, snap.normalY) || 1;
    const off = (def?.size ?? 8) + 3;
    c.snapIndex = idx;
    c.local = snap.center ? { x: 0, y: 0 } : { x: snap.x + (snap.normalX / n) * off, y: snap.y + (snap.normalY / n) * off };
    if (def?.category === 'sensor') c.aimAngle = snap.center ? 0 : Math.atan2(snap.normalY, snap.normalX);
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
      const a = this.anchorFor(w.from.componentId);
      const b = this.anchorFor(w.to.componentId);
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
      local: snap.center ? { x: 0, y: 0 } : { x: snap.x + (snap.normalX / n) * off, y: snap.y + (snap.normalY / n) * off },
      localRotation: 0,
      props: isSensor ? JSON.parse(JSON.stringify(def.defaults)) : {},
    };
    if (isSensor) {
      c.aimAngle = snap.center ? 0 : Math.atan2(snap.normalY, snap.normalX);
      c.props.range = def.defaults.range;
    } else if (def.category === 'special') {
      // special parts (e.g. the Propagator) carry their tuning in props from the start
      for (const k of ['threshold', 'cooldownTicks', 'maxConverted']) {
        if (def.defaults?.[k] != null) c.props[k] = def.defaults[k];
      }
    }
    this.state.vehicle.components.push(c);
    this.selectedComp = c.id;
    this.refresh();
  }

  // ---- logic gates (floating nodes in vehicle.logicGates, not body parts) ----
  gate(id) { return (this.state.vehicle.logicGates ?? []).find(g => g.id === id); }

  // Anchor point for any node that a wire can reference: a body component's
  // `.local` or a logic gate's `.pos`. Lets the wire renderer resolve both.
  // Fixed size for every gate box so the drawn symbol and wire anchors agree.
  gateBox() { return { w: 30, h: 14 }; }

  // Vertical offset of the i-th stub among n, centered on the box (y = 0). Evenly
  // spaced and symmetric, so a single tap sits at centre and adding taps fans out
  // equally above/below rather than piling on one side (was: 2nd tap jumped up).
  rowY(i, n, h) {
    if (n <= 1) return 0;
    const outer = h / 2 - 1;                    // keep stubs just inside the box edge
    const step = n === 2 ? outer * 0.5 : outer / ((n - 1) / 2);
    return (i - (n - 1) / 2) * step;
  }

  // Rotate a center-relative vector by rot degrees (canvas +y is down). A node's
  // orientation (g.rot = 0/90/180/270) moves its input/output stubs consistently.
  rotateVec(x, y, rot) {
    const r = ((rot ?? 0) * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  // Point (vehicle-local) of a gate's connection stub. Inputs sit on the LEFT
  // edge, outputs on the RIGHT, each spread vertically and symmetric about centre;
  // g.rot then orients the whole node so outputs can face away from the robot's
  // front and wires stop crossing.
  gateAnchor(g, port) {
    const { w, h } = this.gateBox();
    const outIds = outputPortIds(g, this.compDef(g.type));
    const oi = outIds.indexOf(port);
    let lx, ly;
    if (oi >= 0) {
      lx = w / 2 + 5;                           // right edge, just outside the box
      ly = this.rowY(oi, outIds.length, h);
    } else {
      const inPorts = (this.compDef(g.type)?.ports ?? []).filter(p => p.kind === 'logic_in');
      const idx = Math.max(0, inPorts.findIndex(p => p.id === port));
      lx = -(w / 2 + 5);                        // left edge
      ly = this.rowY(idx, inPorts.length, h);
    }
    const rv = this.rotateVec(lx, ly, g.rot);
    return { x: g.pos.x + rv.x, y: g.pos.y + rv.y };
  }

  // Anchor for a wire endpoint. For a gate with a known port, returns that
  // connection's stub (not the centre); without a port, the gate centre.
  anchorFor(id, port) {
    const c = this.comp(id);
    if (c) return c.local;
    const g = this.gate(id);
    if (!g) return null;
    return port ? this.gateAnchor(g, port) : { x: g.pos.x, y: g.pos.y };
  }

  // Tiny response-curve glyph for a Neuron: samples its transfer function across
  // input 0..1 and plots it inside the box (output 1 at top). The interactive
  // editor for the curve itself lives in the inspector.
  drawNeuronCurve(ctx, g, w, h) {
    const x0 = -w / 2 + 2, x1 = w / 2 - 2;
    const yTop = -h / 2 + 2, yBot = h / 2 - 6;
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const o = transferOutput(g.props, t);
      const x = x0 + (x1 - x0) * t;
      const y = yBot - (yBot - yTop) * o;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#0d2b1a';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  hitGate(p) {
    for (let i = (this.state.vehicle.logicGates ?? []).length - 1; i >= 0; i--) {
      const g = this.state.vehicle.logicGates[i];
      // radius covers a rotated box corner too (half-diagonal ~16.5 at w=30,h=14)
      if (Math.hypot(g.pos.x - p.x, g.pos.y - p.y) < 18) return g;
    }
    return null;
  }

  placeGate(type, pos) {
    const v = this.state.vehicle;
    v.logicGates = v.logicGates ?? [];
    const c = { id: `gate_${this.nextNum++}`, type, pos };
    // A Neuron carries its transfer config (shape/threshold/sigma/spline) here;
    // boolean gates default to none. Clone so each node owns an independent copy.
    c.props = JSON.parse(JSON.stringify(this.compDef(type)?.defaults ?? {}));
    v.logicGates.push(c);
    this.selectedComp = c.id;
    this.selectedWire = null;
    this.setPlacingGate(null);
    this.refresh();
  }

  removeGate(id) {
    const v = this.state.vehicle;
    v.logicGates = (v.logicGates ?? []).filter(g => g.id !== id);
    v.wires = v.wires.filter(w => w.from.componentId !== id && w.to.componentId !== id);
    if (this.selectedComp === id) this.selectedComp = null;
    this.refresh();
  }

  removeComponent(id) {
    // Gates/Neurons live in logicGates, not components — route to the right
    // remover (this is what the Delete-key handler calls for the selection).
    if (this.gate(id)) { this.removeGate(id); return; }
    const v = this.state.vehicle;
    v.components = v.components.filter(c => c.id !== id);
    v.wires = v.wires.filter(w => w.from.componentId !== id && w.to.componentId !== id);
    this.selectedComp = null;
    this.refresh();
  }

  refresh() {
    const v = this.state.vehicle;

    // A vehicle that never picked a swatch has no body.color. Normalize it ONCE so every
    // surface (editor canvas, local world, co-op snapshot) agrees on the same default, and
    // co-op live-sync can ship it — previously the server fell back to red (#cc3333) while
    // the editor drew blue, so shared bots of an uncolored vehicle were ALWAYS red.
    if (!v.body) v.body = { shape: 'rect', width: 80, height: 40 };
    if (!v.body.color) v.body.color = DEFAULT_BODY_COLOR;

    // Body color lives in the left palette (the old global Wiring box is gone —
    // wiring is now done per-part via the connection slots in the inspector).
    this.ui.bodyColor.innerHTML = `<div class="color-palette">${colorPaletteHtml(v.body.color)}</div>`;
    this._bindBodyColor(this.ui.bodyColor, v);

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

    // logic gates (floating, non-snapped) listed after body components
    for (const g of v.logicGates ?? []) {
      const li = document.createElement('li');
      if (g.id === this.selectedComp) li.classList.add('sel');
      li.innerHTML = `<span>${g.id} · ${this.compDef(g.type)?.name ?? g.type}</span><button class="del" title="remove">✕</button>`;
      li.onclick = () => { this.selectedComp = g.id; this.selectedWire = null; this.refresh(); };
      li.querySelector('.del').onclick = e => { e.stopPropagation(); this.removeGate(g.id); };
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
    const c = this.selectedComp ? (this.comp(this.selectedComp) ?? this.gate(this.selectedComp)) : null;

    // Build the whole panel as one string and assign innerHTML ONCE, then bind
    // handlers. (Body color now lives in the left palette, not here.)
    let html = '';
    if (!c) {
      box.innerHTML = '<p class="hint">Select a placed part to edit it and its wiring.</p>';
      return;
    }
    html += `<h3>Selected</h3>`;
    const def = this.compDef(c.type);
    if (this.gate(c.id)) {
      html += `<p class="hint"><b>${def?.name ?? c.type}</b> — ${gateLogicDesc(c.type)}</p>`;
    }

    // Connection slots: one "In" selector per input port (pick a signal source)
    // and one "Out" selector per output port (pick a destination). Uniform for
    // sensors (1 out), motors (1 in) and gates (N in + 1 out) — this replaces the
    // old global Wiring box. Choosing a value creates/replaces that wire.
    const ports = def?.ports ?? [];
    const inPorts = ports.filter(p => p.kind === 'actuator_input' || p.kind === 'logic_in');
    // Outputs are per-instance (multi-output, §4.2): a def base plus any taps
    // grown via "Add Output". One Out selector is rendered per tap.
    const outPorts = outputPorts(c, def);
    if (inPorts.length || outPorts.length) {
      const allGates = v.logicGates ?? [];
      // Source options list every output TAP of each source so an input can pick
      // a specific one; value "componentId|port".
      const srcOpts = [
        ...v.components.filter(x => this.compDef(x.type)?.category === 'sensor').flatMap(x => outputPortIds(x, this.compDef(x.type)).map(pid => ({ id: `${x.id}|${pid}`, label: `${x.id} · ${this.compDef(x.type).name ?? x.type} (out${pid === 'out' ? '' : pid})` }))),
        ...allGates.filter(g => g.id !== c.id).flatMap(g => outputPortIds(g, this.compDef(g.type)).map(pid => ({ id: `${g.id}|${pid}`, label: `${g.id} · ${this.compDef(g.type)?.name ?? g.type} (out${pid === 'out' ? '' : pid})` }))),
      ];
      const dstOpts = [
        ...v.components.filter(x => this.compDef(x.type)?.category === 'actuator').map(x => ({ id: `act|${x.id}`, label: `${x.id} · ${this.compDef(x.type).name ?? x.type}` })),
        ...allGates.flatMap(g => g.id === c.id ? [] : (this.compDef(g.type)?.ports ?? []).filter(p => p.kind === 'logic_in').map(p => ({ id: `gin|${g.id}|${p.id}`, label: `${g.id} · ${this.compDef(g.type)?.name ?? g.type} (in ${p.id.slice(2)})` }))),
      ];
      const srcInto = port => { const w = v.wires.find(x => x.to.componentId === c.id && x.to.port === port); return w ? `${w.from.componentId}|${w.from.port}` : ''; };
      const dstOfOut = port => { const w = v.wires.find(w => w.from.componentId === c.id && w.from.port === port); return w ? (w.to.port === 'drive' ? `act|${w.to.componentId}` : `gin|${w.to.componentId}|${w.to.port}`) : ''; };
      const opt = (list, cur) => '<option value="">— none —</option>' + list.map(o => `<option value="${o.id}"${o.id === cur ? ' selected' : ''}>${o.label}</option>`).join('');
      html += `<div class="conn" data-ins="${inPorts.length}" data-outs="${outPorts.length}">` +
        inPorts.map(p => `<label>In <select id="conn-in-${p.id}">${opt(srcOpts, srcInto(p.id))}</select></label>`).join('') +
        outPorts.map(p => `<label>Out <select id="conn-out-${p.id}">${opt(dstOpts, dstOfOut(p.id))}</select></label>`).join('') +
        (outPorts.length ? `<button type="button" id="ins-add-out">+ Add Output</button>` : '') +
        `</div>`;
    }
    if (this.compDef(c.type)?.category === 'sensor') {
      const dig = !!c.props?.digital;
      html += `<label class="check"><input type="checkbox" id="ins-digital"${dig ? ' checked' : ''}> Digital (0/1 for gates)</label>`;
      html += `<label>Digital threshold <input type="number" id="ins-dthresh" min="0" max="1" step="0.05" value="${c.props?.threshold ?? 0.5}"></label>`;
    }
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
    if (c.type === 'propagate') {
      const th = c.props?.threshold ?? 260;
      const cool = c.props?.cooldownTicks ?? 0;
      const mc = c.props?.maxConverted ?? '';
      html += `<label>Trigger distance <input type="number" id="ins-prop-th" min="1" step="5" value="${th}"></label>`;
      html += `<label>Cooldown (ticks) <input type="number" id="ins-prop-cool" min="0" step="1" value="${cool}"></label>`;
      html += `<label>Max converted <input type="number" id="ins-prop-max" min="0" step="1" value="${mc}" placeholder="all"></label>`;
      html += `<div class="hint">copies this whole vehicle onto any nearby robot within trigger distance &mdash; the target becomes a clone and spreads onward</div>`;
    }
    if (isNeuron(c.type)) {
      const np = c.props ?? {};
      const shape = TRANSFER_PRESETS.includes(np.shape) ? np.shape : 'bell';
      html += `<label>Response <select id="ins-nshape">` +
        TRANSFER_PRESETS.map(s => `<option value="${s}"${s === shape ? ' selected' : ''}>${s}</option>`).join('') + `</select></label>`;
      if (shape !== 'custom') {
        const th = np.threshold ?? 0.5;
        html += `<label>Peak <input type="range" id="ins-nthresh" min="0" max="1" step="0.01" value="${th}"><span>${th.toFixed(2)}</span></label>`;
        if (shape === 'bell') {
          const sg = np.sigma ?? 0.35;
          html += `<label>Width <input type="range" id="ins-nwidth" min="0.1" max="0.8" step="0.05" value="${sg}"><span>${sg.toFixed(2)}</span></label>`;
        }
      } else {
        html += `<div id="neuron-spline" style="position:relative; border:1px solid var(--line); background:#0c0f14; margin:6px 0"></div>
          <button type="button" id="ins-naddnode">+ Node</button> <button type="button" id="ins-nrmnode">- Node</button>
          <div class="hint">drag points to shape the response (x = input, y = output)</div>`;
      }
    }
    // Logic gates & neurons can be rotated/mirrored so their outputs face away
    // from the robot's front, reducing wire crossings (see rotateVec/gateAnchor).
    if (this.compDef(c.type)?.category === 'logic') {
      const rot = c.rot ?? 0;
      html += `<label>Orientation <select id="ins-rot">` +
        [0, 90, 180, 270].map(r => `<option value="${r}"${r === rot ? ' selected' : ''}>${r === 0 ? 'default' : r + '\u00b0'}</option>`).join('') +
        `</select></label>
        <div class="hint">rotate/mirror so outputs face away from the robot's front and wires stop crossing</div>`;
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
    box.querySelector('#ins-digital')?.addEventListener('change', e => { c.props = c.props ?? {}; c.props.digital = e.target.checked; this.refresh(); });
    box.querySelector('#ins-dthresh')?.addEventListener('change', e => { c.props = c.props ?? {}; c.props.threshold = Math.max(0, Number(e.target.value) || 0); this.refresh(); });
    box.querySelector('#ins-fov')?.addEventListener('change', e => { c.props.fov = (Math.min(360, Math.max(0, Number(e.target.value) || 0))) * Math.PI / 180; this.refresh(); });
    box.querySelector('#ins-thresh')?.addEventListener('change', e => { c.props.threshold = Math.max(0.001, Number(e.target.value) || 0.001); this.refresh(); });
    box.querySelector('#ins-pol')?.addEventListener('change', e => { c.polarity = e.target.value; this.refresh(); });
    box.querySelector('#ins-rot')?.addEventListener('change', e => { c.rot = Number(e.target.value); this.refresh(); });
    box.querySelector('#ins-prop-th')?.addEventListener('change', e => { c.props = c.props ?? {}; c.props.threshold = Math.max(1, Number(e.target.value) || 260); this.refresh(); });
    box.querySelector('#ins-prop-cool')?.addEventListener('change', e => { c.props = c.props ?? {}; c.props.cooldownTicks = Math.max(0, Math.round(Number(e.target.value) || 0)); this.refresh(); });
    box.querySelector('#ins-prop-max')?.addEventListener('change', e => { c.props = c.props ?? {}; const n = Number(e.target.value); c.props.maxConverted = (e.target.value === '' || Number.isNaN(n)) ? null : Math.max(0, Math.round(n)); this.refresh(); });

    // connection slots: selecting a source/destination creates (or replaces) the
    // single wire on that endpoint. Works for every ported part (sensor/motor/gate).
    {
      const pdef = this.compDef(c.type)?.ports ?? [];
      const wireId = () => `wire_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      pdef.filter(p => p.kind === 'actuator_input' || p.kind === 'logic_in').forEach(p => {
        box.querySelector('#conn-in-' + p.id)?.addEventListener('change', e => {
          v.wires = v.wires.filter(w => !(w.to.componentId === c.id && w.to.port === p.id));
          if (e.target.value) { const [cid, pid] = e.target.value.split('|'); v.wires.push({ id: wireId(), from: { componentId: cid, port: pid ?? 'out' }, to: { componentId: c.id, port: p.id }, weight: 1 }); }
          this.refresh();
        });
      });
      outputPorts(c, def).forEach(p => {
        box.querySelector('#conn-out-' + p.id)?.addEventListener('change', e => {
          v.wires = v.wires.filter(w => !(w.from.componentId === c.id && w.from.port === p.id));
          if (e.target.value) {
            const [kind, a, b] = e.target.value.split('|');
            const to = kind === 'act' ? { componentId: a, port: 'drive' } : { componentId: a, port: b };
            v.wires.push({ id: wireId(), from: { componentId: c.id, port: p.id }, to, weight: 1 });
          }
          this.refresh();
        });
      });
      // "Add Output": grow this source's tap list (multi-output, §4.2). The base
      // tap(s) come from the def; added ones get ids out1, out2, ...
      box.querySelector('#ins-add-out')?.addEventListener('click', () => {
        const ids = outputPortIds(c, def);
        c.outputs = [...ids, `out${ids.length}`];
        this.refresh();
      });
    }
    if (isNeuron(c.type)) this.setupNeuronInspector(box, c);
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

  // Neuron inspector bindings: shape selector, bell/threshold sliders, and the
  // interactive custom spline editor (§4.3). Runs right after renderInspector
  // has set innerHTML, so the #neuron-spline container is live.
  setupNeuronInspector(box, c) {
    // A freshly placed neuron has no props; bind edits to the instance itself so
    // they persist across refresh() (a detached {} object would be lost).
    if (!c.props || typeof c.props !== 'object') c.props = {};
    const p = c.props;
    const onChange = () => this.refresh();
    box.querySelector('#ins-nshape')?.addEventListener('change', e => { p.shape = e.target.value; delete p.spline; onChange(); });
    box.querySelector('#ins-nthresh')?.addEventListener('input', e => { p.threshold = +e.target.value; e.target.nextElementSibling.textContent = (+e.target.value).toFixed(2); });
    box.querySelector('#ins-nwidth')?.addEventListener('input', e => { p.sigma = +e.target.value; e.target.nextElementSibling.textContent = (+e.target.value).toFixed(2); });
    this.setupSplineEditor(box, p);
  }

  // A tiny draggable point list for a transfer function. Points have x in [0,1]
  // (input) and y in [0,1] (output); the plot shows the piecewise-linear curve.
  setupSplineEditor(box, p) {
    const el = box.querySelector('#neuron-spline');
    if (!el) return;
    const W = el.clientWidth || 300, H = 150, PAD = 14;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    el.innerHTML = ''; el.appendChild(svg);
    // input 0 at the LEFT, input 1 at the RIGHT (matches toLocalPt and the on-node
    // curve glyph); output 0 at the bottom, 1 at the top.
    const X = x => PAD + x * (W - 2 * PAD);
    const Y = y => H - PAD - y * (H - 2 * PAD);
    const toLocalPt = e => {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left - PAD) / (W - 2 * PAD);
      const y = (H - PAD - (e.clientY - r.top)) / (H - 2 * PAD);
      return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    };
    const dragPoint = (i, endpoint) => e => {
      e.preventDefault(); e.stopPropagation();
      const nx = endpoint ? p.spline[i].x : null;   // endpoints anchor the input domain
      const move = ev => {
        const q = toLocalPt(ev);
        let px;
        if (endpoint) px = nx;                              // vertical only
        else {                                              // keep x between neighbours (no order flips)
          const lo = p.spline[i - 1].x, hi = p.spline[i + 1].x;
          px = Math.max(lo, Math.min(hi, q.x));
        }
        p.spline[i] = { x: +px.toFixed(3), y: +q.y.toFixed(3) };
        render();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); this.refresh(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
    const render = () => {
      svg.innerHTML = '';
      // horizontal reference lines at 25 / 50 / 75 % of peak (output) level.
      [0.25, 0.5, 0.75].forEach(frac => {
        const ln = document.createElementNS(svgNS, 'line');
        ln.setAttribute('x1', PAD); ln.setAttribute('x2', W - PAD);
        ln.setAttribute('y1', Y(frac)); ln.setAttribute('y2', Y(frac));
        ln.setAttribute('stroke', frac === 0.5 ? '#3a4658' : '#232c39');
        ln.setAttribute('stroke-width', '1');
        svg.appendChild(ln);
      });
      const pts = normalizeSpline(p.spline);
      const path = document.createElementNS(svgNS, 'polyline');
      path.setAttribute('points', pts.map(q => `${X(q.x)},${Y(q.y)}`).join(' '));
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#7fd1ff'); path.setAttribute('stroke-width', '2');
      svg.appendChild(path);
      for (let i = 0; i < pts.length; i++) {
        const c = document.createElementNS(svgNS, 'circle');
        c.setAttribute('cx', X(pts[i].x)); c.setAttribute('cy', Y(pts[i].y)); c.setAttribute('r', 6);
        c.setAttribute('fill', '#ffd166'); c.style.cursor = 'grab';
        const endpoint = i === 0 || i === pts.length - 1;
        c.addEventListener('pointerdown', dragPoint(i, endpoint));
        svg.appendChild(c);
      }
    };
    box.querySelector('#ins-naddnode')?.addEventListener('click', () => {
      const s = normalizeSpline(p.spline);
      const xs = s.map(q => q.x); let gap = -1, gi = 0;
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > gap) { gap = xs[i] - xs[i - 1]; gi = i; }
      const mx = +((xs[gi - 1] + xs[gi]) / 2).toFixed(3);
      p.spline = [...s, { x: mx, y: 0.5 }].sort((a, b) => a.x - b.x); render(); this.refresh();
    });
    box.querySelector('#ins-nrmnode')?.addEventListener('click', () => {
      const s = normalizeSpline(p.spline); if (s.length <= 2) return;
      let bi = 1, bd = -1;
      for (let i = 1; i < s.length - 1; i++) { const dy = Math.abs(s[i].y - (s[i - 1].y + s[i + 1].y) / 2); if (dy > bd) { bd = dy; bi = i; } }
      p.spline = s.filter((_, i) => i !== bi); render(); this.refresh();
    });
    if (!Array.isArray(p.spline) || p.spline.length < 2) p.spline = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    render();
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

    // logic gates: amber boxes sized to their label (text never overflows),
    // with short input stubs on the LEFT and an output stub on the RIGHT so the
    // signal-flow direction is obvious at a glance.
    for (const g of v.logicGates ?? []) {
      const sel = g.id === this.selectedComp;
      const label = this.compDef(g.type)?.name ?? g.type;
      ctx.save();
      ctx.translate(g.pos.x, g.pos.y);
      // g.rot orients the node (0/90/180/270); everything below is drawn in the
      // rotated frame so box, curve glyph and stubs all turn together.
      const rot = ((g.rot ?? 0) * Math.PI) / 180;
      ctx.rotate(rot);
      ctx.font = '7px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const { w, h } = this.gateBox();
      // input stubs (left) + one output stub per tap (right) — both use rowY so
      // the drawn stubs line up exactly with the wire anchors (gateAnchor).
      const inPorts = (this.compDef(g.type)?.ports ?? []).filter(p => p.kind === 'logic_in');
      const outIds = outputPortIds(g, this.compDef(g.type));
      ctx.strokeStyle = '#7a5b12';
      ctx.lineWidth = 1;
      inPorts.forEach((p, i) => {
        const y = this.rowY(i, inPorts.length, h);
        ctx.beginPath(); ctx.moveTo(-w / 2 - 5, y); ctx.lineTo(-w / 2, y); ctx.stroke();
      });
      outIds.forEach((id, i) => {
        const y = this.rowY(i, outIds.length, h);
        ctx.beginPath(); ctx.moveTo(w / 2, y); ctx.lineTo(w / 2 + 5, y); ctx.stroke();
      });
      const neuron = isNeuron(g.type);
      // Neurons are tinted teal (analog) vs the amber of boolean gates; a live
      // curve glyph inside shows the chosen response shape at a glance.
      ctx.fillStyle = neuron ? 'rgba(70, 209, 122, 0.9)' : 'rgba(255, 176, 32, 0.9)';
      ctx.strokeStyle = sel ? '#ffffff' : (neuron ? 'rgba(38, 122, 74, 0.7)' : 'rgba(122, 91, 18, 0.6)');
      ctx.lineWidth = sel ? 2 : 1;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      if (neuron) this.drawNeuronCurve(ctx, g, w, h);
      // The label rotates WITH the box so it reads along the flow direction at
      // 90/270; only at 180 would that leave it upside down, so there we undo the
      // rotation and keep the text right side up.
      const flip = (g.rot ?? 0) % 360 === 180;
      if (flip) { ctx.save(); ctx.rotate(-rot); }
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText(label, 0, neuron ? h / 2 - 3 : 0);
      if (flip) ctx.restore();
      ctx.restore();
    }

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

      // Propagator: a dashed ring of radius = its threshold centred on the part
      // itself — you can SEE the conversion boundary while tuning it (this is
      // the same circle the world draws during a run).
      if (c.type === 'propagate') {
        const R = Math.max(0, c.props?.threshold ?? 260);
        ctx.beginPath();
        ctx.arc(c.local.x, c.local.y, R, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(141,255,190,0.05)';
        ctx.fill();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = 'rgba(141,255,190,0.55)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
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
      const a = this.anchorFor(w.from.componentId, w.from.port);
      const b = this.anchorFor(w.to.componentId, w.to.port);
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

// One-line truth-behaviour for each gate, shown in the inspector on selection.
const GATE_LOGIC = {
  gate_and: 'output is HIGH only when every input is HIGH.',
  gate_or: 'output is HIGH when any input is HIGH.',
  gate_nand: 'inverted AND — output is LOW only when every input is HIGH.',
  gate_nor: 'inverted OR — output is HIGH only when every input is LOW.',
  gate_xor: 'output is HIGH when the inputs differ (an odd number of HIGH inputs).',
  gate_not: 'inverts its single input (HIGH\u2192LOW, LOW\u2192HIGH).',
};
const gateLogicDesc = type => GATE_LOGIC[type] ?? '';

import { generateSnapPoints } from '../src/models/snapPoints.js';
import { validateWiring, outputPorts, outputPortIds } from '../src/models/wiring.js';
import { componentSize, componentHits, nearestSnapIndex } from '../src/models/hitTest.js';
import { isNeuron, transferOutput, normalizeSpline, TRANSFER_PRESETS } from '../src/simulation/transfer.js';
import { colorPaletteHtml, lightenHex, DEFAULT_BODY_COLOR } from './color.js';
