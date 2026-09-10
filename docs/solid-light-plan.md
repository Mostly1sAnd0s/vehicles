# Implementation Plan — Solid Body Toggle for the Light Source

> **STATUS: implemented, and rebased onto `d36ab99` mid-work** (the hollow-ring Bumper +
> Density slider — this feature was first built on a stale `bf02a21`). Shipped as **M8** —
> see `PLAN.md §M8` for the as-built notes and the places reality differed from this plan
> (an unscaled slider value, a `Number([]) === 0` coercion trap, a dropped `restitution`
> key, a dedicated probe, a per-run Chrome profile, and a verification pass that had to be
> redone because probes were attaching to stale browsers). The design rationale below is
> kept as-written because it is the reasoning, not a changelog.

**Feature:** make a world light source optionally *solid* — a real, collidable circular
barrier with an adjustable radius — so vehicles can bump into, rest against, and be
deflected by the lamp instead of driving through it.

**Motivation:** Braitenberg's stock situations frequently put the light source in the
world as a physical object (a lamp the vehicle bumps into and turns away from, a bulb it
circles, a "food" object it presses against). Today lights are pure field emitters with
no collision geometry, so those demonstrations are impossible: robots pass through the
sun. This is the light-side counterpart of the Bumper (`bf02a21`), which established
the repo's rule for such features: **the drawn visual and the physical barrier must be
the same number.**

---

## 1. Behaviour spec

A light element gains two properties:

| property | type | default | meaning |
|---|---|---|---|
| `properties.solid` | boolean | `false` | when true, the light carries a static physics body |
| `properties.radius` | number | config (24) | that body's collision radius, in world px, scaled by `el.scale.x` |

Precise semantics when `solid === true`:

1. The light **still emits light exactly as before.** Light sensing reads `snapshot.lights`
   only (`src/sensors/light.js`); adding collision geometry must not change a single
   sensor value. *This is the key regression invariant and gets its own test.*
2. The light **blocks rigid bodies** — vehicles, and any other solid thing — as a static
   circle, identically to a `rock` of the same radius.
3. The light **becomes a distance-sensor target** (a physical lamp is a physical object).
   This falls out for free from §3 and is intended.
4. The light **draws a ring at exactly `radius`** (scaled), over its glow, in the local
   world *and* the co-op world, running or paused.
5. When `solid === false` the element behaves exactly as it does today, byte-for-byte:
   no body, no ring, no raycast target. Existing worlds are unaffected.

Naming: `properties.radius`, not `solidRadius`. It matches the existing vocabulary for
`rock`/`obstacle` circle primitives, so `hitElement`, the snapshot, and the Matter body
builder all read the same field with no special-casing. The field is inert while
`solid` is off.

---

## 2. The single seam: `src/simulation/worldSnapshot.js`

Both physics engines derive their static bodies from **one pure function**:

- `WorldSim.buildObstacles()` (`public/app/world.js:66`) — browser / single-player
- `HeadlessWorld._buildObstacles()` (`src/simulation/worldSim.js`) — co-op server

Both call `worldElementsToSnapshot(elements).obstacles`. So the whole feature is
landed in that one light branch, which currently pushes a light and `continue`s:

```js
if (el.type === 'light') {
  lights.push({ x, y, intensity });
  if (isSolid(el)) obstacles.push({ type: 'circle', x, y, radius: solidRadius(el, configs) });
  continue;
}
```

That single change yields, simultaneously: local physics, server physics, distance-sensor
occlusion, and a renderable ring — with **zero** changes to either body builder, either
step loop, or the co-op wire protocol.

Two notes:

- `worldElementsToSnapshot` currently takes only `elements`. To be config-driven it
  needs the world config for defaults. Add an **optional second arg**
  `(elements, configs)` so all existing call sites keep working unchanged; every new
  read uses an inline fallback (`configs?.world?.light?.radius ?? 24`) so a caller
  that passes nothing still gets a sane number.
- Keep the emitted obstacle shape byte-identical to a rock's (`{type:'circle',x,y,radius}`)
  so nothing downstream can tell them apart.

### Pure helper (new, small)

`src/models/solidBody.js` — the shared, testable arithmetic:

