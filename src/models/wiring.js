/**
 * Wiring validation for a vehicle JSON document.
 * wire = { from: {componentId, port}, to: {componentId, port}, polarity, weight }
 * Returns an array of { code, wireIndex?, message }; empty means valid.
 *
 * Port kinds are read from the component's own `ports` list; if absent they
 * fall back to `defs[componentType].ports` (from components.json).
 */

const POLARITIES = new Set(['excitatory', 'inhibitory']);

export function validateWiring(vehicle, defs = {}) {
  const errors = [];
  const components = new Map(
    (vehicle.components ?? []).map(c => [c.id, c])
  );
  const seenPairs = new Map(); // "fromId:port>toId:port" -> first wire index

  (vehicle.wires ?? []).forEach((wire, i) => {
    checkEndpoint(wire.from, 'from', components, errors, i, defs);
    checkEndpoint(wire.to, 'to', components, errors, i, defs);

    if (wire.weight !== undefined && (typeof wire.weight !== 'number' || wire.weight < 0 || wire.weight > 1)) {
      errors.push({ code: 'bad_weight', wireIndex: i, message: `weight must be a number in [0,1] (got ${wire.weight})` });
    }
    if (!POLARITIES.has(wire.polarity)) {
      errors.push({ code: 'bad_polarity', wireIndex: i, message: `polarity must be excitatory or inhibitory (got ${wire.polarity})` });
    }

    const fromDef = findPortDef(wire.from, components, defs);
    const toDef = findPortDef(wire.to, components, defs);
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
