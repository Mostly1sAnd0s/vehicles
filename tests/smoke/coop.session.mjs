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
    const ev = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
  if (await H.ev(`!document.getElementById('coop-gw-row').hidden`).then(v => v)) fail('BUG4: host/join row still visible while hosting');
  if (await H.ev(`!document.getElementById('coop-gw-fields').hidden`).then(v => v)) fail('BUG4: gateway/name fields still visible while hosting');

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

  // ---------- BUG 5 (row hides on join) + BUG 3a (elements mirror on join) -------
  await J.ev(`(async()=>{const $=id=>document.getElementById(id);$('tab-world').click();$('coop-gw-url').value='${url}';$('coop-gw-name').value='join1';$('coop-join-code').value='${code}';$('coop-join').click();for(let i=0;i<80&&$('coop-gw-code').hidden;i++)await new Promise(r=>setTimeout(r,100));})()`);
  if ((await J.ev(`document.getElementById('coop-gw-code').textContent`)) !== code) fail('joiner did not land in the hosted world');
  if (await J.ev(`!document.getElementById('coop-gw-row').hidden`).then(v => v)) fail('BUG5: host/join row still visible while joined');
  if (await J.ev(`!document.getElementById('coop-gw-fields').hidden`).then(v => v)) fail('BUG5: gateway/name fields still visible while joined');

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

  // ---------- BUG 6: host disconnects → joiner sent home, world reclaimed -------
  await H.ev(`document.getElementById('coop-disconnect').click()`);
  const kick = await poll(J, `return /host left/i.test($('coop-gw-status').textContent) ? $('coop-gw-status').textContent : null`, 6000, 'joiner told the host left');
  if (await J.ev(`!document.getElementById('coop-gw-row').hidden`).then(v => !v)) fail('BUG6: joiner UI did not return to idle layout');
  if (await J.ev(`document.getElementById('coop-gw-fields').hidden`).then(v => v)) fail('BUG6: gateway/name fields not restored after host left');
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
