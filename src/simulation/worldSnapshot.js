/**
 * Convert world JSON elements into a simulation snapshot consumable by
 * the sensor samplers: { lights: [{x,y,intensity}], obstacles: [circle|rect] }.
 * Polygon primitives are not supported by the raycaster yet and are skipped.
 */

const OBSTACLE_TYPES = new Set(['obstacle', 'rock']);

export function worldElementsToSnapshot(elements) {
  const lights = [];
  const obstacles = [];

  for (const el of elements ?? []) {
    if (!el?.position) continue;
    const sx = el.scale?.x ?? 1;
    const sy = el.scale?.y ?? 1;

    if (el.type === 'light') {
      lights.push({
        x: el.position.x,
        y: el.position.y,
        intensity: el.properties?.intensity ?? 1,
      });
      continue;
    }

    if (!OBSTACLE_TYPES.has(el.type)) continue;

    if (el.primitive === 'circle') {
      obstacles.push({
        type: 'circle',
        x: el.position.x,
        y: el.position.y,
        radius: (el.properties?.radius ?? 10) * sx,
      });
    } else if (el.primitive === 'rect') {
      obstacles.push({
        type: 'rect',
        x: el.position.x,
        y: el.position.y,
        rotation: el.rotation ?? 0,
        width: (el.properties?.width ?? 20) * sx,
        height: (el.properties?.height ?? 20) * sy,
      });
    }
  }

  return { lights, obstacles };
}
