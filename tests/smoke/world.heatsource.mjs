// Headless smoke probe: HEAT SOURCE + HEAT SENSOR, end-to-end through the real DOM.
//
// The unit tests already prove the thermodynamics against their closed forms. What only a
// browser can prove is the part a user would notice:
//   · the + Heat source button creates the element with the config's default temperature,
//   · its popup offers Temperature (config-bounded) and Solid, and offers NO Rotation and
//     NO Intensity (a circle has no orientation; it is not a lamp),
//   · the drawn ring and the Matter body are the same number, and a driven robot is stopped
//     by it (and walks through the same fire when it is not solid),
//   · a heat sensor on a live robot actually reads the furnace, with visible thermal lag,
//   · a LIGHT sensor on that same robot does not care whether the furnace is 100 °C or
//     2000 °C — the blindness the feature is named after, asserted in the running app,
//   · Reset cools the probe back to ambient,
//   · and the popup's rows stay inside the panel (the overflow bug this suite caught once).
//
// Owns its own web port (8936) and CDP port (9249), frees BOTH, and uses a unique profile:
// a probe that attaches to a leftover Chrome, or reads a cached module, reports a green that
// tests nothing. See README ("Testing") for both hazards actually observed in this repo.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9249;
const WEB = 8936;
const PROFILE = `/tmp/bv-profile-heat-${process.pid}`;

