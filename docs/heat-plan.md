# Implementation Plan — Heat Source + Heat Sensor

> **STATUS: shipped as M9.** Two features: (A) the heat source / heat sensor described here,
> and (B) co-op fleet organising (`Random` / `Line Up` / `Grid` for *all* bots) — §B below.
> As-built notes, the calibration mis-step and the bugs found on the way are in
> `PLAN.md §M9`. Verified by `tests/heat.test.js` (27), `tests/heatSensor.test.js` (20),
> `tests/formation.test.js` (16), `tests/coop.arrange.test.js` (14), `npm run smoke:heat`
> (12 phases) and `npm run smoke:arrange` (10 phases).

## A.1 What "detects heat in a physics-correct manner" is taken to mean

A light sensor in this app reads `intensity / r^p` summed over sources, mapped to [0,1].
Copying that shape with a different colour would *not* be heat physics — it would be the
light sensor with a new name. Heat differs from light in four ways that are each real,
each cheap to compute, and each visible in behaviour:

1. **A temperature, not a glow.** A heat sensor reads degrees. There is an **ambient
   temperature**: a world with no sources reads ambient, *zero*, and a source at ambient
   emits nothing detectable. Light has no such baseline (a 0-intensity lamp is just off).
2. **Emission is Stefan–Boltzmann, ∝ T⁴** (net over the environment: `T_s⁴ − T_amb⁴`).
   This must be computed in **kelvin** — `(80°C)⁴` is nonsense, and `(353K)⁴` is the physics.
   It is what makes a 300 °C source overwhelmingly stronger than a 60 °C one, far more
   than a linear "intensity" would suggest.
3. **Propagation is radiative (inverse-square) but the medium absorbs.** Thermal IR is
   attenuated by air (Beer–Lambert `e^(−r/L)`), so heat is sensed over a shorter reach than
   light of comparable strength. `L` is a config length; `Infinity` disables it.
4. **A real thermometer has thermal mass.** This is the big one, and the lumped-heat-
   capacitance method (Incropera §5.3) is the standard model:

   The probe exchanges radiation with every source AND leaks passively to the environment:

   ```
   C · dT/dt = Σ_i α·F_i·σ·(T_s,i⁴ − T⁴)  −  h·(T − T_amb)
   ```

   Note the `− T⁴`: the probe radiates BACK. Linearising each exchange about the ambient
   temperature (`σ(T_s⁴−T⁴) ≈ (T_s²+T_a²)(T_s+T_a)·(T_s−T)`) turns this into a sum of
   conductances feeding one node, which again has a closed form and so integrates exactly:

   ```
   Ĝ_i  = coupling · F_i · (T_s² + T_a²)(T_s + T_a) / (4·T_a³)     (≥ 0, = 1 at ambient)
   T_eq = (Σ Ĝ_i·T_s,i + T_amb) / (Σ Ĝ_i + 1)                      (steady state)
   T(t+dt) = T_eq + (T(t) − T_eq) · e^(−dt/τ)                       (exact for a step)
   ```

   **Why the obvious version is wrong.** The first cut dropped the `−T⁴` and wrote
   `C dT/dt = α·A·E − h(T − T_amb)`, giving `T_eq = T_amb + (αA/h)·E`. It is a perfectly
   ordinary textbook lumped model, and it is unphysical HERE: `E` grows without bound as the
   probe approaches a source (1/r²), so a robot driving over a 220 °C furnace reported
   ~4800 °C. Flux is not heat. A passive probe in the radiation field of one body can never
   exceed that body's temperature — the second law shows up as a *ceiling on the readout*, and
   the weighted-mean form has that ceiling built in rather than clamped on afterwards.
   (`clamp(T_eq, …, T_source)` would have hidden it while destroying cold sinks: a probe near
   a sub-ambient trap must read BELOW ambient.)

   Consequences, all of them physically true and none of them available to a light sensor:
   the reading **lags** when a vehicle moves, it **rings down** after it leaves a heat zone,
   a pulse of short exposure **accumulates**, and several sources settle at **one equilibrium
   temperature between them** rather than two independent brightnesses. A cooling probe
   legitimately reads ABOVE its cooler surroundings for a few hundred milliseconds — the bound
   is on the equilibrium, not on the instantaneous reading, and both are asserted.

Everything is config-driven (`sensors.json → heat`), and `τ = 0` degrades the model to a
purely instantaneous radiative sensor, so the inertia can be dialled out without code.

### Honest limits of the model (documented, not hidden)
- **Units are pixel-space.** `σ`, `α`, `h`, `C` are bundled into three tunables
  (`radiationConstant`, `coupling`, `timeConstantMs`) because the sandbox is in px and
  frames, not metres and seconds. The *shape* of the physics is exact; the scale is
  calibrated, like every other model in this repo (`thrustScale`, `falloffPower`).
