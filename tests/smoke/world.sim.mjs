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

  const result = await evalJs(`new Promise(resolve => {
    const step = () => {
      try {
        const app = window.__app();
        document.getElementById('tab-world').click();
        const sim = app.worldSim;
        if (!sim) return resolve({ error: 'worldSim not initialized' });
        const sun = sim.state.world.elements.find(e => e.type === 'light');
        const dists = () => sim.instances.map(i => Math.hypot(i.body.position.x - sun.position.x, i.body.position.y - sun.position.y));
        const before = dists();
        document.getElementById('btn-play').click();
        setTimeout(() => {
          const after = dists();
          const finite = [...before, ...after].every(d => Number.isFinite(d));
          const moved = after.some((d, i) => Math.abs(d - before[i]) > 1);
          resolve({ before: before.map(Math.round), after: after.map(Math.round), finite, moved, count: sim.instances.length });
        }, 6000);
      } catch (e) { resolve({ error: e.message + ' | ' + e.stack }); }
    };
    setTimeout(step, 800);
  })`);

  if (result.error) fail('sim: ' + result.error);
  if (!result.finite) fail('non-finite positions: ' + JSON.stringify(result));
  if (!result.count) fail('no instances');
  if (!result.moved) fail(`instances did not move: ${JSON.stringify(result)}`);
  ok(`simulation running: ${result.count} instances, distances ${JSON.stringify(result.before)} -> ${JSON.stringify(result.after)}`);
} catch (e) {
  fail(e.stack ?? String(e));
}
