PLAN.md
# Braitenberg Vehicles Simulator - Plan

## 1. Overview

A self-hosted, LAN-accessible web simulator for constructing and simulating Braitenberg Vehicles 1-7. The application is a single-page web app with two primary modes: Vehicle Editor and World Simulator.

The design goal is intuitive construction via snap-able components, explicit sensor-to-actuator wiring with polarity and weight, and a realistic 2D physics world with light and distance sensing.

The system is client-side only with manual JSON import/export for sharing. No server-side state is required.

## 2. Scope

### In Scope
* Vehicle construction from a rectangular start shape with attachable components via snap points
* Component library: body shapes, powered wheels, passive wheels/casters, light sensor, distance/proximity sensor, generic sensor mount
* Visual wiring editor with drag-and-drop arcing lines, excitatory/inhibitory polarity, and weight/scaling per connection
* Wiring remains editable after vehicle creation
* World simulation with full 2D physics, primitive obstacles and light sources
* Realistic sensors: inverse-square light falloff, raycast distance/proximity with toggleable beam visualization
* World elements editable in World view: position, rotation, scale
* World and vehicle save/load as JSON
* Vehicle instances list with prototype editing propagation. Instance count controlled via slider/integer
* Responsive world view that expands to browser window

### Out of Scope
* Multi-user collaboration, authentication, or global library
* Server-side persistence
* 3D simulation

## 3. Architecture

### 3.1 Runtime
Static SPA. No build-time backend dependency. Suitable for macOS and Linux self-hosting via nginx, Caddy, or simple Python http.server.

Recommended stack:
* Frontend: ES Modules, Canvas 2D for rendering, HTML5 for UI
* Physics: 2D rigid body physics engine, e.g., Matter.js
* UI: Vanilla JS with a lightweight component model. No framework lock-in
* Storage: Browser localStorage for recent files + manual File System Access API / download for sharing

All code is modular with clear separation: Config, Data Models, Editor, World, Simulation, Rendering, UI.

### 3.2 Config System
No hard-coded variables. All tunable parameters live in JSON config files, each <500 lines.

* `config/app.json` - App metadata, default settings
* `config/components.json` - Component definitions: id, name, category, mass, size, snap compatibility, default properties
* `config/sensors.json` - Sensor types, falloff models, raycast params, beam visualization options
* `config/actuators.json` - Actuator types, force limits, power curves
* `config/world.json` - Default world settings, obstacle primitives, light defaults
* `config/ui.json` - UI layout, tab defaults, snap point density

Config files are loaded at startup and hot-reloadable in development.

## 4. Data Models

### 4.1 Vehicle JSON Schema
```json
{
  "id": "uuid",
  "name": "string",
  "version": 1,
  "body": {
    "shape": "rect|polygon|ellipse",
    "size": {"w": number, "h": number},
    "mass": number
  },
  "snapPoints": [
    {"id": "uuid", "angle": number, "radius": number}
  ],
  "components": [
    {
      "id": "uuid",
      "type": "component_id",
      "snapPointId": "uuid",
      "localOffset": {"x": number, "y": number},
      "rotation": number,
      "properties": {}
    }
  ],
  "wiring": [
    {
      "id": "uuid",
      "sourceId": "component_id_sensor",
      "targetId": "component_id_actuator",
      "polarity": "excitatory|inhibitory",
      "weight": number
    }
  ]
}
```

### 4.2 World JSON Schema
```json
{
  "id": "uuid",
  "name": "string",
  "settings": {
    "gravity": number,
    "timeScale": number
  },
  "elements": [
    {
      "id": "uuid",
      "type": "light|obstacle|rock",
      "primitive": "rect|circle|polygon",
      "position": {"x": number, "y": number},
      "rotation": number,
      "scale": {"x": number, "y": number},
      "properties": {}
    }
  ],
  "vehiclePrototypes": [
    {
      "vehicleId": "uuid",
      "vehicleRef": "<vehicle JSON or ref>",
      "instances": [
        {"id": "uuid", "position": {"x": number, "y": number}, "rotation": number}
      ]
    }
  ]
}
```

Sharing is via import/export of these JSON files. Manual drag-and-drop file handling is supported.

## 5. Vehicle Editor

### 5.1 Construction Flow
* Start with a selectable body shape. Default is rectangle.
* Snap points are generated as an even distribution around the perimeter, including corners. Snap points are universal.
* Component palette from `components.json`. User drags component onto body; system snaps to nearest valid snap point.
* Attached components can be repositioned along snap point, rotated locally, and removed.
* Components support passive wheels/casters and multiple sensor mounts per component.

### 5.2 Wiring Editor
* Open wiring mode after components are placed.
* Sensor outputs and actuator inputs are shown as connection handles.
* Drag from sensor to powered wheel to create a wire. Visual arcing line rendered.
* Per-wire properties: polarity toggle excitatory/inhibitory, weight slider 0-1.
* Wiring is stored in vehicle JSON and remains editable in editor. Validation prevents duplicate connections and type mismatches.

