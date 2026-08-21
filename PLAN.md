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

## 4. Vehicle 4 — Non-monotonic Sensor→Motor Response ("Neuron") + Multi-Output Ports

Reference: `docs/v4.md`. Braitenberg's Vehicle 4 brand replaces the simple
monotonic ("the more, the more / the less") sensor→motor law with a **non-
monotonic** dependence: a motor runs faster as a sensor excites it *only up to
a point* (a maximum at some intensity), then slows again. This lets a vehicle
seek a source and then turn away once the stimulus is too strong, orbit a
source like a satellite, or show "instinct"-like behaviours.

### 4.1 The Neuron component (confirmed decisions)
A new component named **Neuron** that sits *between* a sensor and a motor and
applies a selectable non-linear transfer function `output = f(input)`:
- **Name / id:** `neuron`, label "Neuron".
- **Home:** reuses the logic-gate concept — it **floats** (free-placed rectangle,
  not body-snapped) and is stored in `vehicle.logicGates[]` alongside gates.
  `category: "logic"` so it appears in the same non-snapping processing palette
  as the AND/OR/… gates. It is recognised as a *neuron* (not a boolean gate) via
  `isNeuron(type)` so the evaluator routes it analogously, not through the truth
  tables.
- **Ports:** one input (`in0`, `logic_in`), one base output (`out`, `logic_out`)
  — outputs become multi (see 4.2). Arity 1-in / N-out.
- **Props:** `{ shape, threshold, sigma, gain, spline }`.
- **Shape selector (center of the rectangle):** `bell`, `triangle`, `custom`
  (bell is the literal "maximum at a level" 4a curve; triangle is its piecewise-
  linear form; custom is a user-drawn response line).
- **Threshold** = the input intensity at which the response peaks (the maximum
  efficiency point from the text). For `bell` it is also the peak location
  (Gaussian width `sigma`).
- **Custom** = a spline of adjustable nodes (draggable control points on an
  input→output plot; linear interpolation between nodes) so any irregular
  response — multiple maxima, dead-zones, steep ramps — can be drawn.
- **Output range:** clamped to **[0,1]** magnitude. Excitation/inhibition and
  per-wire `weight` remain the downstream job of `computeActuation` (unchanged),
  so a Neuron is a pure reshape of the signal, not a re-weighting.
- **v1 scope:** single in / N out. The engine already supports neuron→neuron and
  gate→neuron chaining (the evaluator recurses over `logicGates`); the UI keeps
  it simple in v1.

