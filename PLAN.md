PLAN.md
# Braitenberg Vehicles Simulator - Plan

## 1. Overview

A self-hosted, LAN-accessible web simulator for constructing and simulating Braitenberg Vehicles 1-7. The application is a single-page web app with two primary modes: Vehicle Editor and World Simulator.

The design goal is intuitive construction via snap-able components, explicit sensor-to-actuator wiring with polarity and weight, and a realistic 2D physics world with light and distance sensing.

The system is client-side only with manual JSON import/export for sharing. No server-side state is required.

> **Superseded in part:** single-player remains client-side exactly as written, but the
> M0–M6 co-op program (see the Multi-User section below) added an optional authoritative
> server world + gateway. Everything else in this section still holds.

## 2. Scope

### In Scope
* Vehicle construction from a rectangular start shape with attachable components via snap points
* Component library: body shapes, powered wheels, passive wheels/casters, light sensor, distance/proximity sensor, generic sensor mount
* Visual wiring editor with drag-and-drop arcing lines, excitatory/inhibitory polarity, and weight/scaling per connection
* Wiring remains editable after vehicle creation
* World simulation with full 2D physics, primitive obstacles and light sources
* Realistic sensors: inverse-square light falloff, raycast distance/proximity with toggleable beam visualization
* World elements editable in World view: position, rotation, scale, and emitter properties —
  light intensity and, from M9, a heat source's temperature *(and, as of M8,
  a light's solidity + collision radius)*
* World and vehicle save/load as JSON
* Vehicle instances list with prototype editing propagation. Instance count controlled via slider/integer
* Responsive world view that expands to browser window

### Out of Scope
* ~~Multi-user collaboration, authentication, or global library~~ — multi-user collaboration
  (a LAN co-op gateway, no auth) was later added as the M0–M6 program; accounts/global
  library remain out of scope
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
  *(shipped in part as of M8: the solid-light defaults + bounds. Worlds themselves
  remain sample JSON documents under `public/worlds/`, not a config. Treated as
  OPTIONAL by all three loaders, with built-in fallbacks in `src/models/solidBody.js`,
  so a checkout whose `public/config/` predates the file still boots)*
* `config/ui.json` - UI layout, tab defaults, snap point density

Config files are loaded at startup *(hot-reload was planned but never implemented; a reload
of the page re-reads them)*.

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

* ~~Static files served from `dist/`. No server code required.~~ — the site lives in
  `public/` (not `dist/`), and `scripts/serve.mjs` is required server code for co-op
  (one port serves the SPA + `/info` + the gateway). Static-only hosting still works for
  single-player (copy `public/` to any web root, per the README).
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
- **Combinational logic gates** (AND/OR/NAND/NOR/XOR/NOT, commit b7acf3e): floating `logicGates[]` nodes in `category: "logic"` in `config/components.json`, placed from `#gate-palette` (free click-placement — deliberately NOT snap-point parts), wired through the normal `vehicle.wires` graph via per-gate In/Out connection slots in the inspector. `src/simulation/logic.js` evaluates them topologically with a cycle guard (`gateOutput` truth tables, `evaluateLogicGates`); a per-sensor `digital` toggle + `threshold` (`toDigital`) coerces analog readings to 0/1 for gate inputs while analog feeders still reach motors unchanged. Unit-tested (`tests/logic.test.js`, `tests/logicWiring.test.js`); placement/arity/wiring covered by `npm run smoke:editor`.
- **Neuron (§4) + multi-output taps (§4.2):** interactive response editor in the inspector — shape selector (bell / triangle / custom), peak-intensity slider, bell-width (sigma) slider, and a draggable custom-spline editor (add/remove nodes; point-drag writes `props.spline`). Every output component now exposes an **"Add Output"** button that grows per-instance taps (`out`, `out1`, …); input connection slots enumerate each source's taps, so one sensor can drive several parts from its own side. Model: `src/simulation/transfer.js` (pre-existing) + dynamic-output ports in `src/models/wiring.js` (`outputPorts` / `outputPortIds`). Verified by unit tests (`tests/transfer.test.js`, `tests/logicWiring.test.js`) and headless UI smoke `tests/smoke/neurons.outputs.mjs` (`npm run smoke:neurons`).
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

*(Banner is stale-by-design — re-verify with `git status`) state was committed & pushed to
`main` at the start of the M7 review-fix session (2026-08-27), and items 1–5 below are ALL
done — the features to build next are in the README "Next" list. What follows is the original
session handoff, kept as the historical design record for items 1–5.)*

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

### 4. Logic blocks (combinational gates) wired between sensors and motors — DONE

> **As-built (commit b7acf3e; see the README "Done" list):** gates **AND/OR/NAND/NOR/XOR/NOT**
> (no XAND — it is not a standard gate and duplicates AND) live in `config/components.json`
> (category `logic`) and are evaluated topologically with a cycle guard in
> `src/simulation/logic.js` (`gateOutput` truth tables, `evaluateLogicGates`, `toDigital`).
> They were deliberately made **floating nodes** (`vehicle.logicGates[]`, free click-placement
> from `#gate-palette`) rather than snap-point parts — gates are not physical hardware. The
> per-sensor `digital` toggle + `threshold` coerce analog readings to 0/1 for gate inputs.
> Unit-tested (`tests/logic.test.js`, `tests/logicWiring.test.js`); UI + arity covered by
> `npm run smoke:editor`. The original design text below is kept for history.

Goal: insert digital logic into the wiring graph so a motor's drive can depend on the *combination*
of several sensor readings, not just a weighted sum ("if A AND B then..."). This is the foundation
for Vehicles 6/7-style conditional behaviour, and it generalises the parked "decision-table" idea.

- New `logic` category in `config/components.json`, one definition per gate: **AND, OR, NAND, NOR,
  XOR, NOT**. (The request also listed "XAND"; that is not a standard gate and appears to duplicate
  AND — RESOLVED in the implementation: no XAND, the six standard gates shipped.) Each gate has one
  or more **inputs** (port kind `logic_in`) and one **output** (kind `logic_out`; NOT is exactly 1 in / 1
  out). *(The plan was to place gates on snap points like wheels/sensors; the implementation
  instead made them floating nodes — see the As-built note above.)*
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
- Leftover-Chrome gotcha: stale headless processes cause "devtools not reachable". Each probe owns its own web port (8901–8905, 8907, 8915, 8925 — no sharing), CDP port (922x–924x) and profile dir (`/tmp/bv-profile*`), and pkills only its own before launching; probes also SIGKILL their own chrome/server on exit. (This note predates the port unification — the probe list above is the current one.)

### Current defaults (tuned, do not regress)
- `config/actuators.json`: `defaultMotorPower: 0.1`, `defaultFriction: 0.5`, `powerCurve: linear`.
- `config/sensors.json` light: `detectionThreshold: 0.02`, `fullScaleRatio: 16`.
- On-body readouts (Values toggle) show x/y, per-sensor level→output + distance-to-light,
  per-wheel signed force. Light beam = true sensing radius only (ghost-range fallback removed).

## Multi-User / Co-op (implemented — current model is M5)

### Goal & confirmed decisions
Many participants share **one world** and watch their own bot(s) interact with everyone
else's, in real time. Confirmed choices (avoid school-specific terms in code/UI — use
generic *session* / *participant*):
- **Identity:** display name + auto token per participant. No accounts/passwords.
- **Sessions:** one world per admin-run session (a short session id/code). Admin runs the
  server; participants join by session id + a name.
