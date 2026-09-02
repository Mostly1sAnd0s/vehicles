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
npm test                 # 262 unit tests (node --test, no framework)
npm run smoke            # all eight headless-Chrome probes below, in sequence
npm run smoke:editor     # place + drag-snap + wire, gates + slots, body color via UI
npm run smoke:world      # sim runs; sensor/motor polarity, detection, propagation
npm run smoke:crud       # add/remove vehicle types, drag a running robot to reposition
npm run smoke:neurons    # Neuron response editor + "Add Output" multi-output taps
npm run smoke:tabs       # Sandbox/Co-Op sidebar tabs, design row, Deploy gating
npm run smoke:coop       # co-op panel: host→code, deploy, fleet ±/✕, element sync, prune+GC
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
probe owns its own web port (8901–8905, 8907, 8915, 8925 — no two probes share
one), CDP debug port, and Chrome profile dir (plus a gateway port for the co-op
ones — `coop.panel` 8961, `coop.session` 8963, `world.tabs` 8975) and cleans up
after itself, so the sequence inside `npm run smoke` can never race on a port.
Stale headless Chrome is the usual cause of "devtools not reachable"; each probe
`pkill`s only its own profile.

## Layout

```
config/                 JSON config (source of truth)
  app.json                fixed timestep, snap-point count, misc app defaults
  components.json         every placeable part + logic gates + Neuron + Propagator
  sensors.json            light / distance / vehicle-detection sensor models
  actuators.json          powered-wheel model (power, friction, power curve)
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
  simulation/worldSnapshot.js   world elements -> {lights, obstacles}
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
  teleporting on mouseup; joiners mirror immediately on welcome.
- **Host fleet management**: `#remote-fleet` lists every participant's prototype
  with a live bot count; the host gets −/+/✕ plus a typeable exact-count input
  per row (`setCount`, clamped 0–50), never edit.
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
