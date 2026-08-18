# Braitenberg Vehicles Simulator

Self-hosted, client-side SPA for constructing and simulating Braitenberg vehicles
(snap-on components, explicit sensor→actuator wiring, 2D physics world with light
sources and obstacles). See `PLAN.md` for the full design.

## Run

```bash
npm run build    # sync src/ -> public/src (pure ESM core used by the browser)
npm run serve    # http://localhost:8080  (python3 http.server over public/)
```

For real deployment copy `public/` to a web root (nginx/Caddy/anything static).
No build step is required at runtime — vanilla ES modules + vendored Matter.js.

## Test (TDD)

```bash
npm test                                  # 59 unit tests (node --test, no framework)
node tests/smoke/world.sim.mjs            # headless Chrome: sim runs, vehicles move
node tests/smoke/editor.ui.mjs            # headless Chrome: place + wire via UI
```

The smoke tests need `npm run serve` running and Google Chrome on PATH location
used in the scripts (macOS path; adjust CHROME constant if needed).

## Layout

```
config/                 JSON config (app, components, sensors, actuators, ui)
src/                    testable core (pure ESM, no DOM)
  models/snapPoints.js    perimeter snap-point generation (corners always included)
  models/vehicle.js       pose math, component transform resolution
  models/wiring.js        wiring validation (duplicates, type mismatch, weight…)
  sensors/light.js        inverse-square light sampling, range + saturation
  sensors/raycast.js      ray vs circle / rotated rect (pure geometry)
  simulation/sampleSensors.js   per-step sensor evaluation for a vehicle pose
  simulation/worldSnapshot.js   world elements -> {lights, obstacles}
  actuators.js            sensor value × weight × polarity -> clamped force
tests/                  unit tests (node --test) + headless Chrome smoke tests
public/                 the static site
  app/                    main.js (bootstrap), editor.js, world.js (Matter glue)
  vendor/matter.min.js    vendored physics engine
  vehicles/, worlds/      sample documents (JSON import/export supported in UI)
```

Simulation loop: fixed timestep (config/app.json), each step runs Matter.js, then
`samples sensors → wires → actuator forces` using the tested core. The editor and
world share one state object; edits in the editor propagate to all instances of the
owned prototype on save.

## Status / next steps

Done:
- Config-driven components/sensors/actuators, no hard-coded tunables
- Snap-point body construction + component placement (click snap point)
- Wiring editor with polarity/weight, live validation
- World sim: lights (inverse-square), raycast distance sensors + beam viz,
  powered wheels, pan/zoom camera, element gizmo-style inspector, instance
  tools (Add Here / Random / Line Up / Grid), play/pause/step/reset/time scale
- Vehicle/world JSON import/export + localStorage recents

Next (per PLAN.md):
- Rotate handles for components in the editor; drag-along-snappoint repositioning
- Polygon world primitives (raycast + Matter already support them)
- More Braitenberg vehicle presets (1–7)
- Keyboard shortcut polish, camera collapse on play, recent-file thumbnails
