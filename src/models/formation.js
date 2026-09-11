/**
 * Formation layouts: the maths behind "Random", "Line Up" and "Grid".
 *
 * ONE definition, used by both organising surfaces:
 *   · single-player, per prototype (`WorldSim.protoAction`), and
 *   · the shared co-op world, for EVERY bot in it (`HeadlessWorld.arrangeAll`).
 * Before this existed the layouts lived inside the single-player button handler, and the
 * co-op version would have had to re-implement them — which is how "Line Up" ends up
 * meaning 130px apart here and 90px apart there, in a sim whose whole subject is geometry.
 *
 * Pure and side-effect free: it returns poses, it does not move anything. `rng` is
 * injectable so the random layout is testable (and so a future "seeded run" feature has
 * somewhere to put the seed).
 */

export const FORMATION_MODES = Object.freeze(['random', 'line', 'grid']);

/** Default gap between neighbours — the number the single-player buttons always used. */
export const DEFAULT_SPACING = 130;

const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function isFormationMode(mode) {
  return FORMATION_MODES.includes(mode);
}

/**
 * `n` poses for `mode` around `center`, as [{x, y, rotation}].
 *
 * @param {number} n            how many. <1 yields [].
 * @param {'random'|'line'|'grid'} mode
 * @param {{x:number,y:number}} center   what the formation is built around — the viewer's
 *                               camera centre in both surfaces, so bots gather where the user
 *                               is LOOKING rather than at an invisible world origin.
 * @param {object} [opts]
 *   spacing   gap between neighbours in a line/grid (default 130)
 *   spread    half-extent of the random box (default: spacing * n / 2, so a bigger fleet
 *             gets a bigger area instead of piling into the same box)
 *   rng       () => [0,1) — injectable for tests
 *   minSeparation  random mode tries to keep this much room between bots (default spacing*0.9)
 *
 * @returns {Array<{x:number,y:number,rotation:number}>|null}  null for an unknown mode, so
 *   the caller can produce an error message instead of silently doing nothing.
 */
export function formationPoses(n, mode, center, opts = {}) {
  const count = Math.trunc(finite(n, 0));
  if (!(count >= 1)) return [];
  if (!isFormationMode(mode)) return null;
  const cx = finite(center?.x, 0);
  const cy = finite(center?.y, 0);
  const spacing = Math.max(1, finite(opts.spacing, DEFAULT_SPACING));
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;

  if (mode === 'line') {
    // Centred on `center`, so "Line Up" does not slide the fleet off to one side as it grows.
    return Array.from({ length: count }, (_, i) => ({
      x: cx + (i - (count - 1) / 2) * spacing,
      y: cy,
      rotation: 0,
    }));
  }

  if (mode === 'grid') {
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / cols));
    return Array.from({ length: count }, (_, i) => ({
      x: cx + ((i % cols) - (cols - 1) / 2) * spacing,
      y: cy + (Math.floor(i / cols) - (rows - 1) / 2) * spacing,
      rotation: 0,
    }));
  }

  // random: uniform over a box, orientation random. Rejection-sampled against the spots
  // already taken — with two or three bots it barely matters, but "Grid → Random" on a
  // twenty-bot co-op world otherwise drops several robots inside each other, and Matter
  // spends the next second violently disagreeing with that. Rejection is bounded (12
  // attempts) so a world with no room left still places every bot.
  const spread = Math.max(spacing, finite(opts.spread, (spacing * count) / 2));
  const minSep = finite(opts.minSeparation, spacing * 0.9);
  const out = [];
  for (let i = 0; i < count; i++) {
    let x = 0;
    let y = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      x = cx + (rng() - 0.5) * 2 * spread;
      y = cy + (rng() - 0.5) * 2 * spread;
      const clear = out.every(p => Math.hypot(p.x - x, p.y - y) >= minSep);
      if (clear) break;
    }
    out.push({ x, y, rotation: rng() * Math.PI * 2 });
  }
  return out;
}

/**
 * Where a fleet's poses should be centred when the caller has no camera (the co-op SERVER
 * receives the host's view centre, but a headless caller — a test, a future scripted world —
 * has nothing). Bots are laid out around the centroid of the bots themselves, so "Line Up"
 * lines them up where they ARE instead of teleporting everyone to the origin.
 *
 * Returns {x, y}; a caller with no instances at all gets {x:0, y:0}.
 */
export function centroid(instances) {
  const pts = (instances ?? []).filter(i => Number.isFinite(i?.x) && Number.isFinite(i?.y));
  if (!pts.length) return { x: 0, y: 0 };
  const sum = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / pts.length, y: sum.y / pts.length };
}