```js
export function isSolidLight(el)                       // boolean coercion, strict
export function solidLightRadius(el, configs)          // clamp(props.radius ?? cfg, min, max)
export function pushOutOfCircle(center, radius, poses, clearance)  // §6 overlap fix
```

Keeping the clamp/coercion in one pure module means the inspector, the snapshot, the
renderer and the tests all agree on what "the radius" is — the same class of bug the
Bumper commit fixed (thumb, readout and physics disagreeing).

---

## 3. Config (no hard-coded tunables)

New `config/world.json` — the home PLAN.md always reserved for this and never shipped:

```json
{
  "schemaVersion": 1,
  "light": {
    "solid": false,
    "radius": 24,
    "minRadius": 8,
    "maxRadius": 240,
    "restitution": 0.05
  }
}
```

**Every consumer must treat it as optional.** Three loaders fetch a fixed list of config
files and must add `world`:

- `public/app/main.js:16-20` (`load('config/world.json').catch(() => ({}))`)
- `scripts/serve.mjs:108-115`
- `scripts/serve-coop-gateway.mjs:28-31`

…and four test files hand-build a `configs` object with **no** `world` key
(`tests/multiplayer.{client,gateway,sim}.test.js`, `tests/session.test.js`). Rather
than touch all four, the rule is: **every read is `configs.world?.X ?? <literal>`.**
That also makes an old `public/config/` checkout (synced before this file existed) keep
working. `scripts/sync-config.mjs` copies `config/*.json` wholesale, so it needs no
change.

*Minimal-diff alternative:* nest the same object under `config/app.json` →
`defaults.world`. Zero new loaders. Slightly worse semantics; call it the fallback if
you'd rather not add a file.

---

## 4. Changes by file

| File | Change |
|---|---|
| `config/world.json` | **new** — light solid defaults + min/max + restitution |
| `src/models/solidBody.js` | **new** — `isSolidLight`, `solidLightRadius` (clamped), `pushOutOfCircle` |
| `src/simulation/worldSnapshot.js` | solid light also emits a `circle` obstacle; optional `configs` 2nd arg |
| `public/app/worldInspector.js` | emit `#wi-solid` checkbox + `#wi-sradius` slider for lights; bind through the existing `bind()` helper (which already calls `buildObstacles()` + `renderInspector()`) |
| `public/app/worldDraw.js` | draw the solid ring over the glow; ring radius === collision radius |
| `public/app/world.js` | `hitElement`: a solid light grabs at `max(12, radius*scale)`; optional overlap push-out on toggle/reset |
| `public/app/main.js` | load `config/world.json` |
| `scripts/serve.mjs`, `scripts/serve-coop-gateway.mjs` | load `config/world.json` |
| `public/worlds/light-field.json` | optional: showcase a solid lamp so the sample demonstrates the feature |
| `tests/*` | see §7 |
| `README.md`, `PLAN.md` | document |

### Inspector UI (worldInspector.js)

Inside the existing `isLight` branch, after Intensity:

```html
<label class="check">
  <input type="checkbox" id="wi-solid" ${el.properties?.solid ? 'checked' : ''} ${ro}>
  Solid body (vehicles bump into it)
</label>
<label>Body radius
  <input type="range" id="wi-sradius" min="8" max="240" step="1" value="…" ${ro}>
  <span id="wi-sradius-v">24</span>
</label>
```

- Reuses `label.check` (the `#ins-digital` pattern from `editor.js:539`) and the
  range+readout pattern from the Bumper (`editor.js:627-636`, bound at `699-710`).
- The radius row is hidden (or `disabled`) while `solid` is off — never let the user
  tune a value that isn't doing anything.
- Both go through the existing `bind(id, fn)` helper, which already does
  `fn(...); sim.buildObstacles(); sim.renderInspector();` — so a toggle rebuilds the
  physics and repaints the panel in one line, and the read-only (co-op participant)
  path is already handled by `ro`.
- Checkbox handler must write a real boolean (`e.target.checked`), not a string —
  see §5.
- **Harden `el.properties` in this whole branch.** Today
  `${el.properties.intensity ?? 1}` throws on an imported light with no `properties`
  object at all. Fix with `(el.properties ??= {})` at the top of the branch — the exact
  bug class the Bumper commit hardened.

### Rendering (worldDraw.js)

