/**
 * Page-side shadow of the engine (M10.2).
 *
 * `applyReply` writes protocol replies onto the page's instance bookkeeping
 * (`WorldSim.instances`): plain mirror bodies `{position, angle, velocity,
 * angularVelocity}` — exactly the shape the existing draw/hit-test code reads — plus the
 * per-run extras (samples, motors, flash, converted docs, path points).
 *
 * LocalBridge passes `resolveBody`, which hands back the REAL Matter body (same heap, so
 * identity is stable and direct writes — probes, optimistic drags — hit the engine). The
 * Worker transport gets plain mirrors; authoritative poses arrive with every reply, so a
 * mirror never needs to be written authoritatively.
 */

export const MIRROR_PATH_CAP = 2000;

/** Idempotent mirror body creation; never replaces an existing body object (identity). */
export function ensureMirror(inst) {
  if (!inst.body) {
    inst.body = { position: { x: inst.seed?.x ?? 0, y: inst.seed?.y ?? 0 }, angle: inst.seed?.rotation ?? 0, velocity: { x: 0, y: 0 }, angularVelocity: 0 };
  }
  return inst.body;
}

/**
 * Apply one protocol reply to the instance list.
 * @param {Array} instances  WorldSim.instances (mutated in place)
 * @param {object} reply     simProtocol reply
 * @param {{pathsOn?: boolean, pathCap?: number, reset?: boolean, resolveBody?: ?function}} [opts]
 */
export function applyReply(instances, reply, opts = {}) {
  if (!reply || !Array.isArray(reply.bots)) return;
  const byId = new Map(instances.map(i => [i.id, i]));
  const pathCap = opts.pathCap ?? MIRROR_PATH_CAP;

  for (const b of reply.bots) {
    const inst = byId.get(b.id);
    if (!inst) continue; // the page already removed this instance

    if (opts.resolveBody) {
      const real = opts.resolveBody(b.id);
      if (real) inst.body = real; // local transport: identity-stable real body
    }
    const body = ensureMirror(inst);
    if (body.position) { body.position.x = b.x; body.position.y = b.y; }
    else body.position = { x: b.x, y: b.y };
    body.angle = b.angle;
    if (body.velocity) { body.velocity.x = b.vx ?? 0; body.velocity.y = b.vy ?? 0; }
    else body.velocity = { x: b.vx ?? 0, y: b.vy ?? 0 };
    if (!('angularVelocity' in body)) body.angularVelocity = 0;

    // detail=false replies carry no samples/motors: leave the last ones intact (the
    // renderers that read them are exactly the toggles that switched detail off anyway).
    if (b.samples !== undefined) inst.lastSamples = b.samples;
    if (b.motors !== undefined) inst.lastMotors = b.motors;
    if (b.flashUntil !== undefined) inst.flashUntil = b.flashUntil;

    const pts = opts.pathsOn && reply.path ? reply.path[b.id] : null;
    if (pts?.length) {
      if (!Array.isArray(inst.path)) inst.path = [];
      for (const p of pts) inst.path.push(p);
      const excess = inst.path.length - pathCap;
      if (excess > 0) inst.path.splice(0, excess); // keep the NEWEST points
    }
  }

  for (const ev of reply.events ?? []) {
    if (ev?.type !== 'converted') continue;
    const inst = byId.get(ev.id);
    if (inst && ev.vehicle) inst.vehicleOverride = ev.vehicle;
  }

  if (opts.reset) {
    for (const inst of instances) {
      inst.path = [];
      inst.flashUntil = 0;
      inst.vehicleOverride = null;
      inst.lastSamples = [];
      inst.lastMotors = [];
    }
  }
}
