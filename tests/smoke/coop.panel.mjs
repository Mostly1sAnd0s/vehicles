// Headless smoke test for the Co-op sidebar panel (M5, UI phases 2–4): the real SPA talks to a
// real in-process gateway over a real browser WebSocket.
//   p2: Host → code + layout swap + client count; Disconnect → prune+GC; dead join refused.
//   p3: Deploy design → shared fleet list; host adds a light from the World canvas and moves it,
//       and a second (Node-side) participant sees both in its welcome (element sync out).
//   p4: host fleet management — + grows a participant's fleet, ✕ removes all (setCount on server).
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import Matter from 'matter-js';
import { createCoopGateway } from '../../src/net/gateway.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9228;
const WEB = 8905;
const GW_PORT = 8961;

const freePort = spawn('sh', ['-c', `lsof -ti:${WEB} | xargs kill 2>/dev/null; true`], { stdio: 'ignore' });
await new Promise(r => freePort.on('exit', r));
const srv = spawn('sh', ['-c', `python3 -m http.server ${WEB} --directory public > /tmp/bv-srv-${WEB}.log 2>&1`], { stdio: 'ignore' });
await sleep(700);

const freeChrome = spawn('sh', ['-c', "pkill -f 'user-data-dir=/tmp/bv-profile-coop' 2>/dev/null; rm -rf /tmp/bv-profile-coop; true"], { stdio: 'ignore' });
// Fresh profile each run: a reused one can serve stale JS modules from its HTTP cache,
// which would test last run's app instead of the current source.
await new Promise(r => freeChrome.on('exit', r));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/bv-profile-coop',
  'about:blank',
], { stdio: 'ignore' });

// The gateway the page will talk to (same shape as tests/multiplayer.gateway.test.js).
const configs = {
  app: { defaults: { thrustScale: 2 } },
  actuators: { powered_wheel: { maxForce: 1, powerCurve: 'linear', defaultPolarity: 'forward', defaultMotorPower: 1, defaultFriction: 0.5, frictionAirBase: 0.001, frictionAirScale: 0.2 } },
  sensors: { light: { falloffPower: 2, minDistance: 5, defaultRange: 600, detectionThreshold: 0.02, fullScaleRatio: 16, fov: Math.PI * 2 } },
  components: { components: [{ id: 'light_sensor', category: 'sensor', size: 8 }, { id: 'powered_wheel', category: 'actuator', size: 16 }] },
};
const gw = createCoopGateway({ Matter, configs, port: GW_PORT, host: '127.0.0.1' });
await gw.start();

const fail = m => { console.error('FAIL:', m); chrome.kill('SIGKILL'); srv.kill('SIGKILL'); gw.close().catch(() => {}); process.exit(1); };
const ok = m => { console.log('PASS:', m); chrome.kill('SIGKILL'); srv.kill('SIGKILL'); gw.close().catch(() => {}); process.exit(0); };