Lights are drawn first, obstacles second, and `drawWorld` returns early for co-op
*after* static elements — so lights and obstacles already render in both modes. Add,
inside the light loop, after the glow:

- a filled dark disc at `radius` (so the lamp reads as an object, not just glow),
- a crisp outline ring at exactly `radius` (the barrier),
- `restitution`/color from config, and a subtle dashed outer hair when solid so it is
  distinguishable from a rock at a glance.

Draw it **after** the radial gradient so the ring is not washed out. Do not gate it on
`sim.beams` — the barrier is always visible, running or paused.

---

## 5. Co-op: no protocol change

The existing path already carries this feature end to end:

```
inspector → hooks.onElementChange({op:'update', id, patch:{properties:{solid:true}}})
  → CoopClient.updateElement            (src/net/client.js:174)
  → Session._updateElement              (src/session.js)  shallow-merges patch.properties
                                        and calls world.rebuildObstacles()
  → broadcast {type:'elements', elements:[…]}
  → joiner: state.world.elements = clone(…); worldSim.buildObstacles()
```

Verified-by-reading, but pinned with tests because two things are load-bearing:

1. **Shallow merge must carry an explicit `false`.** `{...props, ...patch.properties}`
   overrides correctly only if the client *sends* `solid:false`. Sending
   `{properties:{}}` or omitting the key would leave a previous `true` in place. So the
   checkbox always writes an explicit boolean and the patch always includes it.
2. **`rebuildObstacles()` on the server is what makes it real.** It already runs in
   `_updateElement`; a test asserts the static body count actually changes, so a future
   refactor that drops that call fails loudly instead of silently making co-op lights
   non-solid.

Also free: the host seeds `setElements` at host time, and joiners mirror on `welcome`,
so a solid light that existed before anyone joined crosses the wire too. Read-only
participants get the disabled checkbox from the existing `ro` pattern.

---

## 6. Edge cases

| Case | Handling |
|---|---|
| **Enable solid with a bot inside the radius** | Matter resolves the interpenetration by ejecting the bot violently. Use `pushOutOfCircle()` to move each overlapping live instance to `radius + clearance` along the light→bot vector with velocity zeroed (same "zeroed momentum" idiom as `moveBot` / drag-drop). Apply on the solid ON-transition only. |
| **Reset with a seed pose inside a solid light** | Same helper at reset time, or accept the gentle separation. Decide during implementation; the helper is shared either way. |
| **Imported light with no `properties`** | `(el.properties ??= {})` guard; `isSolidLight` returns false for anything not exactly `true`/`'true'`. |
| **Imported `solid: "true"` (string from JSON by hand)** | Coerce in `isSolidLight` (`v === true || v === 'true'`), then write back a real boolean on the next edit. |
| **NaN / out-of-range radius** | `solidLightRadius` clamps to `[minRadius, maxRadius]` and falls back to the config default for non-finite input — never emit `NaN` into `M.Bodies.circle`, which would poison the whole world. |
| **`el.scale`** | Radius scales by `scale.x` exactly like a rock's circle. |
| **Zoom / grab area** | Non-solid lights keep the current 12px handle; solid lights grab at `max(12, radius*scale)`. Do **not** make the glow a grab target. |
| **Two solid lights overlapping** | Both static bodies coexist; Matter is fine with static-static. |
| **Light deleted while solid** | Existing delete path rebuilds obstacles; body disappears. Covered by an existing-path test. |
| **Co-op participant toggles** | Inspector renders disabled; the server refuses non-admin `_updateElement` anyway (already tested pattern). |

---

## 7. Test plan (TDD — write these first)

**Unit (`npm test`, node --test, no framework):**

`tests/worldSnapshot.test.js` (extend)
- solid light emits **both** a `lights` entry and a `circle` obstacle at the same x/y
- non-solid / absent `solid` emits **no** obstacle (existing tests must not change)
- radius scales with `scale.x`
- missing `radius` → config default; `configs` arg omitted → built-in default
- non-finite radius → default, never `NaN`

`tests/solidBody.test.js` (new)
- `isSolidLight`: `true`/`'true'` → true; `false`/`'false'`/`1`/`0`/absent → per spec
- `solidLightRadius` clamps to `[min,max]`, honors config over built-in
- `pushOutOfCircle`: inside → pushed to `r + clearance` along the outward vector;
  outside → untouched; concentric (zero vector) → deterministic direction

