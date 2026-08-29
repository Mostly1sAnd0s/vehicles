/**
 * Pure geometric raycasting against primitive obstacles (circle, rotated rect).
 * angle in radians; 0 points along +x, positive is y-down (canvas) direction.
 * Returns { hit: boolean, distance: number } where distance is the nearest hit
 * clamped to maxRange, or maxRange when nothing is hit.
 */

export function castRay(origin, angle, maxRange, obstacles) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = Infinity;

  for (const obs of obstacles) {
    let t = Infinity;
    if (obs.type === 'circle') t = rayCircle(origin.x, origin.y, dx, dy, obs);
    else if (obs.type === 'rect') t = rayRect(origin.x, origin.y, dx, dy, obs);
    if (t !== Infinity && t < best) best = t;
  }

  if (best <= maxRange) return { hit: true, distance: best };
  return { hit: false, distance: maxRange };
}

function rayCircle(ox, oy, dx, dy, c) {
  const px = ox - c.x;
  const py = oy - c.y;
  const a = dx * dx + dy * dy; // 1
  const b = 2 * (px * dx + py * dy);
  const cc = px * px + py * py - c.radius * c.radius;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  const EPS = 1e-9;
  if (t1 > EPS) return t1;
  if (t2 > EPS) return t2; // also the origin-inside case: the far exit point is still a "hit"
  return Infinity;
}

function rayRect(ox, oy, dx, dy, r) {
  // transform ray into the rect's local frame (slab test is invariant to the rigid transform)
  const rot = r.rotation ?? 0;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const relX = ox - r.x;
  const relY = oy - r.y;
  const lx0 = relX * cos - relY * sin;
  const ly0 = relX * sin + relY * cos;
  const ldx = dx * cos - dy * sin;
  const ldy = dx * sin + dy * cos;

  const hw = r.width / 2;
  const hh = r.height / 2;
  let tmin = 0;
  let tmax = Infinity;
  const EPS = 1e-9;

  for (const [o, d, h] of [[lx0, ldx, hw], [ly0, ldy, hh]]) {
    if (Math.abs(d) < EPS) {
      if (Math.abs(o) > h) return Infinity; // parallel and outside
    } else {
      let t1 = (-h - o) / d;
      let t2 = (h - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin > EPS ? tmin : tmax > EPS ? tmax : Infinity;
}
