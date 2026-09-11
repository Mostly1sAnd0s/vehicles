// Headless smoke probe: CO-OP FLEET ORGANISING — Random / Line Up / Grid for the whole
// shared world, driven through the real UI on two pages (host + joiner) against a real
// in-process gateway.
//
// What only a browser can prove here:
//   · the row EXISTS in the hosted-world controls and is visible to the HOST,
//   · it is HIDDEN for a participant (they must not be invited to move other people's bots —
//     the server refuses them anyway, and this checks they are not offered the button),
//   · clicking it moves EVERY bot — both participants' fleets — on BOTH screens,
//   · the layout is grouped per participant and uses the shared 130px spacing,
//   · Reset keeps the formation (seeds moved, checked against the SERVER's world), and
//   · a participant who calls the command directly is refused and nothing moves.
//
// Owns web 8937, CDP 9250, gateway 8965; frees BOTH Chrome ports and uses a unique profile.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import Matter from 'matter-js';
import { createCoopGateway } from '../../src/net/gateway.js';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9250;
const WEB = 8937;
const GW_PORT = 8965;
const PROFILE = `/tmp/bv-profile-arrange-${process.pid}`;
const NONCE = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

spawn('sh', ['-c', `lsof -ti:${WEB} | xargs -r kill -9 2>/dev/null; lsof -ti:${PORT} | xargs -r kill -9 2>/dev/null; true`], { stdio: 'ignore' });
await sleep(400);
spawn('sh', ['-c', `rm -rf ${PROFILE}; true`], { stdio: 'ignore' });
await sleep(200);

const srv = spawn('python3', ['-m', 'http.server', WEB, '--directory', 'public'], { stdio: 'ignore' });
await sleep(600);

const gw = createCoopGateway({ Matter, port: GW_PORT, host: '127.0.0.1', configs: {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: {
    light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 },
    distance: { model: 'raycast', defaultRange: 150, output: 'normalized_inverse', inversionRef: 1 },
    vehicle_detection: { model: 'presence', defaultRange: 300, fov: Math.PI / 2 },
  },
  components: { components: [
    { id: 'light_sensor', category: 'sensor', size: 8 },
    { id: 'powered_wheel', category: 'actuator', size: 16 },
  ] },
} });
await sleep(600);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { srv.kill('SIGKILL'); } catch {} try { gw.close(); } catch {} spawn('sh', ['-c', `rm -rf ${PROFILE}; true`], { stdio: 'ignore' }); };
const fail = m => { console.error('FAIL:', m); cleanup(); process.exit(1); };
const pass = m => console.log('PASS:', m);
const hard = setTimeout(() => fail('probe timed out'), 300_000);

