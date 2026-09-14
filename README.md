# Braitenberg Vehicles Simulator

Self-hosted, client-side SPA for constructing and simulating Braitenberg-style
vehicles — snap-on components, explicit sensor→actuator wiring, **combinational
logic gates** between them, a non-monotonic **Neuron** transfer block, a special
**Propagator** component that lets one robot clone its whole configuration onto
nearby neighbours, and a 2D physics world with light sources, obstacles, and
multiple vehicle types. Plus an optional **co-op mode**: one WebSocket gateway
hosts many 6-char coded worlds that participants join from their own browser, with
the server running the single authoritative simulation. See `PLAN.md` for the full
design and current status.

Requires Node 22+ (developed on Node 26). Only two deps: `matter-js`, `ws` — both
in `dependencies`, not dev: the co-op gateway imports `matter-js` at runtime, so a
production `npm install --omit=dev` must still yield a working server.

## Run

```bash
npm run build    # sync config/ -> public/config, link src/ -> public/src (pure ESM core)
npm run serve    # the SPA + the co-op gateway, on ONE port
```

One command, one port, one process. `PORT=<n>` pins a port (otherwise it probes
up from 8080), `HOST=127.0.0.1` restricts it to this machine, `NO_COOP=1` serves
the SPA without the shared-world sim. The startup banner prints the local URL plus
one line per LAN interface — that LAN URL is what you hand to participants.

**Hosting:** open the app → World → **Co-Op** tab in the sidebar → **Host**. You get
a 6-char world code and an invite link, e.g.
`http://192.168.68.67:8080/#join=K7M2QF` — **Copy** it and send it to anyone on
your network. Opening that link loads the app *from your machine* and joins the
world with no further clicks. You are that world's host (admin): you run
Play/Pause/Reset, edit the shared elements, and set other participants' clone
counts.

**Joining:** open the invite link, or open the app and enter the world **code**
and press **Join**. No address to type: the page's own origin *is* the gateway.
Only if your page came from somewhere else (a different server, a file on disk)
does **Advanced → Host address** matter; it accepts `192.168.1.20`,
`192.168.1.20:8080`, `host.local`, a `ws://` URL, or a whole invite link, and
remembers an override only when you set one.

> macOS will ask whether Node.js may accept incoming network connections the first
time you host — click **Allow**, or participants can't load the page at all.

`npm run serve:coop` still exists as a **standalone gateway** for the rarer case of
a box that hosts worlds but serves nothing (defaults to `ws://127.0.0.1:8090`,
`COOP_HOST=0.0.0.0` for LAN, `COOP_PORT` to move it); point the Advanced field at
it. For real deployment copy `public/` to a web root (nginx/Caddy/anything static)
— with `wss://` the client uses a secure socket automatically — and run the gateway
beside it. `GET /info` reports the advertised host, port and world count; `GET
/health` reports `{worlds:<n>}` on the standalone gateway.

No build step is required at runtime — vanilla ES modules + vendored Matter.js.
(`public/src` is a symlink to `../src` created by `build`; it is git-ignored — do
not commit it, and a checkout needs `npm run build` before the page resolves
`./src/…` imports.)

## Test (TDD)

```bash
npm test                 # 495 unit tests (node --test, no framework)
npm run smoke            # all twelve headless-Chrome probes below, in sequence
npm run smoke:editor     # place + drag-snap + wire, gates + slots, body color via UI
npm run smoke:world      # sim runs; sensor/motor polarity, detection, propagation
npm run smoke:crud       # add/remove vehicle types, drag a running robot to reposition
npm run smoke:neurons    # Neuron response editor + "Add Output" multi-output taps
npm run smoke:tabs       # Sandbox/Co-Op sidebar tabs, design row, Deploy gating
npm run smoke:solid      # solid light: inspector toggle, ring===barrier, bump-and-stop,
                         #   eviction, and the soft-light control run
npm run smoke:heat       # heat source + heat sensor: element, popup, solid furnace blocks a
                         #   robot, thermal lag, Reset cools the probe, and light sensors are
                         #   provably blind to the furnace
npm run smoke:arrange    # co-op fleet organising (2 pages + gateway): host-only row, every
                         #   bot of both participants laid out, seeds follow so Reset keeps it
npm run smoke:coop       # co-op panel: host→code, deploy, fleet ±/✕, element sync, prune+GC
npm run smoke:lineage    # propagation lineage: host deploys a Propagator design, joiner a plain
                         #   one; conversion moves the COUNT to the converter's row on both
                         #   screens (2/2 → 4/0), ownership never moves, Reset restores 2/2
npm run smoke:merged     # `npm run serve` itself: one port serves SPA + /info + WebSocket,
                         #   invite link built from /info, zero-click join, leave-means-leave
```