try {
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; }
    catch { await sleep(200); }
  }
  if (!targets?.find(t => t.type === 'page')) fail('no CDP page target');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? {}); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 300));
  };
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise(r => ws.onopen = r);
  const evalJs = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');

  await send('Page.navigate', { url: `http://localhost:${WEB}/index.html` });
  let booted = false;
  for (let attempt = 0; attempt < 2 && !booted; attempt++) {
    for (let i = 0; i < 30; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState === "complete" && typeof window.__app === "function"', returnByValue: true });
      if (r.result?.value) { booted = true; break; }
      await sleep(400);
    }
    if (!booted) { console.log('RENAV: renderer stalled, re-navigating (' + (attempt + 1) + '/2)'); await send('Page.navigate', { url: `http://localhost:${WEB}/index.html` }); }
  }
  if (!booted) fail('editor app did not boot:');
  console.log('BOOT:', JSON.stringify(await evalJs(`JSON.stringify({ ready: document.readyState, app: typeof window.__app, pre: document.querySelector('pre')?.textContent ?? null })`)));

  // ---------- phase 2+3+4 driver, part A: layout, host, deploy, fleet mgmt, element add+move ----------
  const resultA = JSON.parse(await evalJs(`(async () => {
    const $ = id => document.getElementById(id);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const poll = async (fn, tries = 80) => { for (let i = 0; i < tries; i++) { let v; try { v = fn(); } catch { } if (v) return v; await sleep(100); } throw new Error('poll timeout'); };

    // 1. Layout: Co-op lives in the World sidebar; the standalone tab is gone.
    const layout = {
      sideHasCoop: [...document.querySelectorAll('#world-side h3')].some(h => h.textContent === 'Co-op'),
      noTab: !document.getElementById('tab-coop'),
      rowShown: !$('coop-gw-row').hidden, disconnectHidden: $('coop-disconnect').hidden, codeHidden: $('coop-gw-code').hidden,
    };

    // 2. Host: a fresh world appears with its code; the layout swaps to Disconnect.
    $('coop-host-addr').value = 'ws://127.0.0.1:${GW_PORT}';
    $('coop-gw-name').value = 'smoke';
    $('coop-host').click();
    let code;
    try { code = await poll(() => !$('coop-gw-code').hidden ? $('coop-gw-code').textContent : null); }
    catch {
      const cp = window.__app().coopPanel;
      throw new Error('code never revealed: status=' + $('coop-gw-status').textContent
        + ' clientStatus=' + cp.client.status + ' lastError=' + cp.client.lastError
        + ' wsState=' + (cp.client.ws ? cp.client.ws.readyState : 'no-ws'));
    }
    const hosted = { rowHidden: $('coop-gw-row').hidden, disconnectShown: !$('coop-disconnect').hidden, status: $('coop-gw-status').textContent };

    // 2b. Phase 3: deploy the current design -> it lands in the shared fleet list.
    // Click ONCE then poll: each click resets the status to "deploying…", so re-clicking inside
    // the poll would race the settled "deployed…" state and never observe it.
    // Give the editor's body a distinctive palette color first: the deployed bot must adopt it.
    window.__app().state.vehicle.body.color = '#be4bdb';
    $('coop-deploy').click();
    try { await poll(() => /deployed —/.test($('coop-gw-status').textContent), 40); }
    catch { throw new Error('deploy never acked: status=' + $('coop-gw-status').textContent); }
    const deployedStatus = $('coop-gw-status').textContent;
    await poll(() => !$('remote-fleet').hidden && /1 bot/.test($('remote-fleet').textContent));

    // 2c. Phase 4: host fleet management — + grows the fleet, ✕ removes it all (server setCount).
    const plus = $('remote-fleet').querySelector('button[data-act="plus"]');
    if (!plus) throw new Error('no + button in the fleet list: ' + $('remote-fleet').innerHTML.slice(0, 200));
    plus.click();
    await poll(() => /2 bot/.test($('remote-fleet').textContent), 40);
    $('remote-fleet').querySelector('button[data-act="remove"]').click();
    await poll(() => /no design|0 bot/.test($('remote-fleet').textContent), 40);
    // grow it back to one so the world has a bot for the observer to see
    $('remote-fleet').querySelector('button[data-act="plus"]').click();
    await poll(() => /1 bot/.test($('remote-fleet').textContent), 40);

    // REGRESSION: the fleet re-renders at snapshot rate (15 Hz). If renderFleet rebuilt the row DOM
    // every time, the + button would be destroyed between mousedown and mouseup and the browser
    // would never fire a real click on it (a host had to spam ~30 clicks before one landed). Hold a
    // press open across several re-render windows: the SAME node must still be connected.
    const plusBtn = $('remote-fleet').querySelector('button[data-act="plus"]');
    plusBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250)); // ~3–4 snapshot re-renders pass through here
    if (!plusBtn.isConnected) throw new Error('fleet + button was re-created mid-press (renderFleet must patch in place)');
    plusBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    plusBtn.click(); // the press survived → the click must count
    await poll(() => /2 bot/.test($('remote-fleet').textContent), 40);
    $('remote-fleet').querySelector('button[data-act="minus"]').click(); // back to one for the observer phase
    await poll(() => /1 bot/.test($('remote-fleet').textContent), 40);

    // Manual fleet size: type an exact number in the row's input and press Enter -> setCount.
    const countInput = $('remote-fleet').querySelector('.fleet-count-input');
    if (!countInput) throw new Error('no manual fleet-size input in the host fleet row');
    countInput.value = '3';
    countInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await poll(() => /3 bot/.test($('remote-fleet').textContent), 40);
    countInput.value = '1'; // back to one for the observer phase
    countInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await poll(() => /1 bot/.test($('remote-fleet').textContent), 40);

    // 2d. Phase 3 element sync: open the World tab, add a light from the canvas toolbar…
    $('tab-world').click();
    await poll(() => window.__app().worldSim);
    const lightBtn = $('add-light');
    if (lightBtn.disabled) throw new Error('add-light disabled for the host: ' + lightBtn.title);
    lightBtn.click();
    await sleep(400); // let the addElement command round-trip to the gateway
    // …and move it (the WorldSim onElementChange hook -> client.moveElement). Driving the hook
    // directly keeps this probe deterministic; canvas drag mechanics are covered by smoke:world.
    const doc = window.__app().state.world;
    const el0 = doc.elements[doc.elements.length - 1];
    if (!el0 || el0.type !== 'light') throw new Error('add-light did not land in the local world doc: ' + JSON.stringify(el0));
    window.__app().worldSim.hooks.onElementChange({ op: 'move', id: el0.id, x: 25, y: 15 });
    await sleep(400);
    if (/^⚠/.test($('coop-gw-status').textContent)) throw new Error('server refused an element edit: ' + $('coop-gw-status').textContent);

    // The shared bot's wire color must be the editor's body color (snapshot carries body.color).
    const botColor = await poll(() => window.__app().coopPanel.client.bots[0]?.color ?? null, 40);

    // …and the PAINTED body must actually show it. Regression: the coop component loop appended
    // its rects to the path that still held the body rect, so the first wheel's fill() repainted
    // the whole body in the fixed actuator blue on top of the editor color ("bots all look
    // blue, only the outline matches"). Center the camera on the bot, force a frame, and read
    // the body-center pixel (no component sits at local (0,0)).
    const sim = window.__app().worldSim;
    const rb = sim.hooks.remoteBots()[0];
    sim.view.x = rb.x; sim.view.y = rb.y;
    sim.draw(); // headless rAF may be throttled
    const cx = sim.canvas.width / 2 | 0, cy = sim.canvas.height / 2 | 0;
    const pp = sim.canvas.getContext('2d').getImageData(cx, cy, 1, 1).data;
    const isMagenta = pp[0] > 140 && pp[2] > 140 && pp[1] < 130; // #be4bdb signature (blended ok)
    const bodyPixel = [pp[0], pp[1], pp[2]];

    // 5. LIVE design sync (regression: "no matter what color I pick in the editor, bots stay red"):
    //    pick another swatch and do NOT click Deploy — the already-deployed shared bot must adopt
    //    the new body color within ~1s via the throttled auto-redeploy (body rebuilt in place).
    $('tab-editor').click();
    await sleep(400);
    const sw = [...document.querySelectorAll('.color-palette .swatch')].find(b => b.dataset.color === '#339af0');
    if (!sw) throw new Error('no #339af0 swatch in the body palette');
    sw.click();
    const liveColor = await poll(() => {
      const c = window.__app().coopPanel.client.bots.find(b => b.owner === 'smoke')?.color;
      return c === '#339af0' ? c : null;
    }, 60);

    // 6. X/Y/Rot popup (regression: "no pose popup when clicking a bot in co-op mode"): click the
    //    shared bot directly ON THE CANVAS — the inspector shows X/Y/Rot, and editing Rot sends an
    //    authoritative moveBot that lands server-side (bot angle ≈ 90°, echoed in a snapshot).
    $('tab-world').click();
    await sleep(400);
    const sim2 = window.__app().worldSim;
    const rb2 = sim2.hooks.remoteBots().find(b => b.owner === 'smoke');
    if (!rb2) throw new Error('no shared bot to select on the canvas');
    sim2.view.x = rb2.x; sim2.view.y = rb2.y; // center the camera so the bot is at screen center
    const rect = sim2.canvas.getBoundingClientRect();
    const px = rect.left + rect.width / 2, py = rect.top + rect.height / 2;
    sim2.canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: px, clientY: py, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(200);
    const wiBox = $('world-inspector');
    const hasInputs = !!(wiBox && wiBox.style.display !== 'none' && ['wi-ix', 'wi-iy', 'wi-ir'].every(id => wiBox.querySelector('#' + id)));
    if (!hasInputs) throw new Error('X/Y/Rot popup did not appear for a selected shared bot: display=' + (wiBox?.style.display) + ' html=' + (wiBox?.innerHTML ?? '').slice(0, 120));
    const rotIn = wiBox.querySelector('#wi-ir');
    rotIn.value = '90';
    rotIn.dispatchEvent(new Event('change', { bubbles: true }));
    const angleAfter = await poll(() => {
      const b = window.__app().coopPanel.client.bots.find(b => b.owner === 'smoke');
      return b && Math.abs(b.angle - Math.PI / 2) < 0.05 ? +b.angle.toFixed(4) : null;
    }, 40);

    return JSON.stringify({ layout, code, hosted, deployedStatus, fleetText: $('remote-fleet').textContent, botColor, bodyPixel, isMagenta, liveColor, hasInputs, angleAfter, addedEl: { id: el0.id, type: el0.type, x: el0.position.x, y: el0.position.y } });
  })()`));

  const { layout, code, hosted, deployedStatus, fleetText, botColor, bodyPixel, isMagenta, liveColor, hasInputs, angleAfter, addedEl } = resultA;
  if (liveColor !== '#339af0') fail('LIVE color sync failed: bot did not adopt the picked swatch without a re-deploy: ' + liveColor);
  if (!hasInputs) fail('X/Y/Rot popup missing for a selected shared bot');
  if (angleAfter == null || Math.abs(angleAfter - Math.PI / 2) > 0.05) fail('inspector Rot edit did not land server-side: ' + angleAfter);
  if (!layout.sideHasCoop) fail('no Co-op section in the World sidebar: ' + JSON.stringify(layout));
  if (layout.noTab === false) fail('standalone Co-op tab still present');
  if (!/^[A-Z0-9]{6}$/.test(code ?? '')) fail('host did not reveal a 6-char code: ' + code);
  if (!hosted.rowHidden || !hosted.disconnectShown) fail('layout did not swap to Disconnect on host: ' + JSON.stringify(hosted));
  if (!/\b1 client\b/.test(hosted.status)) fail('host status missing the live client count: ' + hosted.status);
  if (!/deployed — 1 bot/.test(deployedStatus ?? '')) fail('deploy ack never surfaced: ' + deployedStatus);
  if (botColor !== '#be4bdb') fail('deployed bot did not adopt the editor body color: got ' + botColor);
  if (!isMagenta) fail('painted body pixel is not the editor color (component overpaint regression?): got rgb(' + (bodyPixel ?? []).join(',') + ')');
  if (!/1 bot/.test(fleetText ?? '')) fail('fleet list did not settle at 1 bot after +/-/✕: ' + fleetText);

  // Node-side observer joins the hosted world: its welcome must contain the light the SPA added
  // AND moved (proving host canvas edits sync out to a second participant).
  const obs = await new Promise((resolve, reject) => {
    const ows = new WebSocket(`ws://127.0.0.1:${GW_PORT}`);
    const seen = {};
    ows.onmessage = e => { const m = JSON.parse(e.data); seen[m.type] ??= []; seen[m.type].push(m); };
    ows.onopen = () => ows.send(JSON.stringify({ type: 'join', name: 'observer', code }));
    ows.onerror = () => reject(new Error('observer ws error'));
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (seen.welcome?.[0]) { clearInterval(iv); resolve({ ows, seen }); }
      else if (seen.error?.[0]) { clearInterval(iv); reject(new Error('observer refused: ' + seen.error[0].error)); }
      else if (Date.now() - t0 > 4000) { clearInterval(iv); reject(new Error('observer welcome timeout')); }
    }, 25);
  });
  // The host seeded their pre-loaded world on host (bugfix), so match the added light by id.
  const obsEls = obs.seen.welcome[0].world.elements;
  const obsLight = obsEls.find(e => e.id === addedEl.id);
  if (!obsLight) fail('observer welcome missing the light the host added (id ' + addedEl.id + '): ' + JSON.stringify(obsEls.map(e => e.id)));
  // The move (to 25,15) was sent through the same onElementChange hook a canvas drag uses, so
  // the observer's welcome must show the MOVED position, not the spawn point.
  if (obsLight.position.x !== 25 || obsLight.position.y !== 15)
    fail('observer saw stale light position (move not synced): ' + JSON.stringify(obsLight) + ' (expected {x:25,y:15})');
  if (!obs.seen.welcome[0].world.bots.some(b => b.owner === 'smoke'))
    fail('observer welcome missing the host\u2019s deployed bot: ' + JSON.stringify(obs.seen.welcome[0].world.bots));

  // ---------- phase 2 driver, part B: disconnect + refused join ----------
  const resultB = JSON.parse(await evalJs(`(async () => {
    const $ = id => document.getElementById(id);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const poll = async (fn, tries = 80) => { for (let i = 0; i < tries; i++) { let v; try { v = fn(); } catch { } if (v) return v; await sleep(100); } throw new Error('poll timeout'); };

    // 3. Disconnect: layout returns; (server-side prune/GC is asserted on the Node side).
    $('coop-disconnect').click();
    try {
      await poll(() => !$('coop-gw-row').hidden && $('coop-gw-code').hidden);
    } catch {
      const cp = window.__app().coopPanel;
      throw new Error('layout never restored after disconnect: rowHidden=' + $('coop-gw-row').hidden
        + ' codeHidden=' + $('coop-gw-code').hidden + ' status=' + $('coop-gw-status').textContent
        + ' clientStatus=' + cp.client.status);
    }
    const left = { status: $('coop-gw-status').textContent, codeStillHidden: $('coop-gw-code').hidden };

    // 4. Join with a dead code: the server's refusal shows up in the status line.
    $('coop-join-code').value = 'ZZZZZZ';
    $('coop-join').click();
    const refused = await poll(() => /no such world/.test($('coop-gw-status').textContent) ? $('coop-gw-status').textContent : null);

    return JSON.stringify({ left, refused });
  })()`));

  const { left, refused } = resultB;
  if (!left.codeStillHidden) fail('code still shown after disconnect');
  if (!refused || !/no such world/i.test(refused)) fail('refused join did not surface the server error: ' + refused);
  try { obs.ows.close(); } catch {}

  // Server side of the disconnect: the host's world was pruned and garbage-collected.
  for (let i = 0; i < 40 && gw.worlds.size !== 0; i++) await sleep(100);
  if (gw.worlds.size !== 0) fail('world not reclaimed after the browser left: ' + gw.worlds.size);
  const exc = logs.filter(l => l.startsWith('EXC'));
  if (exc.length) fail('page threw exceptions: ' + exc.join(' | '));

  ok(`co-op panel p2–p4: host→${code} (swap, count) · deploy→fleet (+/✕) · light add+move mirrored to observer · disconnect→prune+GC · dead join refused`);
} catch (e) {
  fail(e.stack || String(e));
}