## 6. World Simulator

### 6.1 World View
* Tabbed SPA. Editor tab and World tab.
* World view occupies max browser real estate. UI chrome collapses on play.
* World elements: primitive shapes, rocks, light sources. Editable in world view via gizmos for position, rotation, scale.
* Elements are created from a palette and saved in world JSON.

### 6.2 Vehicle Instances
* Left panel lists vehicle prototypes by name, e.g., Vehicle A.
* Each prototype shows instance count with slider/integer input. Changing count adds/removes instances in world.
* Edits to prototype via "Edit" button open Vehicle Editor. Changes propagate to all instances on save.
* World-level distribution tools: Add Here, Random Distribute, Line Up, Grid.

### 6.3 Simulation Loop
* Physics step via Matter.js with fixed timestep.
* Sensor sampling per step:
  - Light sensor: samples light sources with inverse-square falloff. Summation of all sources in range.
  - Distance/Proximity sensor: raycast with configurable angle and range. Beam pattern toggleable for visualization.
* Actuator update: sensor value * weight * polarity -> motor force/torque applied to powered wheels. Differential drive behavior emerges naturally from wiring.
* Controls: Play/Pause, Reset, Step, Time Scale.

## 7. Rendering & UX

* Modern simple aesthetic. Clean lines, minimal chrome.
* Snap point highlight on hover. Valid drop target feedback.
* Wiring arcs with color coding for polarity.
* Toggleable sensor beam visualization.
* World camera pan/zoom with mouse. Vehicle orientation editable via drag handle or rotate gizmo.
* Keyboard shortcuts for common actions defined in `ui.json`.

## 8. Persistence & Sharing

* Client-side only. Save/Load via file download and file input.
* Recent files stored in localStorage.
* Vehicle JSON and World JSON are human-readable and versioned for future compatibility.

## 9. Deployment

* Static files served from `dist/`. No server code required.
* Self-host on macOS/Linux with nginx/Caddy.
* LAN access via local IP. No external dependencies at runtime.

## 10. Future Expansion Design

* Component system is data-driven via `components.json`. New components require only config entry, no code change.
* Sensor and actuator models are pluggable via config.
* JSON schemas are versioned. Migration functions handle schema evolution.
* Config files <500 lines each to maintain readability.
* Simulation engine is abstracted behind an interface to allow swapping physics or adding new sensor models.
* UI panels are defined in `ui.json` to allow layout changes without code.

This plan provides a modular, config-driven foundation for Vehicles 1-7 simulation with clear paths for extension.

## Status (updated after sensor/motor tuning session)

### Implemented
- Light sensing normalized linearly in *distance* (`lightLevelNormalized`): a dim source responds from a real range with no near-source cliff; inverse-square physics still sets the sensing window (radius = min(range, sqrt(I/T)), full scale at sqrt(I/F)). Replaces the old level-linear map that made one polarity look "less sensitive" and only fired near a source.
- Per-sensor FOV + wedge beams: each light sensor has `fov` (default 2 pi / omni) and `aimAngle`; beam drawn as a true triangular wedge whose length = effective sensing radius. Ghost-range fallback removed - no more misleading ring when nothing is in view.
- On-body telemetry ("Values:" toggle): per-robot x/y, per-sensor level to output + distance-to-light, per-wheel signed force.
- Per-wheel tuning on the motor element: `motorPower` (gain) and `friction` (mapped to Matter `frictionAir` drag; 0 = ice, 1 = grippy), with live inspector sliders and config defaults (`applyMotorPower`, `wheelFrictionAir`, unit-tested).
- Power curves in `computeActuation`: `linear` (default) and `sqrt` are now selectable in `config/actuators.json`.
- Per-motor polarity (forward/reverse) is editable in the inspector via `actuatorPolaritySign` - resolves the old "inhibitory wheel spins the wrong way" symptom.

### Still parked
- Explicit cw/ccw *visual spin* direction per actuator, fully decoupled from force sign. Per-motor polarity now covers most of this; a dedicated render-direction param is a small nicety, not required for Vehicles 1-5.
- Motor-response scripting / decision-table layer: thresholds, dead-bands, and conditional branches ("if light > 0.6 then full speed...") to generalize the `value x weight x polarity x powerCurve` model for Vehicles 6/7. Keep `computeActuation` as the single seam so simple and scripted responses share the same clamping + force pipeline.

## Next Up — Session Handoff (start fresh session, read this + relevant files)

State is committed & pushed (`74404d7`, `main`). Three features to build next, all in the
live UI layer (`public/app/` + `config/`) following existing patterns. TDD where pure logic
is involved; verify each with the headless smoke probes (see below) and `npm test`.

### 1. Multiple vehicle types (CRUD) — currently only "Vehicle A"
- Data: `worldDoc.vehiclePrototypes` = array of `{ id, name, instances:[seed...], vehicle|_vehicle }`
  (loaded from `public/worlds/light-field.json`). `renderPrototypes()` in `public/app/world.js`
  renders one `.proto-block` per prototype (count input + Add Here/Random/Line/Grid/Edit).