`npm run smoke` also runs `tests/smoke/coop.session.mjs` (no `smoke:` alias of its
own) — the strictest probe, since it drives **two** real browser pages (host +
joiner) against a real in-process gateway through the whole co-op bug list.
`merged.serve.mjs` is the only probe that spawns the real `scripts/serve.mjs`
rather than an in-process gateway, so it is the one that would catch a broken
startup path.

Smoke tests are self-contained (each starts its own static server and drives
headless Chrome over raw CDP — no Puppeteer) and need a Chrome/Chromium at the
`CHROME` constant in each script — the macOS Google Chrome path by default, or
point `CHROME=/usr/bin/chromium-browser` (or any build) at a different one. Each
probe owns its own web port (8901–8905, 8907, 8915, 8925, 8935 — no two probes share
one), CDP debug port, and Chrome profile dir (plus a gateway port for the co-op
ones — `coop.panel` 8961, `coop.session` 8963, `world.tabs` 8975) and cleans up
after itself, so the sequence inside `npm run smoke` can never race on a port.
Stale headless Chrome is the usual cause of "devtools not reachable"; each probe
`pkill`s only its own profile.

`smoke:solid` takes the profile name one step further and uses a **unique profile per
run** (`/tmp/bv-profile-solid-<pid>`). `python3 -m http.server` sends no
`Cache-Control`, so a reused profile lets Chrome's heuristic caching serve a
world/config JSON captured on an earlier run — the app then edits a stale document and
the probe fails for reasons that have nothing to do with the code under test. If you
add a probe that asserts on a file under `public/`, give it a fresh profile too.

That hazard is REAL, not theoretical, and it has two halves — both were measured while
writing the solid-light work, and each produced a probe result that was flatly wrong:

- **Stale files from a reused profile.** A probe asserted a light's popup had no Rotation
  field, and it kept failing — while a `fetch(..., {cache:'no-store'})` of the same module
  in the same page showed the new code. The page had been served the old module out of the
  profile's cache. `coop.session` deletes its profile at startup, but a Chrome still dying
  from the PREVIOUS run re-creates it (with its cache) after the `rm`; the reset has to
  wait for the old browser to actually exit, or use a unique name per run.
- **Attaching to a stale page.** Every probe's CDP port is fixed, and Chrome exits quickly
  but `chrome --remote-debugging-port` takes a moment to release it. If anything is still
  listening when a probe starts, `GET /json` answers and the probe drives **that** page —
  possibly one loaded from an entirely different checkout — and reports green. So
  `smoke:solid` frees its CDP port before launching and puts a unique `?nc=<runid>` on its
  URL, then refuses to proceed unless the page it attached to reports that same nonce.

A third variant is **mixed caching**, and it looks exactly like a code regression: a probe
edited `main.js` and `index.html` together, and the page came up with the NEW `main.js` and
the CACHED `index.html` — so the app threw `CoopPanel: missing UI element "arrange"` for
elements that were demonstrably in the file on disk (confirmed by `curl`). When HTML and JS
must change together, a reused profile can serve them from two different runs.

The rule when a probe disagrees with the source you can read: **distrust the probe**. First
`curl` the file from the probe's own port (is the SERVER right?), then check
`curl http://127.0.0.1:<cdp>/json` for the page URL, then who owns the web port — and only
then touch the code. Killing leftover Chromes and `rm -rf`-ing the fixed profiles between
runs is a 30-second habit that saves an hour of debugging a bug that does not exist.

## Layout

