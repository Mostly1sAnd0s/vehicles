// Headless smoke probe: CO-OP PROPAGATION LINEAGE — the "survival of the fittest" scoreboard.
//
// A Propagator converts a bot's DESIGN; lineage moves the bot's COUNT to the converter's proto
// (transitively). The co-op fleet list counts by lineage, so this probe proves, through the real
// UI on two pages (host + joiner) against a real in-process gateway:
//
//   · before the run, each participant's row counts their own deployed bots (2 / 2);
//   · once the shared sim runs, the host's Propagator converts BOTH of the joiner's bots and
//     the rows become 4 / 0 on BOTH screens — the joiner's row loses bots it still owns
//     (ownership never moves; only the count does);
//   · the server world, the wire snapshot and both clients' `client.bots` all agree on the
//     `lineage` field (the converted bot keeps its own protoId/owner, lineage = converter's);
//   · Pause + Reset restores the initial mix (2 / 2), even though the sim is paused — the
//     gateway's unconditional 15 Hz snapshot broadcast is what keeps the rows fresh.
//
// Owns web 8938, CDP 9252, gateway 8967; frees BOTH Chrome ports and uses a unique profile.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import Matter from 'matter-js';
import { createCoopGateway } from '../../src/net/gateway.js';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9252;
const WEB = 8938;
const GW_PORT = 8967;
const PROFILE = `/tmp/bv-profile-lineage-${process.pid}`;
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
  const poll = async (pg, fnBody, ms = 10000, label = '') => {
    const body = `(async()=>{const $=id=>document.getElementById(id);const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<${Math.ceil(ms / 100)};i++){let v;try{v=(()=>{${fnBody}})();}catch(e){throw e;}if(v)return v;await sleep(100);}return null;})()`;
    // The inner loop runs `ms`; the CDP eval gets ms + headroom, because headless Chrome
    // intermittently STALLS the renderer (PLAN, item 2 NOTE) and a 20s default race would kill
    // a perfectly healthy poll. One retry absorbs a stalled eval; a real condition timeout
    // (the loop finishing with null) still fails, with the page's live state named.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const v = await pg.ev(body, ms + 15000);
        if (v === null) throw new Error(`timeout: ${label}`);
        return v;
      } catch (e) {
        if (attempt === 0 && /ev timeout/.test(String(e.message))) continue; // renderer stall: re-poll
        const live = await pg.ev(fleetRows).catch(() => null);
        throw new Error(`${e.message} — live fleet rows: ${JSON.stringify(live)}`);
      }
    }
  };

  // Fleet rows as the UI shows them: [{proto, count}] straight off #remote-fleet.
  const fleetRows = `(() => [...document.querySelectorAll('#remote-fleet .fleet-row')].map(r => ({
    proto: r.dataset.protoId,
    count: Number(String(r.querySelector('.fleet-count')?.textContent ?? '').match(/\\d+/)?.[0] ?? -1),
  })))()`;
  // Node-side row wait: SIMPLE sync evals in a Node loop, never an in-page timer loop. While the
  // shared sim is running, both pages chew 15 Hz snapshots + rAF drawing and an in-page
  // `await sleep(100)` polling loop starves for far longer than its own timeout (measured); a
  // one-shot sync eval gets its event-loop slot and reads the freshly rendered row (renderFleet
  // re-renders on every snapshot message, so there is no stale-frame window to poll through).
  const waitForRows = async (pg, protoA, protoB, wantA, wantB, ms, label) => {
    const t0 = Date.now();
    for (;;) {
      const rows = await pg.ev(fleetRows).catch(() => null);
      if (rows) {
        const a = rows.find(r => r.proto === protoA)?.count ?? -1;
        const b = rows.find(r => r.proto === protoB)?.count ?? -1;
        if (a === wantA && b === wantB) return rows;
      }
      if (Date.now() - t0 > ms) fail(`timeout: ${label} — live rows: ${JSON.stringify(rows)}`);
      await sleep(200);
    }
  };

  // ---- host page: host the world, deploy the "fittest" design ----------------
  const H = await newPage();
  await boot(H, `http://localhost:${WEB}/index.html?nc=${NONCE}&worker=0`);
  const hrefH = await H.ev('location.href');
  if (!hrefH.includes(NONCE)) fail(`host page is STALE (${hrefH}) — another browser owns CDP ${PORT}`);
  await H.ev(`document.getElementById('tab-world').click()`);
  await H.ev(`document.getElementById('mode-coop').click()`);
  await H.ev(`document.getElementById('coop-gw-name').value='Boss'`);
  await H.ev(`document.getElementById('coop-host-addr').value='ws://127.0.0.1:${GW_PORT}'`);
  await H.ev(`document.getElementById('coop-host').click()`);
  const code = await poll(H, `const c=$('coop-gw-code').textContent.trim();return /[A-Z0-9]{6}/.test(c)?c:null;`, 15000, 'host code')
    .catch(async () => fail('never got a join code: ' + await H.ev(`document.getElementById('coop-gw-status').textContent`)));
  pass(`hosting world ${code}`);

  const session = () => gw.worlds.get(code)?.session;
  const serverBots = () => session().world.instances.map(i => ({ id: i.id, protoId: i.protoId, lineage: i.lineage, converted: !!i.converted }));
  const waitFor = async (fn, label, tries = 60) => {
    for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(200); }
    fail(`timeout waiting for ${label}; server bots: ` + JSON.stringify(serverBots()));
  };

  // The host's design is the default sun-car plus a Propagator (450 radius — wide enough to
  // reach across the 130px line layout). The joiner deploys the same default UNCHANGED, so the
  // two configurations genuinely differ and the conversion is a real one.
  await H.ev(`(() => { const v = window.__app().state.vehicle;
    if (!v.components.some(c => c.type === 'propagate')) v.components.push({
      id: 'prop_probe', type: 'propagate', local: { x: 0, y: 0 }, localRotation: 0, props: { threshold: 450 },
    }); return 1; })()`);
  await H.ev(`document.getElementById('coop-deploy').click()`);
  await sleep(1200);
  if (!/deployed/.test(await H.ev(`document.getElementById('coop-gw-status').textContent`))) fail('host deploy not acked');
  const hostProto = await H.ev(`window.__app().coopPanel.client.you.protoId`);
  await H.ev(`(() => { window.__app().coopPanel.client.setCount('${hostProto}', 2); return 1; })()`);
  pass('host deployed the Propagator design and grew its fleet to 2');

  // ---- joiner page: plain design, fleet of 2 ---------------------------------
  const J = await newPage();
  await boot(J, `http://localhost:${WEB}/index.html?nc=${NONCE}j&worker=0`);
  const hrefJ = await J.ev('location.href');
  if (!hrefJ.includes(NONCE)) fail(`joiner page is STALE (${hrefJ})`);
  await J.ev(`document.getElementById('mode-coop').click()`);
  await J.ev(`document.getElementById('coop-gw-name').value='Guest'`);
  await J.ev(`document.getElementById('coop-host-addr').value='ws://127.0.0.1:${GW_PORT}'`);
  await J.ev(`document.getElementById('coop-join-code').value='${code}'`);
  await J.ev(`document.getElementById('coop-join').click()`);
  await sleep(2500);
  if ((await J.ev(`window.__app().coopPanel.client.status`)) !== 'connected') fail('joiner not connected');
  await J.ev(`document.getElementById('coop-deploy').click()`);
  await sleep(1500);
  if (!/deployed/.test(await J.ev(`document.getElementById('coop-gw-status').textContent`))) fail('joiner deploy not acked');
  const guestProto = await J.ev(`window.__app().coopPanel.client.you.protoId`);
  await H.ev(`(() => { window.__app().coopPanel.client.setCount('${guestProto}', 2); return 1; })()`);
  await waitFor(() => serverBots().length === 4, 'four bots on the SERVER');
  await sleep(1000); // let both mirrors catch up on the 15 Hz snapshot cadence

  // ---- before the run: the rows count each participant's own bots ------------
  const rowsH0 = await H.ev(fleetRows);
  const rowsJ0 = await J.ev(fleetRows);
  const countOf = (rows, proto) => rows.find(r => r.proto === proto)?.count ?? -1;
  if (countOf(rowsH0, hostProto) !== 2 || countOf(rowsH0, guestProto) !== 2)
    fail(`host rows should read 2/2 before the run: ${JSON.stringify(rowsH0)}`);
  if (countOf(rowsJ0, hostProto) !== 2 || countOf(rowsJ0, guestProto) !== 2)
    fail(`joiner rows should read 2/2 before the run: ${JSON.stringify(rowsJ0)}`);
  pass('both screens read 2/2 before the run (each row counts its deployer\'s bots)');

  // ---- line them up (130px spacing ⇒ every host bot is inside the 450 radius) -
  await H.ev(`document.getElementById('coop-arrange-line').click()`);
  await waitFor(() => { const ys = session().world.instances.map(i => i.body.position.y);
    return ys.length === 4 && Math.max(...ys) - Math.min(...ys) < 0.5; }, 'the SERVER to lay them flat', 40);
  await sleep(900);

  // ---- run the shared sim: the Propagator takes over the joiner's fleet ------
  await H.ev(`document.getElementById('btn-play').click()`);
  await waitFor(() => session().running === true, 'the session to start (Play forwarded to the server)', 30);
  await waitFor(
    () => { const b = serverBots(); return b.length === 4 && b.every(x => x.converted === false || x.lineage === hostProto) && b.filter(x => x.protoId === guestProto).every(x => x.lineage === hostProto); },
    'both of the joiner\'s bots to convert on the SERVER', 150,
  );
  const converged = serverBots();
  for (const b of converged) {
    if (b.protoId === guestProto) assert2(b.converted && b.lineage === hostProto, `converted bot ${b.id} keeps its own protoId but counts for the converter`);
    else assert2(b.lineage === hostProto, `host bot ${b.id} counts for its own proto`);
  }
  // the wire agrees with the engine (this is what both screens render from).
  const wire = session().currentSnapshotWire().bots;
  assert2(wire.every(b => typeof b.lineage === 'string' && b.lineage !== undefined), 'every wire bot carries a lineage field');
  assert2(wire.filter(b => b.protoId === guestProto).every(b => b.lineage === hostProto), 'wire: both converted bots carry the converter\'s lineage');
  pass('the Propagator converted both of the joiner\'s bots — the server, the wire and the counts agree');

  // ...and BOTH screens show the scoreboard: host 4, joiner 0 (the joiner's bots are still
  // theirs — ownership never moves — they just no longer COUNT for them).
  const rowsH1 = await waitForRows(H, hostProto, guestProto, 4, 0, 15000, 'host rows to reach 4/0');
  const rowsJ1 = await waitForRows(J, hostProto, guestProto, 4, 0, 15000, 'joiner rows to reach 4/0');
  for (const [label, rows] of [['host', rowsH1], ['joiner', rowsJ1]]) {
    if (countOf(rows, hostProto) !== 4) fail(`${label} scoreboard should show the host at 4 bots: ${JSON.stringify(rows)}`);
    if (countOf(rows, guestProto) !== 0) fail(`${label} scoreboard should show the joiner at 0 bots: ${JSON.stringify(rows)}`);
  }
  // The clients' normalized bots carry the lineage field (the UI's data source) — and the
  // converted bot still carries the JOINER's ownerToken: it is still the joiner's bot, it just
  // no longer counts for the joiner. (On the joiner's own page that is literally you.token.)
  const takenLineage = (ownToken) => `(() => { const b = window.__app().coopPanel.client.bots;
    const mine = window.__app().coopPanel.client.you.token;
    return { n: b.length, allHave: b.every(x => typeof x.lineage === 'string'),
      taken: b.some(x => x.protoId === '${guestProto}' && x.lineage === '${hostProto}' && ${ownToken ? 'x.ownerToken === mine' : 'x.ownerToken !== mine'}) }; })()`;
  for (const [label, pg, ownToken] of [['joiner', J, true], ['host', H, false]]) {
    const cl = await pg.ev(takenLineage(ownToken));
    if (cl.n !== 4 || !cl.allHave) fail(`${label} client.bots must all carry lineage (n=${cl.n}, allHave=${cl.allHave})`);
    if (!cl.taken) fail(`${label} client.bots: the converted bot must keep the joiner's ownerToken while counting for the host`);
  }
  pass('both screens show 4/0 — the "survival of the fittest" scoreboard, live, on every client');

  // ---- Pause + Reset restores the initial mix (2/2) — even while paused ------
  await H.ev(`window.__app().coopPanel.client.controls('pause'); 1`);
  await waitFor(() => session().running === false, 'the session to pause', 30);
  await H.ev(`window.__app().coopPanel.client.controls('reset'); 1`);
  await waitFor(
    () => serverBots().every(b => !b.converted && b.lineage === b.protoId),
    'the SERVER to restore the initial mix (seeds + lineage)', 60,
  );
  const rowsH2 = await waitForRows(H, hostProto, guestProto, 2, 2, 15000, 'host rows back to 2/2');
  const rowsJ2 = await waitForRows(J, hostProto, guestProto, 2, 2, 15000, 'joiner rows back to 2/2');
  for (const [label, rows] of [['host', rowsH2], ['joiner', rowsJ2]]) {
    if (countOf(rows, hostProto) !== 2 || countOf(rows, guestProto) !== 2)
      fail(`${label} rows should read 2/2 after Reset (the sim is PAUSED — the 15 Hz snapshots keep them fresh): ${JSON.stringify(rows)}`);
  }
  pass('Pause + Reset restores 2/2 on both screens — the scoreboard returns to the initial mix');

  function assert2(cond, msg) { if (!cond) fail(msg); }

  console.log('\nALL PASS — co-op propagation lineage verified end-to-end (counts follow the converter, ownership never moves)');
  clearTimeout(hard);
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e.message);
  cleanup();
  process.exit(1);
}
