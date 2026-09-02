/**
 * Editor hit-testing and snap selection. All in body-local coordinates
 * (same frame as component `local` transforms and generated snap points).
 */

/**
 * Collision/draw footprint of a component in its own frame.
 * Actuators (wheels) are top-down rects: long along the travel axis
 * (localRotation, the tire footprint/diameter), short laterally (tread width).
 * Everything else is a circle.
 */
export function componentSize(c, def) {
  const size = def?.size ?? 8;
  if (def?.category === 'actuator' || def?.shape === 'rect') {
    return { kind: 'rect', along: size * 1.5, lateral: size * 0.9 };
  }
  // A Bumper's draw/hit footprint is its per-instance adjustable radius (props.radius),
  // falling back to the def default; every other circle component uses the def size.
  const radius = def?.id === 'bumper' ? (c?.props?.radius ?? c?.radius ?? def.defaults?.radius ?? def.size ?? 8) : size;
  return { kind: 'circle', radius };
}

/**
 * Draw footprint radius of a circular component (editor/world renderers and the co-op
 * snapshot's per-component `r`). A Bumper reports its per-instance props.radius so the
 * drawn ring matches the adjustable barrier the sim's force field enforces
 * (src/simulation/bumpers.js — the Bumper itself is no longer a solid Matter part);
 * every other component keeps the long-standing def.size footprint.
 * `c` may be a full component (props present) or a partial {local, radius}.
 */
export function collisionRadius(c, def) {
  if (def?.id === 'bumper') return Math.max(0.1, c?.props?.radius ?? c?.radius ?? def.defaults?.radius ?? def.size ?? 8);
  return def?.size ?? 8;
}

/** Point-in-component test using the full element footprint. */
export function componentHits(point, c, def) {
  const s = componentSize(c, def);
  const dx = point.x - c.local.x;
  const dy = point.y - c.local.y;
  if (s.kind === 'circle') return Math.hypot(dx, dy) <= s.radius;
  // rotate the point into the component frame (by -localRotation)
  const a = c.localRotation ?? 0;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  return Math.abs(lx) <= s.along / 2 && Math.abs(ly) <= s.lateral / 2;
}

/**
 * World-space grab radius for a vehicle instance: max(body half-extent, 20px)
 * plus a small zoom-adjusted slack so tiny cars stay grabbable when zoomed out.
 */
export function instanceHitRadius(v, zoom = 1) {
  const base = Math.max((v?.body?.width ?? 40) / 2, (v?.body?.height ?? 40) / 2, 20);
  return base + 6 / zoom;
}

/**
 * Nearest live instance whose body is within its grab radius of world point.
 * vehicleOf(protoId) is injected so this stays pure and testable.
 */
export function findInstanceAt(instances, vehicleOf, point, zoom = 1) {
  let best = null, bestD = Infinity;
  for (const inst of instances) {
    if (!inst?.body?.position) continue;
    const r = instanceHitRadius(vehicleOf(inst.protoId), zoom);
    const d = Math.hypot(point.x - inst.body.position.x, point.y - inst.body.position.y);
    if (d <= r && d < bestD) { bestD = d; best = inst; }
  }
  return best;
}

/** Index of the closest snap point, or -1 if farther than maxDist. */
export function nearestSnapIndex(snapPoints, point, maxDist = Infinity) {
  let best = -1;
  let bd = maxDist;
  for (let i = 0; i < snapPoints.length; i++) {
    const p = snapPoints[i];
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}