```
config/                 JSON config (source of truth)
  app.json                fixed timestep, snap-point count, misc app defaults
  components.json         every placeable part + logic gates + Neuron + Propagator
  sensors.json            light / heat / distance / vehicle-detection sensor models
                          (heat carries the thermal constants: ambientTemp, coupling,
                          timeConstantMs = the probe's thermal inertia, attenuationLength for
                          air absorption — OMIT it for transparent air; outputSpanC sets what
                          counts as full-scale)
  actuators.json          powered-wheel model (power, friction, power curve)
  world.json              world-element defaults per emitter type (light, heat): the solid
                          radius, its min/max bounds, eviction clearance, and for heat the
                          default temperature and its min/max. OPTIONAL at runtime: every read
                          falls back to a built-in, so an old public/config/ checkout still boots
  ui.json                 keyboard shortcuts

src/                    testable core (pure ESM, no DOM) — linked in as public/src
  actuators.js            the actuator model — computeActuation (value × weight ×
                          polarity × powerCurve, clamped), applyMotorPower,
                          wheelFrictionAir, actuatorPolaritySign (the "single seam")
  models/snapPoints.js    perimeter snap-point generation (corners + body centre)
  models/vehicle.js       pose math, component transform resolution
  models/wiring.js        wiring validation (duplicates, port-type mismatch, weight,
                          dynamic multi-output taps via outputPorts)
  models/hitTest.js       component footprints, nearest snap, instance hit-testing
  models/solidBody.js     the solid-light numbers: isSolidLight, solidLightRadius
                          (clamped, scaled, never NaN), authoredLightRadius (what the
                          slider binds to), solidLightCircles, pushOutOfCircle — pure,
                          so the drawn ring, the readout and the Matter body cannot
                          disagree
  models/lineage.js       the converted-bot tally: lineageOf / lineageCounts. A bot a
                          Propagator converted COUNTS for the converter's proto
                          (transitively along the conversion chain) — the "survival of
                          the fittest" scoreboard; ownership (protoId/owner) never moves
  sensors/light.js        distance-normalized level, effective range (drives beam
                          length), cone helper (inFov)
  sensors/raycast.js      ray vs circle / rotated rect (pure geometry)
  sensors/polarity.js     forward/inverted sensor sign conventions
  sensors/vehicleDetection.js  cone + range test that detects another vehicle
  simulation/sampleSensors.js   per-step sensor evaluation for a vehicle pose
  simulation/logic.js     gate truth tables, topological eval (cycle-safe), the
                          Neuron's analog branch, and the Propagator core
                          (signature / target select / deep clone)
  simulation/transfer.js  Neuron response curves: bell / triangle / custom spline
  simulation/worldSnapshot.js   world elements -> {lights, obstacles}. THE seam for
                          static geometry: both engines build bodies from it, so a
                          rule added here lands in single-player, the authoritative
                          co-op world and the raycaster at once
  simulation/worldSim.js  HeadlessWorld — the whole per-step loop, Node-runnable
                          (matter step, friction, propagation, sensor→logic→motor)
  session.js              Session — transport-agnostic co-op rules: participants,
                          ownership, deploy, admin-only controls, element edits
  net/gateway.js          co-op transport: Map<code, Session>, host/join handshake,
                          roster fan-out, one step+broadcast loop for all worlds;
                          owns its http server OR attaches to an existing one
  net/client.js           CoopClient — the socket core, runs in page and under node
  net/invite.js           LAN addressing: host-address parsing, invite links, and
                          which interface to advertise (no Node/DOM — shared by both)

tests/                  unit tests (node --test) + headless Chrome smoke probes
scripts/
  serve.mjs               the one server: static public/ + GET /info + co-op gateway,
                          same port (auto port scan, no-store, LAN-open by default)
  serve-coop-gateway.mjs  OPTIONAL standalone gateway (a host that serves no files)
  sync-config.mjs         config/ -> public/config

public/                 the static site
  app/                    main.js (bootstrap), editor.js, world.js (Matter glue),
                          worldDraw.js, worldInspector.js, prototypes.js,
                          coopPanel.js, color.js
  vendor/matter.min.js    vendored physics engine
  config/                 copy of config/ (made by `npm run build`)
  vehicles/, worlds/      sample documents (sun-car, light-field; JSON import/export in UI)
```

Simulation loop: fixed timestep (`config/app.json`). Each step runs Matter.js,
then **configuration propagation** (Propagators clone nearby robots), then
`samples sensors → resolves logic/gates/Neurons topologically → actuator forces`,
using the tested core. In single-player the browser runs this loop; in co-op the
**server** runs the identical loop (`HeadlessWorld` → `Session`) and broadcasts
~15 Hz snapshots that carry bot poses **plus** per-bot sensor samples and motor
forces, so beams, on-body values and paths render for everyone's robots. The
editor and world share one state object; edits in the editor propagate to every
running instance of the owned prototype on save.

