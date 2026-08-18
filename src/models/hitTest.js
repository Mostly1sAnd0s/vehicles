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
  return { kind: 'circle', radius: size };
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
