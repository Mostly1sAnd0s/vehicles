/**
 * Vehicle-detection sensor model. Reuses the light sensor's cone geometry — a
 * field of view of full aperture `fov` (radians) centred on `direction`, capped
 * at `range` — but the things it looks for are OTHER vehicles, not light
 * sources, and the answer is presence.
 *
 * The nearest in-view target is reported (distance + pose) so the world view can
 * draw a marker/line to it and the on-body readout can show how close it is.
 */

import { inFov } from './light.js';

/**
 * @param {{x:number,y:number}} point      sensor sample position, world space
 * @param {number} direction               aim bearing (radians)
 * @param {number} range                   hard detection radius
 * @param {number|undefined} fov           full cone aperture in radians (omni when omitted / 2π)
 * @param {Array<{id?:any,x:number,y:number,angle?:number}>} targets other vehicles' poses
 * @param {any} selfId                     this vehicle's instance id (excluded from its own view)
 * @returns {{detected:boolean,distance:number|null,target:{x:number,y:number,...}|null}}
 */
export function detectVehicle(point, direction, range, fov, targets, selfId) {
  let best = null;
  for (const t of targets ?? []) {
    if (!t) continue;
    if (selfId !== undefined && t.id === selfId) continue; // never detect yourself
    const dx = t.x - point.x;
    const dy = t.y - point.y;
    const d = Math.hypot(dx, dy);
    if (d > range) continue; // hard range cap (inclusive)
    if (!inFov(Math.atan2(dy, dx), { aim: direction, fov })) continue; // outside the cone
    if (best === null || d < best.distance) best = { distance: d, target: t };
  }
  return best ? { detected: true, ...best } : { detected: false, distance: null, target: null };
}
