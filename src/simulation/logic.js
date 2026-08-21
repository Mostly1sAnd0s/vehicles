/**
 * Combinational logic gates for the vehicle editor.
 *
 * A small, pure evaluation layer that lets one or more (optionally digitalised)
 * sensor readings be combined with standard boolean gates and fed to actuators
 * or other gates. Gates live in `vehicle.logicGates` (floating nodes, not body
 * components) and are wired through the normal `vehicle.wires` graph.
 *
 * Every function here is pure so the truth tables and graph evaluation are
 * unit-tested headlessly; the world sim calls `evaluateLogicGates` once per
 * instance per step to resolve gate outputs before actuation.
 */

// Canonical set of gates (no "XAND" — that is not a standard gate). NOT has a
// single input; the rest are binary.
const GATES = {
  gate_and: { name: 'AND', inputs: 2 },
  gate_or: { name: 'OR', inputs: 2 },
  gate_nand: { name: 'NAND', inputs: 2 },
  gate_nor: { name: 'NOR', inputs: 2 },
  gate_xor: { name: 'XOR', inputs: 2 },
  gate_not: { name: 'NOT', inputs: 1 },
};

export function isLogicGate(type) {
  return type in GATES;
}

export function gateName(type) {
  return GATES[type]?.name ?? '?';
}

/** Number of input ports a gate type expects (NOT = 1, the rest = 2). */
export function gateInputCount(type) {
  return GATES[type]?.inputs ?? 0;
}

// A gate reads its inputs as booleans: any non-zero value is HIGH. (A raw analog
// sensor fed straight in thus counts as HIGH whenever it is active; the per-sensor
// digital threshold is the tool for making that cutoff exact.)
const hi = v => (v ? 1 : 0);

/**
 * Truth table for a single gate given its (ordered) input values.
 * Returns 0 or 1. Unknown types evaluate LOW rather than throwing, so a bad
 * config degrades gracefully.
 */
export function gateOutput(type, inputs = []) {
  const i = inputs.map(hi);
  switch (type) {
    case 'gate_not': return 1 - i[0];
    case 'gate_and': return i.every(Boolean) ? 1 : 0;
    case 'gate_or': return i.some(Boolean) ? 1 : 0;
    case 'gate_nand': return 1 - gateOutput('gate_and', inputs);
    case 'gate_nor': return 1 - gateOutput('gate_or', inputs);
    case 'gate_xor': return i.reduce((a, b) => (hi(a) ^ hi(b)), 0); // parity
    default: return 0;
  }
}

/**
 * Coerce a sensor reading to a boolean when its `digital` toggle is on.
 * HIGH (1) if the (polarity-applied) value >= threshold, else LOW (0). Default
 * threshold is 0.5 — the mid-point of every normalised sensor range. When the
 * toggle is off the value passes through unchanged (analog), so wiring an
 * analog sensor to a motor is exactly as before.
 */
export function toDigital(raw, comp) {
  const props = comp?.props ?? {};
  if (!props.digital) return raw;
  return (raw ?? 0) >= (props.threshold ?? 0.5) ? 1 : 0;
}

/**
 * Resolve the 0/1 output of every logic gate in a vehicle, given a function
 * that returns a sensor's raw (polarity-applied) reading for its id.
 *
 * Evaluation is topological via memoised recursion: a gate input reads either a
 * sensor (coerced to digital when the sensor says so) or another gate's output.
 * An unwired input is LOW. A wiring cycle resolves LOW instead of recursing
 * forever (combinational logic with a feedback loop has no settled value).
 *
 * @returns {Object} map of gateId -> 0|1
 */
export function evaluateLogicGates(vehicle, valueOf) {
  const gates = vehicle?.logicGates ?? [];
  if (!gates.length) return {};

  const byGate = new Map(gates.map(g => [g.id, g]));
  const compById = new Map((vehicle.components ?? []).map(c => [c.id, c]));

  // For each gate input port ("gateId:port"), the id of the node feeding it.
  const inFeeders = new Map();
  for (const w of vehicle.wires ?? []) {
    if (w?.to && byGate.has(w.to.componentId)) {
      inFeeders.set(`${w.to.componentId}:${w.to.port}`, w.from.componentId);
    }
  }

  const cache = new Map();
  const visiting = new Set();

  const nodeValue = id => {
    if (cache.has(id)) return cache.get(id);
    if (visiting.has(id)) return 0; // cycle guard
    const gate = byGate.get(id);
    const inputs = [];
    if (gate) {
      visiting.add(id);
      for (let k = 0; k < gateInputCount(gate.type); k++) {
        const src = inFeeders.get(`${id}:in${k}`);
        inputs.push(src === undefined ? 0 : nodeValueOfSource(src));
      }
      visiting.delete(id);
      const out = gateOutput(gate.type, inputs);
      cache.set(id, out);
      return out;
    }
    // a sensor id: digitalise if the sensor asks for it
    return nodeValueOfSource(id);
  };

  const nodeValueOfSource = src => {
    if (byGate.has(src)) return nodeValue(src);
    const raw = valueOf(src) ?? 0;
    return toDigital(raw, compById.get(src));
  };

  const out = {};
  for (const g of gates) out[g.id] = nodeValue(g.id);
  return out;
}