- **Conduction/convection through the medium is not modelled** — only radiation + the
  sensor's own response. A heat source in a closed box still warms the box's air in
  reality; here it does not.
- **Obstacle shadowing is optional and OFF by default** (`occluded: false`), matching the
  light sensor's simplicity. Flip it on and walls cast a thermal shadow via the existing
  raycaster — radiation *is* blocked in reality; conduction around a wall is what isn't
  modelled, so shadowing is only "correct" for the radiative component.
- **The source is a point.** Its own radius affects its drawn size (and collision, if
  solid) but not its emission profile.

## A.2 Where it plugs in (each seam already exists)

| Concern | Seam | Note |
|---|---|---|
| element → sim data | `worldSnapshot.js` (THE single seam) | emits `heats:[{x,y,temperatureK,...}]` next to `lights` |
| solidity | `models/solidBody.js` | generalised to `light` \| `heat`; **ring === barrier** carries over unchanged |
| sensing | `sampleSensors.js` | `heat_sensor` branch; **light sensors never receive `heats`**, so the two fields are physically separate by construction |
| sensor state | new optional 4th arg `sensorStates` | `evaluateVehicleSensors` is otherwise pure, and both engines call it with a *fresh* `{...v, pose}` object every tick, so state cannot ride on the vehicle — the engine owns a `Map` per instance and **clears it on reset** |
| editor | `components.json` + palette + inspector | `heat_sensor`, `modelRef: "sensors.json#heat"` |
| drawing | `worldDraw.js` | amber glow distinct from the light's white; °C in the values overlay |

Sensors are keyed by **component id** in the state map, and ids not present on the vehicle
are pruned, so deleting a sensor cannot leak state into its replacement.

## A.3 Tests (the physics is only "correct" if it is pinned)

- Kelvin, not Celsius: a 0 °C source still radiates (273K); a source at exactly ambient
  contributes nothing.
- Stefan–Boltzmann: doubling absolute temperature multiplies flux by 16, not 2.
- Inverse square: 2× distance → ¼ flux; air attenuation `e^(−r/L)` verified against the
  closed form.
- Step response: after exactly one `τ` the sensor has covered **63.2 %** of the gap to
  equilibrium (first-order systems are defined by this), and converges to `T_eq`.
- Equilibrium matches the closed form (the conductance-weighted mean) to numerical precision.
- **The bound**: for every combination of source temperature, distance (0.01 px → 5000 px) and
  coupling (up to 1000), the equilibrium is strictly below the hottest source and above the
  coldest; `stepSensorTemperature` rejects a bare flux number rather than re-deriving an
  unbounded one; and a threshold at or above a source's own rise yields *no* reach, not an
  infinite one. Reported by a player and reproduced in `npm run smoke:heat` phase 8b, which
  cold-soaks the probe in the running app and then parks it on the furnace.
- Ring-down: sources removed → decays back to ambient, never below it.
- Superposition: two sources → one equilibrium between them.
- **Blindness both ways**: a light sensor reads 0 next to a heat source; a heat sensor
  reads ambient next to a bright lamp.
- Junk hardening: NaN/negative/absurd temperatures cannot produce NaN on the wire
  (same lesson as the solid-light radius — `properties` is shared, and a NaN that reaches
  the actuator freezes a robot silently).
- Reset clears thermal state (a sensor does not resume hot).
- Snapshot: `heats` present, `lights` unaffected, solid heat emits a rock-identical circle.

## B. Co-op fleet organising (Random / Line Up / Grid for everyone)

Single-player arranges **one prototype** at a time (`WorldSim.protoAction`). Co-op needs the
same three layouts applied to **every bot in the world**, which is a different scope: the
authoritative poses live on the server, and seeds must move too or Reset destroys the
formation (a bug the single-player code documents — it used to write only the running seed).

- New pure module `src/models/formation.js`: `formationPoses(n, mode, center, opts)` →
  `[{x,y,rotation}]`. Single-player is refactored onto it so there is **one** definition of
  "line up" and it cannot drift between the two modes.
- `HeadlessWorld.arrangeAll(mode, center)`: teleports every instance (position + angle,
  **momentum zeroed** so a fast bot does not fling out of the formation), writes
  `inst.seed` **and** the documented `proto.instances[i]` so Reset keeps it and saves keep it.
- `Session._arrangeBots` — **admin-only**, like every other world-mutating command; validates
  the mode and a finite centre (the host's camera centre rides along, so bots gather where
  the host is looking, matching single-player muscle memory); broadcasts an authoritative
  snapshot so joiners see it land immediately.
- UI: a host-only row in the co-op pane, hidden for participants (the server enforces it
  regardless — the UI is courtesy, the session is the gate).
