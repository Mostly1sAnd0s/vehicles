/**
 * Single-player sim protocol — the ONLY engine surface the page has (M10.2).
 *
 * One protocol, two transports: `LocalSimBridge` runs `applyCommand` synchronously on the
 * main thread; `WorkerSimBridge` posts the same messages to a Worker where the same code
 * runs off-thread. The page never touches Matter or the engine directly — it sends
 * `init | sync | move | step | reset | snapshot` and renders the replies through
 * `public/app/simMirror.js`.
 *
 * `applyCommand(world, state, msg)` is pure given (world, state) — a REAL `HeadlessWorld`
 * is what both transports execute, so single-player and the co-op server can never drift
 * into meaning different things by "step" or "reset". The engine owns physics AND the
 * extras that used to live in the browser loop; the protocol owns the two things the page
 * needs that the engine alone never had:
 *   - conversion EVENTS (so the page mirrors `vehicleOverride` for drawing/inspector),
 *   - PATH recording (per physics step, capped, delivered incrementally, and only while
 *     the page's Paths toggle is on — recording is per-toggle since the transport cannot
 *     hand the page its history retroactively).
 *
 * Message shapes (page → engine):
 *   { op:'init',  seq?, dtMs, elements, vehicles:[{id,name,vehicle}], instances:[{id,protoId,seed}] }
 *   { op:'sync',  seq?, elements?, vehicles?, instances? }   (full desired state; engine diffs)
 *   { op:'move',  seq?, id, x, y, rot? }                     (zero momentum, adopt seed)
 *   { op:'reset', seq? }
 *   { op:'step',  seq?, n, detail, trackPaths }              (detail: samples/motors in reply)
 *   { op:'snapshot', seq?, detail }
 *
 * Reply (engine → page):
 *   { op:'reply', ack, seq, t, bots:[{id,protoId,x,y,angle,vx,vy,flashUntil,samples?,motors?}],
 *     convertedCount, events:[{type:'converted',id,vehicle}], path?:{id:[{x,y}...]} }
 * A `move` reply carries ONLY the moved bot — drags stream at pointer rate and must not
 * serialize a thousand robots per mousemove.
 */

/** Same trail cap the browser loop used (PATH_CAP); long runs stay O(1) memory. */
export const PATH_CAP = 2000;

/** Runaway guard: one rAF frame may ask for many steps (tab restore), but not for millions. */
export const MAX_STEPS_PER_COMMAND = 120;

export function createProtocolState({ pathCap = PATH_CAP } = {}) {
  return {
    pathCap,
    paths: new Map(), // instanceId -> [{x,y}] pending (undelivered) points
  };
}

function reply(world, state, msg, { detail = true, withPaths = false, bots = null } = {}) {
  const r = {
    op: 'reply',
    ack: msg?.op ?? null,
    seq: msg?.seq,
    t: world.tick,
    bots: bots ?? botsOf(world, detail),
    convertedCount: world.convertedCount,
    events: world.conversionEvents.splice(0),
  };
  if (withPaths) r.path = drainPaths(state);
  return r;
}

function botsOf(world, detail) {
  return world.instances.filter(i => i?.body).map(i => {
    const b = {
      id: i.id, protoId: i.protoId, lineage: i.lineage ?? i.protoId, // the converted-bot tally (models/lineage.js)
      x: i.body.position.x, y: i.body.position.y, angle: i.body.angle,
      vx: i.body.velocity.x, vy: i.body.velocity.y,
      flashUntil: i.flashUntil ?? 0,
    };
    // Samples/motors are the payload hogs at 1000 robots; the page asks for them only
    // while Beams or Values are on. The renderer always gets the pose.
    if (detail) { b.samples = i.lastSamples ?? []; b.motors = i.lastMotors ?? []; }
    return b;
  });
}

function recordPaths(world, state) {
  for (const i of world.instances) {
    if (!i?.body) continue;
    let pts = state.paths.get(i.id);
    if (!pts) { pts = []; state.paths.set(i.id, pts); }
    pts.push({ x: Math.round(i.body.position.x), y: Math.round(i.body.position.y) });
    if (pts.length > state.pathCap) pts.shift();
  }
}

function drainPaths(state) {
  const out = {};
  for (const [id, pts] of state.paths) if (pts.length) out[id] = pts.splice(0);
  return out;
}