## Status / next steps

Done (single-player):
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
- **Neuron (Vehicle 4)**: a floating non-monotonic transfer block between sensor
  and motor — `bell` / `triangle` / `custom` spline response, peak-threshold and
  sigma sliders, draggable spline nodes; output clamped to [0,1] so polarity and
  weight stay `computeActuation`'s job. Plus **multi-output taps**: any output
  component can grow `out`, `out1`, `out2`… and each downstream input picks a
  specific tap
- **Configuration propagation ("Propagator")**: a special component that copies
  its host's full config onto any robot whose config differs within range — a
  true clone (it carries the Propagator onward), modelling one seed spreading
  through a population. The trigger radiates from the part itself, not the body;
  a dashed ring shows the live boundary in both the editor and the world; a
  status pill reports converted/total; `reset()` restores the initial mix
- **Vehicle detection sensor**: FOV-cone + range sensor that detects another
  vehicle (aim/range/FOV, cone beam viz, on-body readout)
- **Bumper (hollow-ring force barrier)**: a passive part drawn as an outline ring at its live
  per-instance Radius. It is *not* a solid Matter part — each step the ring pushes back any
  other bot that crosses it, with its body parts *or its own bumper rings* (rings push
  rings; the bumper's own vehicle is exempt, and the ring's interior is passable). The
  **Density** slider (0.1–50, default 10) sets the ring's stiffness: 50 is effectively
  solid, 10 holds a top-speed bot, low values let a fast bot push through — so swarms
  squish against each other at ring distance instead of tunnelling through, and
  radius/density edits apply on the very next step with no physics rebuild
  (`src/simulation/bumpers.js`)
- **The world popup says only what a shape can actually do**: a light source no longer
  offers a Rotation field — a circle looks identical at every angle, and its `rotation` fed
  `distanceTo` FOV gating, `sensorAngles`/`aimVector` (a circle has no aim), the `r` field
  of a serialized world and the editor's rotation handle, and NOTHING drew a light rotated
  or read it for physics. It was a control whose entire effect was a number in a file, so it
  is gone for lights (obstacles keep theirs — a rect genuinely turns). To keep that from
  being an untested opinion, `coop.session` now asserts a light popup has **no** `#wi-rot`
  and takes its rotation-sync coverage from a rect wall, which still has and needs one.
- **Sliders stay inside the popup**: the popup is 200px and the global `input[type=range]`
  was `width:240px` — the Body-radius slider used every pixel of its label and then ran off
  the right edge, because the label is a flex row that never clamped its child. Fixed with
  the `min-width:0` + `flex:1 1 auto` pattern the Editor popup already used, so it holds for
  any future slider row and any label length, and it was verified by MEASURING the slider
  against the popup box in the browser (it was 89px wide and overflowing by 14px before).
- **Heat source + Heat sensor** — real thermal physics, not the light sensor re-skinned. A
  heat source radiates and a heat sensor reports the temperature of its own probe, so four
  things are true here that are not true of light: there is an **ambient** temperature (a
  world with no sources reads room temperature, and a source *at* ambient is undetectable);
  emission is **Stefan–Boltzmann** `T⁴` computed in **kelvin**, so a 300 °C furnace is far more
  than 5× a 60 °C one; propagation is inverse-square but the air **absorbs infrared**
  (`e^(−r/L)`, off by default); and the probe has **thermal mass**, a lumped-capacitance body
  exchanging radiation with what it sees, integrated exactly — so the reading **lags** when a
  vehicle moves, **rings down** when it leaves, **accumulates** over repeated passes, and two
  fires settle at **one equilibrium** between them. That equilibrium is a conductance-weighted
  **mean** of the source and ambient temperatures, never `ambient + gain·flux`: flux diverges
  as a probe closes on a source, and a passive sensor **cannot** read hotter than the hottest
  thing it sees (parked on a 220 °C furnace it settles at 218 °C, not 4800). `τ` (the
  `Response` field) means what a datasheet says: one τ covers 63.2 % of the gap; `0` gives an
  instantaneous probe. Note a *cooling* probe legitimately reads above its cooler surroundings
  for a while — that is the thermal mass, and it is asserted as deliberately as the bound. Being a circle, it
  gets the same popup rules as a lamp — Temperature (config-bounded, and a value **below**
  ambient makes a genuine cold sink), no Rotation, and an optional **Solid body** sharing the
  ring-equals-barrier rule. The two fields are separate arrays in the world snapshot, so **a
  light sensor cannot see heat and a heat sensor cannot see light** by construction, not by
  tuning (probed in the browser: light readings bit-identical while a furnace goes 60→2000 °C).
  Model, calibration and limits: `docs/heat-plan.md`, `src/sensors/heat.js`, `tests/heat.test.js`
