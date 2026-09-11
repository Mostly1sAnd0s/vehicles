/**
 * World Simulator: the page half of the simulation (M10.2).
 *
 * Physics, sensors, actuation and propagation run inside a HeadlessWorld reached through
 * the sim protocol (src/simulation/simProtocol.js) — on a Worker by default, on the main
 * thread via `?worker=0`. This file keeps documents, seeds, selection, camera, UI and
 * drawing; `inst.body` is the real Matter body on the local transport (same heap) and a
 * pose mirror otherwise — every renderer/hit-test read works unchanged.
 * Fixed-timestep loop, camera pan/zoom, element editing, instance tools.
 */

import { findInstanceAt, componentSize } from '../src/models/hitTest.js';
import { isSolidBody, solidBodyRadius, solidBodyCircles, pushOutOfCircle, pushClearance } from '../src/models/solidBody.js';
import { defaultElementTemperature } from '../src/models/heatSource.js';
import { formationPoses } from '../src/models/formation.js';
import { applyReply } from './simMirror.js';
import { createSimBridge } from './simBridge.js';
import { drawWorld } from './worldDraw.js';
import { renderWorldInspector } from './worldInspector.js';
import { nextVehicleName, makePrototype, blankVehicle, removePrototype, nextVehicleColor } from './prototypes.js';
import { lightenHex, DEFAULT_BODY_COLOR } from './color.js';

/** Max points kept per instance for the Paths overlay. Long runs stay O(1). */
const PATH_CAP = 2000;

export class WorldSim {
  constructor(canvas, ui, state, hooks) {
    this.canvas = canvas;
    this.ui = ui;
    this.state = state;
    this.hooks = hooks;
    this.M = window.Matter; // kept for direct-body compatibility (local transport runs in this heap)

    this.view = { x: 0, y: 0, zoom: 1 };
    this.playing = false;
    // Co-op (M5): while connected, the World canvas IS the shared world. Local physics then
    // neither steps nor draws its own instances; everything rides on server snapshots.
    this.coopMode = false;
    this.coopPaths = new Map(); // bot.id -> [{x,y}] accumulated client-side from snapshots
    this._dragBot = null;       // host-dragged shared bot: {id, x, y} for optimistic render until server echoes
    this.beams = true;
    this.selectedElement = null;
    this.selectedInstance = null;   // a running vehicle shown in the inspector (X/Y/Rot)
    this.selectedRemoteBot = null;  // a shared (co-op) bot selected for the X/Y/Rot popup
    this.convertedCount = 0;   // mirrored from the engine (reset on reset())
    this.instances = [];          // {id, protoId, body(matter|mirror), seed:{x,y,rotation}, path, lastSamples, lastMotors}
    this.lastSamples = [];        // for beam drawing (per instance)
    this.showValues = true;       // on-body sensor/motor readouts
    this.paths = false;           // show motion trails behind each robot
    this.acc = 0;
    this.lastT = performance.now();

    // Everything physical lives behind this bridge: a Worker by default (physics + sensors
    // never touch the UI thread), the main thread under `?worker=0` or when the Worker
    // fails to boot (loud fallback). One protocol either way — see simBridge/simProtocol.
    this.bridge = createSimBridge({
      configs: this.state.configs,
      dtMs: this.dtMs,
      onReply: (reply, helpers) => this._onSimReply(reply, helpers),
    });
    this.bridge.send({
      op: 'init',
      dtMs: this.dtMs,
      elements: this.worldDoc.elements ?? [],
      vehicles: this._protoDocs(),
      instances: [],
    });

    this.bindUI();
    this.bindCanvas();
    this.syncInstances();
    this.renderPrototypes();
    this.loop();
  }

  get worldDoc() { return this.state.world; }
  get dtMs() { return this.state.configs.app.defaults.fixedTimestepMs; }
  timeScale() { return this.worldDoc.physics?.timeScale ?? 1; }