/**
 * Execute one command against the world. Returns the reply object, or null for an op this
 * protocol does not know (a future transport addition must not throw on an old engine).
 */
export function applyCommand(world, state, msg) {
  if (!msg || typeof msg !== 'object') return null;
  switch (msg.op) {

    case 'init': {
      world.worldDoc.elements = msg.elements ?? [];
      world.worldDoc.vehiclePrototypes = (msg.vehicles ?? []).map(p => ({
        id: p.id, name: p.name ?? p.id, vehicle: p.vehicle ?? null, _vehicle: p.vehicle ?? null, instances: [],
      }));
      world.rebuildObstacles();
      for (const inst of msg.instances ?? []) {
        if (world.instances.some(x => x.id === inst.id)) continue;
        world.addInstance({ id: inst.id, protoId: inst.protoId, seed: inst.seed ?? { x: 0, y: 0, rotation: 0 } });
      }
      world._syncInstances();
      return reply(world, state, msg, { detail: msg.detail !== false });
    }

    case 'sync': {
      // Full desired state, diffed — never a rebuild. Kept bots keep pose AND momentum
      // (the "edit a running car without stopping it" contract); new bots spawn at seed;
      // gone bots (and their path bookkeeping) are removed.
      if (msg.elements) {
        world.worldDoc.elements = msg.elements;
        world.rebuildObstacles();
      }
      if (msg.vehicles) {
        for (const p of msg.vehicles) {
          let proto = world.prototypes().find(x => x.id === p.id);
          if (!proto) {
            proto = { id: p.id, name: p.name ?? p.id, vehicle: null, instances: [] };
            world.worldDoc.vehiclePrototypes.push(proto);
          }
          if (p.name != null) proto.name = p.name;
          if (p.vehicle !== undefined) { proto.vehicle = p.vehicle; proto._vehicle = p.vehicle; }
        }
      }
      if (msg.instances) {
        const want = new Map(msg.instances.map(i => [i.id, i]));
        for (const inst of [...world.instances]) {
          if (!want.has(inst.id)) {
            world.removeInstance(inst.id);
            state.paths.delete(inst.id);
          }
        }
        for (const want1 of msg.instances) {
          const have = world.instances.find(x => x.id === want1.id);
          if (have) {
            // The PAGE owns seeds (it is the doc of record); the engine's copy only decides
            // where Reset returns. Refresh it WITHOUT touching the live body — arrange
            // buttons move seeds while the fleet keeps driving.
            if (want1.seed) have.seed = { ...want1.seed };
            continue;
          }
          world.addInstance({ id: want1.id, protoId: want1.protoId, seed: want1.seed ?? { x: 0, y: 0, rotation: 0 } });
        }
      }
      world._syncInstances();
      return reply(world, state, msg, { detail: msg.detail !== false, withPaths: true });
    }

    case 'move': {
      // HeadlessWorld.moveBot already zeroes momentum and adopts the seed (drag-drop is a
      // re-seat, not a shove — same contract as the co-op host drag).
      world.moveBot(msg.id, msg.x, msg.y, msg.rot);
      const moved = world.instances.find(i => i.id === msg.id && i.body);
      const bots = moved ? botsOf(world, false).filter(b => b.id === moved.id) : [];
      return reply(world, state, msg, { bots });
    }

    case 'reset': {
      // Seeds may ride along (arrange-then-reset in one round trip): adopt them first so
      // Reset returns the fleet to where the page just put it.
      if (msg.seeds) {
        for (const inst of world.instances) {
          const s = msg.seeds[inst.id];
          if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) inst.seed = { x: s.x, y: s.y, rotation: s.rotation ?? 0 };
        }
      }
      world.reset();               // engine: seeds, overrides, sensor heat, counters
      state.paths.clear();         // a fresh run draws a fresh trail
      return reply(world, state, msg, { detail: msg.detail !== false });
    }

    case 'step': {
      const n = Math.max(0, Math.min(MAX_STEPS_PER_COMMAND, Math.floor(Number(msg.n) || 0)));
      const detail = msg.detail !== false;
      const track = !!msg.trackPaths;
      for (let i = 0; i < n; i++) {
        world.step();
        if (track) recordPaths(world, state);
      }
      return reply(world, state, msg, { detail, withPaths: track });
    }

    case 'snapshot': {
      return reply(world, state, msg, { detail: msg.detail !== false, withPaths: true });
    }

    default:
      return null;
  }
}
