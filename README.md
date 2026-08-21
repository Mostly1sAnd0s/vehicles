# Braitenberg Vehicles Simulator

Self-hosted, client-side SPA for constructing and simulating Braitenberg-style
vehicles — snap-on components, explicit sensor→actuator wiring, **combinational
logic gates** between them, a special **Propagator** component that lets one robot
clone its whole configuration onto nearby neighbours, and a 2D physics world with
light sources, obstacles, and multiple vehicle types. See `PLAN.md` for the full
design and current status.

## Run

```bash
npm run build    # sync config/ -> public/config, link src/ -> public/src (pure ESM core)
npm run serve    # Node static server; auto-avoids busy ports, PORT=<n> pins
```

For real deployment copy `public/` to a web root (nginx/Caddy/anything static).
No build step is required at runtime — vanilla ES modules + vendored Matter.js.
(`public/src` is a symlink created by `build`, so keep it out of version control.)

## Test (TDD)

```bash
npm test                 # 193 unit tests (node --test, no framework)
npm run smoke            # all three headless-Chrome probes below, in sequence
npm run smoke:editor     # place + drag-snap + wire, gates + slots, body color via UI
npm run smoke:world      # sim runs; sensor/motor polarity, detection, propagation
npm run smoke:crud       # add/remove vehicle types, drag a running robot to reposition
```

Smoke tests are self-contained (each starts its own static server and drives
headless Chrome over raw CDP — no Puppeteer) and need the Google Chrome at the
`CHROME` constant in each script (macOS path; adjust if needed). Each probe owns
its own web port (8901–8903), CDP debug port, and Chrome profile dir, and cleans
up after itself.

## Layout

```
config/                 JSON config (source of truth)
  app.json                fixed timestep, snap-point count, misc app defaults
  components.json         every placeable part + logic gates + the Propagator
  sensors.json            light / distance / vehicle-detection sensor models
  actuators.json          powered-wheel model (power, friction, power curve)
  ui.json                 keyboard shortcuts

src/                    testable core (pure ESM, no DOM) — linked in as public/src
  models/snapPoints.js    perimeter snap-point generation (corners always included)
  models/vehicle.js       pose math, component transform resolution
  models/wiring.js        wiring validation (duplicates, port-type mismatch, weight…)
  models/hitTest.js       component footprints (wheel rects / sensor circles) + nearest snap
  sensors/light.js        inverse-square sampling + distance-normalized level,
                          effective range (drives the beam length), cone helper
  sensors/raycast.js      ray vs circle / rotated rect (pure geometry)
  sensors/polarity.js     forward/inverted sensor sign conventions
  sensors/vehicleDetection.js  cone + range test that detects another vehicle
  simulation/sampleSensors.js   per-step sensor evaluation for a vehicle pose
  simulation/logic.js     gate truth tables, topological eval (cycle-safe), and the
                          Propagator core (signature / target select / deep clone)
  simulation/worldSnapshot.js   world elements -> {lights, obstacles}
  actuators.js            sensor value x weight x polarity x power -> clamped force

tests/                  unit tests (node --test) + headless Chrome smoke probes
public/                 the static site
  app/                    main.js (bootstrap), editor.js, world.js (Matter glue),
                          worldDraw.js, worldInspector.js, prototypes.js, color.js
  vendor/matter.min.js    vendored physics engine
  config/                 copy of config/ (made by `npm run build`)
  vehicles/, worlds/      sample documents (sun-car, light-field; JSON import/export in UI)
```

Simulation loop: fixed timestep (`config/app.json`). Each step runs Matter.js,
then **configuration propagation** (Propagators clone nearby robots), then
`samples sensors → resolves logic gates topologically → actuator forces`, using
the tested core. The editor and world share one state object; edits in the editor
propagate to every running instance of the owned prototype on save.

## Status / next steps

Done:
- Config-driven components/sensors/actuators, no hard-coded tunables
- Snap-point body construction + component placement: drag palette items onto
  nodes (or click-place); a **body-centre** attachment point for mounting a part
  at the core; drag placed components by their full footprint and they snap to
  the nearest node on drop, sensors re-aim along the node normal, wires follow
- Wiring editor: per-part In/Out **connection slots** (counts match each gate's
  arity), polarity + weight, live validation in the inspector
- **Combinational logic gates** (AND/OR/NAND/NOR/XOR/NOT): floating nodes wired
  between sensors and motors, evaluated topologically with a cycle guard so a
  mis-wired vehicle never throws inside the animation loop
- **Configuration propagation ("Propagator")**: a special component that copies
  its host's full config onto any robot whose config differs within range — a
  true clone (it carries the Propagator onward), modelling one seed spreading
  through a population. The trigger radiates from the part itself, not the body;
  a dashed ring shows the live boundary in both the editor and the world; a
  status pill reports converted/total; `reset()` restores the initial mix
- **Vehicle detection sensor**: FOV-cone + range sensor that detects another
  vehicle (aim/range/FOV, cone beam viz, on-body readout)
- Per-vehicle **body color** (fill + lightened outline) via an always-visible
  4x4 swatch palette; the editor canvas and the world render the same color
- **"+Paths"** toggle: capped motion trails per robot, cleared on reset
- **Multiple vehicle types (CRUD)**: add/remove/edit named types; per-type
  instance counts with Add Here / Random / Line Up / Grid layout
- **Drag a running robot** to reposition it (zeroed momentum, dropped pose
  adopted as the seed so Reset restores it)
- World sim: distance-normalized light sensors (normal + inverted are exact
  complements on [0,1]; beam length = the sensor's effective sensing radius,
  brightness = normalized level), raycast distance sensors + beam viz, powered
  wheels, pan/zoom camera, element gizmo-style inspector, instance tools,
  play/pause/step/reset/time scale
- Vehicle/world JSON import/export + localStorage recents

Next (per PLAN.md):
- Rotate handles for components in the editor
- Polygon world primitives (raycast + Matter already support them)
- More Braitenberg vehicle presets (1–7)
- Motor-response scripting / decision-table layer (thresholds, dead-bands,
  conditionals) to generalize `value x weight x polarity x powerCurve` for
  Vehicles 6/7 — keep `computeActuation` as the single seam
- Per-actuator visual spin direction fully decoupled from force sign
- Keyboard shortcut polish, camera collapse on play, recent-file thumbnails