- **Fleet organising in a hosted co-op world**: the host gets **Random / Line Up / Grid** in
  the Co-Op pane, and unlike the Sandbox buttons (which lay out one prototype) these arrange
  **every bot in the world**, from every participant, grouped so each person's fleet holds one
  contiguous stretch. Layout centres on the host's camera, so bots gather where they are
  looking. Host-only on the server, because it moves other people's bots — hidden for
  participants, refused if they call it anyway, with nothing moved. The poses are written to
  each bot's **seed** as well as its body (with momentum zeroed, so a fast bot cannot fly back
  out of the line), which means **Reset keeps the formation**: the layout becomes a property of
  the world rather than a momentary glimpse. Both surfaces share one layout module
  (`src/models/formation.js`), so "Line Up" cannot come to mean 130px here and 90px there
- **Solid light sources**: any light can be made a real object a vehicle bumps into —
  an inspector **Solid** toggle plus a radius slider (config-bounded, default 24, and
  contained inside the popup rather than overflowing it). A light no longer offers a
  **Rotation** field — it is a circle, so the control was meaningless; obstacles keep
  theirs. Off is the default, so existing worlds are untouched. Solidity adds a static body
  and a ring drawn at *exactly* that radius; it never changes what a light sensor
  reads (pinned by `tests/solidLightSensors.test.js`), and it does make the lamp a
  distance-sensor target, because a physical lamp is a physical object. Switching it
  on under a parked robot nudges it out to barrier + clearance with momentum zeroed
  instead of letting Matter fling it, in both engines
- Per-vehicle **body color** (fill + lightened outline) via an always-visible 4x4
  swatch palette; the editor canvas and the world render the same color
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

Done (co-op, milestone **M5**):
- **One gateway, many worlds** (`src/net/gateway.js`): first message
  `{type:'host'}` creates a world and returns its 6-char code (that client becomes
  its admin); `{type:'join',code}` enters one. Every join/leave fans out
  `roster`; a leaving socket's bots are pruned, an emptied world is reclaimed.
- **Co-op lives in the World sidebar**, Sandbox/Co-Op tabs; the World canvas *is*
  the shared world (the old standalone Co-op tab is gone).
- **Server-authoritative sim**: Play/Pause/Reset forward to the session while
  connected and the buttons follow the authoritative `state {running}`; deployed
  bots sense lights, fire motors and collide with walls in the *shared* world.
- **Deploy model, then live-sync**: "Edit my design" opens the editor on your own
  co-op doc, "Deploy design" pushes it and rebuilds your clones in place, keeping
  each clone's pose/momentum. Before the first deploy, editing touches nothing;
  after it, live edits auto-redeploy (throttled ~400 ms, content-signature
  guarded), so picking a body color in the editor updates your running shared bot
  within ~400 ms — no second "Deploy design" click.
- **Ownership**: every bot has exactly one owner; deploy is owner-only by
  construction (no protoId on the wire). Participants select but cannot drag
  elements (read-only inspector), cannot run the session, and their local bots
  are untouchable while connected.
- **Element sync**: the host's whole world is seeded at host time (`setElements`)
  and thereafter mirrored; element drags stream live (~30 Hz) rather than
  teleporting on mouseup; joiners mirror immediately on welcome. A light's
  **Solid** flag rides this existing channel with no protocol change —
  `_updateElement` shallow-merges `patch.properties` and calls `rebuildObstacles()`,
  so the shared world's physics is the one that moved. Two contracts are load-bearing
  and tested: the client must send an *explicit* `solid:false` to revoke it (an
  omitted key would leave a stale `true`), and evicting bots happens on the
  ON-transition only, never on the drag stream (that would pin them in place at 30 Hz).
