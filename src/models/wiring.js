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

export function validateWiring(vehicle, defs = {}) {
  const errors = [];
  const components = (vehicle.components ?? []);
  const byId = new Map(components.map(c => [c.id, c]));
  const seenPairs = new Map(); // "fromId:port>toId:port" -> first wire index

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
    if (fromDef && toDef && !(fromDef.kind === 'sensor_output' && toDef.kind === 'actuator_input')) {
      errors.push({
        code: 'type_mismatch',
        wireIndex: i,
        message: `wires must connect a sensor_output to an actuator_input (got ${fromDef.kind} -> ${toDef.kind})`,
      });
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
