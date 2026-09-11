// Headless smoke probe: SOLID LIGHT SOURCE, end-to-end through the real DOM.
//
// Covers what the unit tests cannot: that the inspector actually emits the controls,
// that toggling them rebuilds the physics bodies, that the drawn ring and the Matter
// body are the same number, and that a driven robot is actually stopped by a solid
// lamp (and passes straight through the same lamp when it is not solid).
//
// Owns its own web port (8935), CDP port (9248) and Chrome profile, per the repo
// rule that no two probes share a port.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9248;
const WEB = 8935;
// UNIQUE profile per run. A reused profile keeps Chrome's HTTP cache, and
// `python3 -m http.server` sends no Cache-Control, so Chrome's heuristic caching can
// serve a world/config JSON captured on an EARLIER run: the app then silently edits a
// stale document (observed: a sample-world element added between runs was missing from
// `state.world`, while a `cache:'no-store'` fetch saw it fine). A fresh profile costs
// ~200ms; the alternative is a probe that can fail for reasons unrelated to the code
// under test.
const PROFILE = `/tmp/bv-profile-solid-${process.pid}`;

// Free BOTH ports. The web port alone is not enough: if a previous run's Chrome still
// holds the CDP debug port, the new Chrome cannot bind it and this probe attaches to a
// DEAD browser from an earlier run — driving a stale page and reporting a green that
// tests nothing. (This happened: a leftover Chrome served a page captured before a
// revert, and every assertion passed against code that was no longer on disk.)
spawn('sh', ['-c', `lsof -ti:${WEB} | xargs -r kill 2>/dev/null; lsof -ti:${PORT} | xargs -r kill 2>/dev/null; true`], { stdio: 'ignore' });
await sleep(400);
spawn('sh', ['-c', `rm -rf ${PROFILE}; true`], { stdio: 'ignore' });
await sleep(200);
// Proof-of-freshness: only a page WE just loaded carries this nonce.
const NONCE = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const srv = spawn('sh', ['-c', `python3 -m http.server ${WEB} --directory public > /tmp/bv-srv-${WEB}.log 2>&1`], { stdio: 'ignore' });
await sleep(700);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  chrome.kill('SIGKILL'); srv.kill('SIGKILL');
  spawn('sh', ['-c', `rm -rf ${PROFILE}; true`], { stdio: 'ignore' });
};
const fail = m => { console.error('FAIL:', m); cleanup(); process.exit(1); };
const pass = m => console.log('PASS:', m);

