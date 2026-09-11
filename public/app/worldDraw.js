/**
 * World canvas rendering (extracted from WorldSim.draw for file-size limits).
 * Pure presentation: reads sim state, draws lights/obstacles/instances/beams.
 */
import { worldElementsToSnapshot } from '../src/simulation/worldSnapshot.js';
import { componentSize } from '../src/models/hitTest.js';
import { isSolidBody, solidBodyRadius } from '../src/models/solidBody.js';
import { heatSourceColor, elementAmbientC } from '../src/models/heatSource.js';
import { hexToRgba, lightenHex, DEFAULT_BODY_COLOR } from './color.js';

export function drawWorld(sim) {
    const cv = sim.canvas;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== cv.clientWidth * dpr || cv.height !== cv.clientHeight * dpr) {
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.translate(cv.clientWidth / 2, cv.clientHeight / 2);
    ctx.scale(sim.view.zoom, sim.view.zoom);
    ctx.translate(-sim.view.x, -sim.view.y);

    const snap = worldElementsToSnapshot(sim.worldDoc.elements, sim.state?.configs);

    // lights: radial glow
    for (const l of snap.lights) {
      const r = 14 * Math.log2(2 + l.intensity);
      const g = ctx.createRadialGradient(l.x, l.y, 2, l.x, l.y, Math.max(r * 4, 60));
      g.addColorStop(0, 'rgba(255,230,150,.95)');
      g.addColorStop(0.25, 'rgba(255,200,90,.35)');
      g.addColorStop(1, 'rgba(255,200,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(l.x, l.y, Math.max(r * 4, 60), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath();
      ctx.arc(l.x, l.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // HEAT sources: a thermal field, drawn warm (or cool blue for a cold sink) so a furnace
    // never reads as a lamp. The glow is decoration; the SOLID ring below is the barrier, and
    // the temperature label is the number the physics actually used. Colour comes from
    // heatSourceColor() — the same ramp the editor uses, so "hot" looks the same everywhere.
    for (const h of snap.heats) {
      const ambient = elementAmbientC(sim.state?.configs);
      const temp = Number.isFinite(h.temperatureC) ? h.temperatureC : ambient;
      const color = heatSourceColor(temp, sim.state?.configs);
      // Glow radius grows with how far above (or below) ambient it is — a 25 °C radiator is
      // nearly invisible, a 900 °C one floods the screen. sqrt so the scale stays readable.
      const strength = Math.sqrt(Math.abs(temp - ambient) / 100);
      const r = Math.max(26, 34 * strength);
      const rgb = color.match(/\d+/g) ?? [255, 120, 60];
      const g = ctx.createRadialGradient(h.x, h.y, 2, h.x, h.y, r * 2.2);
      g.addColorStop(0, `rgba(${rgb.join(',')},.9)`);
      g.addColorStop(0.3, `rgba(${rgb.join(',')},.28)`);
      g.addColorStop(1, `rgba(${rgb.join(',')},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(h.x, h.y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(h.x, h.y, Math.max(5, r * 0.32), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(temp)}\u00b0C`, h.x, h.y - Math.max(9, r * 0.45));
      ctx.textAlign = 'left';
    }

    // SOLID emitters (lamp or furnace): a real object a vehicle can bump into. Drawn after the
    // glow so the ring is not washed out, and at `solidBodyRadius()` — the SAME pure function
    // the snapshot handed the physics engine — so the ring IS the barrier and the two can never
    // drift apart. Same idiom as a Bumper: an outline ring reads as a barrier rather than a
    // solid mount. Not gated by the Beams toggle: the barrier is there whether sim or paused.
    for (const el of sim.worldDoc.elements ?? []) {
      if (!isSolidBody(el, sim.state?.configs)) continue;
      const R = solidBodyRadius(el, sim.state?.configs);
      const x = el.position.x, y = el.position.y;
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,236,190,0.95)';
      ctx.stroke();
      // dashed halo just outside: reads as "solid" and separates a lamp-body ring
      // from a rock's silhouette at a glance
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(x, y, R + 3.5, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(150,180,220,0.55)';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // obstacles
    for (const obs of snap.obstacles) {
      ctx.fillStyle = '#3a4657';
      ctx.strokeStyle = '#55647a';
      ctx.lineWidth = 1.5;
      if (obs.type === 'circle') {
        ctx.beginPath();
        ctx.arc(obs.x, obs.y, obs.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.save();
        ctx.translate(obs.x, obs.y);
        ctx.rotate(obs.rotation);
        ctx.fillRect(-obs.width / 2, -obs.height / 2, obs.width, obs.height);
        ctx.strokeRect(-obs.width / 2, -obs.height / 2, obs.width, obs.height);
        ctx.restore();
      }
    }

    // Co-op (M5): while connected, the canvas IS the shared world. Static elements above are
    // already mirrored from the server, but local instances/paths/readouts/beams would be a
    // second (frozen) simulation painted over the real one — skip everything instance-driven.
    if (sim.coopMode) return;

    // instances
    for (const inst of sim.instances) {
      const v = sim.vehicleFor(inst);
      if (!v || !inst.body) continue;
      const b = inst.body;
      ctx.save();
      ctx.translate(b.position.x, b.position.y);
      ctx.rotate(b.angle);

      // body: fill is the chosen color; outline a few shades lighter than it
      const bodyColor = v.body?.color ?? DEFAULT_BODY_COLOR;
      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = lightenHex(bodyColor);
      ctx.lineWidth = 2;
      ctx.fillRect(-v.body.width / 2, -v.body.height / 2, v.body.width, v.body.height);
      ctx.strokeRect(-v.body.width / 2, -v.body.height / 2, v.body.width, v.body.height);

      for (const c of v.components) {
        if (!c.local) continue;
        const def = sim.componentDef(c.type);
        const s = componentSize(c, def);
        ctx.beginPath();
        if (s.kind === 'rect') {
          ctx.save();
          ctx.translate(c.local.x, c.local.y);
          ctx.rotate(c.localRotation ?? 0);
          ctx.rect(-s.along / 2, -s.lateral / 2, s.along, s.lateral);
          ctx.restore();
          ctx.fillStyle = def?.category === 'actuator' ? '#35547a' : '#2f6b46';
          ctx.fill();
        } else if (c.type === 'bumper') {
          // collision barrier: outline ring (no fill) at its live collision radius
          ctx.arc(c.local.x, c.local.y, s.radius, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(200,210,225,0.9)';
          ctx.lineWidth = 2;
          ctx.stroke();
        } else {
          ctx.arc(c.local.x, c.local.y, s.radius, 0, Math.PI * 2);
          ctx.fillStyle = def?.category === 'actuator' ? '#35547a' : '#2f6b46';
          ctx.fill();
        }
      }
      // conversion flash: a freshly-converted robot rings green, fading over 700ms.
      if (inst.flashUntil && typeof performance !== 'undefined' && inst.flashUntil > performance.now()) {
        const t = Math.max(0, (inst.flashUntil - performance.now()) / 700);
        ctx.strokeStyle = `rgba(141,255,190,${(0.35 + 0.6 * t).toFixed(3)})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(-v.body.width / 2 - 6, -v.body.height / 2 - 6, v.body.width + 12, v.body.height + 12);
      }
      ctx.restore();
    }

    // motion trails (drawn over the bodies), gated by the Paths toggle
    if (sim.paths) {
      for (const inst of sim.instances) {
        const v = sim.vehicleFor(inst);
        if (!v || !Array.isArray(inst.path) || inst.path.length < 2) continue;
        ctx.beginPath();
        inst.path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.strokeStyle = hexToRgba(v.body?.color ?? DEFAULT_BODY_COLOR, 0.5);
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }

    // on-body readouts: sensor level→output per sensor, signed force per wheel (upright)
    if (sim.showValues) {
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const inst of sim.instances) {
        const v = sim.vehicleFor(inst);
        if (!v || !inst.body) continue;
        const a = inst.body.angle;
        const toWorld = l => ({ x: inst.body.position.x + Math.cos(a) * l.x - Math.sin(a) * l.y,
                                y: inst.body.position.y + Math.sin(a) * l.x + Math.cos(a) * l.y });
        const label = (x, y, text, color) => {
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.strokeText(text, x, y);
          ctx.fillStyle = color;
          ctx.fillText(text, x, y);
        };
        // world X/Y above the body (centered-ish), for distance-to-light comparison
        label(inst.body.position.x - 34, inst.body.position.y - ((v.body?.height ?? 40) / 2 + 12),
              `x ${Math.round(inst.body.position.x)}  y ${Math.round(inst.body.position.y)}`, '#e8f0ff');
        for (const s of inst.lastSamples ?? []) {
          const comp = v.components.find(c => c.id === s.componentId);
          if (!comp?.local) continue;
          const p = toWorld(comp.local);
          let txt;
          let col = '#ffd479';
          if (s.kind === 'heat') {
            // The probe's OWN temperature and what that maps to, so a lagging reading is
            // visible as what it is: still climbing, not stuck.
            txt = `H ${Math.round(s.heatTemperatureC)}\u00b0C\u2192${s.value.toFixed(2)}`;
            col = s.heatTemperatureC > (s.ambientC ?? 20) + 2 ? '#ff9c5a' : '#8fb8ff';
          } else if (comp.type.startsWith('light') && s.lightLevel !== undefined) {
            const dTxt = s.lightDistance != null ? ` d\u2248${Math.round(s.lightDistance)}` : '';
            txt = `L ${s.lightLevel.toFixed(2)}\u2192${s.value.toFixed(2)}${dTxt}`;
          } else if (comp.type === 'vehicle_detection_sensor') {
            const dTxt = s.detected && s.detectedDistance != null ? ` d\u2248${Math.round(s.detectedDistance)}` : '';
            txt = `V ${s.detected ? 1 : 0}${dTxt}`;
            col = s.detected ? '#8dffbe' : '#ffd479';
          } else {
            txt = `${comp.type.startsWith('distance') ? 'D' : '?'} ${s.value.toFixed(2)}`;
          }
          label(p.x + 8, p.y - 9, txt, col);
        }
        for (const m of inst.lastMotors ?? []) {
          const p = toWorld(m.local);
          const txt = m.force < 0 ? `M -${Math.abs(m.force).toFixed(2)}` : `M +${m.force.toFixed(2)}`;
          label(p.x + 8, p.y + 9, txt, m.force < 0 ? '#ff9d9d' : '#9ad0ff');
        }
      }
    }

    // sensor beams
    if (sim.beams) {
      for (const s of sim.lastSamples) {
        // Vehicle-detection sensor: a cone whose aperture IS its FOV and whose
        // length IS its full range. Faint green when idle, bright when it is
        // actually seeing another vehicle, plus a line + ring to that target.
        if (s.kind === 'vehicle') {
          const vfov = s.fov === undefined || !Number.isFinite(s.fov) ? 2 * Math.PI : s.fov;
          const reach = s.effectiveRange ?? s.range ?? 0;
          const sx = s.samplePoint.x, sy = s.samplePoint.y;
          if (reach > 0) {
            const half = Math.min(vfov / 2, Math.PI);
            const on = s.detected ? 1 : 0;
            const rgb = on ? '90,240,170' : '120,205,165';
            const alpha = 0.12 + 0.6 * on;
            ctx.beginPath();
            if (half >= Math.PI - 1e-3) {
              ctx.arc(sx, sy, reach, 0, 2 * Math.PI);
            } else {
              const a1 = s.direction - half, a2 = s.direction + half;
              ctx.moveTo(sx, sy);
              ctx.lineTo(sx + Math.cos(a1) * reach, sy + Math.sin(a1) * reach);
              ctx.arc(sx, sy, reach, a1, a2);
            }
            ctx.closePath();
            ctx.fillStyle = `rgba(${rgb},${(alpha * 0.2).toFixed(3)})`;
            ctx.fill();
            ctx.strokeStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
            ctx.lineWidth = 1 + 1.5 * on;
            ctx.stroke();
          }
          if (s.detected && s.detectedTarget) {
            const t = s.detectedTarget;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(t.x, t.y);
            ctx.strokeStyle = 'rgba(120,255,190,0.75)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(t.x, t.y, 6 + (s.detectedDistance ?? 0) * 0.05, 0, 2 * Math.PI);
            ctx.strokeStyle = 'rgba(120,255,190,0.9)';
            ctx.stroke();
          }
          continue;
        }
        // Light AND heat sensors are the same picture — an aperture-equals-FOV wedge whose
        // length is the sensor's TRUE reach — so they share one branch and differ only in hue
        // and in which level field drives the brightness. (Keyed on `kind`, because a heat
        // sample also carries `effectiveRange`; testing that field alone would silently paint
        // every heat sensor amber and call it a day.)
        const isHeat = s.kind === 'heat';
        const isWedge = isHeat || s.effectiveRange !== undefined;
        const wedgeRgb = isHeat ? '255,110,55' : '255,180,90';
        let length;
        let level;
        if (isWedge) {
          // Light sensor: a wedge (triangle) whose aperture IS the sensor FOV
          // and whose length IS its sensitivity. Brightness tracks the detected
          // light level; when no light is in view it still shows the FOV shape
          // faintly at full range so you can see what the sensor "looks" at.
          // The beam IS the sensor's actual current sensing radius
          // (effectiveRange = min(thresholdRadius, range)). We do NOT fall back
          // to the configured range when nothing is in view: that used to draw
          // a large faint ghost ring that looked like a sensing radius but
          // wasn't — real sensing begins at this radius. When nothing is within
          // range we just mark the sensor's position with a small dot.
          const fov = (s.fov === undefined || !Number.isFinite(s.fov)) ? 2 * Math.PI : s.fov;
          const lvl = Math.min(Math.max((isHeat ? s.heatLevel : s.lightLevel) ?? 0, 0), 1);
          const reach = s.effectiveRange ?? 0;
          const sx = s.samplePoint.x, sy = s.samplePoint.y;
          if (reach <= 0) {
            ctx.beginPath();
            ctx.arc(sx, sy, 3, 0, 2 * Math.PI);
            ctx.strokeStyle = `rgba(${wedgeRgb},0.25)`;
            ctx.lineWidth = 1;
            ctx.stroke();
            continue;
          }
          const half = Math.min(fov / 2, Math.PI);
          const alpha = 0.06 + 0.8 * lvl;
          ctx.beginPath();
          if (half >= Math.PI - 1e-3) {
            ctx.arc(sx, sy, reach, 0, 2 * Math.PI); // omni: full circle
          } else {
            const a1 = s.direction - half, a2 = s.direction + half;
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + Math.cos(a1) * reach, sy + Math.sin(a1) * reach);
            ctx.arc(sx, sy, reach, a1, a2); // edge -> arc -> other edge = wedge
          }
          ctx.closePath();
          ctx.fillStyle = `rgba(${wedgeRgb},${(alpha * 0.22).toFixed(3)})`;
          ctx.fill();
          ctx.strokeStyle = `rgba(${wedgeRgb},${alpha.toFixed(3)})`;
          ctx.lineWidth = 1 + 1.5 * lvl;
          ctx.stroke();
          continue;
        }

        // Distance sensor: thin full-range ray.
        length = sim.vehicleFor(sim.instances.find(i => i.id === s.instanceId))
          ?.components.find(c => c.id === s.componentId)?.props?.range ?? 150;
        level = 1;
        if (length <= 0) continue;
        const end = { x: s.samplePoint.x + Math.cos(s.direction) * length,
                      y: s.samplePoint.y + Math.sin(s.direction) * length };
        ctx.beginPath();
        ctx.moveTo(s.samplePoint.x, s.samplePoint.y);
        ctx.lineTo(end.x, end.y);
        ctx.strokeStyle = `rgba(140,200,255,${0.35.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Propagator trigger range: a full circle centred on the Propagator's own
      // position, radius = its threshold. This IS the conversion boundary, so it
      // shows exactly which side of the host can convert (and how far) — adjust
      // the threshold and watch the ring grow/shrink to match.
      for (const inst of sim.instances) {
        const v = sim.vehicleFor(inst);
        if (!v || !inst.body) continue;
        const prop = (v.components ?? []).find(c => c.type === 'propagate');
        if (!prop?.local) continue;
        const a = inst.body.angle;
        const cx = inst.body.position.x + Math.cos(a) * prop.local.x - Math.sin(a) * prop.local.y;
        const cy = inst.body.position.y + Math.sin(a) * prop.local.x + Math.cos(a) * prop.local.y;
        const R = Math.max(0, prop.props?.threshold ?? 260);
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(141,255,190,0.05)';
        ctx.fill();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = 'rgba(141,255,190,0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

