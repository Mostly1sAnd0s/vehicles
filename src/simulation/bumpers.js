/**
 * Bumper — a hollow-ring force barrier (soft, density-tunable).
 *
 * A Bumper is NOT a solid Matter part of its vehicle. Each physics step, its ring
 * (world anchor + radius) pushes back anything that crosses the ring surface:
 *
 *   F = BUMPER_FORCE_SCALE × density × penetration
 *
 * applied radially outward — at the crossing point, on the other bot's body.
 *
 * Targets, per source ring:
 * - the other bot's BODY: any surface vertex that has crossed the ring (the usual
 *   "body bumps the ring" case);
 * - the other bot's BUMPER RINGS: when two rings overlap, each ring pushes back a
 *   point on the other ring (applied to that other body). Bumpers interact with
 *   bumpers — the rings are the only thing that can "see" each other, since a
 *   bumper is not part of its own body's collision geometry. Each ring uses its
 *   OWN density, so a stiff bumper wins against a soft one.
 *
 * - `density` (per instance — the editor's Density slider, 0.1–50, default 10)
 *   is the barrier's stiffness: high ≈ solid wall, low = a fast/strong bot can
 *   plough through. This is deliberate: solver-hard collisions sink under swarm
 *   load (many bodies pushing at once), a tunable force field stays honest about
 *   how much force a barrier actually resists.
 * - Calibrated for Matter's Verlet units, where a force F on mass m changes
 *   velocity by (F/m)×dt² per step (dt² ≈ 278 at the 16.667 ms fixed timestep).
 *   A full-throttle stock bot (v ≈ 9.8 px/step, mass ≈ 5) sustains only ~0.02
 *   of force, so scale 0.001 makes density 10 a firm barrier a top-speed bot
 *   squishes ~10 px into, and density ≤ ~0.3 a wall that only a fast bot beats.
 * - HOLLOW: a ring never acts on a bot whose CENTER is inside it — the interior
 *   is passable. While the center is outside and something has crossed the
 *   surface, the ring pushes it back out. Crossing is a one-way fall: once the
 *   center is through, the ring no longer fights it.
 * - A ring never acts on its own bot (the whole bot, not just the one ring);
 *   static bodies are skipped (immovable by definition).
 *
 * Radius and density are read live from the component each step, so editor
 * edits apply on the very next tick with no physics-body rebuild.
 */

export const BUMPER_DEFAULTS = { radius: 25, density: 10 };

/** Maps `density × penetration` to Matter force units (see module doc for the calibration). */
export const BUMPER_FORCE_SCALE = 0.001;

/** Per-instance bumper tuning with safe fallbacks (imported docs may lack props). */
export function bumperProps(c) {
  const p = c?.props ?? {};
  const radius = Number(p.radius ?? BUMPER_DEFAULTS.radius);
  const density = Number(p.density ?? BUMPER_DEFAULTS.density);
  return {
    radius: Math.max(0.1, Number.isFinite(radius) && radius > 0 ? radius : BUMPER_DEFAULTS.radius),
    density: Math.max(0, Number.isFinite(density) ? density : BUMPER_DEFAULTS.density),
  };
}

/**
 * World-space ring descriptors for one instance's bumper components.
 * @param {object} v vehicle doc ({components}) — the instance's effective doc
 * @param {object} body the instance's Matter body (position/angle in world space)
 * @returns [{anchor:{x,y}, radius, density}] (empty if the vehicle has no bumpers)
 */
export function bumperAnchorsFor(v, body) {
  if (!v?.components?.length || !body?.position) return [];
  const cos = Math.cos(body.angle ?? 0), sin = Math.sin(body.angle ?? 0);
  const out = [];
  for (const c of v.components) {
    if (c?.type !== 'bumper' || !c.local) continue;
    const p = bumperProps(c);
    out.push({
      anchor: {
        x: body.position.x + cos * c.local.x - sin * c.local.y,
        y: body.position.y + sin * c.local.x + cos * c.local.y,
      },
      radius: p.radius,
      density: p.density,
    });
  }
  return out;
}