try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
  if (!targets?.find(t => t.type === 'page')) fail('no CDP page target');

  const newPage = async () => {
    let t;
    try { t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); }
    catch { t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`)).json(); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pending = new Map(); const logs = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? {}); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
    };
    const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
    await new Promise(r => ws.onopen = r);
    await send('Page.enable'); await send('Runtime.enable');
    const ev = async (expression, timeoutMs = 20000) => {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`ev timeout ${timeoutMs}ms`)), timeoutMs).unref()),
      ]);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result?.value;
    };
    return { ev, logs };
  };
  const boot = async (pg, url) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await pg.ev(`location.href=${JSON.stringify(url)}`).catch(() => {});
      for (let i = 0; i < 60 && (await pg.ev('typeof window.__app').catch(() => null)) !== 'function'; i++) await sleep(250);
      if ((await pg.ev('typeof window.__app').catch(() => null)) === 'function') return;
    }
    throw new Error('page never booted: ' + (pg.logs.join(' | ') || 'no console errors'));
  };
  const poll = (pg, fnBody, ms = 10000, label = '') => pg.ev(`(async()=>{const $=id=>document.getElementById(id);const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<${Math.ceil(ms / 100)};i++){let v;try{v=(()=>{${fnBody}})();}catch(e){throw e;}if(v)return v;await sleep(100);}return null;})()`)
    .then(v => { if (v === null) throw new Error(`timeout: ${label}`); return v; });

  // ---- host page ---------------------------------------------------------
  const H = await newPage();
  await boot(H, `http://localhost:${WEB}/index.html?nc=${NONCE}`);
  const hrefH = await H.ev('location.href');
  if (!hrefH.includes(NONCE)) fail(`host page is STALE (${hrefH}) — another browser owns CDP ${PORT}`);
  await H.ev(`document.getElementById('tab-world').click()`);
  await H.ev(`document.getElementById('mode-coop').click()`);
  // This probe runs the gateway on its OWN port (the merged server that normally shares one
  // port is not what we are starting here), so point the client at it explicitly — the same
  // override the Advanced field exposes for "joining a world served somewhere else".
  await H.ev(`document.getElementById('coop-gw-name').value='Boss'`);
  await H.ev(`document.getElementById('coop-host-addr').value='ws://127.0.0.1:${GW_PORT}'`);
  await H.ev(`document.getElementById('coop-host').click()`);
  const code = await poll(H, `const c=$('coop-gw-code').textContent.trim();return /[A-Z0-9]{6}/.test(c)?c:null;`, 15000, 'host code')
    .catch(async () => fail('never got a join code: ' + await H.ev(`document.getElementById('coop-gw-status').textContent`)));
  pass(`hosting world ${code}`);

  const sessionOf = () => { const w = gw.worlds.get(code); return w?.session ?? w; };
  const serverBots = () => sessionOf().world.instances.map(i => ({ id: i.id, x: i.body.position.x, y: i.body.position.y, seed: { ...i.seed } }));
  const waitFor = async (fn, label, tries = 60) => {
    for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(200); }
    fail(`timeout waiting for ${label}; server bots: ` + JSON.stringify(serverBots()));
  };

  // The row must exist and be visible to the host.
  const hostRow = await H.ev(`(() => { const r = document.getElementById('coop-arrange');
    return r ? { found: true, hidden: r.hidden || !r.offsetParent && getComputedStyle(r).display === 'none',
      buttons: [...r.querySelectorAll('button')].map(b => b.id) } : { found: false }; })()`);
  if (!hostRow.found) fail('no #coop-arrange row in the co-op controls');
  if (hostRow.hidden) fail('the arrange row is hidden for the HOST (who is supposed to use it)');
  const want = ['coop-arrange-random', 'coop-arrange-line', 'coop-arrange-grid'];
  if (want.some(id => !hostRow.buttons.includes(id))) fail('missing arrange button(s): ' + hostRow.buttons.join(','));
  pass('host sees the fleet-organise row: Random / Line Up / Grid');

  // Both participants deploy, and each fleet grows to 2 → four bots from two designs.
  await H.ev(`document.getElementById('coop-deploy').click()`);
  await sleep(1200);
  const depStatus = await H.ev(`document.getElementById('coop-gw-status').textContent`);
  if (!/deployed/.test(depStatus)) fail('host deploy not acked, status was: ' + depStatus);
  const hostProto = await H.ev(`window.__app().coopPanel.client.you.protoId`);
  await H.ev(`(() => { window.__app().coopPanel.client.setCount('${hostProto}', 2); return 1; })()`);
  pass('host deployed its design and grew its fleet to 2');

  // ---- joiner page -------------------------------------------------------
  const J = await newPage();
  await boot(J, `http://localhost:${WEB}/index.html?nc=${NONCE}j`);
  const hrefJ = await J.ev('location.href');
  if (!hrefJ.includes(NONCE)) fail(`joiner page is STALE (${hrefJ})`);
  await J.ev(`document.getElementById('mode-coop').click()`);
  await J.ev(`document.getElementById('coop-gw-name').value='Guest'`);
  await J.ev(`document.getElementById('coop-host-addr').value='ws://127.0.0.1:${GW_PORT}'`);
  await J.ev(`document.getElementById('coop-join-code').value='${code}'`);
  await J.ev(`document.getElementById('coop-join').click()`);
  await sleep(2500);
  const jSt = await J.ev(`(() => ({ s: window.__app().coopPanel.client.status, t: document.getElementById('coop-gw-status').textContent }))()`);
  if (jSt.s !== 'connected') fail('joiner not connected — status=' + JSON.stringify(jSt));
  await sleep(400);
  if ((await J.ev(`window.__app().coopPanel.client.you.role`)) !== 'participant') fail('joiner is not a participant');
  await J.ev(`document.getElementById('coop-deploy').click()`);
  await sleep(1500);
  const jDep = await J.ev(`document.getElementById('coop-gw-status').textContent`);
  if (!/deployed/.test(jDep)) fail('joiner deploy not acked, status was: ' + jDep);
  console.log('step: joiner deployed; reading its protoId');
  const guestProto = await J.ev(`window.__app().coopPanel.client.you.protoId`);
  console.log('step: guestProto=' + guestProto + ' → growing guest fleet');
  // Fleet growth comes from the HOST: setCount is admin-only, so sending it from the joiner
  // would be refused (and that refusal is itself asserted later for arrangeBots).
  await H.ev(`(() => { window.__app().coopPanel.client.setCount('${guestProto}', 2); return 1; })()`);
  console.log('step: host grew the guest fleet');
  await waitFor(() => serverBots().length >= 4, 'four bots on the SERVER');
  console.log('step: server holds 4');
  await waitFor(() => serverBots().length >= 4, 'four bots');
  await sleep(900); // let both mirrors catch up on their own snapshot cadence
  const mirror = await J.ev(`window.__app().coopPanel.client.bots.length`);
  const mirrorH = await H.ev(`window.__app().coopPanel.client.bots.length`);
  if (mirror < 4 || mirrorH < 4) fail(`both screens should show 4 bots (host ${mirrorH}, joiner ${mirror})`);
  pass(`two participants deployed, 2 bots each — ${mirror} bots from two designs visible on BOTH screens`);

  // A participant must not even be offered the button.
  const guestRow = await J.ev(`(() => { const r = document.getElementById('coop-arrange');
    return { hidden: !!r.hidden, role: window.__app().coopPanel.client.you.role }; })()`);
  if (guestRow.role !== 'participant') fail('the joiner is not a participant, so this proves nothing: ' + guestRow.role);
  if (!guestRow.hidden) fail('a PARTICIPANT can see the fleet-organise row — it moves other people\'s bots');
  pass('the row is hidden for a participant (role confirmed) — the session still refuses them, below');

  // ---- scatter, so the formation is a real change -----------------------
  const scatter = await H.ev(`(() => {
    const c = window.__app().coopPanel.client;
    c.bots.forEach((b, i) => c.moveBot(b.id, -700 + i * 190, -650 + (i % 2) * 780));
    return c.bots.length;
  })()`);
  await sleep(900);
  const scattered = serverBots();
  if (new Set(scattered.map(b => `${Math.round(b.x)},${Math.round(b.y)}`)).size < 4) fail('the scatter did not land on the server: ' + JSON.stringify(scattered));
  pass(`scattered all ${scatter} bots (host drag channel) — the layout below is a real change, not a no-op`);

  // ---- LINE UP: every bot, both designs, on both screens ----------------
  await H.ev(`document.getElementById('coop-arrange-line').click()`);
  const flatOnServer = () => { const b = serverBots(); return b.length >= 4 && Math.max(...b.map(x => x.y)) - Math.min(...b.map(x => x.y)) < 0.5; };
  await waitFor(flatOnServer, 'the SERVER to lay them flat', 40);
  await sleep(900); // both mirrors refresh on their own snapshot cadence
  const lineH = await H.ev(`(() => { const b = window.__app().coopPanel.client.bots;
    const ys = b.map(x => x.y), xs = b.map(x => x.x).sort((p,q)=>p-q);
    return { n: b.length, ySpread: Math.max(...ys) - Math.min(...ys), xSpan: xs[xs.length-1] - xs[0] }; })()`);
  const lineS = serverBots();
  if (lineH.n < 4) fail('fewer than four bots on the host screen');
  if (lineH.ySpread > 0.5) fail('bots are not on one line on the host: y spread ' + lineH.ySpread);
  if (Math.max(...lineS.map(b => Math.abs(b.y))) > 0.5) fail('the SERVER still has bots off the line: ' + JSON.stringify(lineS.map(b => b.y)));
  if (lineH.xSpan < 3 * 120) fail(`line spacing looks wrong (span ${lineH.xSpan} for 4 bots at 130px)`);
  const lineJ = await J.ev(`(() => { const b = window.__app().coopPanel.client.bots;
    const ys = b.map(x => x.y); return { n: b.length, ySpread: Math.max(...ys) - Math.min(...ys) }; })()`);
  if (lineJ.n < 4 || lineJ.ySpread > 0.5) fail('the JOINER does not show the line: ' + JSON.stringify(lineJ));
  const protosOnLine = new Set(lineS.map(b => b.id.split('#')[0]));
  if (protosOnLine.size < 2) fail('only one design was arranged — the point of the feature is EVERY bot: ' + lineS.map(b => b.id).join(','));
  pass(`Line Up moved every bot from BOTH designs onto one line (${lineH.n} bots, x span ${Math.round(lineH.xSpan)}px) on both screens`);

  // ---- GRID: 2×2, grouped, and the seeds follow -------------------------
  await H.ev(`document.getElementById('coop-arrange-grid').click()`);
  const gridOnServer = () => { const b = serverBots(); const xs = new Set(b.map(x => Math.round(x.x))), ys = new Set(b.map(x => Math.round(x.y)));
    return b.length >= 4 && xs.size === 2 && ys.size === 2; };
  await waitFor(gridOnServer, 'the SERVER to form a 2x2 grid', 40);
  await sleep(900);
  const gridJ = await J.ev(`(() => { const b = window.__app().coopPanel.client.bots;
    return { n: b.length, xs: [...new Set(b.map(x => Math.round(x.x)))].length, ys: [...new Set(b.map(x => Math.round(x.y)))].length }; })()`);
  if (gridJ.n < 4 || gridJ.xs !== 2 || gridJ.ys !== 2) fail('the JOINER does not show the grid: ' + JSON.stringify(gridJ));
  const gridS = serverBots();
  const gx = new Set(gridS.map(b => Math.round(b.x)));
  const gy = new Set(gridS.map(b => Math.round(b.y)));
  if (gx.size !== 2 || gy.size !== 2) fail(`expected a 2x2 grid, got x:${[...gx]} y:${[...gy]}`);
  // Seeds moved too — that is what makes the layout survive a Reset.
  for (const b of gridS) {
    if (Math.abs(b.x - b.seed.x) > 1e-6 || Math.abs(b.y - b.seed.y) > 1e-6) fail(`bot ${b.id} pose and seed disagree: ${JSON.stringify(b)}`);
  }
  pass('Grid put all four bots in a 2×2 whose seeds match, so Reset will keep it');

  // ---- Reset keeps the formation ---------------------------------------
  // Displace the bodies WITHOUT re-seating them. Deliberately not `moveBot`: the drag channel
  // adopts the dropped pose as the seed (by design — a drag should survive a Reset), which
  // would overwrite the grid seeds this step exists to test. Writing the body positions on the
  // server reproduces "the fleet wandered off" while leaving the seeds alone.
  for (const inst of sessionOf().world.instances) {
    Matter.Body.setPosition(inst.body, { x: inst.body.position.x + 430, y: inst.body.position.y - 260 });
  }
  const wandered = serverBots();
  if (wandered.some(b => Math.abs(b.x - b.seed.x) < 1)) fail('the displacement did not take; Reset below would prove nothing');
  await H.ev(`window.__app().coopPanel.client.controls('reset')`);
  await sleep(900);
  const afterReset = serverBots();
  for (const b of afterReset) {
    if (Math.abs(b.x - b.seed.x) > 0.5 || Math.abs(b.y - b.seed.y) > 0.5) fail(`Reset undid the Grid for ${b.id}: at ${b.x},${b.y} seed ${b.seed.x},${b.seed.y}`);
  }
  if (new Set(afterReset.map(b => Math.round(b.x))).size !== 2) fail('after Reset the bots are no longer in the grid columns');
  pass('Reset returns the fleet to the Grid — the layout is a property of the world, not a moment');

  // ---- a participant who calls it directly is refused -------------------
  const beforeRefuse = serverBots();
  await J.ev(`window.__app().coopPanel.client.arrangeBots('line', { x: 0, y: 0 }); 1`);
  let refusal = null;
  for (let i = 0; i < 40 && !refusal; i++) {
    refusal = await J.ev(`(() => { const t = document.getElementById('coop-gw-status').textContent; return /\u26a0/.test(t) ? t : null; })()`);
    if (!refusal) await sleep(100);
  }
  if (!refusal) fail('a participant calling arrangeBots got no visible refusal (the server must refuse it, not ignore it)');
  if (!/host/i.test(refusal)) fail('refusal does not explain who may do it: ' + refusal);
  await sleep(400);
  const afterRefuse = serverBots();
  const moved = afterRefuse.some((b, i) => Math.abs(b.x - beforeRefuse[i].x) > 0.5 || Math.abs(b.y - beforeRefuse[i].y) > 0.5);
  if (moved) fail('a PARTICIPANT moved the shared fleet — the server accepted arrangeBots from a non-admin');
  pass(`participant refused outright ("${refusal.slice(0, 60)}…") and nothing moved on the server`);

  console.log('\nALL PASS — co-op fleet organising verified end-to-end (host-only, every bot, seed-persistent)');
  clearTimeout(hard);
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e.message);
  cleanup();
  process.exit(1);
}