`tests/solidLightSensors.test.js` (new — the invariant that matters most)
- `lightLevelNormalized` / `lightEffectiveRange` / `sampleLight` produce **identical**
  results for the same geometry with the light solid vs not (solidity never touches sensing)
- `castRay` **is** blocked by a solid light and **passes through** a non-solid one
  (documents that distance sensors now see the lamp, deliberately)

`tests/multiplayer.sim.test.js` / `tests/session.test.js` (extend)
- `HeadlessWorld`: a solid light yields a static body in `obstacleBodies`; toggling off
  removes it after `rebuildObstacles()`
- **physics assertion:** drive a bot straight at a solid light for N steps → its centre
  never enters `radius - ε`; the identical run with `solid:false` passes straight through
- `Session._updateElement` with `{properties:{solid:true}}` persists, broadcasts the
  boolean, and rebuilds; a follow-up `{solid:false}` **does** clear it (shallow-merge
  regression guard)
- non-admin `updateElement` still refused

**Smoke (headless Chrome, `npm run smoke`):**
- `tests/smoke/world.sim.mjs` — add a phase: select the light in the world → toggle
  `#wi-solid` → drag `#wi-sradius` → assert `el.properties.solid === true`, the radius
  landed on the element, `sim.obstacleBodies.length` grew by one, and a driven bot's
  min distance to the lamp ≥ its radius.
- `tests/smoke/coop.session.mjs` — host toggles solid; assert the joiner's mirrored
  element carries `solid:true` **and** the joiner's `buildObstacles()` produced the
  body (i.e. the property survived JSON round-trip through the gateway, not just the
  local object).

---

## 8. Phasing

**Phase 1 — the seam (core, no UI).** `config/world.json` + `src/models/solidBody.js` +
`worldSnapshot.js` + the three unit-test files. After this, `HeadlessWorld` already
simulates a solid lamp and the invariant tests pass. Nothing user-visible yet.

**Phase 2 — local UX.** Inspector checkbox + radius slider, the ring render,
`hitElement`, `main.js` config load. This is the demoable single-player feature.

**Phase 3 — co-op.** Tests only (no production change expected). If a test finds a gap
it will be in the boolean-explicitness or the rebuild call, both one-liners.

**Phase 4 — polish.** Overlap push-out on enable/reset, sample-world update, README +
PLAN.md, both smoke probes.

Each phase ends green on `npm test`; Phase 2+ also on `npm run smoke:world`, Phase 3/4 on
`npm run smoke:coop`.

---

## 9. Alternatives considered

- **A separate `type:'solidLight'` element.** Rejected: duplicates the glow render, the
  `addLight` button, the invite/seed/`setElements` shape checks and every
  `type === 'light'` test, for something that is a property of a light, not a new kind
  of thing. It would also silently split existing worlds' mental model.
- **Lights always solid.** Rejected: Vehicles 1–2 *approach* the light; making every
  lamp a wall turns every default demo into a collision test and breaks every saved
  world's behaviour. Default off is the only compatible choice.
- **Emit into a separate `snapshot.solidLights` array instead of `obstacles`.** The
  escape hatch if you want *physics-only* solidity that distance sensors do **not**
  see. Costs one extra array plus a change in both body builders, and breaks the
  "obstacles is the set of things rays and bodies collide with" invariant. Recommended
  only if the distance-sensor coupling turns out to be unwanted.
- **Reusing the Bumper component on a synthetic vehicle.** Rejected: a light is a world
  element, not a vehicle part; ownership, propagation, co-op element sync and the
  inspector all key off that distinction.

## 10. Explicitly out of scope (natural follow-ons)

- **Light occlusion / shadowing.** A solid lamp does not block *another* lamp's light,
  and a solid rock does not block light at all. Real occlusion means raycasting in the
  light model against `snapshot.obstacles` — a separate, larger feature (and it would
  change every existing light-sensor response near obstacles, so it needs its own
  toggle and its own discussion).
- **Non-circular light bodies** (rect/polygon lamps) — blocked anyway by the raycaster's
  pending polygon work listed in README's Next.
- **Per-light mass / dynamic lamps** (a light you can push). Static-only for now.
- **Solid obstacles affecting the Propagator's range.**