- **Deploy model (not live-edit):** the *last deployed* config keeps running while a
  participant edits in their local lab. Editing never affects the running bot until they
  press **Deploy**, which pushes the new doc to the shared world (all of that participant's
  clones update, preserving each clone's current pose/momentum).
- **Physics:** bots still collide/bump — the shared world runs the same matter-js engine the
  single-player world already uses, so behavior is preserved.
- **Scale/transport:** LAN, ≤ ~20 concurrent participants. WebSocket is the transport.
- **Clones:** the **admin** decides how many clones each participant's bot has in the world
  (not the client).

### Core architecture: server-authoritative world + thin clients
The single biggest decision: **the server runs one authoritative simulation; clients are
renderers.** Participants do *not* each run their own world (that desyncs — 20 people would
see 20 different realities). Instead the server steps everyone's bots together and broadcasts
positions/sensor readings at ~10–20 Hz.
- Guarantees every participant sees the *same* world and the same interactions, with no client
  reconciliation or deterministic lockstep needed.
- Cheap at class scale: ~30 bots × (x,y,angle) at 15 Hz is a few KB/s. The sim itself is
  O(bots × components)/tick — trivial for <40 bodies in matter-js.
- **Why the build risk is low here:** the sim is already pure and Node-runnable (`src/**` unit-
  tested with `node --test`; matter-js runs headless; `public/src` is a symlink to `src`, so
  browser + server share the same modules). We *extract* the loop, not rewrite it.

### Ownership = why your "can't modify/move others" rule is nearly free
- **Every bot has exactly one owner** (`ownerId`). There is no two-people-editing-one-object
  case to resolve — the hardest part of multiplayer is absent.
- Bots are self-propelled (sim-driven); there is no "drag someone else's bot" affordance, so
  "can't move others" holds by construction. In the editor, non-owned bots are read-only/locked;
  the server additionally **drops any mutation not from the owner** as a backstop.
- The existing building experience (component/wire editing, gates, Neurons + response/spline
  editor, multi-output, orientation) is **untouched** — we wrap it with a sync layer, not replace
  it. Two mental spaces per participant: **my lab** (full local edit control over my bot) and
  **the shared world** (read-only view of everyone's deployed bots, live).

### Data model additions
- Server `session = { id, started, bots: [ {protoId, ownerId, name, vehicle, count, deployedAt} ] }`.
  - `vehicle` = the full bot doc currently running (what was last **deployed**).
  - `count` = number of live clones in the world (admin-set).
- Server holds a `HeadlessWorld` (the extracted sim) per session; each deployed bot → N
  instances with stable `seed` poses. `Deploy` updates `vehicle` + rebuilds those N bodies in
  place (pose/velocity preserved). `setCount` adds/removes clones around the last deploy pose.
- Participant identity: `{ id, name, token, role: 'participant' | 'admin' }` in `session.users`.

### Wire protocol (implemented — JSON over WebSocket; see `src/net/gateway.js` + `src/session.js`)

> **Note:** the file named below was `src/net/server.js` in the M0–M4 era and was deleted
> (commit 00cf59a) when M5 replaced it with the many-world gateway. The first message is the
> gateway **host/join** handshake (`{type:'host',name}` → new world + code; `{type:'join',
> name,code}` → participant; roles are explicit — `Session.join` throws without one), not the
> `{type:'join', name, role?}` / "first joiner becomes admin" shape that follows. The
> non-handshake commands below (deploy/setCount/controls/element ops) survive unchanged into
> the M5 protocol.

- **C→S** (first message must be the join handshake)
  - `{type:'join', name, role?}` → S replies `{type:'welcome', running, you:{name,role,protoId,token}, world:{elements,bots}}` *(superseded by the host/join handshake above)*.
  - `{type:'deploy', vehicle}` — owner only (always the sender's own proto); acks `{type:'deployed', protoId, count}`, broadcasts `{type:'peerDeployed', protoId, name}`.
  - `{type:'setCount', protoId?, count}` — admin only, numeric count required (NaN/missing is refused, never read as 0) → broadcasts `{type:'countSet', protoId, count}`.
  - `{type:'controls', command:'start'|'pause'|'reset'}` — admin only → broadcasts `{type:'state', running}`.
  - `{type:'addElement'|'moveElement'|'updateElement'|'removeElement'|'setElements'}` — admin only (shared-element edits) → each success broadcasts the full `{type:'elements', elements}` list.
- **S→C**
  - `{type:'snapshot', t, bots:[{id,protoId,owner,x,y,angle,vx,vy}]}` at ~15 Hz to everyone (bots rounded on the wire).
  - Errors (`{type:'error', error}`) are echoed to the offending actor only.
- **Enforcement:** deploy is owner-only by construction (no protoId in the message — a participant can only push their own bot); `setCount`/controls require `role==='admin'`. Rejections are sent back as `{type:'error'}`. The first joiner (no role given) becomes the admin who runs the session.

> **Superseded by M5.** The M0–M4 plan below describes the first co-op build: one session per
> process (`npm run serve:coop`), “first joiner becomes admin”, and a standalone Co-op tab with a
> read-only shared-world view. It shipped, but the **co-op UX was replaced by M5** (see the end of
> this section): one always-on
> gateway hosting many 6-char-coded worlds, the Co-op controls in the World sidebar, and the World
> canvas *is* the shared world. Where the two conflict, M5 wins — notably “host = per-world admin”
> replaces “first joiner is admin”, and deploy + element sync replace the read-only view.
>
> **Residue retired:** the transport-agnostic core (`src/session.js` + `HeadlessWorld`) remains —
> the gateway drives it. The single-world transport (`src/net/server.js`, `scripts/serve-session.mjs`,
> `npm run serve:coop:single`) and the implicit role fallback are **removed**; roles are explicit
> (host → admin). M1’s session unit tests moved to `tests/session.test.js`; `multiplayer.client.test.js`
> now runs `CoopClient` against the gateway.

### Phases (each shippable + tested on its own)
- **M0 — Headless shared world sim.** Extract the per-step loop from `world.js` into
  `src/simulation/worldSim.js` (`HeadlessWorld`), runnable in Node with matter-js headless.
  API: `addInstance`, `setCount(protoId,n,spawnAt)`, `deploy(protoId,vehicle)`, `reset()`,
  `step(dtMs)`, `snapshot()`. Port friction + matter step + propagation + sensor→logic→actuation
  faithfully. **Unit test:** two bots move, they collide/bump (positions react), snapshot is
  JSON-serializable & stable, `deploy` updates a bot preserving pose, `setCount` adds/removes.
- **M1 — WebSocket server + sessions. ✅ DONE.** Transport-agnostic `src/session.js`
  (`Session`: participants, ownership, admin-only controls, snapshotting — unit-testable with no
  sockets) wired to a thin `src/net/server.js` (ws handshake + 60Hz fixed-dt step + 15Hz snapshot
  broadcast). Run one session: `npm run serve:coop [world.json]`. Tested headless: 6 socket-free
  unit tests + a 2-participant real-WebSocket e2e (`tests/multiplayer.server.test.js`).
- **M2 — Client: Join screen + shared-world view.** A "Join session" panel (session id/code +
  name) → connect, then render the shared world **read-only** by reusing `worldDraw.js` over
  the broadcast snapshot. The existing editor/lab stays local and fully intact alongside it.
- **M3 — Deploy bridge + ownership locks.** Editor **Deploy** button sends the current bot doc to
  the server (updates that participant's clones, pose preserved). Client locks/hides edit controls
  on non-owned bots; server backstop enforces owner-only. Admin panel: per-bot clone counts,
  start/pause/reset the session.
- **M4 — Polish (optional):** rejoin keeps your deployed bots; per-participant metrics/spectate;
  chat; a teacher/observer dashboard; save/load a session to file.

### M0 status
- [x] `src/simulation/worldSim.js` — `HeadlessWorld` extracted from `world.js` (matter-js
  headless; friction + step + propagation + sensor→logic→actuation ported faithfully).
- [x] `tests/multiplayer.sim.test.js` — proves motion, collision, serializable snapshot,
  deploy-with-pose-preserve, and admin `setCount`.

### M1 status
- [x] `src/session.js` — `Session`: join (first = admin), owner-only deploy, admin-only
  setCount/controls, leave, welcome; bots rounded on the wire; permission rejections echoed to the actor.
- [x] `src/net/server.js` — `createVehicleServer({Matter, configs, worldDoc, port, host})`: ws join
  handshake, socket→token routing, 60Hz fixed-dt step + 15Hz broadcast, clean `start()`/`close()`.
- [x] `scripts/serve-session.mjs` + `npm run serve:coop` — runs a session (loads the app's config;
  `COOP_PORT`, `COOP_HOST=0.0.0.0` to open to the LAN).
- [x] `tests/multiplayer.server.test.js` — 6 unit + 1 e2e (two participants over WS: join, deploy,
  both receive live snapshots, admin-only controls enforced over the wire).

### M2 status — client join view
- [x] `src/net/client.js` — `CoopClient`: the thin socket core. Reuses Node's built-in /
  browser `WebSocket`, so one implementation runs in the page and under `node --test`. Methods:
  `connect(url,name)` (resolves on `welcome`), `deploy`, `setCount`, `controls`, plus live
  `bots`/`tick`/`running` state for the view. **Bug fixed here:** `setCount` was sending `{protoId,
  n}` while the server reads `msg.count` → `Number(undefined)` = NaN → `||0` silently *wiped* the
  fleet to zero; now sends `count` (matches the documented wire field).
- [x] `public/app/coop.js` — `CoopWorld`: the read-only shared-world view. Reuses
  `worldElementsToSnapshot` for static elements and worldDraw's visual conventions; renders on
  snapshot arrival (~15Hz) rather than a hot rAF loop (snapshots replace bot state wholesale, so
  redrawing at message rate is correct *and* cheaper); a single coalesced rAF handles local
  pan/zoom. Join bar (name + server URL, both persisted) and a "Deploy current design" button that
  ships the editor's live vehicle (a minimal preview of the full M3 bridge; server enforces owner).
- [x] `public/index.html` + `public/app/main.js` — new **Co-op** tab (`panel-coop`) wired into
  `activate()` (generalized to N tabs while preserving the exact editor/world chrome the smoke tests
  assert) and lazily built in `initCoop()`.
- [x] `tests/multiplayer.client.test.js` — e2e over real sockets against a running server:
  join→`welcome` (identity + static elements), deploy→owned bot appears, live stream (advancing
  tick + both participants observe the *same* world), admin-only `setCount` refused for a participant,
  and admin `setCount(3)` expands the fleet in every view. Full unit suite **230/230** and all four
  browser smoke tests green (SPA boots with the new tab).
### M3 status — deploy bridge + ownership locks
- [x] **Deploy bridge** — `public/app/main.js` passes `getVehicle: () => state.vehicle` into
  `CoopWorld`, so the Co-op tab's "Deploy current design" pushes the editor's live vehicle into
  *your* slot (the server enforces owner-only by construction — a deploy message carries no protoId).
- [x] **Admin panel** — `public/index.html` adds a "Session · admin" block (Start / Pause / Reset +
  fleet size); `public/app/coop.js` wires them. Fleet control resizes the acting user's own
  prototype; selecting *other* participants' fleets is an M4 enhancement.
- [x] **Ownership locks** — `CoopWorld.refreshControls()` gates every session control on
  `you.role === 'admin'`: participants see them disabled with a "read-only — only the admin runs
  the session" note (Start/Pause additionally track the live running flag). The server is the real
  backstop; this is the client reflection of it.
- [x] **Live running state** — `src/net/client.js` now tracks `running` from authoritative `state`
  messages (start/pause/reset echo one), so Start/Pause enable/disable against the true sim state.
- [x] **Bug fixed:** `src/simulation/worldSim.js` `reset()` called bare `M.Body.setVelocity` where
  `M` was undefined → a `ReferenceError` that escaped the WS handler and *crashed the server* on any
  admin reset. Now `this.M.Body.…`. Exposed by M3's admin Reset.
- [x] `tests/multiplayer.client.test.js` adds an M3 e2e: two participants each deploy their own
  design (ownership isolated — one distinct owner per bot, cross-deploy can't touch another's
  fleet), then admin start→real motion→pause→**reset restores every bot to its spawn with zero
  velocity**. Full unit suite **231/231**, no hangs; all four browser smoke tests green.
### M5 — revised co-op UX (pivot; supersedes the Co-op tab)
The separate "Co-op tab that clears the screen" + "first-joiner-is-admin" model is clunky and left
no way back to editing. Revised model: **one always-on gateway** hosting many **6-char coded
worlds**; the CO-OP controls move into the **World tab's left pane** (under ELEMENTS/VEHICLES); the
**World canvas IS the shared world** (host edits run like single-player and sync out). Roles:
**host** (full control of that world) vs **joiners** (deploy their own vehicles; leaving prunes them).

- [x] **Phase 1 — gateway + code worlds.** `src/net/gateway.js` hosts a `Map<code, Session>`; first
  message `{type:'host'}` creates a world (returns its code; that client becomes its admin) or
  `{type:'join',code}` enters one (participant); every join/leave fans out
  `{type:'roster',clients}`; a leaving socket prunes its bots and an emptied world is GC'd. One
  step+broadcast loop iterates all worlds. `src/session.js` welcome now carries the world `code`.
  `scripts/serve-coop-gateway.mjs` = one-command launcher (`/health`, LAN hint). **Bug fixed:**
  removed a duplicate `serve:coop` key in `package.json`; it now runs the gateway. `tests/multiplayer.gateway.test.js` e2e over real sockets:
  host→code, join by code, wrong-code refused, roster on both, per-host world isolation, prune+GC.
  Full unit suite **232/232**, no hangs.
- [x] **Phase 2 — CO-OP pane in the World sidebar.** `#world-side` gains a Co-op section under
  Vehicles: **Host** → `{type:'host'}` reveals the 6-char code big and tracks the live client count
  (roster) next to the gateway address; **Join** + code box (Enter works, auto-uppercased) →
  `{type:'join',code}`; while connected the row swaps for a single **Disconnect** that closes the
  socket (server prunes this client's bots). Gateway address + display name persist in localStorage.
  The standalone Co-op tab, `panel-coop`, its top-bar chrome, and `public/app/coop.js` are removed;
  `main.js` is back to two tabs and exposes `__app().coopPanel`. **Client:** `CoopClient.connect(url,
  name, {mode:'host'|'join', code})` drives the gateway handshake — host/join are the ONLY accepted
  modes now (`connect` throws otherwise; the legacy single-world join it "still worked" with was
  removed with the single-world transport) — keeps `code`/`clients`, and now REJECTS on a pre-welcome
  server error or close — so a dead join code surfaces in the status line instead of hanging. **Bug fixed:** the gateway left refused
  handshakes (unknown code, bad first message) as unbound open sockets whose next frame would crash
  on `state.code`; it now sends the error and hangs up, and the post-handshake path guards `!state`.
  `tests/multiplayer.gateway.test.js` adds refusal-hang-up + a `CoopClient` host/join e2e;
  `tests/smoke/coop.panel.mjs` is a real-browser probe (SPA ↔ in-process gateway over CDP): host →
  code + layout swap + client count, disconnect → layout back + server prune/GC, dead join refused
  in the status line. It caught two UI-only bugs: Disconnect left disabled on the success path, and
  a reused headless-Chrome profile serving stale JS from its HTTP cache (fresh profile per run now).
- [x] **Phase 3 — bind host's world to the shared world.** The World canvas IS the shared world:
  `WorldSim` gained two hooks — `onElementChange({op:'add'|'move',…})` (fired by the +Light/+Rock/
  +Wall buttons and at the end of an element drag) and `remoteBots()` (drawn on top of the local
  render each frame, world-space, one hue per participant, own bots highlighted). main.js wires
  them to the panel client **only when connected as admin**: adds/moves go out as
  `{type:'addElement'|'moveElement'}`; participants instead mirror — an `elements` message replaces
  their local static elements + rebuilds obstacle bodies, and the element-add buttons are disabled
  for them (re-enabled on disconnect). **Server:** Session gained admin-only `addElement` /
  `moveElement` / `removeElement` (each sends its ack AND broadcasts the full `{type:'elements',…}`
  list; welcome already carries it for fresh joiners). **Bug fixed:** those handlers returned
  success replies that `handle()` never transmits (it only echoes errors) — now `_sendTo`d like
  `_deploy`; and `addElement` validated position with truthiness, which rejected a light dropped at
  the canvas centre `{x:0,y:0}` — now `Number.isFinite`. **UI:** the panel gains **Deploy design**
  (everyone; owner-only on the server) and host-only **▶/⏸/↺** session controls (Start/Pause track
  the authoritative `state.running` echo), so the shared sim can actually be run.
- [x] **Phase 4 — host list management.** `#remote-fleet` under Vehicles lists every participant's
  prototype with its live bot count (roster × snapshot bots); the host gets **− / + / ✕** per row
  mapping to `setCount(protoId, n±1 | 0)` — add/remove, never edit; participants see a read-only
  roster. Server enforces admin-only as before. **Panel bug fixed:** the 15Hz `snapshot` stream was
  re-running `renderStatus()` and clobbering event messages like “deployed…” in the status line —
  the count now refreshes on `roster` only, snapshots redraw just the fleet.
  `tests/multiplayer.gateway.test.js` covers add/move/remove mirroring, participant refusal, ack
  ids, and post-remove welcome state; `tests/smoke/coop.panel.mjs` (now p2–p4) drives the real SPA:
  host → deploy → fleet ±/✕ → light added from the World toolbar and moved through the hook, and a
  Node-side observer's welcome must contain the light at its MOVED position plus the host's bot.
  It caught three more: `#remote-fleet` missing from index.html (CoopPanel now fails fast naming
  the missing element), the smoke's own click-every-poll tick racing the settled “deployed…”
  status, and the truthiness-zero addElement refusal above. Full unit suite **232/232**, all
  browser smokes green.

### M5 — bug-fix pass (found via a two-browser reproduction)
- [x] **Edit-my-design + deploy.** Every participant gets a first-class co-op design: the panel's
  **✎ Edit my design** opens the editor on *their* design (edits land in `state.coopVehicle`, not a
  local prototype), and **Deploy design** ships exactly that doc — `world.deploy` rebuilds the
  clones in place, so the shared world's vehicle updates for everyone. Hosts and joiners use the
  same flow.
- [x] **Fleet management works.** Root causes: (1) the count was read from the button's rendered
  `data-count`, so a fast click acted on a stale count (a plus right after a deploy resent the old
  size — looked broken); the handler now counts from live snapshot state. (2) growing a never-
  deployed proto minted **ghost instances** (null vehicle) silently — now refused with `"<name> has
  not deployed a design yet"`, surfaced in the status line. The −/+/✕ buttons were also 11px with
  no padding and read as inert; they're real buttons now.
- [x] **Element mirroring.** Root cause: the host's pre-loaded world never crossed the wire —
  joiners only saw elements added AFTER joining. Now (a) the host seeds the whole local element
  list onto the shared world at host-time (new admin-only `setElements`), and (b) joiners mirror
  immediately on welcome, not only on later change events.
- [x] **Host leaves → everyone sent home.** A world left without its admin lingered dead. Gateway:
  when the leaver is the admin, broadcast `{type:'worldClosed', reason:'host left'}`, terminate the
  remaining sockets, and reclaim the world. Clients return to the Host/Join layout with a "the host
  left — <code> was closed" status, and participants get their **home world restored** (pre-join
  elements were backed up on join).
- [x] *(rows hidden while connected)* was already implemented in phase 2; re-verified on both pages.
  **New permanent regression test:** `tests/smoke/coop.session.mjs` drives TWO real browser pages
  (host + joiner) through the entire bug list: edit+deploy own design → server vehicle changed ·
  fleet −/+/✕ on others' rows with live counts · elements mirror on join AND live · host/join row
  hidden while connected · host leave → kick home + world reclaimed.

  **Bugs the fix work caught:** the stale-count race above; a shrunken-to-zero fleet mislabeled
  "no design deployed yet" (now factual `0 bots`); the panel smoke's observer had to match seeded
  elements by id, not type. Unit suite **234/234**, all browser smokes green across three
  consecutive runs.

- [x] **The shared world actually runs ("deployed bots ignore the world elements").** Root cause: two
  disconnected simulations — Play/Pause/Reset toggled only the LOCAL single-player mirror and nothing ever
  sent `controls` to the server session, so deployed vehicles never stepped (no light sensing, walls passed
  straight through them); snapshots also carried no sensor data, so beams/values/paths could never render for
  shared bots. Fix: (a) while connected, Play/Pause/Reset forward to the session and the button follows the
  authoritative `state {running}`; the canvas IS the shared world — local stepping + home-instance rendering
  stop (`WorldSim.setCoop`, early-out in `drawWorld`). (b) snapshots now carry per-bot `samples` (world-space
  samplePoint/direction, level, effectiveRange, fov, detected) + `motors` (signed forces) + component
  ids/ranges; `normalizeBot` passes them through; the client overlay draws shared-bot beams/readouts exactly
  like local instances and accrues paths client-side per snapshot tick (cleared on `state {reset}`). Covered
  e2e (`coop.session.mjs` BUG9: Play via the UI starts the shared session; one server step proves a bot ON a
  light reads full scale with firing motors — and that data rides the wire to the client; the bot moves while
  running, Pause stops the session, Reset reseats + clears trails) and by unit tests (snapshot samples/motors
  ride the wire; reset marker on the state echo). A wall-pinning e2e design was tried first but is unstable at
  the test's `thrustScale=2` (~300 px/tick tunnels any matter-js discrete collision), hence the step-level
  assertions. The smoke itself gained per-eval CDP timeouts, step milestones, and a watchdog so a wedged
  headless page fails loudly instead of hanging the probe forever.

- [x] **Client co-op world rendering: locked elements, live element drags, ticking bot popup.** Three
  polish bugs in the shared-world canvas. (a) *Locked world:* a participant's mousedown still grabbed
  world elements and dragged them on a frozen mirror (`bindCanvas` had no role gate on the element
  branch — only bots were host-gated). Now a participant may SELECT an element for its popup but not
  drag it (no grab, no pan); the element inspector renders **read-only** for non-hosts in co-op mode
  (inputs `disabled`, Delete hidden, "(read-only)" title — same contract as the shared-bot popup), and
  the local-instance grab is skipped entirely while connected so a frozen ghost can't be picked up.
  (b) *No warp on element drags:* the host only sent `moveElement` on mouseup, so participants saw the
  element teleport to its drop spot. Element drags now stream the move while dragging (~30 Hz throttle,
  identical to bot drags; final rounded send still on mouseup), and the participant's `elements` mirror
  re-renders its open read-only popup per message so selected elements track live too. (c) *Bot popup
  ticks while dragging:* clicking a shared bot showed X/Y/Rot once, then froze while the drag went on
  (element drags re-render the inspector every mousemove; bot drags didn't). New `WorldSim
  ._refreshRemoteBotPopup()` updates the popup values in place — no innerHTML rebuild, so a focused
  input is never clobbered — reading the optimistic `_dragBot` pose while dragging and the latest server
  snapshot otherwise; it runs on every bot-drag mousemove AND per received snapshot (`onCoopSnapshot`,
  ~15 Hz), so a selected bot keeps ticking while the session runs. The popup also shows the optimistic
  drag pose immediately (was: stale snapshot position mid-drag). Covered e2e in `coop.session.mjs`
  BUG10a/10b/10c: joiner drag moves nothing (local, host, or server) + read-only popup asserted; host
  element drag verified on the joiner's mirror **mid-drag with the button still down** (pre-fix this
  was empty), then host/joiner within 3px after release; host bot popup `wi-ix` follows the cursor live
  through a drag. Unit suite **246/246**; all 7 browser smokes green (+ `coop.session.mjs`).

- [x] **World sidebar UI polish (M5).** Small layout/affordance fixes in the World left column:
  Sandbox / Co-Op tabs now split the column evenly — the root cause was a **pre-existing broken CSS
  comment** (`-->` instead of `*/`) in `style.css` that silently swallowed the `.side-tabs{display:flex}`
  rule, so the tab bar fell back to block layout and sized to its labels. Closing it restores equal
  `flex:1` tabs (also added `width:100%` + `min-width:0` since `.side` shrink-to-fits). "Designed by
  Adam Kemp, 2026" footer is centred (`.pane-footer{text-align:center}`). Top-bar Load/Download buttons
  drop the ⤓/⤒ text glyphs for inline **Lucide** icons (ISC, no runtime dep): `upload` = load a file in,
  `download` = save one out (vehicle + world pairs). Co-op pane: Gateway/Name fields get consistent 8px
  spacing and full-width inputs; **Host** moves to its own row above the Join row (code field still takes
  the remaining width); both stay inside `#coop-gw-row` so they hide together on connect (the new flex
  rule needed a higher-specificity `[hidden]` override). "Edit my design" + "Deploy design" now sit
  **above** the Co-Op section, always visible, and split the column width; **Deploy stays `disabled`
  until a world is actually joined/hosted** (`coopPanel.setConnectedLayout`/welcome flip `disabled`, not
  `hidden`). Covered in `world.tabs.mjs` (design buttons visible pre-connect + Deploy greyed + enabled
  on connect; Host above Join). Unit **246/246**; all 7 browser smokes green.

## M6 — one server, one port (merged gateway + LAN hosting)

The ops story used to be two commands (`npm run serve` for the files, `npm run serve:coop` for the
shared world) and, for a joiner, two secrets: the host's IP **and** a second port. Both are gone.
**`npm run serve` now serves the SPA *and* hosts the co-op gateway on the same port**, and a joiner
needs only the world code — or nothing at all if they open the invite link.

### Why one port is the right shape, not just fewer terminals
`ws` attaches to an existing `http.Server` and consumes only the `upgrade` event, so the static
`request` handler is untouched. The consequence is what matters: **page reachable ⇒ gateway
reachable**. Previously a host could serve files on 8080, not start the gateway (or leave 8090
blocked by the OS firewall), and participants saw a spinner with no explanation. One address, one
firewall rule, one thing that can be down.

### Confirmed decisions
- **No gateway field.** The page's own origin *is* the gateway. The `Gateway` input is removed;
  **Advanced → Host address** remains for the rare case of joining a world whose page you didn't
  load (empty = origin; accepts `ip`, `ip:port`, `*.local`, `ws(s)://`, or a whole invite URL, and
  an invite URL's `#join=` code is picked up from the field too).
- **LAN-open by default**, because hosting is the whole point. `HOST=127.0.0.1` locks it down;
  `NO_COOP=1` serves files only. No auth — a LAN/classroom tool, not an internet service.
- **Auto-join from the invite link** (`#join=CODE`): remembered name else `Bot-NN`, with the World
  view brought up first so you don't join a world you can't see. The hash survives a successful join
  (a refresh rejoins) and is cleared by Disconnect and by a failed auto-join — *leave means leave*,
  and a dead link can't retry itself on every refresh.

### What was built
- `src/net/invite.js` **(new, pure — no Node, no DOM, `ws`-free so the browser can import it)**:
  `parseHostInput`, `buildWsUrl`, `buildInvite`, `joinCodeFromHash`, `normalizeCode`,
  `pickLanInterfaces`, `buildServerInfo`.
- `scripts/serve.mjs`: static handler + `GET /info` + the attached gateway on one port;
  `PORT`/`HOST`/`NO_COOP`; startup banner prints the local URL plus one line **per LAN interface**,
  and the macOS "allow incoming connections" note (Deny = participants load nothing).
- `src/net/gateway.js`: `{ server }` injection (attach; don't `listen`; never close a server you were
  merely handed), a dialable URL from `start()` on a wildcard bind, and a per-world `try/catch` sweep
  around step + snapshot (`onStepError`) — a world that throws is logged once per distinct error and
  skipped, because an uncaught exception would now take the file server down with it.
- `GET /info` exists because a browser cannot ask for its own LAN IP: `{host, lan[], hostnames[],
  port, secure, wsUrl, coop, worlds}`. `pickLanInterfaces()` ranks `en0`/`eth0`/`wlan0` first and
  drops `utun*`, `awdl*`, `llw*`, `bridge*`, `vmnet`/`docker`/`veth`, hotspot `ap*`, loopback and
  `169.254.*` — "first IPv4" on a laptop with VPN up advertises an address nobody can join (this
  machine has 6 utun tunnels).
- `public/index.html` + `style.css`: `<details id="coop-advanced">` with a live `→ ws://host:port`
  validation hint and the override echoed in the collapsed summary (so a non-default target is
  visible without opening it); `#coop-invite` + `Copy`; `#coop-invite-alt` "other networks" chips.
- `public/app/coopPanel.js`: `_autoAddress` / `_resolveTarget` / `_syncAddressHint` /
  `_syncAdvancedTag`, override-**only** persistence (legacy `bv.coop.url` is migrated, and its old
  `ws://127.0.0.1:8090` default is *dropped* — migrated, it would silently shadow the automatic
  address forever), `_fetchInfo` + `_publishInvite`/`_showInvite` (a host never publishes
  `localhost`; the address comes from `/info`, and a joiner's link points at the gateway they
  actually reached so forwarding works), `copyInvite` (clipboard API → `execCommand` → select + ⌘C,
  because plain http is not a secure context), `autoJoinFromLink`, `_clearJoinHash`, `_failAutoJoin`.
- `public/app/main.js`: new element map, `onDeepLink`, and a boot-time `coopPanel.autoJoinFromLink()`.

### Bugs this pass caught
- `originParts()` destructured `{host, port}` **with array syntax** → every origin lookup returned
  null, so the automatic address silently never worked.
- `familyIs()` uppercased only one side (`String('IPv4').toUpperCase() === 'IPv4'` is false) → every
  interface filtered out; `/info` would have advertised `127.0.0.1` on every machine.
- Family is `4`/`6` on older Node and `'IPv4'`/`'IPv6'` on newer → `familyOf()` now takes either and
  falls back to inspecting the address.
- A *probe* bug that cost real debugging time: `!getComputedStyle(el).display === "none"` parses as
  `(!display) === "none"`, i.e. always false — unary `!` binds tighter than `===`. The merged probe
  timed out on a perfectly correct invite until the poll's failure path started printing the panel's
  live state (worth keeping: it names the broken step instead of saying "timeout").
- Pre-existing flake, now fixed: `neurons.outputs.mjs` shared web port **8903** with
  `proto.crud.mjs`, reused a stale Chrome profile, and still used the old 18-second boot loop with no
  retry. It now owns port 8904, deletes its profile, and boots with 45×500ms + re-navigation ×2 plus
  a `readyState`/`<pre>`/`__app` diagnostic on failure. (Orphan hazard worth remembering: probes
  spawn `sh -c python3 -m http.server`, so `srv.kill()` kills the shell and can leave python
  listening — the `lsof -ti:<port> | xargs kill` pre-clean is what saves the next run.)

### Verified
- Unit **260/260**. `tests/invite.test.js` ranks a macOS laptop (en0 + 6 utun + awdl/llw/bridge/vmnet
  /ap + a link-local Thunderbolt) and Linux-style names (`enp0s3`, `wlan0`, docker/veth), tolerates
  numeric `family`, honours `limit`, round-trips `buildInvite` → `parseHostInput`, and asserts the
  rejection messages (`not a valid host`, `port number`, `IPv6 needs brackets`).
- New probe **`tests/smoke/merged.serve.mjs`** (`npm run smoke:merged`, added to `npm run smoke`) —
  the only probe that spawns the real `scripts/serve.mjs`. Asserts: one port serves `/` (html),
  `/info`, and the `public/src` symlink, and refuses path traversal; `coop:true`; host+join
  WebSocket handshakes **on that same port** (admin/participant); no `#coop-gw-url` remains; Advanced
  collapsed with the serving origin as its placeholder and "automatic" hint; invite row hidden until
  connected; `invite === http://<info.host>:<port>/#join=<code>` with no loopback host anywhere in it;
  Copy produces either "Copied" or the ⌘C instruction; a Node observer joins by code; **a second page
  opened at the invite URL joins with zero clicks** (host roster → 2) and lands on the World tab with
  an empty address field; Disconnect clears the hash and the roster drops back to 1.
- `npm run serve:coop` stays as a standalone gateway (a box that hosts worlds and serves no files).

## M7 — codebase-review fix pass (2026-08-27)

A full codebase review (scope: all of `src/`, `public/app/`, `scripts/`, `config/`, probes,
README/PLAN) produced the punch list below. Everything was fixed + TDD'd (new/updated unit
tests and smoke assertions), docs corrected, and dead code removed.

### Functional gaps in the shared world (the two real ones)
- **Element deletion never synced.** The world-inspector **Delete** button mutated the host's
  local `worldDoc.elements` and stopped — the authoritative server world (and every joiner's
  render + collisions) kept the deleted element forever. `CoopClient.removeElement` and
  `Session._removeElement` existed and were tested; nothing in the app ever called them.
  Fix: `hooks.onElementChange({op:'remove'})` → `c.removeElement(id)`. Same gap for
  **inspector edits** (X/Y/Rot/Scale/Intensity/Radius/W/H): they were bound locally and never
  streamed, unlike canvas drags (~30 Hz). Fix: X/Y ride the existing `moveElement`; the rest go
  out as a new admin-only `updateElement {id, patch{rotation|scale|properties}}` command
  (`Session._updateElement` + `CoopClient.updateElement` + main.js `op:'update'`), which
  broadcasts the full element list like its siblings.
- **Co-op Reset did not undo propagation.** `HeadlessWorld.reset()` re-seated poses only:
  `vehicleOverride`/`converted`/`convertedAt`/`flashUntil`/`convertedCount`/`stepCount` all
  survived, so converted clones stayed converted in the SHARED world after a Reset and a
  `maxConverted` cap stayed permanently half-spent — while the local `WorldSim.reset()`
  "restores the initial mix". Fix: `reset()` drops every override + bookkeeping, zeroes the
  counters/clock, and `_syncInstances()` swaps converted bodies back to the prototype doc.
  Pinned by `tests/multiplayer.sim.test.js` (convert → reset → geometry restored + spread
  restarts).

### User-data-loss in the editor
- **Out selector destroyed fan-out wires.** Re-pointing/clearing a source tap's "Out" dropdown
  deleted EVERY wire from that tap (`wires.filter(w => !(from===tap))`) — but a tap feeding two
  motors is legitimate and routinely created from the motors' In selectors. Fix: the selector
  replaces ONLY the wire it displays (the tap's first), and a `+N fan-out` hint makes the extra
  wires visible instead of the panel silently lying. Covered in `smoke:editor`.

### Correctness / robustness
- **`matter-js` was a devDependency but is runtime-required by the server** (`serve.mjs` /
  `serve-coop-gateway.mjs` import it; `Session→HeadlessWorld` needs it) — a production
  `npm install --omit=dev` yielded a server that crashed on co-op. Moved to `dependencies`.
- **Path-traversal prefix hole** in `scripts/serve.mjs`: `file.startsWith(ROOT)` also accepted
  siblings whose absolute path starts with the same string (`…/public-backup/x.json`). Now
  `file === ROOT || file.startsWith(ROOT + path.sep)`.
- **`Session._setCount` silently wiped a fleet on a malformed count**: `Number(msg.count) || 0`
  read missing/NaN as 0 → removed every clone (the exact NaN→0 failure the M2 CLIENT bug had).
  Now refuses with a message (`setCount requires a numeric count`); an explicit 0 still removes
  all (✕).
- **Gateway error-dedup cleanup was broken**: entries were stored under composite
  `code + ':' + message` keys while the success path called `failed.delete(code)` — which can
  never match, so a healed world never re-logged a re-occurring error and the set grew
  unbounded. Now a `Map<code, Set<message>>`; a clean sweep deletes the world's entry.
- **Co-op identity keyed on display name, not token**: same-name participants (typed or the
  random `Bot-NN` draw) mis-attributed the "my bots" highlight, popup affordance and fleet
  "· other" label. Fix: `welcome.you` carries the `token`, wire bots carry `ownerToken`
  (`Session._tagWire`), and `CoopClient.isMine(b)` keys on the token with the name as legacy
  fallback. `owner` (the name) still rides for popups/roster labels.
- **`vehicleSignature` omitted wire polarity, wire ports, and output taps** (and component
  polarity): configs differing only in those hashed identically → a genuine propagation
  conversion was skipped as "configs already match". All are in the signature now; the
  clone-equality invariant (idempotency) is re-proven with taps/polarity/ports in
  `tests/propagation.test.js`.
- **`HeadlessWorld.stepOnce()` double-snapshotted** every tick (60 Hz hot path): `world.step()`
  already builds + caches the snapshot; `stepOnce` called `snapshot()` again for the wire
  bots. Now reuses it.
- **`CoopClient.normalizeBot` color fallback was still `#cc3333`** — the exact red the
  `worldSim.snapshot()` comment says must be `#4da3ff` (worldSim fixed, the client copy
  survived). Fixed, so a non-conforming sender can't re-introduce the red-bot bug.
- **Local `WorldSim.reset()` crashed on a bodyless instance** (`M_BodySetPosition` lacked the
  `if (body)` guard `HeadlessWorld` has). Guarded, matching the headless engine.
- **`Session._setElements` accepted any array** and handed it to `rebuildObstacles`/the
  joiner's renderer. Now shape-checked (type + finite position per entry) and refused
  wholesale with a message; the accepted list is `structuredClone`d so the server owns its copy.
- **Minor:** `timescale.oninput` wrote `worldDoc.physics.timeScale` unguarded (an imported world
  without `physics` threw) → `??=`; `ensureCount` instance ids could collide within the same
  millisecond after add/remove churn → monotonic `_instSeq` suffix; `serve-coop-gateway.mjs`
  LAN hint used first-IPv4 + `family === 'IPv4'` (the exact VPN-address / old-Node trap the M6
  commit fixed centrally) → now `pickLanInterfaces()`.
- **Editor Delete/Backspace had no active-tab guard**: pressing it on the World tab deleted
  whatever was still selected in the hidden editor. Now gated on `#panel-editor` being active
  (mirrors the world tab's `isWorldTabActive` gate).

### Dead code removed
- `src/sensors/light.js` `normalizeLightLevel()` (superseded by `lightLevelNormalized`; zero
  production callers) + its tests.
- `src/models/vehicle.js` `resolveComponentTransforms()` (never used; production resolves
  per-component via `vehicleToWorld`) + its tests.
- `src/simulation/logic.js` `gateName()` / `isLogicGate()` (no callers outside nothing).
- `src/sensors/raycast.js` `rayCircle`: unreachable duplicate `if (t2 > EPS) return t2;` branch.
- `public/app/main.js`: the original `onVehicleChanged` hook (overwritten before ever running)
  and the unused `const _onVehicleChanged`; the `_vehicleOwnerName` check (never assigned
  anywhere). `public/app/coopPanel.js`: empty `if (v && !this.onEditDesign) {}` branch in
  `deploy()`. `public/app/editor.js`: redundant `c.props.range = def.defaults.range` re-assign
  (the deep clone already set it).

### Docs (README + PLAN corrected to match shipped behavior)
- README: stale "probes share web port 8903" sentence (each probe owns a port now,
  8901–8905/8907/8915/8925; `CHROME` env override documented); `public/src` is now genuinely
  git-ignored (untracked the committed symlink, fixed the `.gitignore` pattern so it matches a
  symlink — it was tracked as mode-120000 and `build` rewrote it every run); deps line notes
  both are runtime; "Deploy model, not live-edit / Editing never touches the running bot until
  deploy" → replaced by the shipped live-sync behavior (~400 ms auto-redeploy after first
  deploy); `src/actuators.js` added to the layout tree; fleet rows now documented with the
  typeable exact-count input (commit 743538e).
- PLAN: Next-Up item 4 (logic gates) marked **DONE** with an as-built note (floating nodes, not
  snap points; no XAND); original design sections annotated where superseded (§1/§2
  client-side-only + "no server-side state", §2 out-of-scope multi-user, §3.2
  `config/world.json` never shipped + hot-reload never implemented, §9 `dist/` → `public/` +
  `serve.mjs` required); wire-protocol header pointed at `gateway.js`/`session.js` with a
  superseded callout (the header itself read as current); "legacy single-world join still works"
  corrected (it doesn't); probe port/profile note updated.

### Verified
- Unit **262/262** (`npm test`; +11 new: 5 signature, 4 session, 1 client isMine, 1
  sim reset-propagation; −9 removed with dead code).
- All 8 browser probes green in one `npm run smoke` run (Chromium, `CHROME` env override),
  including NEW coverage: `smoke:editor` asserts the Out selector keeps fan-out + shows the
  hint; `smoke:coop.session` BUG11 (inspector Delete → server + joiner lose the element) and
  BUG12 (inspector intensity/rot edits → server + joiner mirrored).
- Traversal fix verified directly: the encoded sibling-prefix escape
  (`/..%2fpublic-backup%2fx.json`) is now 403 (the old check served it).

## M8 — Solid light sources

Braitenberg's stock situations often put the light in the world as a thing a vehicle
can bump into, circle, or press against; lights were pure field emitters, so every such
demo drove straight through the sun. This adds a **Solid** toggle plus a radius slider to
the light's world inspector. Plan and rationale: `docs/solid-light-plan.md`.

### As built
* **Data**: `properties.solid` (boolean, default `false`) + `properties.radius`
  (default 24, config-bounded 8–240, scaled by `el.scale.x`). `radius` — not
  `solidRadius` — so a light reads the same circle vocabulary as a `rock` and no
  consumer has to special-case it. A light with no `properties` object at all
  (hand-written JSON) is hardened, not fatal.
* **The seam** is `worldElementsToSnapshot(elements, configs)`, which both
  `WorldSim.buildObstacles()` and `HeadlessWorld._buildObstacles()` already call: a
  solid light emits its emitter entry **and** a rock-identical `circle` obstacle. That
  one change lands in the browser, the authoritative co-op world, and the raycaster —
  zero edits to either body builder, either step loop, or the wire protocol.
* **The invariant that makes it safe**: solidity NEVER changes what a light sensor
  reads. Sensors read `snapshot.lights`; the body goes in `snapshot.obstacles`.
  Pinned across a sweep of distances, through `evaluateVehicleSensors`, and in the
  shared world. What it *does* change is that the lamp becomes a distance-sensor
  target — intended, because a physical lamp is a physical object.
* **Ring === barrier**, the rule the Bumper fix (`bf02a21`) established: the renderer
  draws at `solidLightRadius()`, the same pure function the snapshot handed physics.
* **Co-op needed no protocol change.** `Session._updateElement` already shallow-merges
  `patch.properties` and calls `rebuildObstacles()`. Two contracts are load-bearing
  and now tested: the client sends an **explicit** `solid:false` to revoke it (an
  omitted key would merge-clean and leave a stale `true`), and eviction runs on the
  ON-transition only — never from the ~30 Hz `moveElement` stream, which would pin
  every bot under the drag.
* **Eviction** (`evictOverlappingBots`, mirrored in both engines): Matter resolves an
  interpenetration by ejecting the intruder, so ticking Solid on top of a parked robot
  flings it. Each overlapping bot is stepped out to barrier + clearance along the
  light→bot vector with momentum zeroed, and the evicted pose becomes its seed so a
  Reset cannot shove it back in.

### Deviations from the plan (each caught by a test or by measurement)
* **`authoredLightRadius` added.** The slider must bind to the *unscaled* radius; a
  slider bound to the scaled value multiplies by `el.scale` again on every edit and the
  barrier creeps.
* **Number coercion tightened.** A test asserted a `[]` radius falls back to the
  default and failed, because `Number([]) === 0`: the old helper silently turned a
  wrong type into a zero-size barrier. Only real numbers and non-empty numeric strings
  are accepted now.
* **`restitution` dropped** from `config/world.json`. Wiring it would have meant either
  a non-rock-shaped obstacle (breaking the "nothing downstream can tell them apart"
  property) or changing existing rock behaviour; Matter's default reads fine.
* **A dedicated probe** (`tests/smoke/world.solidlight.mjs`, web 8935 / CDP 9248,
  `npm run smoke:solid`) rather than extending `world.sim.mjs`, which already fails
  before its late phases in this environment.
* **Unique Chrome profile per probe run.** A reused profile plus `python3 -m
  http.server` (no `Cache-Control`) let Chrome's heuristic cache serve a
  pre-edit `light-field.json`; the app edited a stale document and the probe asserted
  against files that were not the ones on disk. Cost: ~200 ms.

### The two UI fixes from review
* **Radius slider escaped the popup.** The cause was found by measuring, not guessing —
  the first theory (a flex item's ~129px *automatic minimum size*) was wrong and was
  disproved by reading the computed style: a global `input[type=range] { width:240px }`
  rule sat in the stylesheet, and `#world-inspector` is only 200px wide. A 240px child in
  a `display:flex` label that never clamps its children (no `min-width:0`) overflows the
  200px box — and since the popup is pinned to `right:10px`, it ran off the screen. Fixed
  with `flex:1 1 auto; min-width:0; width:auto` on `#world-inspector input[type=range]`,
  which is the rule the editor inspector already relied on (`#editor-inspector` sets
  `min-width:0` on its labels) — so the two popups now behave identically and any future
  slider row is safe. Measured before: 89px wide, `right` edge 254px against a 240px box
  (14px past it, the last ~40px unreadable). Measured after: contained.
* **A light no longer shows Rotation.** Not because the field was dead — it was NOT, and
  the honest reason is narrower: it wrote `el.rotation`, which is read by the
  `distanceTo` FOV gate, by `sensorAngles`/`aimVector`, by the serialized `r` field and by
  the editor's rotation handle. But a light is a CIRCLE drawn by `arc()`, so no consumer
  can produce an observable difference — every angle is the same shape. The control was
  therefore a knob whose only output was a number in a file, and it is gone for lights.
  Obstacles keep theirs, where rotation is real for a rect (and for polygon primitives on
  the horizon). The light's own `el.rotation` value is left untouched — only the control
  is hidden — so nothing that already stored a rotation loses it.
  Removing it then surfaced a genuine regression: `coop.session`'s BUG12 drove `#wi-rot` on
  a LIGHT to prove rotation mirrored to the joiner, and threw on the null input. Fixed by
  moving that coverage to a rect wall (which has, and needs, the field), asserting the
  light popup has NO `#wi-rot`, and leaving the intensity-sync check on the light.

### ⚠ Process note: this work was built on a stale base
The review round reported "the Bumper is broken — it says same-prototype clones pass
through, and my Density slider is gone". Neither was a regression from this feature:
**this workspace was one commit behind.** Local `origin/main` still read `bf02a21`
because nothing had fetched, while the real remote (and the user's other machine) was on
`d36ab99` — the hollow-ring force-field Bumper with the Density slider and the corrected
tip. Symptoms of a stale base look exactly like self-inflicted breakage, because the
file you are reading IS the old one.

Recovery, in the order that is safe (all of it recoverable at every step, and nothing
committed without the user's go-ahead):
1. `git fetch origin` — the ONLY step that tells the truth about the remote.
2. Back the work up OUTSIDE git (`git diff > /tmp/…patch` + `tar` the untracked files),
   because a stash can be dropped and a botched pop is easier to fix from a file.
3. `git stash push -u` → `git merge --ff-only origin/main` (main had no commits of its
   own, so it fast-forwards rather than merges) → `git stash pop`.
4. Resolve. Here: 3 files, and 2 were *pure import-line collisions* (both sides added
   an import at the same place) — keep both, don't think too hard about those.
5. Re-run everything, and confirm BOTH features survived, not just yours.

Test count is the tell: base went 262 → 283 (upstream's 21 bumper tests), and with the
55 solid-light tests the merged tree must be 338. Anything else means a side got lost.

### Verified (on a clean environment — the first pass at this was not, see below)
* Unit **338/338** (`npm test`) on the rebased tree = 283 upstream (incl.
  `tests/bumper.test.js`) + 55 new here across `solidBody`, `solidLightSensors`,
  `worldSnapshot`, `multiplayer.sim`.
* `smoke:solid` 12/12 in headless Chromium: controls emitted · toggle builds a static
  body and reveals the slider · ring === barrier exactly · slider drives the body live
  and clamps · a driven robot is stopped · the same robot passes straight through with
  solidity off (the control run) · property-less import · eviction with momentum
  zeroed and seed adopted · slider contained inside the popup · light has no Rotation
  field while obstacles keep theirs · Bumper is the force-field build (Radius + Density
  sliders present, corrected tip, stale "clones pass through" copy gone).
  The containment and Bumper checks are checkout-correctness guards: they fail loudly on
  a tree that predates `d36ab99` instead of quietly testing the wrong code.
* No regressions: `editor.ui`, `neurons.outputs`, `world.tabs`, `coop.panel` and
  `merged.serve` all green, plus the standalone `serve:coop` gateway booting with the new
  config file.
* The three probes that do NOT pass here fail at **exactly the phase clean HEAD fails at**,
  measured on a throwaway worktree at `d36ab99` rather than assumed:
  | probe | this tree | clean HEAD |
  |---|---|---|
  | `coop.session` | `BUG6: joiner not restored to home world: ["light"]` | same |
  | `world.sim` | `vehicle detection: need two instances` | same |
  | `proto.crud` | `add: expected >=6 live instances (3+3), got 4` | same |
  Getting to "the same failure" rather than "a new failure" is the actual bar for a change
  to a suite that already has red in it.

### The verification itself had to be redone
An earlier pass of this table was **wrong in both directions** — it reported green for a
phase that was really broken and red for one that was fine — because of the two harness
hazards documented in the README: a probe attached to a still-live Chrome bound to its
fixed CDP port (a page loaded from a different checkout), and a per-run `rm -rf` of the
Chrome profile racing a dying Chrome that re-created the profile and its HTTP cache.
Both were caught the same way: by asserting a fact two ways at once (the served module
source vs the DOM it had produced) inside a single `Runtime.evaluate`, where a stale page
cannot fake both. Symptoms, if you meet them again: a probe insisting on code you can see
is not in the file, or `PASS` from a probe run while its server is answering from another
directory. Check `curl http://127.0.0.1:<cdp>/json` and who owns the web port before
believing either result. `smoke:solid` now frees its CDP port and verifies a `?nc=` nonce
on the page it attaches to; the other probes still rely on a fixed profile+port and could
use the same treatment.

---

## M9 — Heat source + heat sensor, and co-op fleet organising

Two features delivered together: a second emitter type with genuinely different physics, and
the fleet-layout controls lifted into the shared world.

### M9.1 Heat: a thermal field, not a re-skinned light sensor

Design, model choice and limits are written up in `docs/heat-plan.md`. As built:

* **Two separate fields.** `worldElementsToSnapshot` now emits `heats:[{x,y,temperatureC}]`
  beside `lights`. A light sensor is handed `lights`, a heat sensor `heats`, so "a furnace is
  invisible to phototaxis" is a property of the data flow. Pinned at unit level and in the
  browser (light readings bit-identical while a furnace goes 60 °C → 2000 °C).
* **The physics** (`src/sensors/heat.js`): net Stefan–Boltzmann emission in **kelvin**
  `k·((Ts/Ta)⁴ − 1)`; inverse-square propagation about a **calibration radius**; optional
  Beer–Lambert air absorption; FOV gating shared with light via `inFov`; optional obstacle
  shadowing (off by default). The sensor itself is a lumped heat-capacitance body —
  `C·dT/dt = Σ αF_iσ(T_s,i⁴ − T⁴) − h(T − T_amb)`, whose steady state is a conductance-weighted
  **mean** `T_eq = (Σ Ĝ_i·T_s,i + T_amb)/(Σ Ĝ_i + 1)`, integrated **exactly** in `τ`.
* **Exact integration is not decoration.** A naive Euler step is frame-rate dependent: one
  `dt=τ` gives 63.2 %, two `dt=τ/2` steps give 75 %, so 30 fps and 60 fps would disagree about
  how hot the world is, and `dt > τ` oscillates (reachable with the Time slider). The test
  suite asserts subdivision consistency (100 tiny steps land exactly on one big step) and
  non-overshoot at `dt = 2.5τ`.
* **Sensor state is per instance.** Heat is the first sensor in this codebase with a past.
  `evaluateVehicleSensors` gained an optional 4th arg `{sensorStates, dtMs}`; it cannot live on
  `vehicle` because both engines pass a fresh `{...v, pose}` every tick, so each engine owns a
  `Map` per instance. **Reset clears it** (a reset robot must not resume hot) and **removed
  components are pruned** (component ids are stable per design and shared across clones, so a
  dead sensor's heat would boot its replacement hot).
* **Solidity is shared, not copied.** `solidBody.js` generalised from lights to
  `SOLID_BODY_TYPES = {light, heat}`: same strict `true`-only reading, same per-type config
  bounds, same ring-equals-barrier identity, same eviction. `isSolidLight` et al. remain as
  thin wrappers so nothing that already used them changed.

#### Deviations and bugs found on the way (each now pinned by a test)
* **The probe could read hotter than its source (found by a player: 4800 °C off a 220 °C
  furnace).** The equilibrium was `T_ambient + coupling·flux` — a textbook lumped-capacitance
  form, and unphysical here, because incident flux diverges as the probe closes on a source
  (1/r²) while the probe's own reradiation was modelled as independent of it. Flux is not
  heat: a passive probe cannot exceed the hottest body in view. Fixed by linearising the
  exchange properly (`σ(T_s⁴−T⁴) ≈ (T_s²+T_a²)(T_s+T_a)(T_s−T)`), which makes the steady state
  a conductance-weighted MEAN with the ceiling built in — 218 °C parked on a 220 °C furnace,
  at any distance, for any coupling, with any mix of sources. Deliberately NOT fixed with a
  `clamp`, which would have deleted cold sinks (a probe beside a sub-ambient trap must read
  BELOW ambient) and hidden the ceiling instead of explaining it. The `coupling` constant also
  changed meaning (a °C-per-flux gain of 10 became a conductance ratio of 0.5), which is why
  the calibration points are now asserted by name rather than implied. Pinned in
  `tests/heat.test.js` (bound swept over temperature × distance × coupling) and in the browser
  by `npm run smoke:heat` phase 8b — whose first version was itself wrong: it asserted a peak
  bound while the probe was still cooling from the previous 1500 °C phase, and a cooling probe
  reading above its surroundings is correct behaviour, not the bug. The phase now cold-soaks
  first, and separately asserts the transient stays hot, so neither half can be "fixed" into
  the other.
* **The first calibration was unusable.** Written as `P/(4πr²)` a hot source at 100 px gave
  ΔT ≈ 5e-5 °C — correct law, sensor never moved off ambient, and exactly the kind of bug that
  reads as "the sensor is broken". Fixed by writing the inverse-square law about a
  `referenceDistance`, which keeps the law and makes every constant interpretable.
* **Two of my own test assertions were wrong, not the code.** (a) "two half-steps differ from
  one full step" — false, exact exponential integration is subdivision-consistent; the test
  was inverted to assert the real property plus the Euler contrast. (b) a ring-down tolerance
  of 1e-6 against a 60 °C gap decaying for 5 s (answer: 2e-4). Both are worth recording
  because each looked like a physics bug.
* **Eviction swept only lights** (`solidLightCircles`), so a furnace switched on under a parked
  robot would have been flung by Matter — the exact failure `pushOutOfCircle` exists to stop.
  Engines moved to `solidBodyCircles`.
* **Latent crash fixed**: `HeadlessWorld.evictOverlappingBots` fell back to `?? {}` for a
  world with no elements, and `{}` is not iterable — eviction threw on precisely the empty
  worlds most likely to be created first. Now `?? []`.
* **A browser-only syntax error** (`a?.b = c` is not valid JS) broke the whole app boot while
  all 385 unit tests passed — unit tests never load `public/app/world.js`. The smoke probe
  caught it in seconds, which is the argument for the probes existing.
* **The probe's own assumptions failed twice, informatively**: the sample car is *wired*, so it
  drove away while "settling" (a moving probe always reads off-equilibrium); and `moveBot`
  adopts the dropped pose as the seed, so using it to "drive bots away" before a Reset test
  overwrote the very seeds under test. The Reset test now displaces bodies server-side.

### M9.2 Co-op fleet organising (Random / Line Up / Grid for everyone)

* **One layout module** `src/models/formation.js` serves both the existing per-prototype
  Sandbox buttons and the new server-side `arrangeAll`, so the two cannot drift into meaning
  different things. Numbers preserved exactly (130px spacing, random over the view radius).
* **`arrangeAll` does three things per bot**: teleports the body, **zeroes its momentum** (a
  bot at speed otherwise flies straight back out of the formation), and writes the **seed** —
  plus the documented `proto.instances[i]` where it exists, so a saved world exports what the
  screen showed. Bots are ordered **grouped by participant**, so each fleet owns one stretch
  of the line instead of being scattered through it.
* **`arrangeBots` is admin-only** — it moves other people's bots, which is precisely why a
  participant must not send it. The UI hides the row for participants; the session is the
  gate, and a participant calling it directly is refused with nothing moved (probed).
* **A centre is validated, never clamped**: a NaN handed to Matter does not stay on one body.
  With no centre the layout is built around the fleet's own **centroid**, so it does not
  teleport the world to the origin.
* **One broadcast, not an ack plus a broadcast** — `broadcast` already includes the sender, so
  the first cut handed the host the same event twice (caught by a test that asserted "exactly
  once"). Other commands legitimately send both because their ack is a *different* message from
  the broadcast (`elementAdded` vs `elements`).
* **Follows immediately even while paused**: the command broadcasts an authoritative snapshot
  after the event, rather than waiting for a ~15 Hz tick that a paused world never sends.

### Verified (M9)
* Unit **422/422** = the previous 338, plus `heat` 34 (thermodynamics against closed forms,
  including the never-hotter-than-the-source bound swept over temperature × distance ×
  coupling),
  `heatSensor` 20 (seam + engine lifecycle: blindness, lag, ring-down, per-instance state,
  reset, solid furnace blocking a robot), `formation` 16, `coop.arrange` 14.
* `smoke:heat` 12 phases and `smoke:arrange` 10 phases, both on dedicated web+CDP ports with
  a unique profile and a freshness nonce.
* No regressions: `editor.ui`, `world.tabs`, `coop.panel`, `coop.session`→`world.solidlight`,
  `merged.serve`, `neurons.outputs` all green. `world.sim`, `proto.crud` and `coop.session`'s
  BUG6 still fail exactly where clean `main` fails them — pre-existing sample-world
  assumptions, unchanged by this work.
* The suite's cache hazard bit again during this work (new JS + cached HTML, README
  "Testing"), producing a confident false failure; recorded there so the next reader spends
  thirty seconds on it instead of an hour.

## M10 — Performance: spatial-hash vehicle detection + worker-stepped simulation

### Why (the actual problem)

Target scale is ~1000 vehicles. Two CPU costs dominate a step (measured by reading the loop,
confirmed by user htop traces: the GPU sits idle while one browser thread pins):

1. **Vehicle-detection is O(N²).** `detectVehicle` scans every other vehicle per sensor per
   step: 1000 vehicles × 1 sensor each ≈ 1M hypot/atan2 checks per step, 60M/s. This is the
   reason lag ramps superlinearly with fleet size.
2. **Everything runs on the main thread.** In single-player the Matter engine, sensor math,
   propagation AND Canvas 2D drawing share the page's only JS thread; physics overrun the
   16.6 ms budget and the UI (pan, drag, inspector) stutters with it.

Rendering (Canvas 2D → WebGL) was considered and deliberately **not** part of M10: it only
moves the drawing slice, while the lag is physics+sensors. Parked for a later program.

### M10.1 — Spatial hash grid for vehicle detection

* **`src/simulation/spatialGrid.js`** — a pure, dependency-free grid: `buildGrid(items,
  {cellSize})` + `queryCircle(grid, x, y, r)` returning a candidate SUPERSET (cells whose bbox
  overlaps the query circle); the caller does the exact predicate. Correct for any range,
  negative coords, dense piles; a huge range degrades to brute force but stays correct.
* **`src/sensors/vehicleDetection.js`** gains `buildVehicleGrid(vehicles, sensorsConfig)` and
  `detectVehicleGrid(point, dir, range, fov, grid, selfId)`. Semantics are the array model's
  exactly: hard range cap inclusive, FOV gate shared via `inFov`, self excluded by instance id,
  nearest wins. One documented divergence: among EXACTLY-equal-distance ties the reported
  target id may differ (cell order vs array order); distance and detected are identical.
* **Seam**: `sampleSensors` uses `world.vehicleGrid` when the engine provides one and falls
  back to `world.vehicles` otherwise — pure function unchanged in spirit, every existing test
  keeps passing, and co-op/`HeadlessWorld` and the browser engine opt in by building the grid.
* **Config**: `sensors.json → vehicle_detection.gridCellSize` (OPTIONAL read with built-in
  fallback, the M8 `world.json` idiom — an old checkout still boots).
* Obstacle raycasts and heat occlusion stay array-scanned: obstacles are few, this is the
  wrong fight. Parked.

### M10.2 — Worker-stepped single-player simulation

The codebase already HAS a headless, injectable, server-authoritative engine
(`HeadlessWorld`) that is behaviour-parity by construction. Single-player converges onto it
instead of maintaining a third engine: **the page steps a `HeadlessWorld` through a message
protocol, and that protocol is executed either on the main thread or inside a Web Worker —
one protocol, two transports.**

* **`src/simulation/simProtocol.js`** — `applyCommand(world, pstate, msg)` (pure given the
  world + protocol state): ops `init | sync | move | reset | step | snapshot`. Protocol state
  owns the extras single-player needs that co-op does: conversion EVENT log (so the page can
  mirror `vehicleOverride` for drawing/inspector), per-step PATH recording (capped, delivered
  incrementally only while `trackPaths` is on), and `detail` gating (samples/motors omitted
  from replies when Beams+Values are off — the payload is the cost at 1000 bots).
* **`public/app/simMirror.js`** — `applyReply(instances, reply, opts)`: writes poses onto
  plain mirror bodies `{position, angle, velocity, angularVelocity}` (everything the draw +
  hit-test code already reads), appends path points, applies flash, swaps converted docs.
  With `opts.realBodies` (LocalBridge only — same heap) the mirror IS the Matter body: zero
  copies, direct-write compatibility.
* **`public/app/simBridge.js`** — `LocalSimBridge` runs the protocol synchronously on the
  main thread; `WorkerSimBridge` posts the same messages to a Worker and delivers replies
  async. `WorldSim` is written ONLY against the async bridge shape — LocalBridge's replies
  are synchronous, so the classic sync semantics (tests, `btnStep`, probes that write
  `inst.body.position` directly) survive unchanged when the Local transport is selected.
* **`public/app/sim.worker.js`** — classic Worker: `importScripts('../vendor/matter.min.js')`
  (the UMD build keys off `this`, so it cannot be imported as ESM) then a dynamic `import()`
  of the ESM sim modules. Same protocol entry point as local.
* **Mode selection**: Worker by default (that is the point); `?worker=0` forces the local
  transport; a Worker boot failure falls back to local with a loud console warning rather
  than a dead canvas. Existing smoke probes run `?worker=0` (they poke bodies directly and
  assume sync steps — same engine, same protocol, so coverage is honest); a new
  `smoke:worker` probe exercises the default async path: boot, Play→motion, async step
  settling, drag→seed adoption, Reset.
* **Main thread keeps**: world/prototype docs, seeds, `ensureCount`, element editing, hit
  tests (mirror poses), drawing, propagation status pill, inspector. Eviction stays the
  existing main-side sweep (shared `pushOutOfCircle`) but applies THROUGH the bridge so the
  engine's seeds follow the evicted pose.
* **Cadence/backpressure**: the rAF loop still accumulates fixed-dt; it sends ONE `step n`
  per frame and skips sending while a step is in flight — at overload the sim loses time
  (like today's dropped frames) instead of queueing unbounded work or freezing the UI.
* Heat `sensorStates` live on the engine's instances (they already do in `HeadlessWorld`);
  the page's copies become unused in bridged mode. Reset clears both sides.

### Verification plan (TDD order)

1. `tests/spatialGrid.test.js` + `tests/vehicleDetectionGrid.test.js` first (semantics
   equivalence against the brute-force model incl. randomised corpora; boundary-inclusive
   range; self-exclusion; a loose perf assertion grid ≪ brute force at 2000 targets).
2. `tests/simProtocol.test.js` — protocol commands against a real `HeadlessWorld` with
   node matter-js: init/sync/move/reset/step semantics, conversion events, path recording +
   cap + incremental delivery, detail gating. `tests/simMirror.test.js` — reply application.
3. world.js rewire guarded by the full unit suite + smoke probes; `world.sim`, `proto.crud`,
   `world.solidlight`, `world.heatsource` on `?worker=0`; new `smoke:worker` for the Worker.

### M10 as built (session 2) — status, deviations, and what still needs a real browser

**Shipped:** M10.1 (grid) and M10.2 (protocol/worker/bridge) as designed above. Measured
`HeadlessWorld.step()` @ 1000 vehicles with one detection sensor each: **20.7 ms → 7.9 ms**
(`scripts/bench-fleet.mjs`, grid on/off A/B). The detection layer itself went from ~60M
distance checks/s to a few hundred thousand. Unit suite: 478/478.

Deviations from the plan, each forced by the design itself:
* **Recording Paths only while the toggle is on** (was: always record, hidden). The transport
  cannot hand the page history retroactively, and recording unconditionally for a renderer
  that is off is exactly the hidden work M10 is about. Toggle-on starts a fresh trail.
* **`sync` is full-desired-state, diffed engine-side** (elements + prototype docs + instance
  seeds), so every page-side structural change re-states the world idempotently. Seeds are
  page-owned; `sync` refreshes engine seeds WITHOUT moving live bodies, and `reset` can carry
  seeds (arrange-then-reset is one round trip). This is why `ensureCount`/`move`/`reset` have
  identical semantics on both transports.
* **HeadlessWorld geoSig now includes component props** — the browser engine's
  "bumper radius change must rebuild the body" rule the headless copy was missing. Caught by
  a protocol test; co-op silently benefited.
* **Compatibility surfaces kept:** `sim.M`, `sim.obstacleBodies` (engine's list via the local
  bridge; empty on the Worker transport) and `sim.instWireMap()` (re-states the world).
  Existing probes keep their direct-write contract under `?worker=0`.
* **Conversion event payload** carries the full cloned vehicle doc — the page needs it for
  drawing/inspector of converted robots, and cloning at convert-time (engine side) is the one
  point where both heaps can agree on the doc.

**Environment finding (important for the next session on this box):** headless Chromium on
this Linux machine cannot load ANY `http://` page — even a 15-byte static page over two
different local servers hangs CDP navigation (renderer never commits; sometimes not even a
request reaches the server), while `data:` and `file://` loads work. GPU init also fails
loudly (Vulkan/EGL), fixed for the working paths with `--no-zygote --disable-vulkan
--no-sandbox`. So **no smoke probe can run here** — that is the box, not the app. To verify
M10 end-to-end, run on the Mac: `npm run smoke` (all existing probes now carry `?worker=0`)
plus a manual Worker-mode pass (open the app WITHOUT the param: World tab → Play → bots
move; Step; drag a bot → Reset returns it to the drop; heat sensor still lags; propagation
status pill counts). A dedicated `smoke:worker` probe is deliberately NOT committed — an
untested probe is exactly the false-failure generator the README "Testing" section warns
about; write it on a machine that can run it.

**Not run here (needs a working browser):** everything browser-only — Worker boot in Chrome
(importScripts path resolution + dynamic import in a classic worker), pan/drag UX over the
Worker transport, all twelve existing probes. The Node-side worker-transport test covers the
worker script's boot order, message loop and structured-clone replies; the protocol tests
cover engine semantics; but treat the in-browser pass as REQUIRED before shipping M10.
