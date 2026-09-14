/**
 * Propagation lineage — who a bot "counts for" after a Propagator conversion.
 *
 * A conversion swaps a bot's DESIGN (vehicleOverride); lineage decides who the bot's COUNT
 * belongs to in a "survival of the fittest" run. Three rules:
 *
 *   1. Origin   — a bot's lineage starts as its own proto (the one its deployer seeded it under).
 *   2. Adoption — a converted bot adopts the CONVERTER's lineage (not merely the converter's
 *      proto), so attribution follows the configuration chain: A converts B, and B's clone
 *      converts C ⇒ C counts for A. The converter's lineage is already the head of the chain,
 *      so a single assignment IS the recursion.
 *   3. Reset    — the engine restores every lineage to its origin, so a Reset returns the
 *      scoreboard to the initial mix, exactly as it restores the designs.
 *
 * Lineage is deliberately NOT ownership. The converted bot keeps its protoId / owner /
 * ownerToken — deploy rebuilds, fleet −/+/✕ and prune-on-leave all keep targeting the
 * deployer. Only the count moves.
 *
 * Pure on purpose: the engine (worldSim), the page's protocol reply (simProtocol), the
 * co-op wire client (net/client) and the fleet UI (coopPanel) all read through `lineageOf`,
 * so the scoreboard cannot drift from the simulation.
 */

/**
 * The proto a bot counts under. `inst.lineage` when set (converted); falls back to the bot's
 * own protoId, so a bot that predates the field (a legacy wire sender) or one carrying an
 * explicit null still counts for its deployer instead of vanishing from every row.
 */
export function lineageOf(inst) {
  return inst?.lineage ?? inst?.protoId ?? null;
}

/**
 * Count a list of snapshot bots by the proto their lineage points at.
 *
 * @returns {Object<string, number>} { protoId: count } — one entry per proto that has at
 *   least one bot counting for it. A proto with zero bots is ABSENT (readers use `?? 0`),
 *   and a bot with no readable proto (neither lineage nor protoId) is skipped rather than
 *   counted into a phantom row.
 */
export function lineageCounts(bots) {
  const out = {};
  for (const b of bots ?? []) {
    const k = lineageOf(b);
    if (k == null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
