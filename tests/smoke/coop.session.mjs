// Headless smoke — two real browser pages (host + joiner) against a real in-process gateway: the
// full human-facing co-op flow from the bug report.
//   1. Host "Edit my design" → editor opens → place a component → Done → "Deploy design"
//      → the SERVER's running vehicle changed (both sides can edit + deploy their own design).
//   2. Joiner deploys too; host manages fleets with the real −/+/✕ buttons (add/subtract/remove
//      other participants' vehicles) and the row counts update.
//   3. World elements: joiner's world mirrors the host's on join AND live when the host adds a
//      light (the pre-loaded world is seeded onto the shared world at host-time).
//   4/5. Host/Join/code row is hidden while connected on BOTH pages.
//   6. Host disconnects → the joiner is sent home (idle layout, "host left" status) and the
//      world is reclaimed; nothing is stranded.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import Matter from 'matter-js';
import { createCoopGateway } from '../../src/net/gateway.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9232;
const WEB = 8907;
const GW_PORT = 8963;

const freePort = spawn('sh', ['-c', `lsof -ti:${WEB} | xargs kill 2>/dev/null; true`], { stdio: 'ignore' });
await new Promise(r => freePort.on('exit', r));
const srv = spawn('python3', ['-m', 'http.server', WEB, '--directory', 'public'], { stdio: 'ignore' });
await sleep(700);

// Fresh profile per run (a reused one can serve stale JS from its HTTP cache).
spawn('sh', ['-c', "pkill -f 'user-data-dir=/tmp/bv-profile-session' 2>/dev/null; rm -rf /tmp/bv-profile-session; true"], { stdio: 'ignore' });
await sleep(300);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/bv-profile-session',
  'about:blank',
], { stdio: 'ignore' });

const gw = createCoopGateway({ Matter, port: GW_PORT, host: '127.0.0.1', configs: {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: { light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 } },
  components: { components: [{ id: 'light_sensor', category: 'sensor', size: 8 }, { id: 'powered_wheel', category: 'actuator', size: 16 }] },
} });
const { url } = await gw.start();

const fail = m => { console.error('FAIL:', m); chrome.kill('SIGKILL'); srv.kill('SIGKILL'); gw.close().catch(() => {}); process.exit(1); };
const ok = m => { console.log('PASS:', m); chrome.kill('SIGKILL'); srv.kill('SIGKILL'); gw.close().catch(() => {}); process.exit(0); };
let _lastStep = 'start';
const step = m => { _lastStep = m; console.error(`step: ${m}`); };
// Global watchdog (this machine's headless Chrome stalls): dump session state, then exit(3).
setTimeout(() => {
  try {
    for (const w of gw.worlds.values()) console.error(`WATCHDOG world=${w.code} running=${w.session.running} bots=${w.world.instances.length}`);
  } catch {}
  console.error(`WATCHDOG: stuck, lastStep=${_lastStep}`);
  process.exit(3);
}, 420_000);

