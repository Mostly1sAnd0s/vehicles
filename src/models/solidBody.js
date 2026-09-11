/**
 * Solid-body arithmetic for world elements that can be made collidable.
 *
 * Pure — no DOM, no Matter, no config fetching. The snapshot builder, the world
 * inspector, the renderer and the tests all read the radius through here, so the
 * drawn ring, the numeric readout and the physics body are always THE SAME NUMBER.
 * (That identity is the rule the Bumper fix established: a barrier you cannot read
 * off the screen is a barrier you cannot reason about.)
 *
 * World config is treated as OPTIONAL throughout. Tests hand-build config bundles
 * with no `world` key, and an old `public/config/` checkout predates
 * `config/world.json` entirely — so the literals below are the contract, not a
 * crash guard. Every read is `configs?.world?.X ?? <literal>`.
 */

export const DEFAULT_LIGHT_RADIUS = 24;
export const DEFAULT_LIGHT_MIN_RADIUS = 8;
export const DEFAULT_LIGHT_MAX_RADIUS = 240;

/**
 * Element types that can carry a static collision body. Emitter types: both radiate a
 * field (light, heat) AND can, when `solid` is on, block a robot. The rule that made the
 * Bumper trustworthy carries across unchanged — ONE number is the drawn ring, the readout
 * and the physics radius, for every type in this set.
 */
export const SOLID_BODY_TYPES = new Set(['light', 'heat']);

/**
 * A number, or nothing. Accepts real numbers and non-empty numeric strings (HTML
 * inputs hand back strings) and rejects everything else — notably `[]` and `''`,
 * which `Number()` happily coerces to 0. A silently-zeroed radius would build a
 * zero-size barrier that looks configured but is not, so a bad type falls back
 * rather than rounding down.
 */
const finite = (v, fallback) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
};

/** The `world.light` slice of a config bundle, or {} when there isn't one. */
export function lightConfig(configs) {
  const c = configs?.world?.light;
  return c && typeof c === 'object' ? c : {};
}

/**
 * The config slice for a solid-capable element, chosen by ITS OWN type — a heat source
 * reads `world.heat`, a light reads `world.light`. Each emitter therefore has its own
 * default radius and its own slider bounds (a lamp and a furnace need not agree), and an
 * unknown type falls back to the light slice rather than throwing, because every reader
 * here is optional-config-by-design.
 */
export function bodyConfig(configs, type) {
  const c = configs?.world?.[type];
  return c && typeof c === 'object' ? c : type === 'light' ? lightConfig(configs) : {};
}

/**
 * Is this element a solid light? Strict: real `true` or the hand-written-JSON
 * string `"true"`. Deliberately NOT general truthiness — `solid: 1` or `solid:
 * "on"` reads as a mistake, and a mistake must read as "not solid" rather than
 * silently turning a lamp into a wall.
 *
 * A config default (`world.light.solid: true`) applies only when the element is
 * silent; an explicit value on the element always wins, so a world saved with the
 * toggle off stays off no matter what the config says.
 */
export function isSolidLight(el, configs = {}) {
  if (!el || el.type !== 'light') return false;
  const v = el.properties?.solid ?? lightConfig(configs).solid ?? false;
  return v === true || v === 'true';
}

/**
 * `isSolidLight` generalised to every emitter type (see SOLID_BODY_TYPES). Same strictness:
 * only real `true` or the string `"true"` counts, the element's own value always beats the
 * config default, and anything else reads as "not solid".
 */
export function isSolidBody(el, configs = {}) {
  if (!el || !SOLID_BODY_TYPES.has(el.type)) return false;
  const v = el.properties?.solid ?? bodyConfig(configs, el.type).solid ?? false;
  return v === true || v === 'true';
}

/**
 * The AUTHORED (unscaled) radius — what the inspector's slider edits — clamped
 * into [minRadius, maxRadius] and defaulted. Kept separate from `solidLightRadius`
 * because a slider bound to the SCALED value would multiply by `el.scale` again on
 * every edit and creep the radius upward.
 */
export function authoredLightRadius(el, configs = {}) {
  return authoredBodyRadiusFrom(lightConfig(configs), el);
}

/**
 * Collision radius of a light's solid body, in world px.
 *
 * The authored value is clamped (see `authoredLightRadius`) and THEN multiplied by
 * `el.scale.x` — the clamp bounds the slider, the scale is an independent
 * multiplier, exactly like a rock's circle. The result is kept strictly positive
 * because `M.Bodies.circle` with a zero radius yields a degenerate body with NaN
 * inertia, which poisons the whole physics world.
 */