  // ---------------- engine bridge ----------------
  // The full desired state for the engine: elements + prototype docs + running instances
  // with their page-owned seeds. `sync` is idempotent (the engine diffs), so every
  // structural change just re-states the world — obstacles, vehicles and instances all
  // rebuild through that one seam.
  _protoDocs() {
    return this.worldDoc.vehiclePrototypes.map(p => ({ id: p.id, name: p.name, vehicle: p.vehicle ?? p._vehicle ?? null }));
  }

  _desiredInstances() {
    return this.instances.map(i => ({ id: i.id, protoId: i.protoId, seed: { ...i.seed } }));
  }

  _syncEngine() {
    if (this.coopMode) return; // the local engine is inert while the shared world owns the canvas
    this.bridge.send({
      op: 'sync',
      elements: this.worldDoc.elements ?? [],
      vehicles: this._protoDocs(),
      instances: this._desiredInstances(),
    });
  }

  /** Static obstacle bodies on the local transport (the engine owns them; this is a read view). */
  get obstacleBodies() { return this.bridge.obstacleBodies ?? []; }

  buildObstacles() { this._syncEngine(); }

  /**
   * Push live bots out of any solid light they are now inside, and adopt the new
   * pose as their seed. Enabling solidity under a parked robot would otherwise let
   * Matter eject it violently across the world; instead we step it straight out to
   * barrier + clearance along the light→bot vector with momentum zeroed (the same
   * idiom as a bot drag-drop). Mirrors HeadlessWorld.evictOverlappingBots so the
   * single-player and shared worlds behave identically. Returns bots moved.
   */
  evictOverlappingBots() {
    // Every solid emitter, not just lamps: a furnace switched on on top of a parked robot
    // would otherwise get the same Matter ejection this function exists to prevent.
    const circles = solidBodyCircles(this.worldDoc.elements, this.state.configs);
    if (!circles.length) return 0;
    const clearance = pushClearance(this.state.configs);
    let moved = 0;
    for (const inst of this.instances) {
      if (!inst.body?.position) continue;
      const start = { x: inst.body.position.x, y: inst.body.position.y };
      let pose = { id: inst.id, x: start.x, y: start.y };
      for (const c of circles) {
        const [evicted] = pushOutOfCircle(c, c.r, [pose], clearance);
        if (evicted) pose = evicted;
      }
      if (Math.hypot(pose.x - start.x, pose.y - start.y) < 1e-9) continue;
      // THROUGH the bridge: the engine re-seats the body, zeroes momentum and adopts the
      // seed as the reset target; the page follows its own seed to match.
      this.bridge.send({ op: 'move', id: inst.id, x: pose.x, y: pose.y });
      inst.seed = { x: pose.x, y: pose.y, rotation: inst.body.angle };
      moved++;
    }
    return moved;
  }