try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
  if (!targets?.find(t => t.type === 'page')) fail('no CDP page target');

  // ---- two independent pages in one browser (host + joiner) ------------------
  const newPage = async () => {
    let t;
    try { t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); }
    catch { t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`)).json(); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pending = new Map(); const logs = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? {}); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 250));
    };
    const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
    await new Promise(r => ws.onopen = r);
    await send('Page.enable'); await send('Runtime.enable');
    const ev = async (expression, timeoutMs = 20000) => {
      // A wedged page promise must fail the probe, not hang it forever.
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`CDP ev timeout after ${timeoutMs}ms`)), timeoutMs).unref()),
      ]);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result?.value;
    };
    return { ev, logs };
  };
  const boot = async pg => {
    // Headless Chrome under back-to-back smoke load can stall a fresh target's first paint;
    // retry with a full re-navigation rather than fail the whole probe on infra flake.
    for (let attempt = 0; attempt < 2; attempt++) {
      await pg.ev(`location.href='http://localhost:${WEB}/index.html'`).catch(() => {});
      for (let i = 0; i < 60 && (await pg.ev('typeof window.__app').catch(() => null)) !== 'function'; i++) await sleep(250);
      if ((await pg.ev('typeof window.__app').catch(() => null)) === 'function') return;
    }
    throw new Error('page never booted: ' + (pg.logs.join(' | ') || 'no console errors'));
  };
  // In-page poller: runs `fnBody` (arrow body returning value or null) every 100ms up to ms.
  const poll = (pg, fnBody, ms = 8000, label = '') => pg.ev(`(async()=>{const $=id=>document.getElementById(id);const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<${Math.ceil(ms / 100)};i++){let v;try{v=(()=>{ ${fnBody} })();}catch(e){throw e;}if(v)return v;await sleep(100);}return null;})()`)
    .then(v => { if (v === null) throw new Error(`timeout: ${label}`); return v; });
  // Place `compLabel` from the editor palette at the proven top-edge snap point.
  const placeComponent = pg => compLabel => pg.ev(`(async()=>{
    const btns=[...document.querySelectorAll('#palette button')];
    const b=btns.find(x=>x.textContent.includes('${compLabel}')); if(!b)throw new Error('no ${compLabel} in palette');
    b.click();
    const cv=document.getElementById('editor-canvas'); const r=cv.getBoundingClientRect();
    const scale=Math.min(cv.clientWidth/320, cv.clientHeight/240);
    const pt={x:r.left+r.width/2+(-40+80/3)*scale, y:r.top+r.height/2+(-20)*scale};
    cv.dispatchEvent(new MouseEvent('mousemove',{clientX:pt.x,clientY:pt.y,bubbles:true}));
    cv.dispatchEvent(new MouseEvent('click',{clientX:pt.x,clientY:pt.y,bubbles:true}));
    await new Promise(res=>setTimeout(res,300));
  })()`);

  const H = await newPage(); await boot(H);
  const J = await newPage(); await boot(J);

  // ---------- BUG 4: host a world; Host/Join/code row must hide ------------------
  await H.ev(`(async()=>{const $=id=>document.getElementById(id);$('tab-world').click();$('coop-gw-url').value='${url}';$('coop-gw-name').value='host1';$('coop-host').click();for(let i=0;i<80&&$('coop-gw-code').hidden;i++)await new Promise(r=>setTimeout(r,100));})()`);
  const code = await H.ev(`document.getElementById('coop-gw-code').textContent`);
  if (!/^[A-Z0-9]{6}$/.test(code ?? '')) fail('host never revealed a code');
  // Check VISUAL visibility (computed display), not just the hidden attribute: author CSS
  // (display:flex) overrides [hidden] unless explicitly neutralised.
  const visible = id => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;
  if (await H.ev(visible('coop-gw-row')).then(v => v)) fail('BUG4: host/join row still visible while hosting');
  if (await H.ev(visible('coop-gw-fields')).then(v => v)) fail('BUG4: gateway/name fields still visible while hosting');

  // ---------- BUG 8: the host's pre-loaded world must land ON THE SERVER at host-time -----
  // main.js seeds the shared world via setElements on welcome; without it the server holds an
  // empty element list and deployed bots can never sense lights or collide with rocks.
  let serverEls = [];
  for (let i = 0; i < 40 && !serverEls.length; i++) {
    serverEls = gw.worlds.get(code)?.session.world.worldDoc.elements ?? [];
    if (!serverEls.length) await sleep(100); // setElements is fire-and-forget right after welcome
  }
  if (!serverEls.some(e => e.type === 'light')) fail('BUG8: server world has no lights after hosting — local world never crossed the wire: ' + JSON.stringify(serverEls.map(e => e.type)));

  // ---------- BUG 1: host edits their design via the co-op flow and deploys ------
  await H.ev(`document.getElementById('coop-edit').click()`);
  await sleep(300);
  if (!(await H.ev(`document.getElementById('panel-editor').classList.contains('active')`))) fail('BUG1: "Edit my design" did not open the editor');
  const compsBefore = await H.ev(`window.__app().state.vehicle.components.length`);
  await placeComponent(H)('Powered Wheel');
  const compsAfter = await H.ev(`window.__app().state.vehicle.components.length`);
  if (compsAfter !== compsBefore + 1) fail('BUG1: editor edit did not land (components ' + compsBefore + '->' + compsAfter + ')');

  await H.ev(`(async()=>{document.getElementById('tab-world').click();await new Promise(r=>setTimeout(r,300));document.getElementById('coop-deploy').click();})()`);
  await poll(H, `return /deployed —/.test($('coop-gw-status').textContent) ? 'ok' : null`, 6000, 'host deploy ack');
  await sleep(300);
  const hostP = () => [...gw.worlds.get(code).session.participants.values()].find(p => p.name === 'host1');
  const serverComps = gw.worlds.get(code).session.world.prototypeVehicle(hostP().protoId)?.components?.length;
  if (serverComps !== compsAfter) fail('BUG1: shared-world vehicle not updated by deploy (server ' + serverComps + ' vs edited ' + compsAfter + ')');

  // ---------- BUG 7 (this fix): a deployed bot's geometry must reach the CLIENT over the wire ---
  // The old snapshot only sent body w/h/color, so every client rendered a blank rectangle. Assert
  // the host's LIVE client snapshot now carries each mounted component (x/y/type) for its bot.
  const liveComps = await poll(H,
    `const bots = window.__app().coopPanel.client.bots; const b = bots.find(x=>x.comps && x.comps.length); return b ? JSON.stringify(b.comps) : null`,
    5000, 'client snapshot carries bot components');
  const compsArr = JSON.parse(liveComps);
  if (compsArr.length === 0) fail('BUG7: deployed bot arrived at the client with no components (blank rectangle)');
  for (const c of compsArr) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || typeof c.type !== 'string')
      fail('BUG7: malformed component geometry on the wire: ' + JSON.stringify(c));
  }
  // The host added a Powered Wheel during this test, so at least one wheel must be present.
  if (!compsArr.some(c => c.type === 'powered_wheel'))
    fail('BUG7: expected the added powered_wheel in the wire comps: ' + liveComps);

  // ---------- BUG 5 (row hides on join) + BUG 3a (elements mirror on join) -------
  await J.ev(`(async()=>{const $=id=>document.getElementById(id);$('tab-world').click();$('coop-gw-url').value='${url}';$('coop-gw-name').value='join1';$('coop-join-code').value='${code}';$('coop-join').click();for(let i=0;i<80&&$('coop-gw-code').hidden;i++)await new Promise(r=>setTimeout(r,100));})()`);
  if ((await J.ev(`document.getElementById('coop-gw-code').textContent`)) !== code) fail('joiner did not land in the hosted world');
  const visibleJ = id => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;
  if (await J.ev(visibleJ('coop-gw-row')).then(v => v)) fail('BUG5: host/join row still visible while joined');
  if (await J.ev(visibleJ('coop-gw-fields')).then(v => v)) fail('BUG5: gateway/name fields still visible while joined');

  const elsSig = pg => pg.ev(`JSON.stringify(window.__app().state.world.elements.map(e=>e.id+':'+e.position.x+','+e.position.y))`);
  const elsJ1 = await elsSig(J);
  const elsH1 = await elsSig(H);
  if (elsJ1 !== elsH1) fail('BUG3: joiner world did not mirror the host on join (joiner ' + elsJ1 + ' vs host ' + elsH1 + ')');

  // ---------- BUG 1b: the JOINER edits + deploys their own design ---------------
  await J.ev(`document.getElementById('coop-edit').click()`);
  await sleep(300);
  await placeComponent(J)('Light Sensor');
  await J.ev(`(async()=>{document.getElementById('tab-world').click();await new Promise(r=>setTimeout(r,300));document.getElementById('coop-deploy').click();})()`);
  await poll(J, `return /deployed —/.test($('coop-gw-status').textContent) ? 'ok' : null`, 6000, 'joiner deploy ack');

  // ---------- BUG 2: host manages OTHER participants' fleets with the buttons ---
  const fleetRow = name => `[...document.querySelectorAll('#remote-fleet .fleet-row')].find(r=>r.textContent.includes('${name}'))`;
  // wait until the host's fleet row actually shows join1's bot (snapshot-driven), so the
  // management clicks act on settled state rather than racing the deploy's first snapshot
  await poll(H, `return (${fleetRow('join1')}?.textContent||'').includes('1 bot') ? 'ok' : null`, 5000, 'host sees join1 with 1 bot');
  await H.ev(`${fleetRow('join1')}.querySelector('[data-act="plus"]').click()`);
  await poll(H, `return (${fleetRow('join1')}?.textContent||'').includes('2 bot') ? 'ok' : null`, 5000, 'join1 fleet grew to 2 after +');
  await H.ev(`${fleetRow('join1')}.querySelector('[data-act="minus"]').click()`);
  await poll(H, `return (${fleetRow('join1')}?.textContent||'').includes('1 bot') ? 'ok' : null`, 5000, 'join1 fleet shrank to 1 after −');
  await H.ev(`${fleetRow('host1')}.querySelector('[data-act="remove"]').click()`);
  await poll(H, `return /no design|0 bot/.test((${fleetRow('host1')}?.textContent)||'') ? 'ok' : null`, 5000, 'host fleet cleared after ✕');

  // ---------- BUG 3b: live element mirror (host adds a light while joined) ------
  await H.ev(`document.getElementById('add-light').click()`);
  await sleep(800);
  const elsJ2 = await elsSig(J);
  const elsH2 = await elsSig(H);
  if (elsJ2 !== elsH2) fail('BUG3: live element edit not mirrored to joiner (joiner ' + elsJ2 + ' vs host ' + elsH2 + ')');

  // ---------- BUG 10a: the JOINER's world is locked — its drag must move nothing --------
  // Elements are host-controlled: a participant may select one for the read-only popup but
  // grabbing it on their canvas must not move the element (locally or on the server).
  const lightId = await H.ev(`window.__app().state.world.elements.find(e=>e.type==='light').id`);
  const dragElementOn = (pg, steps) => pg.ev(`(async()=>{
    const app=window.__app(); const sim=app.worldSim;
    const el=app.state.world.elements.find(e=>e.id==='${lightId}');
    const r=sim.canvas.getBoundingClientRect();
    const sx=r.left+r.width/2+(el.position.x-sim.view.x)*sim.view.zoom;
    const sy=r.top+r.height/2+(el.position.y-sim.view.y)*sim.view.zoom;
    sim.canvas.dispatchEvent(new MouseEvent('mousedown',{clientX:sx,clientY:sy,bubbles:true}));
    for(let i=1;i<=${steps};i++){
      sim.canvas.dispatchEvent(new MouseEvent('mousemove',{clientX:sx+i*9,clientY:sy+i*6,bubbles:true}));
      await new Promise(res=>setTimeout(res,40));
    }
    return JSON.stringify(app.state.world.elements.find(e=>e.id==='${lightId}').position);
  })()`);
  const posBefore10a = await dragElementOn(J, 6); // no mouseup: a real drag would end on release
  await J.ev(`window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))`);
  const posAfter10a = await J.ev(`JSON.stringify(window.__app().state.world.elements.find(e=>e.id==='${lightId}').position)`);
  if (posBefore10a !== posAfter10a) fail('BUG10a: joiner drag MOVED a shared element locally (world not locked): ' + posBefore10a + ' -> ' + posAfter10a);
  const hostPos10a = await H.ev(`JSON.stringify(window.__app().state.world.elements.find(e=>e.id==='${lightId}').position)`);
  if (hostPos10a !== posBefore10a) fail('BUG10a: joiner drag reached the host/server (a participant must be read-only): ' + hostPos10a);
  const insp10a = JSON.parse(await J.ev(`(()=>{const b=document.getElementById('world-inspector');return JSON.stringify({txt:b.textContent,xDisabled:b.querySelector('#wi-x')?.disabled,del:!!b.querySelector('#wi-del')})})()`));
  if (!/read-only/i.test(insp10a.txt)) fail('BUG10a: joiner element popup not labeled read-only: ' + JSON.stringify(insp10a));
  if (insp10a.xDisabled !== true) fail('BUG10a: joiner element popup inputs are editable: ' + JSON.stringify(insp10a));
  if (insp10a.del !== false) fail('BUG10a: joiner element popup still offers Delete: ' + JSON.stringify(insp10a));

  // ---------- BUG 10b: the HOST's element drag streams live — no warp on release -----------
  // Mid-drag (button still down) the joiner's mirror must already track the move; before the
  // fix only the mouseup synced, so the client saw the element teleport to its drop spot.
  const sigBefore10b = await elsSig(J);
  const startEl = JSON.parse(await H.ev(`JSON.stringify(window.__app().state.world.elements.find(e=>e.id==='${lightId}').position)`));
  await dragElementOn(H, 6); // mousedown + 6 moves, NO mouseup yet
  let moved10b = false;
  for (let i = 0; i < 50 && !moved10b; i++) {
    const jPos = JSON.parse(await J.ev(`JSON.stringify(window.__app().state.world.elements.find(e=>e.id==='${lightId}').position)`));
    moved10b = Math.hypot(jPos.x - startEl.x, jPos.y - startEl.y) > 10;
    if (!moved10b) await sleep(60);
  }
  await H.ev(`window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))`);
  if (!moved10b) fail('BUG10b: joiner element did not track the host drag BEFORE release (still warps): sig ' + sigBefore10b);
  const hPos10b = await H.ev(`JSON.stringify(window.__app().state.world.elements.find(e=>e.id==='${lightId}').position)`);
  const jPos10b = await J.ev(`JSON.stringify(window.__app().state.world.elements.find(e=>e.id==='${lightId}').position)`);
  const hd = Math.hypot(JSON.parse(hPos10b).x - JSON.parse(jPos10b).x, JSON.parse(hPos10b).y - JSON.parse(jPos10b).y);
  if (hd > 3) fail('BUG10b: host/joiner element out of sync after the drag (host ' + hPos10b + ' vs joiner ' + jPos10b + ')');

  // ---------- BUG 9 (this fix): the shared world actually RUNS — Play drives the session,
  // the deployed vehicle senses the seeded elements, motors fire, it moves, and the client
  // carries beams/values/paths data from the snapshot. Before the fix Play only ran the LOCAL
  // mirror and nothing ever reached the server: deployed bots sat paused forever and ignored
  // lights, rocks, and walls (you could drag a wall straight through them). Three independent
  // checks, each deterministic at this test's rocket tuning (thrustScale=2):
  //   A. SENSE + ACTUATE — one controlled server-side step with the bot on the light; read
  //      lastSamples/lastMotors directly (no timing races).
  //   B. WIRE PROTOCOL — the client's bot snapshot carries samples[] + motors[] (without which
  //      beams/values can never render on a thin client).
  //   C. PLAY VIA UI — the authoritative running flag flips, the bot actually moves, Pause/
  //      Reset work and clear client-side trails.
  step('BUG9: redeploy host design');
  await H.ev(`document.getElementById('coop-deploy').click()`);
  await sleep(500);
  const session = () => [...gw.worlds.values()][0].session;
  const hostBot = () => {
    const p = [...session().participants.values()].find(x => x.name === 'host1');
    return session().world.instances.find(i => i.protoId === p.protoId);
  };

  // A bright light right on the spawn seed: the deployed bot spawns ON it.
  step('BUG9: drop a bright light on the spawn seed');
  await H.ev(`(()=>{const app=window.__app();app.state.world.elements.push({id:'bug9-light',type:'light',primitive:'circle',position:{x:-360,y:0},rotation:0,scale:{x:1,y:1},properties:{intensity:20000}});app.coopPanel.client.setElements(JSON.parse(JSON.stringify(app.state.world.elements)));return 1})()`);
  await sleep(300);

  // A. SENSE + ACTUATE (deterministic): reseat exactly onto the light, step once, read results.
  step('BUG9: single-step sensing');
  const inst0 = hostBot();
  if (!inst0?.body) fail('BUG9: no host bot instance after redeploy');
  session().world.reset(); // exact seed pose (-360, 0) = directly on the light
  session().world.step();
  const aSamp = Math.max(0, ...(inst0.lastSamples ?? []).map(x => x.value));
  const aMot = Math.max(0, ...(inst0.lastMotors ?? []).map(m => Math.abs(m.force)));
  if (!(aSamp > 0.3)) fail('BUG9: deployed bot never sensed the shared light (max sample ' + aSamp.toFixed(3) + ')');
  if (!(aMot > 0.3)) fail('BUG9: sensor readings never reached the actuators (max motor force ' + aMot.toFixed(3) + ')');
  step('BUG9: sensed value=' + aSamp.toFixed(3) + ' motor force=' + aMot.toFixed(3));

  // B. WIRE PROTOCOL: while paused, snapshots keep flowing and carry the (still-hot) samples, so
  // the client can prove it received sensor + motor data for its bot.
  step('BUG9: wire carries samples+motors');
  let wire = null;
  for (let i = 0; i < 40 && !wire; i++) {
    wire = await H.ev(`(()=>{const app=window.__app();const c=app.coopPanel.client;const b=(c.bots||[]).find(b=>b.owner===c.you.name);if(!b||!Array.isArray(b.samples)||!b.samples.length||!Array.isArray(b.motors)||!b.motors.length)return null;return JSON.stringify({best:Math.max(...b.samples.map(s=>s.value)),fmax:Math.max(...b.motors.map(m=>Math.abs(m.force))),coop:!!(app.worldSim&&app.worldSim.coopMode)})})()`);
    if (!wire) await sleep(100);
  }
  if (!wire) fail('BUG9: client bot snapshot never carried samples[]/motors[] (beams+values cannot render on the client)');
  const w = JSON.parse(wire);
  if (!w.coop) fail('BUG9: world is not in co-op render mode (the local sim would paint over the shared world): ' + wire);
  if (!(w.best > 0.3)) fail('BUG9: wire sensor data is dead (max value on the wire ' + w.best.toFixed(3) + ')');
  step('BUG9: wire best=' + w.best.toFixed(3) + ' fmax=' + w.fmax.toFixed(3));

  // C. PLAY VIA UI: authoritative start, real motion, label follows the flag, then Pause/Reset.
  step('BUG9: click Play');
  await H.ev(`document.getElementById('btn-play').click()`);
  let runningNow = false;
  for (let i = 0; i < 40 && !runningNow; i++) { runningNow = session().running === true; if (!runningNow) await sleep(100); }
  if (!runningNow) fail('BUG9: Play did not start the shared session (the server never runs, so deployed bots can\u2019t interact with the world)');
  let p0 = null, dx = 0;
  for (let i = 0; i < 30 && dx < 5; i++) {
    const raw = await H.ev(`(()=>{const c=window.__app().coopPanel.client;const b=(c.bots||[]).find(b=>b.owner===c.you.name);return b?b.x+','+b.y:null})()`);
    if (raw) { const [x, y] = raw.split(',').map(Number); if (!p0) p0 = { x, y }; else dx = Math.max(dx, Math.hypot(x - p0.x, y - p0.y)); }
    await sleep(100);
  }
  if (dx < 5) fail('BUG9: deployed bot never moved while the shared session ran — a frozen mirror (dx=' + dx.toFixed(1) + ')');
  const btnTxt = await H.ev(`document.getElementById('btn-play').textContent`);
  if (!/Pause/.test(btnTxt)) fail('BUG9: Play button did not flip to Pause (authoritative state not applied): ' + btnTxt);

  // Pause actually stops the session; Reset reseats the bot and clears client-side trails.
  step('BUG9: pause');
  await H.ev(`document.getElementById('btn-play').click()`);
  for (let i = 0; i < 20 && session().running; i++) await sleep(100);
  if (session().running) fail('BUG9: Pause did not stop the shared session');
  step('BUG9: reset');
  await H.ev(`document.getElementById('btn-reset').click()`);
  let home = false, hp = null;
  for (let i = 0; i < 20 && !home; i++) {
    hp = JSON.parse(await H.ev(`(()=>{const app=window.__app();const c=app.coopPanel.client;const b=c.bots.find(b=>b.owner===c.you.name);return JSON.stringify({x:b.x,y:b.y,trail:app.worldSim?((app.worldSim.coopPaths.get(b.id)||[]).length):-1})})()`));
    // The server keeps snapshotting while paused, so a couple of fresh trail points re-accumulate
    // right after the clear — trails correctly restart at the seed. (trail = this bot's own
    // point count; coopPaths.size would count BOTS, not points.)
    home = Math.hypot(hp.x - -360, hp.y - 0) < 5 && hp.trail <= 3;
    if (!home) await sleep(50);
  }
  if (!home) fail('BUG9: Reset did not return the bot to its spawn seed (-360, 0) or clear trails: ' + JSON.stringify(hp));
  step('BUG9 done');

  // ---------- BUG 10c: the host's bot popup ticks WHILE dragging (like element drags) ------
  // Clicking a shared bot shows X/Y/Rot; before the fix those values froze at click-time and
  // only re-synced from later snapshots. During the drag the popup must follow the cursor live.
  const pop10c = await H.ev(`(async()=>{
    const app=window.__app(); const sim=app.worldSim; const c=app.coopPanel.client;
    const b=c.bots.find(x=>x.owner===c.you.name);
    const r=sim.canvas.getBoundingClientRect();
    const sx=r.left+r.width/2+(b.x-sim.view.x)*sim.view.zoom;
    const sy=r.top+r.height/2+(b.y-sim.view.y)*sim.view.zoom;
    sim.canvas.dispatchEvent(new MouseEvent('mousedown',{clientX:sx,clientY:sy,bubbles:true}));
    await new Promise(res=>setTimeout(res,120));
    const before=document.getElementById('wi-ix')?.value ?? null;
    for(let i=1;i<=6;i++){
      sim.canvas.dispatchEvent(new MouseEvent('mousemove',{clientX:sx+i*10,clientY:sy+i*4,bubbles:true}));
      await new Promise(res=>setTimeout(res,40));
    }
    const after=document.getElementById('wi-ix')?.value ?? null;
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    return JSON.stringify({before,after});
  })()`);
  const p10c = JSON.parse(pop10c);
  if (p10c.before == null) fail('BUG10c: bot popup did not open on click (wi-ix missing): ' + pop10c);
  if (!(Number(p10c.after) > Number(p10c.before))) fail('BUG10c: bot popup X did not follow the drag live: ' + pop10c);

  // ---------- BUG 6: host disconnects → joiner sent home, world reclaimed -------
  await H.ev(`document.getElementById('coop-disconnect').click()`);
  const kick = await poll(J, `return /host left/i.test($('coop-gw-status').textContent) ? $('coop-gw-status').textContent : null`, 6000, 'joiner told the host left');
  const visibleJ2 = id => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;
  if (await J.ev(visibleJ2('coop-gw-row')).then(v => !v)) fail('BUG6: joiner UI did not return to idle layout');
  if (await J.ev(visibleJ2('coop-gw-fields')).then(v => !v)) fail('BUG6: gateway/name fields not restored after host left');
  for (let i = 0; i < 40 && gw.worlds.size !== 0; i++) await sleep(100);
  if (gw.worlds.size !== 0) fail('BUG6: world not reclaimed after host left: ' + gw.worlds.size);
  const homeEls = await J.ev(`JSON.stringify(window.__app().state.world.elements.map(e=>e.type))`);
  if (!homeEls.includes('rock') && !homeEls.includes('obstacle')) fail('BUG6: joiner not restored to home world: ' + homeEls);

  const exc = [...H.logs, ...J.logs].filter(l => l.startsWith('EXC'));
  if (exc.length) fail('page threw exceptions: ' + exc.slice(0, 3).join(' | '));

  ok(`co-op session (2 browsers): edit+deploy own design → shared vehicle updated · fleet −/+/✕ on others' rows · elements mirror on join + live · rows hidden while connected · host leave → kick home + reclaim (${kick})`);
} catch (e) {
  fail(e.stack || String(e));
}