export function solidLightRadius(el, configs = {}) {
  const scale = Math.max(1e-6, finite(el?.scale?.x, 1));
  return Math.max(0.1, authoredLightRadius(el, configs) * scale);
}

/** Shared clamp: authored radius bounded by the type's own config, then scaled by el.scale.x. */
function authoredBodyRadiusFrom(cfg, el) {
  const min = finite(cfg.minRadius, DEFAULT_LIGHT_MIN_RADIUS);
  const max = Math.max(min, finite(cfg.maxRadius, DEFAULT_LIGHT_MAX_RADIUS));
  const authored = finite(el?.properties?.radius, finite(cfg.radius, DEFAULT_LIGHT_RADIUS));
  return Math.min(max, Math.max(min, authored));
}

/** The unscaled, clamped radius for any solid-capable element (what its slider edits). */
export function authoredBodyRadius(el, configs = {}) {
  return authoredBodyRadiusFrom(bodyConfig(configs, el?.type), el);
}

/** Collision radius in world px for any solid-capable element (clamp, then apply scale). */
export function solidBodyRadius(el, configs = {}) {
  const scale = Math.max(1e-6, finite(el?.scale?.x, 1));
  return Math.max(0.1, authoredBodyRadius(el, configs) * scale);
}

/**
 * Every solid light in an element list as a plain { id, x, y, r } circle.
 * Lets an engine (either one) sweep its bots without re-deriving the geometry.
 */
export function solidLightCircles(elements, configs) {
  const out = [];
  for (const el of elements ?? []) {
    if (!isSolidLight(el, configs) || !el.position) continue;
    out.push({ id: el.id, x: el.position.x, y: el.position.y, r: solidLightRadius(el, configs) });
  }
  return out;
}

/**
 * Every solid body in an element list, of ANY emitter type. Engines use THIS one for
 * eviction — a lights-only sweep would let a furnace be switched on inside a parked robot
 * and let Matter fling it, which is exactly the failure `pushOutOfCircle` exists to prevent.
 */
export function solidBodyCircles(elements, configs) {
  const out = [];
  for (const el of elements ?? []) {
    if (!isSolidBody(el, configs) || !el.position) continue;
    out.push({ id: el.id, x: el.position.x, y: el.position.y, r: solidBodyRadius(el, configs) });
  }
  return out;
}

/** Configured clearance to leave between a lamp's barrier and an evicted bot. */
export function pushClearance(configs) {
  return Math.max(0, finite(lightConfig(configs).pushClearance, 6));
}

/** Same clearance, read from the element's own type slice (falls back to the light's). */
export function bodyPushClearance(configs, type = 'light') {
  const cfg = bodyConfig(configs, type);
  const own = finite(cfg.pushClearance, NaN);
  if (Number.isFinite(own)) return Math.max(0, own);
  return pushClearance(configs);
}

/**
 * Push-out arithmetic for switching solidity ON underneath something that is
 * already inside it.
 *
 * Matter resolves an interpenetration by ejecting the intruder hard — a solid lamp
 * switched on under a parked robot would fling it across the world. Instead we
 * move each overlapping pose straight out to `radius + clearance` along the
 * light→pose vector, preserving bearing. The caller zeroes velocity when it
 * applies the result (same "zeroed momentum" idiom as a bot drag-drop).
 *
 * Returns ONLY the poses that needed to move, as { id, x, y, dx, dy, distance },
 * in input order. The concentric case (zero vector) is resolved along +x so the
 * result is deterministic and never NaN.
 */
export function pushOutOfCircle(center, radius, poses, clearance = 4) {
  const out = [];
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return out;
  const target = Math.max(0, Number(radius) || 0) + Math.max(0, Number(clearance) || 0);
  for (const p of poses ?? []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const d = Math.hypot(dx, dy);
    if (d >= target) continue; // outside, or exactly on the ring, is not an overlap
    let ux, uy;
    if (d > 1e-9) {
      ux = dx / d;
      uy = dy / d;
    } else {
      ux = 1;
      uy = 0; // dead-centre: pick a fixed bearing rather than emit NaN
    }
    out.push({
      id: p.id,
      x: center.x + ux * target,
      y: center.y + uy * target,
      dx: ux * target - dx,
      dy: uy * target - dy,
      distance: target - d,
    });
  }
  return out;
}