/**
 * Force one ring exerts on a body via its SURFACE VERTICES, or null.
 * Pure geometry — `body` needs only `{position, vertices}` (world space), so this
 * is testable without Matter.
 */
export function bumperForce({ anchor, radius, density }, body) {
  if (!body?.position || !Array.isArray(body.vertices) || body.vertices.length === 0) return null;
  // Hollow: the interior of the ring is passable.
  if (Math.hypot(body.position.x - anchor.x, body.position.y - anchor.y) <= radius) return null;
  let best = null, bestD = Infinity;
  for (const v of body.vertices) {
    const d = Math.hypot(v.x - anchor.x, v.y - anchor.y);
    if (d < bestD) { bestD = d; best = v; }
  }
  if (!best || bestD >= radius) return null; // surface not crossing the ring
  const depth = radius - bestD;
  const len = bestD > 1e-9 ? bestD : 1;
  const dirX = (best.x - anchor.x) / len, dirY = (best.y - anchor.y) / len;
  const mag = BUMPER_FORCE_SCALE * density * depth;
  return { point: best, force: { x: dirX * mag, y: dirY * mag } };
}

/**
 * Force one ring (src) exerts on another bot's BUMPER RING, or null.
 * When the circles overlap, the source ring pushes the point of the target ring
 * nearest to it, back outward (the force lands on the target's body at that
 * point). Pure geometry — testable without Matter.
 *
 * @param {{anchor, radius, density}} src   the acting ring
 * @param {{anchor, radius}} ring          the target bot's ring (on body `targetCenter`'s bot)
 * @param {{x, y}} targetCenter            the target bot's body center (hollow rule)
 */
export function bumperForceOnRing(src, ring, targetCenter) {
  if (!src?.anchor || !ring?.anchor || !targetCenter) return null;
  // Hollow: the interior of the source ring is passable (judged on the target bot's center).
  if (Math.hypot(targetCenter.x - src.anchor.x, targetCenter.y - src.anchor.y) <= src.radius) return null;
  // Nearest point on the target ring to the source anchor.
  const dx = src.anchor.x - ring.anchor.x, dy = src.anchor.y - ring.anchor.y;
  const d = Math.hypot(dx, dy) || 1e-9;
  const px = ring.anchor.x + (dx / d) * ring.radius;
  const py = ring.anchor.y + (dy / d) * ring.radius;
  const dist = Math.hypot(px - src.anchor.x, py - src.anchor.y);
  if (dist >= src.radius) return null; // rings do not overlap
  const depth = src.radius - dist;
  const len = dist > 1e-9 ? dist : 1;
  const dirX = (px - src.anchor.x) / len, dirY = (py - src.anchor.y) / len;
  const mag = BUMPER_FORCE_SCALE * src.density * depth;
  return { point: { x: px, y: py }, force: { x: dirX * mag, y: dirY * mag } };
}

/**
 * Apply every bumper's field for one step.
 *
 * @param {object} M Matter namespace (only M.Body.applyForce is used)
 * @param {Array}  entries one per instance: { body, bumpers: [{anchor, radius, density}] }
 *                        (bumpers from bumperAnchorsFor(); [] for bumper-less bots)
 */
export function applyBumperForces(M, entries) {
  if (!entries?.length) return;
  for (const src of entries) {
    const srcBody = src?.body;
    if (!srcBody || srcBody.isStatic) continue;
    for (const ring of src.bumpers ?? []) {
      for (const tgt of entries) {
        const body = tgt?.body;
        if (!body || body === srcBody || body.isStatic) continue;
        // 1) the target's body surface vs this ring
        const f = bumperForce(ring, body);
        if (f) M.Body.applyForce(body, f.point, f.force);
        // 2) each of the target's bumper rings vs this ring (bumpers interact with bumpers)
        for (const tRing of tgt.bumpers ?? []) {
          const fr = bumperForceOnRing(ring, tRing, body.position);
          if (fr) M.Body.applyForce(body, fr.point, fr.force);
        }
      }
    }
  }
}