try {
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); }
  }
  if (!targets) fail('chrome devtools not reachable');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise(r => ws.onopen = r);
  const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
    if (r.error) throw new Error('CDP error: ' + JSON.stringify(r.error));
    const o = r.result ?? {};
    if (o.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(o.exceptionDetails.exception?.description ?? o.exceptionDetails.text));
    return o.result?.value;
  };

  await send('Page.enable', {});
  await send('Page.navigate', { url: `http://127.0.0.1:${WEB}/index.html?nc=${NONCE}&worker=0` });
  for (let i = 0; i < 60; i++) {
    const ready = await ev(`document.readyState === 'complete' && !!window.__app()`).catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  const boot = await ev(`(() => { const a = window.__app(); document.getElementById('tab-world').click();
    return { app: !!a, sim: !!a.worldSim, els: a.state.world.elements.map(e => e.id), solidEls: a.state.world.elements.filter(e => e.properties?.solid).map(e => e.id) }; })()`);
  if (!boot.app || !boot.sim) fail('app/worldSim did not boot: ' + JSON.stringify(boot));
  // The single check that makes every other assertion trustworthy: we are driving a page
  // we loaded in this run, not a leftover tab in someone else's headless Chrome.
  const href = await ev('location.href');
  if (!href.includes(NONCE)) fail(`attached to a STALE page (${href}) — another browser owns CDP port ${PORT}; kill it and re-run`);
  pass('app booted on the World tab: ' + JSON.stringify(boot.els));

  // ---- 1. the inspector emits the solid controls for a light ----------------
  const t1 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const light = sim.worldDoc.elements.find(e => e.type === 'light');
    if (!light) return { error: 'no light in the sample world' };
    if (light.properties?.solid) return { error: 'the probe toggles the FIRST light; it must start non-solid' };
    sim.selectedElement = light.id; sim.renderInspector();
    const box = document.getElementById('world-inspector');
    return {
      id: light.id,
      heading: box.querySelector('h3')?.textContent,
      hasSolid: !!box.querySelector('#wi-solid'),
      solidChecked: !!box.querySelector('#wi-solid')?.checked,
      hasRadius: !!box.querySelector('#wi-sradius'),
      propsSolid: light.properties?.solid ?? null,
      baseline: sim.obstacleBodies.length,
    };
  })()`);
  if (t1.error) fail(t1.error);
  if (!t1.hasSolid) fail('inspector did not emit #wi-solid for a light: ' + JSON.stringify(t1));
  if (t1.solidChecked) fail('a fresh light must start NOT solid (existing worlds unchanged)');
  if (t1.hasRadius) fail('the radius row must be hidden while the light is not solid');
  const BASE = t1.baseline; // the sample world may ship its own solid lamp; everything below is a delta
  pass(`inspector emits the Solid toggle, unchecked, with no radius row (baseline static bodies: ${BASE})`);

  // ---- 2. toggling solid builds a body and reveals the radius row ----------
  const t2 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const light = sim.worldDoc.elements.find(e => e.type === 'light');
    const box = document.getElementById('world-inspector');
    const cb = box.querySelector('#wi-solid');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    const bodies = sim.obstacleBodies;
    return {
      propsSolid: light.properties.solid,
      propsRadius: light.properties.radius,
      hasRadius: !!document.querySelector('#wi-sradius'),
      radiusMin: document.querySelector('#wi-sradius')?.min,
      radiusMax: document.querySelector('#wi-sradius')?.max,
      bodyCount: bodies.length,
      isStatic: bodies[0] ? bodies[0].isStatic : null,
      bodyRadius: bodies[0] ? bodies[0].circleRadius : null,
      bodyPos: bodies[0] ? { x: bodies[0].position.x, y: bodies[0].position.y } : null,
      lightPos: { x: light.position.x, y: light.position.y },
    };
  })()`);
  if (t2.error) fail(t2.error);
  if (t2.propsSolid !== true) fail('toggling did not set properties.solid=true: ' + JSON.stringify(t2));
  if (!Number.isFinite(t2.propsRadius)) fail('enabling solid must materialise a numeric radius, got ' + t2.propsRadius);
  if (!t2.hasRadius) fail('the radius row did not appear after enabling solid');
  if (t2.bodyCount !== BASE + 1) fail(`expected exactly one NEW static body (${BASE}+1), got ${t2.bodyCount}`);
  if (t2.isStatic !== true) fail('the lamp body must be static');
  if (t2.bodyPos.x !== t2.lightPos.x || t2.bodyPos.y !== t2.lightPos.y) fail('body is not centred on the lamp: ' + JSON.stringify(t2));
  pass(`toggling solid built a static body (r=${t2.bodyRadius}) on the lamp and revealed the slider [${t2.radiusMin}..${t2.radiusMax}]`);

  // ---- 3. the drawn ring IS the barrier (same pure function, same number) --
  const t3 = await ev(`(async () => {
    const sim = window.__app().worldSim;
    const light = sim.worldDoc.elements.find(e => e.type === 'light');
    const sb = await import('/src/models/solidBody.js');
    const bodyOf = l => sim.obstacleBodies.find(b => Math.abs(b.position.x - l.position.x) < 0.5 && Math.abs(b.position.y - l.position.y) < 0.5);
    return {
      ring: sb.solidLightRadius(light, sim.state.configs),
      body: bodyOf(light).circleRadius,
      isSolid: sb.isSolidLight(light, sim.state.configs),
    };
  })()`);
  if (Math.abs(t3.ring - t3.body) > 1e-9) fail('ring and barrier disagree: ring=' + t3.ring + ' body=' + t3.body);
  if (t3.isSolid !== true) fail('isSolidLight disagrees with the UI state');
  pass('ring === barrier (both from solidLightRadius, exactly ' + t3.ring + ')');

  // ---- 4. the slider moves the barrier live -------------------------------
  const t4 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const light = sim.worldDoc.elements.find(e => e.type === 'light');
    const bodyOf = l => sim.obstacleBodies.find(b => Math.abs(b.position.x - l.position.x) < 0.5 && Math.abs(b.position.y - l.position.y) < 0.5);
    const s = document.getElementById('wi-sradius');
    s.value = '60'; s.dispatchEvent(new Event('input'));
    const liveBody = bodyOf(light).circleRadius;
    const readout = document.getElementById('wi-sradius-v').textContent;
    s.dispatchEvent(new Event('change'));
    // and out of range: the clamp must hold the authored value inside [min,max]
    s.value = '99999'; s.dispatchEvent(new Event('input'));
    const clamped = light.properties.radius;
    const clampedBody = bodyOf(light).circleRadius;
    return { liveBody, readout, propsRadius: light.properties.radius, clamped, clampedBody };
  })()`);
  if (Math.abs(t4.liveBody - 60) > 1e-9) fail('slider input did not move the body live, got ' + t4.liveBody);
  if (t4.readout !== '60') fail('readout did not track the slider, got ' + t4.readout);
  if (t4.clamped >= 99999) fail('out-of-range slider value was not clamped: ' + t4.clamped);
  if (Math.abs(t4.clampedBody - t4.clamped) > 1e-9) fail('clamped property and body disagree');
  pass(`slider drives the barrier live (60) and clamps out-of-range input to ${t4.clamped}`);

  // ---- 5. PHYSICS: a driven robot cannot cross a solid lamp ---------------
  const t5 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const light = sim.worldDoc.elements.find(e => e.type === 'light');
    const proto = window.__app().state.world.vehiclePrototypes[0]._vehicle;
    const inst = sim.instances[0];
    if (!inst?.body) return { error: 'no running instance to drive' };
    // Set a moderate, explicit radius so the numbers below mean something.
    const s = document.getElementById('wi-sradius');
    s.value = '60'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change'));
    // Isolate the collision: unwire the drivetrain so nothing but the barrier acts.
    const savedWires = proto.wires; proto.wires = [];
    sim.instWireMap(inst);
    const bodyOf = l => sim.obstacleBodies.find(b => Math.abs(b.position.x - l.position.x) < 0.5 && Math.abs(b.position.y - l.position.y) < 0.5);const R = bodyOf(light).circleRadius;
    const startX = light.position.x - R - 260;
    sim.setInstancePose(inst, startX, light.position.y, 0);
    let minD = Infinity;
    for (let i = 0; i < 200; i++) {
      sim.M.Body.setVelocity(inst.body, { x: 6, y: 0 });
      sim.step();
      const d = Math.hypot(inst.body.position.x - light.position.x, inst.body.position.y - light.position.y);
      if (d < minD) minD = d;
    }
    const crossed = inst.body.position.x > light.position.x;
    // restore
    proto.wires = savedWires; sim.instWireMap(inst);
    return { R, minD, crossed, reached: minD < R + 120 };
  })()`);
  if (t5.error) fail('physics probe: ' + t5.error);
  if (!t5.reached) fail('robot never got to the lamp — the test would pass vacuously: ' + JSON.stringify(t5));
  if (t5.minD < t5.R - 1) fail(`robot entered the solid lamp (minD=${t5.minD.toFixed(1)} < R=${t5.R})`);
  if (t5.crossed) fail('robot crossed a solid lamp: ' + JSON.stringify(t5));
  pass(`solid lamp stops a driven robot (minD=${t5.minD.toFixed(1)} >= R=${t5.R})`);

  // ---- 6. CONTROL: the same run with solidity off passes straight through --
  const t6 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const light = sim.worldDoc.elements.find(e => e.type === 'light');
    const proto = window.__app().state.world.vehiclePrototypes[0]._vehicle;
    const inst = sim.instances[0];
    // turn solidity OFF through the real checkbox
    const cb = document.getElementById('wi-solid');
    cb.checked = false; cb.dispatchEvent(new Event('change'));
    const bodiesAfter = sim.obstacleBodies.length;
    const savedWires = proto.wires; proto.wires = []; sim.instWireMap(inst);
    const startX = light.position.x - 320;
    sim.setInstancePose(inst, startX, light.position.y, 0);
    let minD = Infinity;
    for (let i = 0; i < 200; i++) {
      sim.M.Body.setVelocity(inst.body, { x: 6, y: 0 });
      sim.step();
      const d = Math.hypot(inst.body.position.x - light.position.x, inst.body.position.y - light.position.y);
      if (d < minD) minD = d;
    }
    const crossed = inst.body.position.x > light.position.x;
    proto.wires = savedWires; sim.instWireMap(inst);
    return { bodiesAfter, minD, crossed, propsSolid: light.properties.solid };
  })()`);
  if (t6.error) fail('control probe: ' + t6.error);
  if (t6.propsSolid !== false) fail('untoggling did not set properties.solid=false (shallow-merge trap): ' + t6.propsSolid);
  if (t6.bodiesAfter !== BASE) fail(`untoggling left a physics body behind (${t6.bodiesAfter}, expected back to baseline ${BASE})`);
  if (!t6.crossed) fail('a non-solid lamp should not stop the robot: ' + JSON.stringify(t6));
  pass('untoggling removes the body; the same robot passes straight through (minD=' + t6.minD.toFixed(1) + ')');

  // ---- 7. an imported light with NO properties object must not throw ------
  const t7 = await ev(`(() => {
    const sim = window.__app().worldSim;
    sim.worldDoc.elements.push({ id: 'bare-light', type: 'light', primitive: 'circle', position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } });
    delete sim.worldDoc.elements[sim.worldDoc.elements.length - 1].properties;
    sim.selectedElement = 'bare-light';
    sim.renderInspector();            // used to throw on el.properties.intensity
    const box = document.getElementById('world-inspector');
    const cb = box.querySelector('#wi-solid');
    const props = sim.worldDoc.elements.find(e => e.id === 'bare-light').properties;
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    const el = sim.worldDoc.elements.find(e => e.id === 'bare-light');
    sim.worldDoc.elements = sim.worldDoc.elements.filter(e => e.id !== 'bare-light');
    sim.buildObstacles();
    return { emitted: !!cb, propsMaterialised: !!props, nowSolid: el.properties.solid, radius: el.properties.radius };
  })()`);
  if (t7.error) fail('bare-imported-light probe: ' + t7.error);
  if (!t7.emitted) fail('no #wi-solid emitted for a property-less imported light');
  if (t7.nowSolid !== true || !Number.isFinite(t7.radius)) fail('enabling solid on a property-less light failed: ' + JSON.stringify(t7));
  pass('a property-less imported light renders, hardens, and toggles solid without throwing');

  // ---- 8. EVICTION: turning it solid on top of a bot nudges, never flings --
  const t8 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const light = sim.worldDoc.elements.find(e => e.type === 'light');
    // Re-select our lamp: probe 7 left the inspector pointed at an element it then
    // deleted, so the controls in the DOM belong to a ghost.
    sim.selectedElement = light.id;
    sim.renderInspector();
    const inst = sim.instances[0];
    // Park the bot dead on the lamp with momentum, then switch solidity on.
    sim.setInstancePose(inst, light.position.x, light.position.y, 0);
    sim.M.Body.setVelocity(inst.body, { x: 5, y: -3 });
    sim.M.Body.setAngularVelocity(inst.body, 0.4);
    const cb = document.getElementById('wi-solid');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    const bodyOf = l => sim.obstacleBodies.find(b => Math.abs(b.position.x - l.position.x) < 0.5 && Math.abs(b.position.y - l.position.y) < 0.5);
    const R = bodyOf(light).circleRadius;
    const d = Math.hypot(inst.body.position.x - light.position.x, inst.body.position.y - light.position.y);
    const seedD = Math.hypot(inst.seed.x - light.position.x, inst.seed.y - light.position.y);
    return { R, d, seedD, vx: inst.body.velocity.x, vy: inst.body.velocity.y, av: inst.body.angularVelocity };
  })()`);
  if (t8.error) fail('eviction probe: ' + t8.error);
  if (t8.d < t8.R) fail(`bot left inside the barrier after eviction (d=${t8.d.toFixed(1)} < R=${t8.R})`);
  if (t8.vx !== 0 || t8.vy !== 0 || t8.av !== 0) fail('eviction must zero momentum, got ' + JSON.stringify(t8));
  if (Math.abs(t8.seedD - t8.d) > 1e-6) fail('the evicted pose must become the seed (Reset would shove it back in)');
  pass(`a bot caught under a solid lamp is nudged out (d=${t8.d.toFixed(1)} >= R=${t8.R}) with momentum zeroed and its seed adopted`);

  // ---- 9. the Body radius slider must stay INSIDE the properties popup -------
  const t9 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const light = sim.worldDoc.elements.find(e => e.type === 'light');
    sim.selectedElement = light.id; sim.renderInspector();
    const box = document.getElementById('world-inspector');
    const r = document.getElementById('wi-sradius');
    if (!r) return { error: 'no #wi-sradius to measure' };
    const b = box.getBoundingClientRect(), i = r.getBoundingClientRect();
    // widen the panel's content check to every row, not just the slider
    const overflowing = [...box.querySelectorAll('label, .tip-box')]
      .map(el => ({ tag: el.tagName + '.' + el.className, right: Math.round(el.getBoundingClientRect().right) }))
      .filter(x => x.right > Math.round(b.right) + 0.5);
    return {
      boxRight: Math.round(b.right), boxLeft: Math.round(b.left),
      sliderLeft: Math.round(i.left), sliderRight: Math.round(i.right), sliderWidth: Math.round(i.width),
      viewport: window.innerWidth, overflowing,
    };
  })()`);
  if (t9.error) fail('containment probe: ' + t9.error);
  if (t9.sliderRight > t9.boxRight + 0.5) fail(`radius slider overflows the popup (slider right=${t9.sliderRight}, box right=${t9.boxRight})`);
  if (t9.sliderLeft < t9.boxLeft - 0.5) fail(`radius slider overflows the left edge (${t9.sliderLeft} < ${t9.boxLeft})`);
  if (t9.boxRight > t9.viewport) fail(`the popup itself is off-screen (box right=${t9.boxRight}, viewport=${t9.viewport})`);
  if (t9.overflowing.length) fail('rows overflow the popup: ' + JSON.stringify(t9.overflowing));
  pass(`radius slider is contained (${t9.sliderWidth}px wide, inside ${t9.boxLeft}..${t9.boxRight}; no row overflows)`);

  // ---- 10. a light has no Rotation field; an obstacle still does ----------
  const t10 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const light = sim.worldDoc.elements.find(e => e.type === 'light');
    sim.selectedElement = light.id; sim.renderInspector();
    const lightHasRot = !!document.getElementById('wi-rot');
    const lightHasSolid = !!document.getElementById('wi-solid');
    sim.worldDoc.elements.push({ id: 'probe-rock', type: 'rock', primitive: 'circle', position: { x: -400, y: -200 }, rotation: 0, scale: { x: 1, y: 1 }, properties: { radius: 30 } });
    sim.selectedElement = 'probe-rock'; sim.renderInspector();
    const box = document.getElementById('world-inspector');
    const rockHasRot = !!document.getElementById('wi-rot');
    const rockHasSolid = !!document.getElementById('wi-solid');
    const rockHasRadius = !!document.getElementById('wi-rad');
    sim.worldDoc.elements = sim.worldDoc.elements.filter(e => e.id !== 'probe-rock');
    sim.buildObstacles();
    return { lightHasRot, lightHasSolid, rockHasRot, rockHasSolid, rockHasRadius, heading: box.querySelector('h3')?.textContent };
  })()`);
  if (t10.error) fail('rotation-field probe: ' + t10.error);
  if (t10.lightHasRot) fail('a light is a circle — it must not offer a Rotation field');
  if (!t10.lightHasSolid) fail('hiding Rot must not hide the Solid toggle');
  if (!t10.rockHasRot) fail('obstacles must KEEP their Rotation field');
  if (t10.rockHasSolid) fail('the Solid toggle is light-only; a rock is already solid');
  if (!t10.rockHasRadius) fail('rock lost its Radius field');
  pass('light: no Rotation field (Solid intact) · obstacle: Rotation + Radius still present');

  // ---- 11. the Bumper is the hollow-ring force build (guards a stale checkout) --
  const t11 = await ev(`(() => {
    const app = window.__app();
    const def = app.state.configs.components.components.find(c => c.id === 'bumper');
    document.getElementById('tab-editor').click();
    const v = app.state.vehicle;
    const id = 'probe-bumper';
    v.components.push({ id, type: 'bumper', snapIndex: 0, local: { x: 0, y: 0 }, localRotation: 0, props: { radius: 40, density: 10 } });
    app.editor.selectedComp = id;
    app.editor.refresh();
    const box = document.getElementById('editor-inspector');
    const tip = box.querySelector('.tip-box')?.textContent ?? '';
    const out = {
      densityInConfig: def?.defaults?.density ?? null,
      radiusSlider: !!box.querySelector('#ins-bumper'),
      densitySlider: !!box.querySelector('#ins-bumper-d'),
      tipSaysHollow: /hollow ring force barrier/i.test(tip),
      tipClaimsClonesPass: /same-prototype clones.*pass through/i.test(tip),
    };
    v.components = v.components.filter(c => c.id !== id);
    app.editor.selectedComp = null;
    app.editor.refresh();
    document.getElementById('tab-world').click();
    return out;
  })()`);
  if (t11.error) fail('bumper probe: ' + t11.error);
  if (!Number.isFinite(t11.densityInConfig)) fail('Bumper Density default missing from config — this checkout predates the force-field Bumper (d36ab99)');
  if (!t11.radiusSlider || !t11.densitySlider) fail('Bumper must expose BOTH Radius and Density sliders: ' + JSON.stringify(t11));
  if (!t11.tipSaysHollow) fail('Bumper tip is not the hollow-ring force-barrier copy: ' + JSON.stringify(t11));
  if (t11.tipClaimsClonesPass) fail('the stale "same-prototype clones pass through" tip is back');
  pass('Bumper is the hollow-ring force build: Radius + Density sliders, corrected tip');

  console.log('\nALL PASS — solid light source verified end-to-end in the browser');
  cleanup(); process.exit(0);
} catch (e) {
  fail(e?.message ?? String(e));
}
