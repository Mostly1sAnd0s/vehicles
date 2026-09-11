/**
 * Convert world JSON elements into a simulation snapshot consumable by
 * the sensor samplers:
 *
 *   { lights: [{x,y,intensity}], heats: [{x,y,temperatureC}], obstacles: [circle|rect] }
 *
 * `lights` and `heats` are SEPARATE arrays on purpose: a light sensor is handed `lights`
 * and a heat sensor is handed `heats`, so "the furnace is invisible to phototaxis" is a
 * property of the data flow rather than a tuning constant someone has to keep honest.
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
import { isSolidBody, solidBodyRadius, bodyConfig } from '../models/solidBody.js';

const OBSTACLE_TYPES = new Set(['obstacle', 'rock']);

const finiteNum = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * A heat source's temperature in °C, clamped into the config's declared range.
 *
 * Sanitised HERE, at the seam, for the same reason the solid-light radius is: `properties`
 * is shared with rendering and with the sampler, and a NaN that reaches a sensor propagates
 * into actuation, where a NaN force silently freezes a robot rather than throwing. A value
 * that cannot be read falls back to the config default; with no default either it is left
 * `null`, and a source with no temperature is INERT (it sits at ambient and radiates
 * nothing) rather than becoming a surprise furnace.
 */
function sourceTemperature(el, configs) {
  const cfg = bodyConfig(configs, 'heat');
  const raw = finiteNum(el?.properties?.temperature, finiteNum(cfg.temperature, null));
  if (raw === null) return null;
  const lo = finiteNum(cfg.minTemperature, -273.15); // never below absolute zero
  const hi = finiteNum(cfg.maxTemperature, 5000);
  return Math.min(hi, Math.max(lo, raw));
}

export function worldElementsToSnapshot(elements, configs) {
  const lights = [];
  const heats = [];
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
      if (isSolidBody(el, configs)) {
        obstacles.push({
          type: 'circle',
          x: el.position.x,
          y: el.position.y,
          radius: solidBodyRadius(el, configs),
        });
      }
      continue;
    }

    if (el.type === 'heat') {
      // A HEAT source emits a thermal field, and NOTHING in the `lights` array. That
      // separation is the whole feature: a light sensor reads `lights` and cannot see this,
      // so "the furnace is invisible to phototaxis" is true by construction, not by tuning.
      // Solidity behaves exactly as it does for a lamp — same helper, same ring === barrier.
      heats.push({
        x: el.position.x,
        y: el.position.y,
        temperatureC: sourceTemperature(el, configs),
      });
      if (isSolidBody(el, configs)) {
        obstacles.push({
          type: 'circle',
          x: el.position.x,
          y: el.position.y,
          radius: solidBodyRadius(el, configs),
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

  return { lights, heats, obstacles };
}
