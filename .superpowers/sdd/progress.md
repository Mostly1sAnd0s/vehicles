# Handoff #3 — "Paths:" toggle + per-vehicle body color (TDD)

## Task spec (PLAN.md item 3)
- Toggle button `#btn-paths` (Paths: off) next to `#btn-values`; bind in main.js; handler in world.js flips `this.paths`.
- Recording: in `step()`, push `{x,y}` of each `inst.body.position` onto `inst.path` (init `[]` on creation). Cap ~2000 points (shift when exceeded). Clear `inst.path=[]` on `reset()`.
- Rendering: in draw (worldDraw.js) after bodies, gated by `this.paths`, stroke polyline per instance using vehicle body color alpha~0.5, lineWidth~2.
- Body color as vehicle option:
  - Data: `body.color` default `#4da3ff`; "Add Vehicle" cycles a palette so types are distinct.
  - Editor UI: inspector row `<input type="color" id="ins-body-color">` bound to `v.body.color` + refresh.
  - World render: replace hardcoded stroke `#4da3ff` with `v.body?.color ?? '#4da3ff'` (keep dark fill).

## Plan of attack
1. TDD pure helpers in prototypes.js: VEHICLE_COLORS palette, vehicleColor(proto), nextVehicleColor(protos), blankVehicle body.color. (RED then GREEN)
2. Wire HTML button + main.js ui + world.js (constructor paths flag, toggle handler, record-in-step with cap, clear-in-reset, addVehicle color cycle).
3. worldDraw.js: body stroke from v.body.color; path overlay gated by sim.paths (hexToRgba helper).
4. editor.js inspector: always-visible body-color row bound to v.body.color + refresh.
5. Smoke: assert distinct colors after Add Vehicle (proto.crud.mjs); assert path grows while stepping, finite, capped, cleared on reset (world.sim.mjs).
6. Full `npm test` + full `npm run smoke`.

## Checklist
- [x] Unit tests RED (color helpers missing)
- [x] Implement color helpers in prototypes.js
- [x] Unit tests GREEN (130/130)
- [x] index.html btn-paths
- [x] main.js btnPaths ui
- [x] world.js: paths flag, toggle handler, step record + cap (PATH_CAP=2000), reset clear, addVehicle color cycle
- [x] worldDraw.js: body stroke from v.body.color + path overlay gated by sim.paths + hexToRgba
- [x] editor.js: always-visible body-color inspector row (_bindBodyColor)
- [x] Smoke color assertion (proto.crud)
- [x] Smoke paths assertion (world.sim: record/finite/cap=2000/clear-on-reset/toggle labels)
- [x] smoke:world PASS (paths: record/finite/cap=2000/clear-on-reset/toggle labels)
- [x] smoke:crud PASS (colors: 3 distinct after Add Vehicle) — fixed missing IIFE `()` in colors eval
- [x] npm test all green (130/130)
- [x] full npm run smoke green (editor + world + crud; 1 recovered stall via RENAV)
- [x] PLAN.md item #3 marked DONE + Implemented bullet added

## Result
All green. TDD: 5 new unit tests for color helpers (RED->GREEN). Wired HTML button, main.js ui,
world.js (paths flag/toggle/record+cap/reset-clear/addVehicle-color), worldDraw.js (body stroke from
v.body.color + gated trail overlay + hexToRgba), editor.js (always-visible body-color swatch).
Smoke: paths (record/finite/cap=2000/clear-on-reset/toggle labels) in world.sim.mjs; distinct colors
in proto.crud.mjs (fixed a missing IIFE `()` that made the colors eval return a function).
