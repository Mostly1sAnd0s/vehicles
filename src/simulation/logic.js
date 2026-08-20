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