- **Host fleet management**: `#remote-fleet` lists every participant's prototype
  with a live bot count; the host gets −/+/✕ plus a typeable exact-count input
  per row (`setCount`, clamped 0–50), never edit. The count follows the
  **propagation lineage** (M11): a bot a Propagator converted counts for the
  converter's proto — transitively, so a "survival of the fittest" run shows the
  live scoreboard (A converts one of B's bots ⇒ A's row 11, B's 9). Only the count
  moves: `protoId`/`owner` never do, so deploy, ±/✕ and prune-on-leave keep
  targeting the deployer, and −/+/✕ still size the *real* fleet. `reset()` restores
  every lineage to its origin, exactly as it restores the designs.
- **Host leaves → everyone goes home**: `worldClosed` broadcast, sockets
  terminated, world reclaimed, joiners get their pre-join "home" world restored.
- Shared-bot rendering with each participant's hue, per-bot beams/values,
  client-side trails, and a popup that keeps ticking (X/Y/Rot) while the host
  drags that bot.

Done (serving):
- **One command, one port**: the co-op gateway runs inside `npm run serve`
  (`ws` attaches to the static server and consumes only the HTTP `upgrade`
  event). The payoff is not fewer terminals, it is that *a participant who can
  load the page can reach the shared world* — one address, no second port to
  open or mistype. Mechanics in "Co-op on one port" below.

Next:
- Rotate handles for components in the editor
- Polygon world primitives (raycast + Matter already support them)
- More Braitenberg vehicle presets (1–7)
- Motor-response scripting / decision-table layer (thresholds, dead-bands,
  conditionals) to generalize `value x weight x polarity x powerCurve` for
  Vehicles 6/7 — keep `computeActuation` as the single seam
- Per-actuator visual spin direction fully decoupled from force sign
- Keyboard shortcut polish, camera collapse on play, recent-file thumbnails
- **Light occlusion / shadow casting** — deliberately NOT done with solid lights: a
  solid lamp blocks bodies and distance rays, but not light. A solid rock casts no
  shadow either. Real occlusion means raycasting inside the light model against
  `snapshot.obstacles`, which would change every existing sensor response near an
  obstacle, so it needs its own toggle and its own discussion

## Co-op on one port (how it works)

- **Attachment, not a second listener.** `createCoopGateway({ server })` attaches a
  `WebSocketServer` to the caller's `http.Server`; `ws` handles only the `upgrade`
  event, so the static `request` handler is untouched and `GET /` keeps working
  before, during and after a WebSocket session. An attached gateway never closes
  the server it was handed. Standalone mode (`{ port }`) still works unchanged —
  that is what every co-op unit test and smoke probe builds.
- **`GET /info` is why no address field is needed.** A browser cannot ask what its
  own LAN IP is, so the server answers `{host, lan[], hostnames[], port, wsUrl,
  coop, worlds}`. `pickLanInterfaces()` ranks interfaces (prefer `en0`/`eth0`/
  `wlan0`; drop `utun*`, `awdl*`, `llw*`, bridges, `vmnet`/`docker`/`veth`, hotspot
  `ap*`, loopback, `169.254.*`) because "first IPv4" on a laptop with a VPN up
  advertises an address nobody can join.
- **Invite links are self-describing.** A host never publishes `localhost`: the link
  comes from `/info`, and a multi-homed host gets clickable "other networks" chips
  to choose which network to advertise. A joiner's link points at the gateway they
  actually connected to, so forwarding it works.
- **`#join=CODE` auto-joins on load** (`autoJoinFromLink`), with your remembered name
  or the same `Bot-NN` the form would have used, and brings the World view up first.
  The hash survives a successful join (a refresh rejoins the world) and is cleared by
  Disconnect, so *leave means leave*; a failed auto-join clears it too, so a dead
  link cannot retry itself on every refresh.
- **Advanced → Host address** is the escape hatch: empty means this page's origin,
  and a value is persisted only when it is a real override. The legacy
  `bv.coop.url` is migrated, and the old `ws://127.0.0.1:8090` default is *dropped*
  rather than migrated — otherwise it would silently shadow the automatic address.
- **LAN-open by default**, since hosting to other people is the whole point.
  `HOST=127.0.0.1 npm run serve` locks it to the machine; there is no auth — this is
  a classroom/LAN tool, not an internet service.
- **Failure isolation inside the shared process**: a world's step or snapshot throw
  is caught, logged once per distinct error, and stops only that world
  (`onStepError`) — an uncaught exception would now take the file server with it.
- **Copy** uses the clipboard API when the context is secure and falls back to a
  selection + `⌘C` instruction otherwise; a plain-`http` LAN is not a secure
  context, so the fallback is the normal path, not a rare one.
