/**
 * World element inspector panel (extracted from WorldSim.renderInspector).
 */
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
      box.style.display = 'block';
      box.innerHTML = `
        <h3 style="margin:0 0 6px">Shared bot${rb.owner ? ` · ${rb.owner}` : ''}${canEdit ? '' : ' (read-only)'}</h3>
        <label>X <input type="number" id="wi-ix" value="${Math.round(rb.x)}" ${canEdit ? '' : 'disabled'}></label>
        <label>Y <input type="number" id="wi-iy" value="${Math.round(rb.y)}" ${canEdit ? '' : 'disabled'}></label>
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
    box.style.display = 'block';
    const isLight = el.type === 'light';
    box.innerHTML = `
      <h3 style="margin:0 0 6px">${isLight ? 'Light source' : 'Obstacle'}</h3>
      <label>X <input type="number" id="wi-x" value="${Math.round(el.position.x)}"></label>
      <label>Y <input type="number" id="wi-y" value="${Math.round(el.position.y)}"></label>
      <label>Rot° <input type="number" id="wi-rot" step="5" value="${Math.round(el.rotation * 180 / Math.PI)}"></label>
      <label>Scale <input type="number" id="wi-scale" step="0.1" value="${el.scale?.x ?? 1}"></label>
      ${isLight
        ? `<label>Intensity <input type="number" id="wi-int" step="100" value="${el.properties.intensity ?? 1}"></label>`
        : el.primitive === 'circle'
          ? `<label>Radius <input type="number" id="wi-rad" value="${el.properties.radius ?? 10}"></label>`
          : `<label>Width <input type="number" id="wi-w" value="${el.properties.width ?? 20}"></label>
             <label>Height <input type="number" id="wi-h" value="${el.properties.height ?? 20}"></label>`}
      <button id="wi-del">Delete element</button>`;
    const bind = (id, fn) => box.querySelector('#' + id)?.addEventListener('change', e => { fn(Number(e.target.value)); sim.buildObstacles(); sim.renderInspector(); });
    bind('wi-x', v => el.position.x = v);
    bind('wi-y', v => el.position.y = v);
    bind('wi-rot', v => el.rotation = v * Math.PI / 180);
    bind('wi-scale', v => { el.scale.x = v; el.scale.y = v; });
    bind('wi-int', v => el.properties.intensity = v);
    bind('wi-rad', v => el.properties.radius = v);
    bind('wi-w', v => el.properties.width = v);
    bind('wi-h', v => el.properties.height = v);
    box.querySelector('#wi-del').onclick = () => {
      sim.worldDoc.elements = sim.worldDoc.elements.filter(e => e.id !== el.id);
      sim.selectedElement = null;
      sim.buildObstacles();
      sim.renderInspector();
    };
  }
