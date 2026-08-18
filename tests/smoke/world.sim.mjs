// Headless smoke test: loads the app, switches to World tab, plays the sim,
// verifies vehicle instances move (and stay finite) over time.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9222;
const WEB = 8902;

// free the web port in case a previous run left a server behind
const freePort = spawn('sh', ['-c', `lsof -ti:${WEB} | xargs kill 2>/dev/null; true`], { stdio: 'ignore' });
await new Promise(r => freePort.on('exit', r));

const srv = spawn('python3', ['-m', 'http.server', String(WEB), '--directory', 'public'], { stdio: 'ignore' });
await sleep(700); // let the server bind before Chrome navigates

// kill a leftover headless Chrome from a previous run (profile lock breaks boot)
const freeChrome = spawn('sh', ['-c', "pkill -f 'user-data-dir=/tmp/bv-profile ' 2>/dev/null; true"], { stdio: 'ignore' });
await new Promise(r => freeChrome.on('exit', r));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/bv-profile',
  'about:blank',
], { stdio: 'ignore' });

const fail = m => { console.error('FAIL:', m); chrome.kill(); srv.kill(); process.exit(1); };
const ok = m => { console.log('PASS:', m); chrome.kill(); srv.kill(); process.exit(0); };

try {
  // wait for devtools endpoint
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      break;
    } catch { await sleep(200); }
  }
  if (!targets) fail('chrome devtools not reachable');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? {}); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise(r => ws.onopen = r);

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${WEB}/index.html` });
  await sleep(2500);

  const boot = await evalJs(`(() => {
    const app = window.__app?.();
    if (!app) return { error: '__app not exposed' };
    if (!app.state.vehicle) return { error: 'vehicle not loaded' };
    if (!app.state.world) return { error: 'world not loaded' };
    return { vehicle: app.state.vehicle.id, world: app.state.world.name, protos: app.state.world.vehiclePrototypes.length };
  })()`);
  if (boot.error) fail('boot: ' + boot.error);
  console.log('PASS: app booted', JSON.stringify(boot));

  // Phase A: default (excitatory) wiring -> measure mean distance-to-light delta.
  // Phase B: rewire both wires to Inhibitory through the editor UI; assert the
  //          running sim's cached wire maps picked it up (regression: stale map).
  // Phase C: inhibitory driving must invert the distance delta vs phase A.
  const result = await evalJs(`new Promise(resolve => {
    try {
      const app = window.__app();
      document.getElementById('tab-world').click();
      const sim = app.worldSim;
      if (!sim) return resolve({ error: 'worldSim not initialized' });
      const sun = sim.state.world.elements.find(e => e.type === 'light');
      const dists = () => sim.instances.map(i => Math.hypot(i.body.position.x - sun.position.x, i.body.position.y - sun.position.y));
      const meanDelta = (a, b) => b.map((d, i) => d - a[i]).reduce((s, d) => s + d, 0) / b.length;

      const d0 = dists();
      document.getElementById('btn-play').click();
      setTimeout(() => {
        const d1 = dists();
        const deltaA = meanDelta(d0, d1);
        // pause, then rewire through the editor UI like a user would
        document.getElementById('btn-play').click();
        document.getElementById('tab-editor').click();
        // delete wires one at a time: each removal rebuilds the list DOM
        let del = document.querySelector('#wire-list li .del');
        while (del) { del.click(); del = document.querySelector('#wire-list li .del'); }
        for (const pair of [['sL', 'wL'], ['sR', 'wR']]) {
          document.getElementById('wire-from').value = pair[0];
          document.getElementById('wire-to').value = pair[1];
          document.getElementById('wire-polarity').value = 'inhibitory';
          document.getElementById('wire-weight-range').value = '1';
          document.getElementById('add-wire').click();
        }
        const mapPol = (sim.instances[0].wireMap ?? {}).wL?.[0]?.wire.polarity ?? null;
        const d2 = dists();
        // resume with inhibitory wiring and measure again
        document.getElementById('tab-world').click();
        document.getElementById('btn-play').click();
        setTimeout(() => {
          const d3 = dists();
          const deltaB = meanDelta(d2, d3);
          const finite = [...d0, ...d1, ...d2, ...d3].every(d => Number.isFinite(d));
          resolve({
            count: sim.instances.length, finite,
            deltaA: Math.round(deltaA), deltaB: Math.round(deltaB),
            mapPol, editedPolaritys: app.state.vehicle.wires.map(w => w.polarity),
          });
        }, 4500);
      }, 4500);
    } catch (e) { resolve({ error: e.message + ' | ' + e.stack }); }
  })`);

  if (result.error) fail('sim: ' + result.error);
  if (!result.finite) fail('non-finite positions: ' + JSON.stringify(result));
  if (!result.count) fail('no instances');
  if (JSON.stringify(result.editedPolaritys) !== JSON.stringify(['inhibitory', 'inhibitory'])) {
    fail('editor rewiring did not take effect: ' + JSON.stringify(result.editedPolaritys));
  }
  if (result.mapPol !== 'inhibitory') fail('runtime wire map is stale after editor rewire (got ' + result.mapPol + ')');
  if (Math.abs(result.deltaA) < 5 || Math.abs(result.deltaB) < 5) {
    fail(`not enough motion to compare polarity (${JSON.stringify(result)})`);
  }
  if (Math.sign(result.deltaA) === Math.sign(result.deltaB)) {
    fail(`polarity did not invert behavior: deltaA=${result.deltaA} deltaB=${result.deltaB}`);
  }
  ok(`simulation + polarity: ${result.count} instances, excitatory dΔ=${result.deltaA} -> inhibitory dΔ=${result.deltaB}`);
} catch (e) {
  fail(e.stack ?? String(e));
}
