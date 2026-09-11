/**
 * World element inspector panel (extracted from WorldSim.renderInspector).
 */
import {
  isSolidBody,
  authoredBodyRadius,
  bodyConfig,
  DEFAULT_LIGHT_MIN_RADIUS,
  DEFAULT_LIGHT_MAX_RADIUS,
} from '../src/models/solidBody.js';
import { heatElementRange } from '../src/models/heatSource.js';

export function renderWorldInspector(sim) {
    const box = sim.ui.worldInspector;

    // A running vehicle takes the inspector over an element: show + edit its live
    // pose (X/Y/Rot), exactly like a selected light/rock/wall.
    if (sim.selectedInstance && !sim.instances.includes(sim.selectedInstance)) sim.selectedInstance = null;

    // Co-op (M5 p3): a selected SHARED bot shows the same X/Y/Rot popup. Its pose comes from the
    // latest server snapshot; an edit sends an authoritative moveBot command (host-only — the
    // server is the backstop). The selection clears itself if the bot leaves the world.
    const remoteBots = sim.hooks?.remoteBots?.() ?? [];
    if (sim.selectedRemoteBot && !remoteBots.some(b => b.id === sim.selectedRemoteBot.id)) sim.selectedRemoteBot = null;
    const rb = sim.selectedRemoteBot ? remoteBots.find(b => b.id === sim.selectedRemoteBot.id) : null;
    if (rb) {
      const canEdit = !!sim.hooks?.isCoopAdmin?.();
      // While the host drags this bot, show the optimistic pose — the canvas already renders it
      // there, and _refreshRemoteBotPopup keeps tracking it (drag or snapshot) as it moves.
      const dragPose = sim._dragBot?.id === rb.id ? sim._dragBot : null;
      const rx = dragPose ? dragPose.x : rb.x;
      const ry = dragPose ? dragPose.y : rb.y;
      box.style.display = 'block';
      box.innerHTML = `
        <h3 style="margin:0 0 6px">Shared bot${rb.owner ? ` · ${rb.owner}` : ''}${canEdit ? '' : ' (read-only)'}</h3>
        <label>X <input type="number" id="wi-ix" value="${Math.round(rx)}" ${canEdit ? '' : 'disabled'}></label>
        <label>Y <input type="number" id="wi-iy" value="${Math.round(ry)}" ${canEdit ? '' : 'disabled'}></label>
        <label>Rot&deg; <input type="number" id="wi-ir" step="5" value="${Math.round((rb.angle ?? 0) * 180 / Math.PI)}" ${canEdit ? '' : 'disabled'}></label>`;
      if (canEdit) {
        const apply = () => sim.hooks?.onBotChange?.({
          id: rb.id,
          x: Number(box.querySelector('#wi-ix').value),
          y: Number(box.querySelector('#wi-iy').value),
          rot: Number(box.querySelector('#wi-ir').value) * Math.PI / 180,
        });
        for (const id of ['wi-ix', 'wi-iy', 'wi-ir']) box.querySelector('#' + id).addEventListener('change', apply);
      }
      return;
    }

    const inst = sim.selectedInstance;
    if (inst && inst.body) {
      const proto = sim.worldDoc.vehiclePrototypes.find(p => p.id === inst.protoId);
      box.style.display = 'block';
      box.innerHTML = `
        <h3 style="margin:0 0 6px">${proto ? proto.name : 'Vehicle'}</h3>
        <label>X <input type="number" id="wi-ix" value="${Math.round(inst.body.position.x)}"></label>
        <label>Y <input type="number" id="wi-iy" value="${Math.round(inst.body.position.y)}"></label>
        <label>Rot&deg; <input type="number" id="wi-ir" step="5" value="${Math.round(inst.body.angle * 180 / Math.PI)}"></label>`;
      const apply = () => {
        sim.setInstancePose(
          inst,
          Number(box.querySelector('#wi-ix').value),
          Number(box.querySelector('#wi-iy').value),
          Number(box.querySelector('#wi-ir').value) * Math.PI / 180);
        sim.renderInspector();
      };
      for (const id of ['wi-ix', 'wi-iy', 'wi-ir']) box.querySelector('#' + id).addEventListener('change', apply);
      return;
    }

    const el = sim.selectedElement ? sim.worldDoc.elements.find(e => e.id === sim.selectedElement) : null;
    if (!el) { box.style.display = 'none'; return; }
    // Co-op (M5 p3): shared-world elements are host-controlled. Participants see the same popup
    // but read-only (matching the shared-bot contract) — inputs disabled, no Delete.
    const canEdit = !sim.coopMode || !!sim.hooks?.isCoopAdmin?.();
    const ro = canEdit ? '' : 'disabled';
    box.style.display = 'block';
    const isLight = el.type === 'light';
    const isHeat = el.type === 'heat';
    // Both are EMITTERS: a circular source of a field, with an optional solid body. They
    // share everything about their UI except the one property that defines the field —
    // intensity for light, temperature for heat — which is why the solid/slider/rotation
    // handling below is written once for both rather than duplicated.
    const isEmitter = isLight || isHeat;
    // Imported world JSON can carry an element with no `properties` object at all.
    // The template below reads (and the handlers write) `el.properties.X` directly,
    // so materialise it once here — the same hardening the Bumper inspector needed.
    if (!el.properties || typeof el.properties !== 'object') el.properties = {};
    // Solid-body + property bounds come from config/world.json per element TYPE (a lamp and a
    // furnace need not agree), never hard-coded here.
    const cfg = sim.state?.configs;
    const wcfg = bodyConfig(cfg, el.type);
    const RMIN = wcfg.minRadius ?? DEFAULT_LIGHT_MIN_RADIUS;
    const RMAX = Math.max(RMIN, wcfg.maxRadius ?? DEFAULT_LIGHT_MAX_RADIUS);
    const solid = isSolidBody(el, cfg);
    const rShown = Math.round(authoredBodyRadius(el, cfg));
    const [TMIN, TMAX] = heatElementRange(cfg);
    box.innerHTML = `
      <h3 style="margin:0 0 6px">${isLight ? 'Light source' : isHeat ? 'Heat source' : 'Obstacle'}${canEdit ? '' : ' (read-only)'}</h3>
      <label>X <input type="number" id="wi-x" value="${Math.round(el.position.x)}" ${ro}></label>
      <label>Y <input type="number" id="wi-y" value="${Math.round(el.position.y)}" ${ro}></label>
      ${isEmitter ? '' : `<label>Rot° <input type="number" id="wi-rot" step="5" value="${Math.round((el.rotation ?? 0) * 180 / Math.PI)}" ${ro}></label>`}
      <label>Scale <input type="number" id="wi-scale" step="0.1" value="${el.scale?.x ?? 1}" ${ro}></label>
      ${isLight
        ? `<label>Intensity <input type="number" id="wi-int" step="100" value="${el.properties.intensity ?? 1}" ${ro}></label>
           <label class="check"><input type="checkbox" id="wi-solid"${solid ? ' checked' : ''} ${ro}> Solid body (vehicles bump into it)</label>
           ${solid ? `<label>Body radius <input type="range" id="wi-sradius" min="${RMIN}" max="${RMAX}" step="1" value="${rShown}" ${ro}> <span id="wi-sradius-v">${rShown}</span></label>
             <div class="tip-box">The ring drawn on the lamp IS this radius — the barrier and the picture are the same number. Light sensing is unaffected.</div>` : ''}`
        : isHeat
          ? `<label>Temperature <input type="number" id="wi-temp" min="${TMIN}" max="${TMAX}" step="10" value="${el.properties.temperature ?? TMIN}" ${ro}> °C</label>
             <label class="check"><input type="checkbox" id="wi-solid"${solid ? ' checked' : ''} ${ro}> Solid body (vehicles bump into it)</label>
             ${solid ? `<label>Body radius <input type="range" id="wi-sradius" min="${RMIN}" max="${RMAX}" step="1" value="${rShown}" ${ro}> <span id="wi-sradius-v">${rShown}</span></label>` : ''}
             <div class="tip-box">Radiates heat (&prop; T⁴, inverse-square) — invisible to light sensors. Below room temperature it is a cold SINK. ${solid ? 'The ring IS the barrier.' : 'Not solid: robots drive straight through the fire.'}</div>`
          : el.primitive === 'circle'
          ? `<label>Radius <input type="number" id="wi-rad" value="${el.properties.radius ?? 10}" ${ro}></label>`
          : `<label>Width <input type="number" id="wi-w" value="${el.properties.width ?? 20}" ${ro}></label>
             <label>Height <input type="number" id="wi-h" value="${el.properties.height ?? 20}" ${ro}></label>`}
      ${canEdit ? '<button id="wi-del">Delete element</button>' : ''}`;
    // Every mutation also fires hooks.onElementChange so a connected host's edit reaches the
    // authoritative shared world + every joiner (position rides the existing moveElement stream;
    // the rest go out as an 'update' patch). Single-player: the hook is a no-op unless connected.
    const syncMove = () => sim.hooks?.onElementChange?.({ op: 'move', id: el.id, x: Math.round(el.position.x), y: Math.round(el.position.y) });
    const syncPatch = patch => sim.hooks?.onElementChange?.({ op: 'update', id: el.id, patch });
    const bind = (id, fn) => { if (!canEdit) return; box.querySelector('#' + id)?.addEventListener('change', e => { fn(Number(e.target.value)); sim.buildObstacles(); sim.renderInspector(); }); };
    bind('wi-x', v => { el.position.x = v; syncMove(); });
    bind('wi-y', v => { el.position.y = v; syncMove(); });
    // Rot is not emitted for a light (a circle has no orientation), so bind() finds
    // nothing there — that is intentional, not a missing control.
    bind('wi-rot', v => { el.rotation = v * Math.PI / 180; syncPatch({ rotation: el.rotation }); });
    bind('wi-scale', v => { el.scale.x = v; el.scale.y = v; syncPatch({ scale: { x: v, y: v } }); });
    bind('wi-int', v => { el.properties.intensity = v; syncPatch({ properties: { intensity: v } }); });
    // Temperature is clamped on the way IN as well as on the way OUT (the snapshot sanitises
    // too): the seam has to survive hand-written JSON, but the UI should never offer a value
    // it then silently changes on you.
    bind('wi-temp', v => {
      const n = Number.isFinite(v) ? Math.min(TMAX, Math.max(TMIN, v)) : TMIN;
      el.properties.temperature = n;
      syncPatch({ properties: { temperature: n } });
    });
    bind('wi-rad', v => { el.properties.radius = v; syncPatch({ properties: { radius: v } }); });
    bind('wi-w', v => { el.properties.width = v; syncPatch({ properties: { width: v } }); });
    bind('wi-h', v => { el.properties.height = v; syncPatch({ properties: { height: v } }); });
    // Solid-light controls. `bind()` coerces with Number(), which is wrong for a
    // checkbox, so these are wired directly. Both rebuild the physics bodies and
    // re-render the panel, so the ring, the readout and the barrier move together.
    const solidEl = box.querySelector('#wi-solid');
    if (solidEl && canEdit) {
      solidEl.addEventListener('change', e => {
        const on = !!e.target.checked;
        el.properties.solid = on;
        // Materialise the radius on the way IN so the element is self-describing and
        // round-trips through JSON import / the co-op wire with its size intact.
        if (on && !Number.isFinite(Number(el.properties.radius))) {
          el.properties.radius = authoredBodyRadius(el, cfg);
        }
        sim.buildObstacles();
        // Nudge (don't fling) any bot the new barrier landed on top of, before the
        // patch goes out so the shared world evicts identically.
        if (on) sim.evictOverlappingBots();
        syncPatch({ properties: { solid: on } });
        sim.renderInspector(); // reveals/hides the radius row
      });
    }
    const srEl = box.querySelector('#wi-sradius');
    if (srEl && canEdit) {
      // A non-numeric value keeps the current authored radius rather than writing
      // NaN into props.radius — a NaN obstacle radius builds a degenerate Matter
      // body with NaN inertia, which poisons the whole world, not just this lamp.
      const clamp = v => {
        const n = Number(v);
        if (!Number.isFinite(n)) return authoredBodyRadius(el, cfg);
        return Math.min(RMAX, Math.max(RMIN, Math.round(n)));
      };
      // `input` repaints live (ring + barrier together, no wire traffic); `change`
      // syncs out on release — the same split the Bumper slider uses.
      srEl.addEventListener('input', e => {
        el.properties.radius = clamp(e.target.value);
        const readout = box.querySelector('#wi-sradius-v');
        if (readout) readout.textContent = el.properties.radius;
        sim.buildObstacles();
      });
      srEl.addEventListener('change', e => {
        el.properties.radius = clamp(e.target.value);
        syncPatch({ properties: { radius: el.properties.radius } });
        sim.renderInspector();
      });
    }
    const delBtn = box.querySelector('#wi-del'); // absent for read-only (co-op participant) popups
    if (delBtn) delBtn.onclick = () => {
      sim.worldDoc.elements = sim.worldDoc.elements.filter(e => e.id !== el.id);
      sim.selectedElement = null;
      sim.buildObstacles();
      sim.renderInspector();
      // Without this the DELETE never left the page: the server world (authoritative physics!)
      // and every joiner kept the rock/wall/light forever. Co-opClient.removeElement and
      // Session._removeElement existed and were tested — nothing in the app ever called them.
      sim.hooks?.onElementChange?.({ op: 'remove', id: el.id });
    };
  }