// ---------------------------------------------------------------------------
// Configuration propagation ("replicate")
//
// A vehicle can carry a `propagate` component. When its host instance comes
// within the component's `threshold` of another robot whose configuration
// differs, the host copies its *whole* vehicle doc onto that other instance
// (a true clone — including this same component), modelling the spread of a
// single seed across a population. The three functions below are pure and are
// the unit-tested core; `WorldSim` wires them into its step loop.
// ---------------------------------------------------------------------------

/**
 * A stable, ID-INDEPENDENT signature of a vehicle's configuration.
 *
 * Two docs that differ only in their internal component/gate ids (as produced
 * by {@link cloneVehicleForConversion}) get the SAME signature; two docs that
 * differ in a component's type/props/placement, in the wiring topology, or in
 * the body color get DIFFERENT signatures. That is exactly what the propagation
 * "config differs" guard needs: once an instance is converted its signature
 * matches the host's, so the same pair never re-fires (idempotency).
 */
export function vehicleSignature(doc) {
  const d = doc ?? {};
  const comps = (d.components ?? []).map((c, i) => ({
    o: i, t: c.type, s: c.snapIndex,
    l: c.local ? [round3(c.local.x), round3(c.local.y)] : null,
    r: c.localRotation != null ? round3(c.localRotation) : 0,
    p: c.props ?? null,
  }));
  const gates = (d.logicGates ?? []).map(g => ({ t: g.type, pos: g.pos ? [round3(g.pos.x), round3(g.pos.y)] : null }));
  // id -> ordinal, so wire endpoints are compared by position, not by string.
  const ord = {};
  (d.components ?? []).forEach((c, i) => { ord[c.id] = `c${i}`; });
  (d.logicGates ?? []).forEach((g, i) => { ord[g.id] = `g${i}`; });
  const wires = (d.wires ?? []).map(w => [
    ord[w.from?.componentId] ?? String(w.from?.componentId),
    ord[w.to?.componentId] ?? String(w.to?.componentId),
    w.weight ?? 1,
  ]);
  return JSON.stringify({ c: comps, g: gates, w: wires, col: d.body?.color ?? null });
}

const round3 = n => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0);

/**
 * Choose which other instances a host converts this step.
 *
 * @param {object} host       { id, x, y, signature } — the carrying instance.
 * @param {Array}  candidates { id, x, y, signature } — every live instance (incl. host).
 * @param {object} opts       { threshold, maxConverted?, alreadyConverted? }
 * @returns array of candidate objects (nearest first) to convert this step.
 *
 * Excluded: the host itself, any instance whose signature already matches
 * (idempotency — nothing left to copy), and anything beyond `threshold`.
 * Ordered nearest-first with a deterministic tie-break; truncated so that the
 * total never exceeds `maxConverted` (a shared cap across all sources this run).
 */
export function selectPropagationTargets(host, candidates, opts = {}) {
  const threshold = opts.threshold ?? Infinity;
  const maxConverted = opts.maxConverted;
  const already = opts.alreadyConverted ?? 0;
  const pool = [];
  for (const c of candidates) {
    if (!c || c.id === host.id) continue;          // never convert yourself
    if (c.signature === host.signature) continue;   // already same config -> idempotent no-op
    const dist = Math.hypot(c.x - host.x, c.y - host.y);
    if (dist > threshold) continue;                 // out of range
    pool.push({ ...c, dist });
  }
  pool.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const remaining = maxConverted != null ? Math.max(0, maxConverted - already) : Infinity;
  const out = [];
  for (const c of pool) { if (out.length >= remaining) break; out.push(c); }
  return out;
}

/**
 * Deep-clone a vehicle doc for conversion, renaming every component and gate id
 * (so no two docs share ids) and rewriting all wiring references to follow the
 * rename. Body (incl. color), props, placement, and topology are preserved — so
 * the clone carries the `propagate` component and can propagate onward.
 *
 * @param {object} doc   source vehicle doc.
 * @param {string} nonce suffix appended to every id in the clone.
 */
export function cloneVehicleForConversion(doc, nonce) {
  const src = doc ?? {};
  const oldToNew = {};
  for (const c of src.components ?? []) oldToNew[c.id] = `${c.id}_${nonce}`;
  for (const g of src.logicGates ?? []) oldToNew[g.id] = `${g.id}_${nonce}`;
  const clone = JSON.parse(JSON.stringify(src)); // full deep copy (docs are plain JSON)
  for (const c of clone.components ?? []) c.id = oldToNew[c.id] ?? c.id;
  for (const g of clone.logicGates ?? []) g.id = oldToNew[g.id] ?? g.id;
  const remap = id => oldToNew[id] ?? id;
  for (const w of clone.wires ?? []) {
    if (w.from?.componentId != null) w.from.componentId = remap(w.from.componentId);
    if (w.to?.componentId != null) w.to.componentId = remap(w.to.componentId);
  }
  return clone;
}
