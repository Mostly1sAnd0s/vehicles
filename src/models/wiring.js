/**
 * Wiring validation for a vehicle JSON document.
 * wire = { from: {componentId, port}, to: {componentId, port}, weight }
 * Returns an array of { code, wireIndex?, componentId?, message }; empty means valid.
 *
 * Port kinds are read from the component's own `ports` list; if absent they
 * fall back to `defs[componentType].ports` (from components.json).
 *
 * Polarity lives on the *component*, not the wire: sensors are
 * 'normal' | 'inverted', actuators are 'forward' | 'reverse'.
 */

const SENSOR_POLARITIES = new Set(['normal', 'inverted']);
const ACTUATOR_POLARITIES = new Set(['forward', 'reverse']);

// The only legal wiring directions. Logic gates extend the graph with
// logic_in / logic_out port kinds: a sensor or gate output may feed a gate
// input, and a gate output may drive an actuator or another gate.
const VALID_WIRE_PAIRS = new Set([
  'sensor_output>actuator_input',
  'sensor_output>logic_in',
  'logic_out>actuator_input',
  'logic_out>logic_in',
]);

export function validateWiring(vehicle, defs = {}) {
  const errors = [];
  const components = (vehicle.components ?? []);
  // Gate nodes resolve like components (they carry {id, type}; their ports come
  // from the type def in components.json) so wires can reference them by id.
  const byId = new Map([...components, ...(vehicle.logicGates ?? [])].map(c => [c.id, c]));
  const seenPairs = new Map(); // "fromId:port>toId:port" -> first wire index
  const usedGateInputs = new Set(); // "gateId:inPort" -> only one feeder each

  // per-component polarity (category comes from components.json defs)
  for (const c of components) {
    if (c.polarity === undefined) continue;
    const category = defs[c.type]?.category;
    const ok = category === 'sensor'
      ? SENSOR_POLARITIES.has(c.polarity)
      : category === 'actuator'
        ? ACTUATOR_POLARITIES.has(c.polarity)
        : true; // passive/mount: no polarity expected, allow
    if (!ok) {
      errors.push({
        code: 'bad_component_polarity',
        componentId: c.id,
        message: `component ${c.id} has invalid polarity "${c.polarity}" for a ${category ?? 'unknown'}`,      });
    }
  }

  (vehicle.wires ?? []).forEach((wire, i) => {
    checkEndpoint(wire.from, 'from', byId, errors, i, defs);
    checkEndpoint(wire.to, 'to', byId, errors, i, defs);

    if (wire.weight !== undefined && (typeof wire.weight !== 'number' || wire.weight < 0 || wire.weight > 1)) {
      errors.push({ code: 'bad_weight', wireIndex: i, message: `weight must be a number in [0,1] (got ${wire.weight})` });
    }

    const fromDef = findPortDef(wire.from, byId, defs);
    const toDef = findPortDef(wire.to, byId, defs);
    if (fromDef && toDef && !VALID_WIRE_PAIRS.has(`${fromDef.kind}>${toDef.kind}`)) {
      errors.push({
        code: 'type_mismatch',
        wireIndex: i,
        message: `wires must connect a sensor_output or logic_out to an actuator_input or logic_in (got ${fromDef.kind} -> ${toDef.kind})`,
      });
    }

    // A gate input takes exactly one feeder (unlike an actuator, which sums many).
    if (toDef && toDef.kind === 'logic_in' && wire.to) {
      const k = `${wire.to.componentId}:${wire.to.port}`;
      if (usedGateInputs.has(k)) {
        errors.push({ code: 'duplicate_input', wireIndex: i, message: `gate input ${k} already has a feeder (remove it first)` });
      } else {
        usedGateInputs.add(k);
      }
    }

    if (wire.from && wire.to) {
      const key = `${wire.from.componentId}:${wire.from.port}>${wire.to.componentId}:${wire.to.port}`;
      if (seenPairs.has(key)) {
        errors.push({
          code: 'duplicate_connection',
          wireIndex: i,
          message: `duplicates connection from wire ${seenPairs.get(key)}`,
        });
      } else {
        seenPairs.set(key, i);
      }
    }
  });

  return errors;
}

function portList(comp, defs) {
  if (!comp) return [];
  return comp.ports ?? defs[comp.type]?.ports ?? [];
}

function checkEndpoint(ref, role, components, errors, i, defs) {
  if (!ref || typeof ref !== 'object') return;
  if (!components.has(ref.componentId)) {
    errors.push({ code: 'unknown_component', wireIndex: i, message: `${role} references unknown component "${ref.componentId}"` });
    return;
  }
  const comp = components.get(ref.componentId);
  if (!portList(comp, defs).some(p => p.id === ref.port)) {
    errors.push({ code: 'unknown_port', wireIndex: i, message: `${role} references unknown port "${ref.port}" on component ${ref.componentId}` });
  }
}

function findPortDef(ref, components, defs) {
  const comp = components.get(ref?.componentId);
  if (!comp) return undefined;
  return portList(comp, defs).find(p => p.id === ref?.port);
}
