/**
 * Snap point generation for body shapes.
 * Points are distributed around the perimeter, always including corners.
 * Origin is the shape center; canvas coordinates (y-down).
 * Traversal order: top-left corner clockwise (top, right, bottom, left edges).
 */

export function generateSnapPoints(shape, n) {
  if (!shape || typeof shape.width !== 'number' || typeof shape.height !== 'number') {
    throw new Error('generateSnapPoints requires a rect shape {width, height}');
  }
  if (shape.width <= 0 || shape.height <= 0) {
    throw new Error('rect dimensions must be positive');
  }
  if (!Number.isInteger(n) || n < 4) {
    throw new Error('n must be an integer >= 4');
  }

  const hw = shape.width / 2;
  const hh = shape.height / 2;

  // interior points per edge: corners (4) are fixed, split the rest.
  const base = Math.floor((n - 4) / 4);
  const rem = (n - 4) % 4;

  // edge definitions in clockwise order starting top-left.
  // Each edge: start corner, end corner, unit normal (outward), length.
  const edges = [
    { ax: -hw, ay: -hh, bx: hw, by: -hh, nx: 0, ny: -1 }, // top
    { ax: hw, ay: -hh, bx: hw, by: hh, nx: 1, ny: 0 },    // right
    { ax: hw, ay: hh, bx: -hw, by: hh, nx: 0, ny: 1 },    // bottom
    { ax: -hw, ay: hh, bx: -hw, by: -hh, nx: -1, ny: 0 }, // left
  ];

  const points = [];
  edges.forEach((edge, i) => {
    const interiorCount = base + (i < rem ? 1 : 0);
    // start corner
    points.push(cornerPoint(edge.ax, edge.ay, edges, i));
    for (let j = 1; j <= interiorCount; j++) {
      const t = j / (interiorCount + 1);
      points.push({
        x: edge.ax + (edge.bx - edge.ax) * t,
        y: edge.ay + (edge.by - edge.ay) * t,
        normalX: edge.nx,
        normalY: edge.ny,
      });
    }
  });

  return points;
}

function cornerPoint(x, y, edges, prevEdgeIndex) {
  // corner normal = normalized sum of the two adjacent edge normals
  const next = edges[prevEdgeIndex];
  const prev = edges[(prevEdgeIndex + 3) % 4];
  let nx = next.nx + prev.nx;
  let ny = next.ny + prev.ny;
  const len = Math.hypot(nx, ny);
  return { x, y, normalX: nx / len, normalY: ny / len };
}
