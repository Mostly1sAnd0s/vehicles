/**
 * Convert world JSON elements into a simulation snapshot consumable by
 * the sensor samplers: { lights: [{x,y,intensity}], obstacles: [circle|rect] }.
 * Polygon primitives are not supported by the raycaster yet and are skipped.
 *
 * THIS IS THE SINGLE SEAM for static world geometry. Both physics engines derive
 * their bodies from it — `WorldSim.buildObstacles()` in the browser and
 * `HeadlessWorld._buildObstacles()` on the co-op server — so a rule added here
 * lands in single-player, the authoritative shared world, and the raycaster at
 * once, with no change to either body builder or either step loop.
 *
 * `configs` is OPTIONAL (second arg): world config is read with inline fallbacks
 * so every existing call site keeps working and a bundle without a `world` key
 * (tests, or a public/config/ predating config/world.json) still resolves.
 */
import { isSolidLight, solidLightRadius } from '../models/solidBody.js';

const OBSTACLE_TYPES = new Set(['obstacle', 'rock']);

export function worldElementsToSnapshot(elements, configs) {
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
      // A SOLID light is a real object: it emits the field AND a rigid circular
      // barrier, shape-identical to a rock's so nothing downstream can tell them
      // apart. Note what solidity does NOT touch: the emitter entry above is
      // unchanged, so light sensing, beam length and level are identical with the
      // toggle on or off (pinned by tests/solidLightSensors.test.js). It DOES
      // make the lamp a distance-sensor target — a physical lamp is a physical
      // object — and a body vehicles bump into.
      if (isSolidLight(el, configs)) {
        obstacles.push({
          type: 'circle',
          x: el.position.x,
          y: el.position.y,
          radius: solidLightRadius(el, configs),
        });
      }
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