  syncInstances() {
    // Keep running instances in step with the current vehicle doc (call after any editor
    // change). The engine's diff refreshes wire maps on wiring changes and rebuilds bodies
    // only on geometry changes (props included), preserving pose AND momentum — edits
    // never stop a moving car.
    this._syncEngine();
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

  // Compatibility seam (tests + probes): wiring lives on the prototype doc; re-stating the
  // world IS the refresh now — the engine diffs wireSig itself. Synchronous on the local
  // transport, so callers see the change by the time this returns.
  instWireMap() {
    this._syncEngine();
  }

  // ---------------- configuration propagation ("replicate") ----------------
  // The conversion logic itself lives in the engine (it is position-based, and the engine
  // is authoritative — HeadlessWorld._stepPropagation). The page only mirrors the outcome:
  // converted docs arrive as protocol events (simMirror swaps `vehicleOverride`), the
  // converted counter rides every reply, and this pill renders both.
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

  step(n = 1) {
    if (this.coopMode) return; // the shared world is stepped authoritatively on the server
    // One protocol command. Local transport: the reply is delivered synchronously, so
    // step() has exactly its classic sync semantics. Worker transport: the reply lands
    // when the engine is done — the UI never waits, and `bridge.busy` sheds load (below).
    this.bridge.send({
      op: 'step',
      n,
      // samples/motors are the payload hogs at fleet scale; they are needed only while a
      // renderer reads them (Beams or Values). Paths record engine-side while toggled on.
      detail: this.beams || this.showValues,
      trackPaths: this.paths,
    });
  }

  // Engine replies -> page mirrors: poses (real bodies locally, mirrors on the Worker),
  // per-instance samples/motors, flash, converted docs, path points, converted count.
  _onSimReply(reply, helpers = {}) {
    applyReply(this.instances, reply, {
      pathsOn: this.paths,
      pathCap: PATH_CAP,
      resolveBody: helpers.resolveBody ?? null,
      reset: reply.ack === 'reset',
    });
    // Beams render from the flat world-sample list, rebuilt from the freshest replies.
    if (reply.bots?.some(b => b.samples !== undefined)) {
      this.lastSamples = [];
      for (const inst of this.instances) {
        for (const s of inst.lastSamples ?? []) this.lastSamples.push({ ...s, instanceId: inst.id });
      }
    } else if (!this.beams && !this.showValues) {
      this.lastSamples = [];
    }
    if (reply.convertedCount != null) this.convertedCount = reply.convertedCount;
    this.updatePropagationStatus();
  }

  loop() {
    const frame = t => {
      // Single-player only: the shared world is stepped authoritatively on the server.
      if (this.playing && !this.coopMode) {
        this.acc += Math.min(t - this.lastT, 100) * this.timeScale();
        if (this.bridge.busy) {
          // A step batch is still in flight on the Worker: shed time rather than queue
          // unbounded work — under overload the sim loses wall-clock time, the UI does not.
          this.acc = Math.min(this.acc, this.dtMs);
        } else if (this.acc >= this.dtMs) {
          const n = Math.min(8, Math.floor(this.acc / this.dtMs));
          this.acc -= n * this.dtMs;
          this.step(n);
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
      // Co-op (M5 p3): shared-world bots render on top and aren't local instances, so they need
      // their own grab. The host DRAGS them (authoritative moveBot); a participant may SELECT one
      // to read its pose in the inspector (X/Y/Rot are read-only for non-hosts).
      if (this.coopMode) {
        const bot = this.remoteBotAt(w);
        if (bot) {
          this.selectedRemoteBot = { id: bot.id };
          this.selectedInstance = null;
          this.selectedElement = null;
          this.renderInspector();
          if (this.hooks?.isCoopAdmin?.()) {
            drag = { mode: 'bot', id: bot.id, started: { x: bot.x, y: bot.y }, mouse: w, lastSend: 0 };
            this._dragBot = { id: bot.id, x: bot.x, y: bot.y };
          }
          return;
        }
      }
      // instance drag takes precedence: a robot on top of an element gets grabbed first.
      // Co-op: local instances are frozen and not drawn while connected — never grab a ghost.
      const inst = this.coopMode ? null : findInstanceAt(this.instances, pid => this.prototypeVehicle(pid), w, this.view.zoom);
      if (inst) {
        // Grab the robot AND surface it in the inspector (X/Y/Rot), like elements.
        this.selectedInstance = inst;
        this.selectedElement = null;
        this.selectedRemoteBot = null;
        this.renderInspector();
        drag = { mode: 'instance', inst };
        return;
      }
      const el = this.hitElement(w);
      if (el) {
        this.selectedElement = el.id;
        this.selectedInstance = null;
        this.selectedRemoteBot = null;
        this.renderInspector();
        // Co-op (M5 p3): shared-world elements are host-controlled. A participant may SELECT one
        // for the read-only popup but must not drag it — the world is locked on their canvas.
        if (this.coopMode && !this.hooks?.isCoopAdmin?.()) return;
        drag = { mode: 'element', el, started: { x: el.position.x, y: el.position.y }, mouse: w, lastSend: 0 };
      } else {
        this.selectedElement = null;
        this.selectedInstance = null;
        this.selectedRemoteBot = null;
        this.renderInspector();
        drag = { mode: 'pan', view0: { ...this.view }, e0: { x: e.clientX, y: e.clientY } };
      }
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      if (drag.mode === 'bot') {
        // Offset-based (like element drag): the bot follows the grab point, not the cursor center.
        const w = this.toWorld(e);
        const x = drag.started.x + (w.x - drag.mouse.x);
        const y = drag.started.y + (w.y - drag.mouse.y);
        this._dragBot = { id: drag.id, x, y }; // optimistic local render on every move
        this._refreshRemoteBotPopup(); // keep the selected bot's X/Y/Rot popup ticking while dragging
        // Throttle the wire command to ~30Hz; a final authoritative send happens on mouseup.
        const now = performance.now();
        if (now - drag.lastSend > 33) { this.hooks?.onBotChange?.({ id: drag.id, x, y }); drag.lastSend = now; }
      } else if (drag.mode === 'element') {
        const w = this.toWorld(e);
        drag.el.position.x = drag.started.x + (w.x - drag.mouse.x);
        drag.el.position.y = drag.started.y + (w.y - drag.mouse.y);
        this.buildObstacles();
        this.renderInspector();
        // Co-op (M5 p3): stream the move WHILE dragging (~30 Hz, same throttle as bot drags) so
        // participants watch the element follow the cursor instead of warping to its drop spot.
        if (this.coopMode) {
          const now = performance.now();
          if (now - drag.lastSend > 33) {
            this.hooks?.onElementChange?.({ op: 'move', id: drag.el.id, x: Math.round(drag.el.position.x), y: Math.round(drag.el.position.y) });
            drag.lastSend = now;
          }
        }
      } else if (drag.mode === 'instance') {
        // The engine's `move` re-seats the body and zeroes momentum so it never flings.
        // Local transport applies synchronously via the reply; the Worker transport gets an
        // optimistic mirror write so the bot tracks the cursor between replies.
        const w = this.toWorld(e);
        this.bridge.send({ op: 'move', id: drag.inst.id, x: w.x, y: w.y });
        this._optimisticPose(drag.inst, w.x, w.y);
      } else {
        this.view.x = drag.view0.x - (e.clientX - drag.e0.x) / this.view.zoom;
        this.view.y = drag.view0.y - (e.clientY - drag.e0.y) / this.view.zoom;
      }
    });
    window.addEventListener('mouseup', () => {
      if (drag?.mode === 'instance' && drag.inst.body) {
        // adopt the dropped pose as the seed so Reset restores it — final authoritative
        // move (engine adopts it as its seed too), then the page mirrors the seed.
        const p = drag.inst.body.position;
        this.bridge.send({ op: 'move', id: drag.inst.id, x: p.x, y: p.y });
        drag.inst.seed = { x: p.x, y: p.y, rotation: drag.inst.body.angle };
      }
      // Co-op (M5 p3): a dropped element lands at its final pose — sync the move out once.
      if (drag?.mode === 'element') {
        this.hooks?.onElementChange?.({ op: 'move', id: drag.el.id, x: Math.round(drag.el.position.x), y: Math.round(drag.el.position.y) });
      }
      // Co-op (M5 p3): a dropped shared bot lands at its final pose — send the authoritative move
      // once, then let the server snapshot (or the optimistic pose) hold until it echoes back.
      if (drag?.mode === 'bot' && this._dragBot) {
        this.hooks?.onBotChange?.({ id: drag.id, x: Math.round(this._dragBot.x), y: Math.round(this._dragBot.y) });
      }
      this._dragBot = null;
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
    this._refreshRemoteBotPopup(); // a selected shared bot's popup tracks the live pose (~15 Hz)
  }

  clearCoopPaths() { this.coopPaths.clear(); }

  /**
   * Live-update the selected shared bot's X/Y/Rot popup from the latest pose WITHOUT rebuilding
   * the panel (a rebuild would steal focus mid-edit). Reads the optimistic drag pose while the
   * host is dragging, the latest server snapshot otherwise. Only touches inputs that aren't
   * focused, so a hand-typed value is never clobbered.
   */
  _refreshRemoteBotPopup() {
    if (!this.selectedRemoteBot) return;
    const box = this.ui?.worldInspector;
    if (!box) return;
    const rb = (this.hooks?.remoteBots?.() ?? []).find(b => b.id === this.selectedRemoteBot.id);
    if (!rb) { this.renderInspector(); return; } // selection went stale — full render hides it
    const pose = this._dragBot?.id === rb.id ? this._dragBot : rb;
    const set = (id, v) => {
      const el = box.querySelector('#' + id);
      if (el && document.activeElement !== el) el.value = Math.round(v);
    };
    set('wi-ix', pose.x);
    set('wi-iy', pose.y);
    set('wi-ir', (rb.angle ?? 0) * 180 / Math.PI);
  }

  hitElement(w) {
    for (const el of this.worldDoc.elements) {
      const dx = w.x - el.position.x, dy = w.y - el.position.y;
      let r;
      if (el.type === 'light' || el.type === 'heat') {
        // A SOLID emitter is grabbable by its body. A soft one keeps the small handle it
        // has always had: the glow is an order of magnitude larger than the lamp, so
        // letting it drive the hit radius would make the whole halo grab by accident.
        r = isSolidBody(el, this.state?.configs)
          ? Math.max(12, solidBodyRadius(el, this.state?.configs))
          : 10;
      } else if (el.primitive === 'circle') r = (el.properties?.radius ?? 10) * (el.scale?.x ?? 1);
      else r = Math.max(el.properties?.width ?? 20, el.properties?.height ?? 20) / 2;
      if (Math.hypot(dx, dy) <= r + 4 / this.view.zoom) return el;
    }
    return null;
  }

  /**
   * Co-op (M5 p3): find a shared-world bot under world point w, for host drags. Remote bots render
   * on top and aren't in `this.instances`, so they need their own hit-test. The body is an axis-
   * aligned rect rotated by b.angle, so we test in the bot's local frame. Last-drawn (topmost) bot
   * wins, so we scan the draw order in reverse.
   */
  remoteBotAt(w) {
    const bots = this.hooks?.remoteBots?.() ?? [];
    const pad = 4 / this.view.zoom;
    for (let i = bots.length - 1; i >= 0; i--) {
      const b = bots[i];
      const hw = (b.w ?? 80) / 2 + pad, hh = (b.h ?? 40) / 2 + pad;
      const dx = w.x - b.x, dy = w.y - b.y;
      const a = -(b.angle ?? 0);
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return b;
    }
    return null;
  }

  // ---------------- UI ----------------
  bindUI() {
    const mkEl = () => this.toWorld({ clientX: this.canvas.getBoundingClientRect().left + this.canvas.clientWidth / 2,
                                       clientY: this.canvas.getBoundingClientRect().top + this.canvas.clientHeight / 2 });

    this.ui.addLight.onclick = () => this.addElement({ type: 'light', primitive: 'circle', properties: { intensity: 3000 } }, mkEl());
    // Default temperature comes from config/world.json (never a literal here), and the element
    // is NOT solid by default — dropping a furnace on a robot should not shove it.
    if (this.ui.addHeat) this.ui.addHeat.onclick = () => this.addElement({
      type: 'heat', primitive: 'circle',
      properties: { temperature: defaultElementTemperature(this.state?.configs) },
    }, mkEl());
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
      // `??=`: an imported world JSON without a physics block used to throw right here.
      (this.worldDoc.physics ??= {}).timeScale = Number(e.target.value);
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
    // A solid lamp dropped on top of a running bot must nudge it out, not fling it.
    if (isSolidBody(el, this.state.configs)) this.evictOverlappingBots();
    this.renderInspector();
    // Co-op (M5 p3): the host's canvas is the shared world — mirror the add out to joiners.
    this.hooks?.onElementChange?.({ op: 'add', element: el });
  }

  // Optimistic mirror write for the Worker transport only (the local transport's reply is
  // synchronous — the engine has already moved the real body by the time send() returns).
  _optimisticPose(inst, x, y) {
    if (this.bridge.transport === 'local') return;
    const b = inst?.body;
    if (!b) return;
    if (b.position) { b.position.x = x; b.position.y = y; } else b.position = { x, y };
    b.velocity = { x: 0, y: 0 };
  }

  // Move a running vehicle to an explicit pose (used by the inspector) and adopt
  // it as the seed so Reset restores that exact placement.
  setInstancePose(inst, x, y, rot) {
    if (!inst) return;
    this.bridge.send({ op: 'move', id: inst.id, x, y, rot });
    this._optimisticPose(inst, x, y);
    inst.seed = { x, y, rotation: rot };
  }

  reset() {
    // Seeds ride with the command (formation buttons set fresh seeds right before resetting).
    // The engine returns bodies to seeds, drops converted overrides, cools sensor heat and
    // zeroes its counters; the reply clears the page mirrors (paths, flash, overrides,
    // samples) — synchronously on the local transport.
    const seeds = {};
    for (const inst of this.instances) seeds[inst.id] = inst.seed;
    this.bridge.send({ op: 'reset', seeds });
    this.convertedCount = 0;
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
    } else if (act === 'random' || act === 'line' || act === 'grid') {
      // The layout lives in `models/formation.js`, shared with the co-op server's arrangeAll —
      // so the fleet-organise buttons in the shared world and these per-prototype ones cannot
      // drift into meaning different things. Same numbers as before the extraction:
      // random spreads over the visible radius, line/grid use the 130px default spacing.
      const poses = formationPoses(proto.instances.length, act, center, { spread: this.viewRadius() });
      proto.instances.forEach((_, i) => setSeed(i, poses[i].x, poses[i].y, poses[i].rotation));
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
      // Counter suffix, not just insts.length: after add/remove churn two pushes can land in the
      // same millisecond with the same length and mint a DUPLICATE id (ids key selection, popups
      // and the wire).
      this._instSeq = (this._instSeq || 0) + 1;
      insts.push({
        id: `inst_${Date.now().toString(36)}_${this._instSeq}_${insts.length}`,
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
        // `sensorStates` is one robot's thermal memory (see evaluateVehicleSensors) — per
        // instance, so clones of one design do not share a temperature.
        existing.push({ id: seed.id, protoId: proto.id, seed: { ...seed.position, rotation: seed.rotation }, body: null, path: [], sensorStates: new Map() });
      } else {
        existing[i].seed = { x: insts[i].position.x, y: insts[i].position.y, rotation: insts[i].rotation };
      }
    }
    this.instances = this.instances.filter(i => i.protoId !== proto.id).concat(existing);
    // drop instances no longer documented (only this proto: other vehicle types share
    // this.instances and their ids are not in proto.instances). The engine's diff removes
    // their bodies on the sync below.
    for (const inst of this.instances) {
      if (inst.protoId === proto.id && !proto.instances.some(s => s.id === inst.id)) {
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
    this.instances = this.instances.filter(i => i.protoId !== protoId);
    this._syncEngine(); // the engine's diff removes the bodies with them
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
      // Co-op (M5 p3): while the host drags a bot, render it at the optimistic pose so it tracks
      // the cursor; the authoritative server snapshot overwrites this on the next frame.
      const isDrag = this._dragBot?.id === b.id;
      const bx = isDrag ? this._dragBot.x : b.x;
      const by = isDrag ? this._dragBot.y : b.y;
      ctx.save();
      ctx.translate(bx, by);
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
          const s = componentSize({ local: { x: comp.x, y: comp.y }, props: { radius: comp.r } }, def);
          if (comp.type === 'bumper') {
            // collision barrier: outline ring (no fill) at the per-instance live radius (comp.r)
            ctx.beginPath();
            ctx.arc(comp.x, comp.y, s.radius, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(200,210,225,0.9)';
            ctx.lineWidth = 2 / this.view.zoom;
            ctx.stroke();
          } else if (s.kind === 'rect') {
            ctx.fillStyle = def?.category === 'actuator' ? '#35547a' : '#2f6b46';
            // beginPath FIRST: without it the component rect is APPENDED to the path that still
            // holds the body rect, and fill() repaints the whole body in the component color on
            // top of the vehicle's editor color (the bug behind "co-op bots all look blue").
            ctx.beginPath();
            ctx.save();
            ctx.translate(comp.x, comp.y);
            ctx.rect(-s.along / 2, -s.lateral / 2, s.along, s.lateral);
            ctx.fill();
            ctx.restore();
          } else {
            ctx.fillStyle = def?.category === 'actuator' ? '#35547a' : '#2f6b46';
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

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
