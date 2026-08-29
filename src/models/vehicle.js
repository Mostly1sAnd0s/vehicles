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

// (resolveComponentTransforms — bulk component->world transform resolution — was removed here:
//  every production caller (sensors, rendering, sim) resolves just the components it needs via
//  vehicleToWorld, so the batch helper had no users outside its own tests.)
