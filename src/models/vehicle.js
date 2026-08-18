/**
 * Vehicle pose math. Canvas coordinates, y-down, angles in radians.
 * A vehicle pose is { x, y, angle } (body center + heading).
 * Components carry local transforms: { local: {x,y}, localRotation }.
 */

export function vehicleToWorld(pose, local) {
  const cos = Math.cos(pose.angle);
  const sin = Math.sin(pose.angle);
  return {
    x: pose.x + local.x * cos - local.y * sin,
    y: pose.y + local.x * sin + local.y * cos,
  };
}

/**
 * Resolve every placed component to a world-space transform.
 * Returns [{ id, x, y, angle }] (angle = pose.angle + localRotation).
 */
export function resolveComponentTransforms(pose, vehicle) {
  const out = [];
  for (const c of vehicle.components ?? []) {
    if (!c.local) continue;
    const p = vehicleToWorld(pose, c.local);
    out.push({
      id: c.id,
      x: p.x,
      y: p.y,
      angle: pose.angle + (c.localRotation ?? 0),
    });
  }
  return out;
}