### 4.2 Multi-output ports (generalization to all output components)
Today every output component exposes exactly one static `out` port, and the
editor hardcodes `from.port = "out"` when wiring a source into an input — so a
sensor can feed many motors (each motor's In picks it) but there is no way to
add distinct, individually-managed **output taps** from the source side. We add
**dynamic per-instance output ports**, adopted by *every* component that has
outputs (sensors, logic gates, Neurons):
- `componentOutputPorts(comp, def)` → `comp.outputs` if present, else the def's
  output-kind ports. Backward compatible: existing docs/wires use `"out"`, which
  remains the first/default port.
- **"Add Output"** button in the inspector (shown for any component with ≥1
  output-kind port) appends a new tap (`out1`, `out2`, …), materializing
  `comp.outputs` by first copying the def's outputs; added taps can be removed
  (keep ≥1).
- Wires store the specific chosen tap in `from.port`. Source-selection dropdowns
  (an actuator/gate/Neuron input) enumerate each candidate source's output taps
  as distinct options (`componentId|port`).
- **Value routing is unchanged:** a tap's value = its source component's value
  (all outputs of a sensor share the raw reading; all outputs of a Neuron share
  its transfer output). The runtime already keys sources by `componentId`, so no
  world-sim change is needed.
- **Validation** (`src/models/wiring.js`): accept a from-port if it ∈
  `componentOutputPorts(source, def)`; input ports stay strictly from the def.

### 4.3 Integration points (all small, all existing seams)
- **Runtime:** `evaluateLogicGates` (`src/simulation/logic.js`) gets an analog
  branch — a node whose type is a Neuron reads its single input and returns
  `transferOutput(node.props, inputValue)` instead of a truth-table result. Its
  output flows through the existing actuator path in `world.js` (already keyed
  by componentId) → **no change to `world.js` value routing**.
- **New pure module:** `src/simulation/transfer.js` — the transfer functions +
  spline interpolation, unit-tested in isolation.

### 4.4 Phases
- **P1 (pure core):** `src/simulation/transfer.js` (`bell` / `triangle` /
  `custom` spline, optional gain, clamped [0,1]) + unit tests. No UI, no deps.
- **P2 (engine):** analog branch in `evaluateLogicGates`; `neuron` def in
  `components.json` (category `logic`); wiring validation for dynamic outputs;
  version bump; unit/integration tests (analog passthrough, chaining, cycles).
- **P3 (placement + draw):** palette button in the processing palette; free
  placement reusing the gate place/hit path; draw a rectangle with an input slot
  (left), output slot(s) (right) and a mini live curve preview inside.
- **P4 (inspector):** shape `<select>`, threshold slider, `custom` spline editor
  (draggable nodes + add/remove), and the **"Add Output"** button (4.2).
- **P5 (world + verification):** optional in-world rendering of neurons; PLAN
  Status update; behavioral smoke — a light-sensor → Neuron(bell) → two-wheels
  robot driven toward a light source, asserting **non-monotonic motor force**
  (force rises then falls as stimulus crosses the threshold) — the observable
  4a "seek then turn away / orbit" signature.
- **P6 (optional):** per-tap gain on multi-outputs; monotone-cubic spline;
  neuron→neuron chaining surfaced in the UI; extra presets.

## Status (updated — body color + vehicle-detection-sensor sessions; includes prior sensor/motor tuning)

### Implemented
- Light sensing normalized linearly in *distance* (`lightLevelNormalized`): a dim source responds from a real range with no near-source cliff; inverse-square physics still sets the sensing window (radius = min(range, sqrt(I/T)), full scale at sqrt(I/F)). Replaces the old level-linear map that made one polarity look "less sensitive" and only fired near a source.
- Per-sensor FOV + wedge beams: each light sensor has `fov` (default 2 pi / omni) and `aimAngle`; beam drawn as a true triangular wedge whose length = effective sensing radius. Ghost-range fallback removed - no more misleading ring when nothing is in view.
- On-body telemetry ("Values:" toggle): per-robot x/y, per-sensor level to output + distance-to-light, per-wheel signed force.
- Per-wheel tuning on the motor element: `motorPower` (gain) and `friction` (mapped to Matter `frictionAir` drag; 0 = ice, 1 = grippy), with live inspector sliders and config defaults (`applyMotorPower`, `wheelFrictionAir`, unit-tested).
- Power curves in `computeActuation`: `linear` (default) and `sqrt` are now selectable in `config/actuators.json`.
- Per-motor polarity (forward/reverse) is editable in the inspector via `actuatorPolaritySign` - resolves the old "inhibitory wheel spins the wrong way" symptom.
- Drag a running robot: canvas mousedown hit-tests instances *before* elements (nearest body within `max(body half-extent, 20px) + 6/zoom`), drag repositions via `Body.setPosition` with velocity + angular velocity zeroed each move; releasing adopts the dropped pose as that instance's seed (Reset returns there). Pure helpers `instanceHitRadius` / `findInstanceAt` in `src/models/hitTest.js` (unit-tested, injected `vehicleOf` callback keeps them DOM-free); e2e in `tests/smoke/proto.crud.mjs`.
- Multiple vehicle types (CRUD): "+ Add Vehicle" button above the proto list and a per-block "Remove" button (confirm-guarded). Pure helpers in `public/app/prototypes.js` (`nextVehicleName`, `makePrototype`, `removePrototype`, `blankVehicle`; unit-tested in `tests/prototypes.test.js`); `WorldSim.addVehicle` / `removeVehicle` / `dropInstancesOf` wire them to the physics world. New types clone an existing prototype's vehicle (fallback `blankVehicle`) and spawn 3 instances via `ensureCount`. Removed the latent cross-prototype bug in the `ensureCount` decrement path that could drop other types' instances. Verified end-to-end by `npm run smoke:crud`.
- "+Paths:" toggle + per-vehicle body color: a `#btn-paths` toggle (off by default) reveals each robot's motion trail. `step()` records `{x,y}` of every live instance onto `inst.path`, capped at `PATH_CAP` (2000, shift on overflow) and cleared on `reset()`. The trail is stroked in the vehicle's own body color at 0.5 alpha (over the bodies). Body color is now a real vehicle option (`body.color`, default `#4da3ff`): the body **fill** is the chosen color and its **outline** is that color lightened a few shades (`lightenHex`), so each type reads apart. The picker is an always-visible static **4x4 swatch palette** in the editor inspector (`COLOR_PALETTE`, 16 hues, no black/white) — not the native `<input type="color">`, which closed on every click (a click just sets the color + re-renders, so nothing is lost). "Add Vehicle" also cycles a palette (`VEHICLE_COLORS` / `nextVehicleColor`) for auto distinctness. Color helpers live in pure `public/app/color.js` (unit-tested); e2e in `npm run smoke:world` (record/cap/clear-on-reset/toggle), `smoke:crud` (distinct colors + canvas pixel proves the body FILL is the chosen color) and `smoke:editor` (16 swatches, no native input, click sets color + active). The **editor canvas** paints the body with that same fill too (it was a fixed dark navy), so the chosen color is consistent in both views — verified by a horizontal row-scan through the editor canvas centre in `smoke:editor`.
- **Vehicle Detection Sensor** (new config-driven sensor type): reuses the light sensor's *cone* geometry (`inFov` now exported from `src/sensors/light.js`; pure model `detectVehicle()` in `src/sensors/vehicleDetection.js`) but reports the **presence of another vehicle** (1/0) rather than a light level, and never detects itself. The fleet is threaded through `world.js` `step()` as `snapshot.vehicles` plus each sensor's own `instanceId` for self-exclusion. Full Aim / Range / FOV / polarity controls in the editor (FOV control generalized beyond `light_sensor`; an FOV cone is previewed while placing). World view draws a green detection cone (bright when it sees a target, with a line + ring to it) and an on-body `V d≈N` readout. `evaluateVehicleSensors` gains a `vehicle_detection_sensor` branch emitting `kind:'vehicle'`, `detected`, `detectedDistance`, `detectedTarget`, `effectiveRange`. Config: `components.json` entry + `sensors.json#vehicle_detection` (default forward half-circle FOV, range 300). TDD: 15 new unit tests (`tests/vehicleDetection.test.js`, `tests/vehicleDetectionSample.test.js`) + editor/world smoke (`detect / behind / far = 1 / 0 / 0`).
- **Configuration-propagation component ("replicate")**: a `propagate` component (category `special`) lets one vehicle copy its *whole* config onto nearby robots — modelling the spread of a single seed across a population. Pure core in `src/simulation/logic.js`: `vehicleSignature` (ID-independent, so a rename-only clone is "same config"), `selectPropagationTargets` (nearest-first, in-range, config-differs, capped, deterministic), `cloneVehicleForConversion` (deep clone, renames every component/gate id, rewires references, preserves the Propagator + body color). `WorldSim.step()` runs `stepPropagation()` after the physics update; a converted instance carries its own doc in `inst.vehicleOverride` (pose/momentum untouched), routed through a new `vehicleFor(inst)` used by body-build/wire-map/friction/actuation/draw. Idempotent + converging: a pair whose configs already match never re-fires, so a single seed reaches all-converted and stops; `maxConverted` is an optional shared cap and `cooldownTicks` bounds spread speed. A converted robot flashes green for 700ms and a status pill shows `N/cap converted`; `reset()` clears every override + counter back to the initial mix. Config: `components.json` entry (threshold/cooldownTicks/maxConverted defaults) + editor placement copies the defaults into props and a dedicated inspector row tunes them. TDD: 13 new unit tests (`tests/propagation.test.js`) + `smoke:world` drives it end-to-end (seed among 3 plain → 3/3 converted, each clone carries `propagate`, seed never self-converted, count monotonic + stable after convergence, reset restores the mix).

### Still parked
- Explicit cw/ccw *visual spin* direction per actuator, fully decoupled from force sign. Per-motor polarity now covers most of this; a dedicated render-direction param is a small nicety, not required for Vehicles 1-5.
- Motor-response scripting / decision-table layer: thresholds, dead-bands, and conditional branches ("if light > 0.6 then full speed...") to generalize the `value x weight x polarity x powerCurve` model for Vehicles 6/7. Keep `computeActuation` as the single seam so simple and scripted responses share the same clamping + force pipeline.

## Next Up — Session Handoff (start fresh session, read this + relevant files)

State is committed & pushed to `main`. Features to build next, all in the
live UI layer (`public/app/` + `config/`) following existing patterns. TDD where pure logic
is involved; verify each with the headless smoke probes (see below) and `npm test`.

### 1. Multiple vehicle types (CRUD) — DONE (see Status/Implemented above; `npm run smoke:crud`)
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

### 2. Drag a running robot to reposition it (like lights/rocks/walls) - DONE (see Status/Implemented; e2e in `npm run smoke:crud`, unit in `npm test`)
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
- [x] All done; verified with 3 consecutive full `npm run smoke` passes.
- NOTE (ops): headless Chrome on this machine intermittently STALLS module loading for tens of seconds right after first paint (renderer scheduling quirk, not an app bug - server logs show all resources served immediately). Smoke probes now absorb it: 45x500ms boot wait, `Page.navigate` retry up to 2x when the wait times out (`RENAV:` log line), focus emulation + 1.5s pre-nav settle. Don't "fix" this by shortening waits.

### 3. "Paths:" toggle + per-vehicle body color — DONE (see Status/Implemented; e2e in `npm run smoke:world` + `smoke:crud`, unit in `npm test`)
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

### 4. Logic blocks (combinational gates) wired between sensors and motors — NEXT SESSION
Goal: insert digital logic into the wiring graph so a motor's drive can depend on the *combination*
of several sensor readings, not just a weighted sum ("if A AND B then..."). This is the foundation
for Vehicles 6/7-style conditional behaviour, and it generalises the parked "decision-table" idea.

- New `logic` category in `config/components.json`, one definition per gate: **AND, OR, NAND, NOR,
  XOR, NOT**. (The request also listed "XAND"; that is not a standard gate and appears to duplicate
  AND — confirm the intended set first, defaulting to AND/OR/NAND/NOR/XOR/NOT.) Each gate has one or
  more **inputs** (port kind `logic_in`) and one **output** (kind `logic_out`; NOT is exactly 1 in / 1
  out). Gates are added from the palette and positioned by dragging onto a snap point exactly like
  wheels/sensors — reuse `placeComponent` + the existing pointer-drag / `nearestSnapIndex` logic in
  `public/app/editor.js`, so no new placement mechanism is needed.
- Generalise wiring. Today a wire is `{from:{componentId,port:'out'}, to:{componentId,port:'drive'}}`
  with one feeder allowed per motor. Extend it so a wire's target can be a **gate input** and a gate
  output can feed a motor `drive` or another gate input. Keep `src/models/wiring.js` the single
  validator: a motor may have many feeders (as today); a gate input exactly one feeder; a NOT input
  exactly one. Editor inspector: for a selected gate, bind each input to a sensor / upstream gate
  output (drag-to-connect or a small select); show live in/out values in the on-body readout when
  Values is on.
- **Thresholds — making analog sensors digital (the key enabler).** Per sensor, add an optional
  *digital* toggle + `threshold` (reuse the `props.threshold` already surfaced for light sensors in
  the inspector). When enabled, a sensor presents a boolean to any gate input: HIGH(1) if
  `raw >= threshold` else LOW(0). Analog (non-digital) feeders still reach motors directly as before;
  only gate inputs are coerced to boolean. Keep one seam — a `toDigital(raw, comp)` helper next to
  `applySensorPolarity` / `computeActuation` — so the value->force pipeline stays single-sourced.
- Simulation: new pure module (e.g. `src/simulation/logic.js`). `gateOutput(type, inputs[]) -> 0|1`
  with 2-input truth tables for AND/OR/NAND/NOR/XOR and 1-input for NOT. Evaluation order in
  `world.js step()`: sensors (`evaluateVehicleSensors`) -> gates topologically (inputs resolved before
  outputs) -> `computeActuation` consuming gate outputs as motor feeders. Guard cycles / unresolved
  inputs (treat as LOW) so a mis-wired vehicle never throws inside the rAF loop.
- Tests (TDD, pure logic first): `tests/logic.test.js` truth tables for every gate incl. all-low / all-high
  edges; `toDigital` boundary (`raw == threshold` -> HIGH, just below -> LOW); topological eval of a
  2-gate chain; cycle safety. Integration through the sampler->motor path with a synthetic vehicle.
- Smoke: extend `smoke:editor` — place an AND gate on a snap, wire two light sensors to its inputs and
  its output to a wheel, assert the gate state in the inspector; then assert the car only drives when
  BOTH sensors are HIGH (force deterministic HIGH/LOW with the existing threshold/polarity machinery).

### 5. Configuration-propagation component ("replicate") — DONE (see Status/Implemented above; unit `npm test`, e2e in `npm run smoke:world`)

Decisions made & captured in code + tests:
- **Trigger**: euclidean distance from the **Propagator's own world position** (its `local` offset rotated by the host heading) to the other robot's centre `<= props.threshold` (default 260). Radiates from the part, not the body — a robot that bumps the side of the host carrying it is in range; one on the far side is out. Chosen over the vehicle-detection cone for a cheap "physical spread" model that keeps the target selector a clean pure function.
- **Visual trigger**: a dashed green ring centred on the Propagator, radius = its threshold, drawn both in the editor canvas (while tuning) and in the world beams layer during a run — it IS the conversion boundary, so it's what you tune against. A converted robot also flashes briefly (expanding ring in its new body color).
- **Body-centre attachment**: the editor's snap points now include a centre point (index `snapPointCount`) at `(0,0)`, so a Propagator can be mounted at the core and radiate evenly in every direction. Both placement paths (`placeComponent` + drag-`snapInPlace`) special-case it to exact `(0,0)`.
- **What is copied**: config-only deep clone of the host's *effective* vehicle doc (components, wiring, logic gates, body incl. color) — a true clone, so the recipient inherits `propagate` and spreads onward. Pose/momentum are NOT transferred (cleaner; the robot keeps where it is).
- **Idempotency & convergence**: only a target whose `vehicleSignature` differs from the host's is converted, so a matching pair never re-fires → a single seed converges to all-converted and stops. Hard stops: optional shared `maxConverted` cap + natural "all configs equal" stop; optional `cooldownTicks` (default 0) delays a freshly-converted instance before it may itself spread. Hosts are captured from pre-conversion state so a fresh clone can't re-convert its own source in the same pass.
- **Mechanism**: per-instance doc swap via `inst.vehicleOverride`, NOT a new prototype — no proto churn, individual instances of one type can diverge, pose preserved, `reset()` trivially restores the mix. All per-instance reads route through `vehicleFor(inst)`.
Goal: a vehicle can carry a special component that, once the host comes within a proximity threshold
of *another* robot (e.g. its own vehicle-detection sample crossing a distance threshold), copies the
host's full configuration onto that other vehicle — the target becomes a clone of the source, *including
this same component*. Modelling intent: the spread/takeover of a single seed across a population.

Decide these first (capture in code + tests once chosen):
- **Trigger**: reuse the host's vehicle-detection sample (`detected` / `detectedDistance`) vs. an
  independent proximity threshold. Default: fire when `detectedDistance <= props.threshold`.
- **What is copied**: the whole vehicle doc (components, wiring, body incl. color) — a true clone, so
  the recipient inherits the propagation component and can itself propagate onward. Confirm whether to
  transfer runtime state (pose/momentum) or config-only (config-only is cleaner).
- **Idempotency & convergence**: once a vehicle is converted it must not re-trigger on the same source,
  and it propagates onward like any other. Add a hard stop (`maxConverted` or "stop when all are
  converted") so a single seed converges instead of oscillating; an optional `cooldownTicks` guards
  against churn.
- **Mechanism**: because instances reference prototypes by id, decide whether conversion re-points the
  instance to a new prototype or swaps the vehicle doc in place — document the choice.

Implementation sketch:
- New component `propagate` (category e.g. `special`) in `components.json` with a `threshold` prop.
  In `world.js step()`, after sensors are sampled, for each instance carrying it: find any *other*
  instance within the host's detection radius whose config differs; on fire, replace that instance's
  vehicle doc with a deep clone of the host's (marked converted), respecting the cap. Never convert the
  source from itself.
- Rendering/UX: a converted target briefly flashes; the world inspector shows a converted/total count
  and the current cap. `reset()` restores the initial mix.
- Tests (TDD): pure `selectPropagationTargets(host, others, threshold)` (nearest diff-config, cap
  respected) + `cloneVehicleForConversion` (deep clone, new ids, component preserved). Integration:
  one carrying vehicle among plain ones, step until it converts a neighbour; assert the converted doc
  deep-equals the source and now carries `propagate`; assert the population converges to all-converted
  at the cap with no infinite loop. Smoke (`world.sim.mjs`): seed one carrying vehicle, run, assert the
  conversion count rises monotonically to the cap; reset restores the initial mix.

### Verification harness (headless Chrome/CDP, no server changes)
- Probes drive headless Chrome via raw CDP WebSocket (`--remote-debugging-port`, no puppeteer). Boot wait: 45x500ms for `window.__app`; on timeout it logs BOOT-DIAG (readyState, `<pre>` text, 4xx resources, re-import of main.js) and re-navigates up to 2x to absorb intermittent headless renderer stalls (see NOTE in item 2).
- `npm test` → `tests/*.test.js` (node --test). Add pure-logic tests if any feature has a
  non-trivial function (e.g. "next unused vehicle name").
- `npm run smoke` → `tests/smoke/editor.ui.mjs` + `world.sim.mjs` (spins headless Chrome,
  `window.__app()` exposes `{ state, worldSim }`). Pattern: navigate to index.html, click
  `#tab-world`, drive via DOM (buttons/inputs), assert on `worldSim.instances` / vehicle docs.
- For drag + paths you can assert programmatically: set an instance position via a CDP
  evaluate (simulate mousedown/move/up on `world-canvas`, or call the handler), then check
  `inst.body.position` moved and `inst.path.length` grew over a few stepped frames while playing.
- Leftover-Chrome gotcha: stale headless processes cause "devtools not reachable". Each probe now owns its own port + profile dir (`bv-profile-{editor,world,crud}` on 8901-8903) and pkills only its own before launching; probes also SIGKILL their own chrome/server on exit.

### Current defaults (tuned, do not regress)
- `config/actuators.json`: `defaultMotorPower: 0.1`, `defaultFriction: 0.5`, `powerCurve: linear`.
- `config/sensors.json` light: `detectionThreshold: 0.02`, `fullScaleRatio: 16`.
- On-body readouts (Values toggle) show x/y, per-sensor level→output + distance-to-light,
  per-wheel signed force. Light beam = true sensing radius only (ghost-range fallback removed).