- Add: an "Add Vehicle" button (above the proto list) that pushes a new prototype. Name = next
  unused "Vehicle X" (A, B, C...); clone a blank/default vehicle (`blankVehicle()` or clone
  Vehicle A's doc) and spawn a few instances via existing `ensureCount(proto, n)`.
- Remove: a "Remove" button per `.proto-block` (confirm). Must drop that prototype's running
  instances: filter `this.instances` by `protoId`, `M.Composite.remove(world, inst.body)` for
  each, then remove from `vehiclePrototypes` and re-render. Reuse the removal logic already in
  the count-decrement path (~`world.js` lines 401–418).
- Naming helper: compute next letter not already used; keep ids unique (`proto_<rand>`).

### 2. Drag a running robot to reposition it (like lights/rocks/walls)
- Element drag pattern is in `public/app/world.js` `bindCanvas()` (~lines 212–238):
  `mousedown` → `toWorld(e)`, `mousemove` moves the grabbed thing, `mouseup` clears.
- Add an instance-drag branch: on `mousedown`, hit-test `this.instances` for one whose body is
  near the click (distance from `inst.body.position` < max(body half-width, ~20px) * zoom-adjusted).
  If found, set `this.dragInstance = inst`. On `mousemove`: `M.Body.setPosition(inst.body, worldPt)`
  AND `M.Body.setVelocity(inst.body, {x:0,y:0})` + zero angular velocity so it doesn't fling.
  On `mouseup`: clear. Make sure instance-drag takes precedence over / is checked before element
  selection so clicking a robot doesn't also grab an element behind it.
- Note: while playing, the sim keeps stepping; either pause during drag or just keep setting
  position each mousemove (setting position wins per-frame). Simplest correct approach: set
  position + zero velocity in the mousemove handler; works whether paused or playing.

### 3. "Paths:" toggle + per-vehicle body color
- Toggle button: add `<button id="btn-paths">Paths: off</button>` next to `btn-values`
  (`public/index.html` line ~69). Bind in `main.js` ui list (add `btnPaths`) and handler in
  `world.js` next to the `btnValues` onclick (~line 259): `this.paths = !this.paths; btnPaths.textContent`.
- Recording: in `step()` while playing, push `{x, y}` of each `inst.body.position` onto
  `inst.path` (init `[]` on instance creation). Cap length (e.g. keep last ~2000 points; shift
  when exceeded) so long runs don't grow unbounded. Clear `inst.path = []` on `reset()`.
- Rendering: in `draw()` (after bodies, gated by `if (this.paths)`), stroke a polyline through
  each instance's `inst.path` using the vehicle's body color with alpha ~0.5 and lineWidth ~2.
- Body color as a vehicle option:
  - Data: add `color` to the vehicle `body` object: `{ width, height, color }`. Default
    `#4da3ff` (current hardcoded stroke). Each prototype gets its own default; new "Add Vehicle"
    can cycle a palette so types are visually distinct.
  - Editor UI: in `public/app/editor.js` inspector, add a vehicle-level row (shown when no
    component is selected, or always) with `<input type="color" id="ins-body-color">` bound to
    `v.body.color` + `this.refresh()`.
  - World render: replace hardcoded body fill/stroke in the instances draw loop (~line 518+) —
    currently `fillStyle '#2b3a52'`, `strokeStyle '#4da3ff'` — with `v.body?.color ?? '#4da3ff'`
    for the stroke (keep a dark fill, or derive it), so the drawn body and its path share color.

### Verification harness (headless Chrome/CDP, no server changes)
- `npm test` → `tests/*.test.js` (node --test). Add pure-logic tests if any feature has a
  non-trivial function (e.g. "next unused vehicle name").
- `npm run smoke` → `tests/smoke/editor.ui.mjs` + `world.sim.mjs` (spins headless Chrome,
  `window.__app()` exposes `{ state, worldSim }`). Pattern: navigate to index.html, click
  `#tab-world`, drive via DOM (buttons/inputs), assert on `worldSim.instances` / vehicle docs.
- For drag + paths you can assert programmatically: set an instance position via a CDP
  evaluate (simulate mousedown/move/up on `world-canvas`, or call the handler), then check
  `inst.body.position` moved and `inst.path.length` grew over a few stepped frames while playing.
- Leftover-Chrome gotcha: these probes share a profile dir; stale headless processes cause
  "devtools not reachable". `pkill -f remote-debugging-port` and `rm -rf <profile>` before reruns.

### Current defaults (tuned, do not regress)
- `config/actuators.json`: `defaultMotorPower: 0.1`, `defaultFriction: 0.5`, `powerCurve: linear`.
- `config/sensors.json` light: `detectionThreshold: 0.02`, `fullScaleRatio: 16`.
- On-body readouts (Values toggle) show x/y, per-sensor level→output + distance-to-light,
  per-wheel signed force. Light beam = true sensing radius only (ghost-range fallback removed).
