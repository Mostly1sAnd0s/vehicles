// Pure helpers for vehicle-type CRUD in the world document.
// No DOM / Matter.js here: everything is testable with plain node --test.

/** Default chassis used when there is no existing prototype to clone from. */
export function blankVehicle() {
  return {
    schemaVersion: 1,
    id: 'my-vehicle',
    name: 'New Vehicle',
    body: { shape: 'rect', width: 80, height: 40 },
    components: [],
    wires: [],
  };
}

/**
 * Next unused "Vehicle X" name for the given prototypes.
 * Scan order: A..Z, then AA..AZ.. (filling gaps first). Unrelated names ignored.
 */
export function nextVehicleName(prototypes) {
  const used = new Set((prototypes ?? [])
    .map(p => p.name)
    .filter(n => /^Vehicle [A-Z]{1,2}$/.test(n))
    .map(n => n.slice(8)));
  for (let len = 1; len <= 2; len++) {
    for (let a = 0; a < 26; a++) {
      if (!used.has(String.fromCharCode(65 + a))) return `Vehicle ${String.fromCharCode(65 + a)}`;
      if (len === 1) continue;
      for (let b = 0; b < 26; b++) {
        const two = String.fromCharCode(65 + a) + String.fromCharCode(65 + b);
        if (!used.has(two)) return `Vehicle ${two}`;
      }
    }
  }
  // Beyond AA..ZZ: fall back to a number so the UI still works.
  let i = 1;
  while (used.has(String(i))) i += 1;
  return `Vehicle ${i}`;
}

/**
 * Build a new vehicle prototype doc entry.
 * - name: proto display name (e.g. from nextVehicleName)
 * - vehicle: template vehicle doc, cloned into `_vehicle`
 * - count: number of seed instances to place near origin (rng injectable for tests)
 */
export function makePrototype({ id, name, vehicle, count = 0, rng = Math.random }) {
  const instances = [];
  for (let i = 0; i < count; i++) {
    instances.push({
      id: `inst_${Date.now().toString(36)}_${i}`,
      position: { x: Math.round((rng() - 0.5) * 200), y: Math.round((rng() - 0.5) * 200) },
      rotation: rng() * Math.PI * 2,
    });
  }
  return {
    id: id ?? `proto_${Date.now().toString(36)}_${Math.floor(rng() * 1e6).toString(36)}`,
    name,
    _vehicle: JSON.parse(JSON.stringify(vehicle)),
    instances,
  };
}

/**
 * Return a new world doc with the given prototype removed (input untouched).
 * Throws on unknown proto id so a misclick can never silently delete the wrong thing.
 */
export function removePrototype(worldDoc, protoId) {
  if (!worldDoc.vehiclePrototypes.some(p => p.id === protoId)) {
    throw new Error(`Unknown vehicle prototype: ${protoId}`);
  }
  const doc = JSON.parse(JSON.stringify(worldDoc));
  doc.vehiclePrototypes = doc.vehiclePrototypes.filter(p => p.id !== protoId);
  return doc;
}