spawn('sh', ['-c', `lsof -ti:${WEB} | xargs -r kill 2>/dev/null; lsof -ti:${PORT} | xargs -r kill 2>/dev/null; true`], { stdio: 'ignore' });
await sleep(400);
spawn('sh', ['-c', `rm -rf ${PROFILE}; true`], { stdio: 'ignore' });
await sleep(200);
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
    return { app: !!a, sim: !!a.worldSim, heatBtn: !!document.getElementById('add-heat'), heatCfg: a.state.configs?.world?.heat ?? null, heatSensorDef: (a.state.configs.components.components||[]).some(c=>c.id==='heat_sensor') }; })()`);
  if (!boot.app || !boot.sim) fail('app/worldSim did not boot: ' + JSON.stringify(boot));
  const href = await ev('location.href');
  if (!href.includes(NONCE)) fail(`attached to a STALE page (${href}) — another browser owns CDP port ${PORT}`);
  if (!boot.heatBtn) fail('the + Heat source button is missing from the Sandbox pane');
  if (!boot.heatCfg) fail('config/world.json has no "heat" block (the browser is serving a stale or partial config)');
  if (!boot.heatSensorDef) fail('components.json has no heat_sensor (public/config is out of sync — run `npm run build`)');
  pass(`app booted; heat element + heat_sensor component present (ambient ${boot.heatCfg.temperature}°C default)`);

  // ---- 1. the button creates a heat source, and it is NOT light ------------
  const t1 = await ev(`(() => {
    const app = window.__app(); const sim = app.worldSim;
    const before = sim.worldDoc.elements.length;
    const lightsBefore = sim.worldDoc.elements.filter(e => e.type === 'light').length;
    document.getElementById('add-heat').click();
    const el = sim.worldDoc.elements[sim.worldDoc.elements.length - 1];
    return { before, id: el.id, type: el.type, temp: el.properties?.temperature, solid: el.properties?.solid ?? false,
             lights: sim.worldDoc.elements.filter(e => e.type === 'light').length, lightsBefore };
  })()`);
  if (t1.error) fail(t1.error);
  if (t1.type !== 'heat') fail('the + Heat source button created a ' + t1.type);
  if (t1.lights !== t1.lightsBefore) fail('adding a heat source changed the light count — the fields are not separate');
  if (!Number.isFinite(t1.temp)) fail('the new source has no usable temperature: ' + t1.temp);
  if (t1.solid) fail('a freshly dropped heat source must not be solid');
  pass(`+ Heat source creates type=heat at ${t1.temp}°C (from config), non-solid, and leaves the light field alone`);

  // ---- 2. its popup: Temperature + Solid, no Rotation, no Intensity -------
  const t2 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const el = sim.worldDoc.elements.find(e => e.type === 'heat');
    sim.selectedElement = el.id; sim.renderInspector();
    const box = document.getElementById('world-inspector');
    const q = s => box.querySelector(s);
    return {
      heading: box.querySelector('h3')?.textContent,
      hasTemp: !!q('#wi-temp'), temp: q('#wi-temp')?.value, min: q('#wi-temp')?.min, max: q('#wi-temp')?.max,
      hasRot: !!q('#wi-rot'), hasInt: !!q('#wi-int'), hasSolid: !!q('#wi-solid'), solidChecked: !!q('#wi-solid')?.checked,
      hasRadius: !!q('#wi-sradius'),
    };
  })()`);
  if (!/Heat source/.test(t2.heading ?? '')) fail('popup heading is ' + JSON.stringify(t2.heading));
  if (!t2.hasTemp) fail('no Temperature control on a heat source');
  if (t2.hasRot) fail('a heat source is a CIRCLE and must not offer Rotation (same reasoning as a light)');
  if (t2.hasInt) fail('a heat source must not offer Intensity — that is the light property');
  if (!t2.hasSolid) fail('no Solid toggle on a heat source (solidity is shared across emitters)');
  if (t2.solidChecked || t2.hasRadius) fail('a fresh heat source must start non-solid with no radius row');
  if (t2.min !== '-50' || t2.max !== '1500') fail('temperature bounds did not come from config/world.json: ' + t2.min + '..' + t2.max);
  pass(`popup offers Temperature (${t2.temp}, bounded ${t2.min}..${t2.max} from config) + Solid, and no Rotation / Intensity`);

  // ---- 3. editing the temperature reaches the element and clamps ----------
  const t3 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const el = sim.worldDoc.elements.find(e => e.type === 'heat');
    const t = document.getElementById('wi-temp');
    t.value = '750'; t.dispatchEvent(new Event('change'));
    const mid = el.properties.temperature;
    const t2 = document.getElementById('wi-temp');
    t2.value = '999999'; t2.dispatchEvent(new Event('change'));
    return { mid, clamped: el.properties.temperature, bodyStillSoft: sim.obstacleBodies.length };
  })()`);
  if (t3.mid !== 750) fail('temperature edit did not reach the element, got ' + t3.mid);
  if (t3.clamped > 1500) fail('an out-of-range temperature was not clamped: ' + t3.clamped);
  pass(`temperature edits land (750) and out-of-range input is clamped to ${t3.clamped}`);

  // ---- 4. Solid: a static body whose radius IS the drawn ring -------------
  const t4 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const el = sim.worldDoc.elements.find(e => e.type === 'heat');
    const before = sim.obstacleBodies.length;
    const cb = document.getElementById('wi-solid');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    const s = document.getElementById('wi-sradius');
    s.value = '70'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change'));
    const body = sim.obstacleBodies.find(b => Math.abs(b.position.x - el.position.x) < 0.5 && Math.abs(b.position.y - el.position.y) < 0.5);
    // The ring is drawn from solidBodyRadius() and the barrier is a Matter body — pinning BOTH
    // to the slider is the only way to catch the picture and the barrier drifting apart.
    return { before, after: sim.obstacleBodies.length, isStatic: body?.isStatic, bodyR: body?.circleRadius,
             propR: el.properties.radius, slider: s.value, sliderVisible: !!s };
  })()`);
  if (t4.after !== t4.before + 1) fail(`toggling Solid did not add exactly one body (${t4.before} -> ${t4.after})`);
  if (t4.isStatic !== true) fail('the furnace barrier is not a static body');
  if (Math.abs(t4.bodyR - 70) > 1e-9) fail('slider and barrier disagree: body=' + t4.bodyR + ' slider=70');
  if (t4.propR !== 70 || t4.slider !== '70') fail('slider/property/readout out of sync: ' + JSON.stringify(t4));
  pass(`Solid furnace = one static body whose radius (70) is exactly the slider the ring is drawn from`);

  // ---- 5. physics: a driven robot is stopped by the furnace ---------------
  const driveInto = async (expectBlock) => ev(`(() => {
    const sim = window.__app().worldSim;
    const el = sim.worldDoc.elements.find(e => e.type === 'heat');
    const proto = window.__app().state.world.vehiclePrototypes[0]._vehicle;
    const inst = sim.instances[0];
    if (!inst?.body) return { error: 'no running instance to drive' };
    const savedWires = proto.wires; proto.wires = []; sim.instWireMap(inst);
    const body = sim.obstacleBodies.find(b => Math.abs(b.position.x - el.position.x) < 0.5 && Math.abs(b.position.y - el.position.y) < 0.5);
    const R = body ? body.circleRadius : 0;
    const startX = el.position.x - R - 260;
    sim.setInstancePose(inst, startX, el.position.y, 0);
    let minD = Infinity;
    for (let i = 0; i < 200; i++) {
      sim.M.Body.setVelocity(inst.body, { x: 6, y: 0 });
      sim.step();
      const d = Math.hypot(inst.body.position.x - el.position.x, inst.body.position.y - el.position.y);
      if (d < minD) minD = d;
    }
    const crossed = inst.body.position.x > el.position.x;
    proto.wires = savedWires; sim.instWireMap(inst);
    return { R, minD, crossed, reached: minD < R + 120, x: inst.body.position.x };
  })()`);
  const t5 = await driveInto(true);
  if (t5.error) fail('physics probe: ' + t5.error);
  if (!t5.reached) fail('robot never got near the furnace — the test would pass vacuously: ' + JSON.stringify(t5));
  if (t5.minD < t5.R - 1) fail(`robot entered the solid furnace (minD=${t5.minD.toFixed(1)} < R=${t5.R})`);
  if (t5.crossed) fail('robot crossed a solid furnace: ' + JSON.stringify(t5));
  pass(`solid furnace stops a driven robot (minD=${t5.minD.toFixed(1)} >= R=${t5.R})`);

  // ---- 6. CONTROL: solidity off, the same robot goes straight through -----
  const t6 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const el = sim.worldDoc.elements.find(e => e.type === 'heat');
    const cb = document.getElementById('wi-solid');
    cb.checked = false; cb.dispatchEvent(new Event('change'));
    return { bodies: sim.obstacleBodies.length };
  })()`);
  const t6b = await driveInto(false);
  if (t6b.error) fail('control run: ' + t6b.error);
  if (!t6b.crossed) fail('with Solid off the robot should drive through the fire and did not: ' + JSON.stringify(t6b));
  pass(`with Solid off the same robot drives straight through (${t6.bodies} static bodies remain)`);

  // ---- 7. a heat sensor on the live robot reads the furnace, with lag ----
  // (the drivetrain is off for phases 7-9 and put back in the last block)
  const t7 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const app = window.__app();
    const el = sim.worldDoc.elements.find(e => e.type === 'heat');
    // Set it hot and park the robot a fixed distance away.
    const t = document.getElementById('wi-temp'); t.value = '900'; t.dispatchEvent(new Event('change'));
    const proto = app.state.world.vehiclePrototypes[0]._vehicle;
    proto.components.push({ id: 'hh', type: 'heat_sensor', local: { x: 0, y: 0 }, localRotation: 0, props: {} });
    // Unwire the drivetrain for the sensing phases. The sample car SEEKS THE SUN, so it would
    // otherwise drive away while being measured — and a moving probe always reads
    // off-equilibrium (its lag is tracking where it WAS), which looks exactly like a broken
    // model and is not. The physics phases above save/restore wires the same way.
    if (!window.__savedWires) window.__savedWires = proto.wires;
    proto.wires = [];
    const inst = sim.instances[0];
    sim.instWireMap(inst);
    sim.setInstancePose(inst, el.position.x - 220, el.position.y, 0);
    sim.M.Body.setVelocity(inst.body, { x: 0, y: 0 });
    sim.step();
    const first = (inst.lastSamples || []).find(s => s.componentId === 'hh');
    for (let i = 0; i < 400; i++) sim.step();
    const settled = (inst.lastSamples || []).find(s => s.componentId === 'hh');
    return {
      first: first ? { v: first.value, t: first.heatTemperatureC, ambient: first.ambientC } : null,
      settled: settled ? { v: settled.value, t: settled.heatTemperatureC, ambient: settled.ambientC, eq: settled.heatEquilibriumC } : null,
      kind: settled?.kind,
    };
  })()`);
  if (!t7.first || !t7.settled) fail('the heat_sensor produced no sample: ' + JSON.stringify(t7));
  if (t7.kind !== 'heat') fail('sample is not tagged kind=heat: ' + t7.kind);
  if (!(t7.settled.t > t7.settled.ambient + 15)) fail(`probe did not heat up near a 900°C source: ${t7.settled.t} vs ambient ${t7.settled.ambient}`);
  if (!(t7.first.t < t7.settled.t - 1)) fail(`no visible thermal lag (first=${t7.first.t}, settled=${t7.settled.t}) — the probe would have to be massless`);
  if (Math.abs(t7.settled.t - t7.settled.eq) > 2) fail('settled reading is not at its own equilibrium: ' + JSON.stringify(t7.settled));
  pass(`heat sensor reads the furnace (${t7.settled.t.toFixed(0)}°C → ${t7.settled.v.toFixed(2)}), and lags on arrival (${t7.first.t.toFixed(0)}°C) — thermal mass is real in the app`);

  // ---- 8. BLINDNESS: the light sensor ignores the furnace entirely -------
  const t8 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const el = sim.worldDoc.elements.find(e => e.type === 'heat');
    const inst = sim.instances[0];
    const lightVals = () => (inst.lastSamples || []).filter(s => s.componentId === 'sL' || s.componentId === 'sR').map(s => s.value).join(',');
    sim.step();
    const cool = (() => { const t = document.getElementById('wi-temp'); t.value = '60'; t.dispatchEvent(new Event('change')); sim.step(); return lightVals(); })();
    const coolHeat = (inst.lastSamples || []).find(s => s.componentId === 'hh')?.heatTemperatureC;
    const t = document.getElementById('wi-temp'); t.value = '2000'; t.dispatchEvent(new Event('change'));
    for (let i = 0; i < 600; i++) sim.step();
    const hot = lightVals();
    const hotHeat = (inst.lastSamples || []).find(s => s.componentId === 'hh')?.heatTemperatureC;
    return { cool, hot, coolHeat, hotHeat };
  })()`);
  if (!t8.cool || !t8.hot) fail('no light-sensor samples to compare (does the sample vehicle have sL/sR?): ' + JSON.stringify(t8));
  if (t8.cool !== t8.hot) fail(`a LIGHT sensor changed when the FURNACE changed — the fields are merged: light ${t8.cool} -> ${t8.hot}`);
  if (!(t8.hotHeat > t8.coolHeat + 10)) fail(`the heat sensor should have reacted strongly (it did not): ${t8.coolHeat} -> ${t8.hotHeat}`);
  pass(`blindness holds in the running app: light sensors ${t8.cool} unchanged from 60°C to 2000°C while the heat probe went ${t8.coolHeat.toFixed(0)}→${t8.hotHeat.toFixed(0)}°C`);

  // ---- 8b. THE BOUND in the running app: never hotter than the source -----
  // Reported by a real player: passing over a 220 °C source read 4800+ °C. Unit-level physics
  // can pass while the app still shows the impossible number (wrong wiring, wrong field,
  // cached module), so this drives the ACTUAL sensor through the ACTUAL app.
  const t8b = await ev(`(() => {
    const sim = window.__app().worldSim;
    const el = sim.worldDoc.elements.find(e => e.type === 'heat');
    const inst = sim.instances[0];
    const setTemp = (v) => { const t = document.getElementById('wi-temp'); t.value = String(v); t.dispatchEvent(new Event('change')); };
    const setSolid = (on) => { const cb = document.getElementById('wi-solid'); if (cb && cb.checked !== on) { cb.checked = on; cb.dispatchEvent(new Event('change')); } };
    setSolid(false); // so nothing evicts the robot off the source while we measure it
    setTemp(220);
    const probe = () => { const s = (inst.lastSamples || []).find(x => x.componentId === 'hh'); return s ? s.heatTemperatureC : null; };
    const place = (dx) => {
      sim.setInstancePose(inst, el.position.x + dx, el.position.y, 0);
      sim.M.Body.setVelocity(inst.body, { x: 0, y: 0 });
    };
    // SOAK COLD FIRST. Without this the peak would just be leftover heat from the previous
    // phase (which ran a 1500°C source), and a hot probe cooling beside a cooler object is
    // SUPPOSED to read above it for a while — that is the thermal mass, not the bug. The
    // bound under test is on the EQUILIBRIUM: from cold, with every equilibrium below the
    // source temperature, exponential relaxation cannot overshoot, so NOTHING can exceed it.
    place(6000);
    let soak = null;
    for (let i = 0; i < 2000; i++) { sim.step(); soak = probe(); }
    const samples = [];
    const settleAt = (dx) => {
      place(dx);
      let peak = -Infinity;
      for (let i = 0; i < 400; i++) { sim.step(); const t = probe(); if (t === null) continue; samples.push(t); if (t > peak) peak = t; }
      return { dx, peak, settled: probe() };
    };
    // Parked ON the source, then a sweep outward (all beyond minDistance so the sweep is a
    // real gradient rather than the floor of the 1/r² clamp).
    const onTop = settleAt(0);
    // The honest counterpart, measured while the probe is at its HOTTEST: a probe cooling
    // beside a COOLER source reads above that source for a while. Pinned so nobody "fixes"
    // the 4800° bug by clamping readings to the source temperature, which would silently
    // delete the lag that makes this a thermal sensor at all.
    setTemp(60);
    place(3000);
    let transient = null;
    for (let i = 0; i < 3; i++) { sim.step(); samples.push(probe()); transient = probe(); }
    // Back to 220 for the sweep. The peak claim still holds: this transient started AT the
    // bounded 217.8 and only decayed from there.
    setTemp(220);
    const sweep = [12, 30, 80, 200].map(settleAt);
    const peak = Math.max(...samples);
    return { sourceC: 220, soak, onTop, sweep, peak, transient, transientSourceC: 60 };
  })()`);
  if (!(t8b.soak < t8b.onTop.settled / 3)) fail(`the cold soak did not take (soak ${t8b.soak}), so the peak below is not a cold-start peak`);
  if (t8b.peak > t8b.sourceC) {
    fail(`starting cold, the probe still reached ${t8b.peak.toFixed(0)}°C beside a ${t8b.sourceC}°C source — a passive sensor cannot `
      + 'exceed the thing it measures (this is the 4800°C bug: the equilibrium must be a '
      + 'conductance-weighted MEAN, never ambient + coupling*flux)');
  }
  if (!(t8b.onTop.settled > 200)) fail(`parked on a 220°C furnace the probe should be desperate, got ${t8b.onTop.settled}`);
  for (let i = 1; i < t8b.sweep.length; i++) {
    if (!(t8b.sweep[i - 1].settled > t8b.sweep[i].settled)) {
      fail(`heat is not decreasing with distance: ${t8b.sweep.map(s => `${s.dx}px=${s.settled.toFixed(1)}`).join(' ')}`);
    }
  }
  if (!(t8b.transient > 150)) {
    fail(`a probe that was ${t8b.onTop.settled.toFixed(0)}°C one move ago read only ${t8b.transient.toFixed(0)}°C three steps later — `
      + 'that is not lag, something is clamping or resetting the reading');
  }
  if (!(t8b.transient > t8b.transientSourceC && t8b.transient < t8b.onTop.settled)) {
    fail(`cooling transient is wrong (${t8b.transient.toFixed(1)}°C): it should sit ABOVE the 60°C surroundings and `
      + 'BELOW the 217.8°C it came from — above is thermal mass, below is that it is cooling');
  }
  pass(`THE BOUND holds in the app: from cold, parked on a 220°C furnace it settles at ${t8b.onTop.settled.toFixed(1)}°C, the peak anywhere is ${t8b.peak.toFixed(1)}°C — never above the source; `
    + `and a cooling probe still reads ${t8b.transient.toFixed(0)}°C beside a 60°C one (lag intact, not clamped)`);

  // ---- 9. Reset cools the probe back to ambient --------------------------
  const t9 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const inst = sim.instances[0];
    const hot = (inst.lastSamples || []).find(s => s.componentId === 'hh')?.heatTemperatureC;
    sim.reset();
    // The STATE map is the thing Reset must clear. The reading one step later is NOT expected
    // to be exactly ambient: this robot's seed was adopted while the probe was parked next to a
    // hot source, so it starts re-heating the instant it lands. What proves the clear is that
    // it starts from cold — a carried-over reading would still say ~200 °C.
    const cleared = inst.sensorStates ? inst.sensorStates.size : -1;
    sim.step();
    const s = (inst.lastSamples || []).find(s => s.componentId === 'hh');
    return { hot, cleared, after: s?.heatTemperatureC, ambient: s?.ambientC, eq: s?.heatEquilibriumC };
  })()`);
  if (!(t9.hot > t9.ambient + 10)) fail('the probe was not hot before reset, so this proves nothing: ' + JSON.stringify(t9));
  if (t9.cleared !== 0) fail(`Reset left ${t9.cleared} thermal states behind — a robot resumes HOT`);
  if (!(t9.after < t9.hot / 2)) fail(`reading barely moved after Reset (${t9.after} vs ${t9.hot}) — that is carried-over state, not a cold start`);
  if (t9.after < t9.ambient - 0.001) fail(`a passive probe cannot start below ambient: ${t9.after}`);
  pass(`Reset clears thermal state (map empty, ${t9.hot.toFixed(0)}°C → ${t9.after.toFixed(1)}°C and climbing again from cold)`);

  // ---- 10. the popup's rows stay inside the panel ------------------------
  const t10 = await ev(`(() => {
    const sim = window.__app().worldSim;
    const el = sim.worldDoc.elements.find(e => e.type === 'heat');
    sim.selectedElement = el.id; sim.renderInspector();
    // Show the widest rows there are: solid on, so the radius slider appears.
    const cb = document.getElementById('wi-solid'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    const box = document.getElementById('world-inspector');
    const bb = box.getBoundingClientRect();
    const rows = [...box.querySelectorAll('label, .tip-box, button')].map(n => {
      const r = n.getBoundingClientRect();
      return { id: n.querySelector('input')?.id ?? n.className, right: Math.round(r.right), over: Math.round(r.right - bb.right) };
    });
    return { boxRight: Math.round(bb.right), width: Math.round(bb.width), worst: Math.max(...rows.map(r => r.over)), rows: rows.filter(r => r.over > 1) };
  })()`);
  if (t10.worst > 1) fail(`heat popup overflows by ${t10.worst}px: ` + JSON.stringify(t10.rows));
  pass(`heat popup contains every row (panel ${t10.width}px wide, widest row ends at ${t10.boxRight})`);

  // ---- 11. leave the world as found (sensing ran unwired) ----------------
  const t11 = await ev(`(() => {
    const proto = window.__app().state.world.vehiclePrototypes[0]._vehicle;
    if (window.__savedWires) { proto.wires = window.__savedWires; delete window.__savedWires; }
    const inst = window.__app().worldSim.instances[0];
    if (inst) window.__app().worldSim.instWireMap(inst);
    return { restored: Array.isArray(proto.wires) ? proto.wires.length : -1 };
  })()`);
  if (t11.restored <= 0) fail('could not restore the sample drivetrain (wires: ' + t11.restored + ')');
  pass(`sample drivetrain restored (${t11.restored} wires) — a probe must not leave the world mangled`);

  console.log('\nALL PASS — heat source + heat sensor verified end-to-end in the browser');
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e.message);
  cleanup();
  process.exit(1);
}
