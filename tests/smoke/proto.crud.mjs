// Headless smoke test: vehicle-type CRUD in the World tab.
// Adds a second vehicle type, checks naming + live instances, then removes it
// and verifies its running bodies are dropped from the physics world.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223;
const WEB = 8903;

const freePort = spawn('sh', ['-c', `lsof -ti:${WEB} | xargs kill 2>/dev/null; true`], { stdio: 'ignore' });
await new Promise(r => freePort.on('exit', r));
const srv = spawn('sh', ['-c', `python3 -m http.server ${WEB} --directory public > /tmp/bv-srv-${WEB}.log 2>&1`], { stdio: 'ignore' });
await sleep(700);

const freeChrome = spawn('sh', ['-c', "pkill -f 'user-data-dir=/tmp/bv-profile-crud' 2>/dev/null; true"], { stdio: 'ignore' });
await new Promise(r => freeChrome.on('exit', r));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/bv-profile-crud',
  'about:blank',
], { stdio: 'ignore' });

const fail = m => { console.error('FAIL:', m); chrome.kill('SIGKILL'); srv.kill('SIGKILL'); process.exit(1); };
const ok = m => { console.log('PASS:', m); chrome.kill('SIGKILL'); srv.kill('SIGKILL'); process.exit(0); };

try {
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; }
    catch { await sleep(200); }
  }
  if (!targets) fail('chrome devtools not reachable');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise(r => ws.onopen = r);

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
    if (r.error) throw new Error('CDP error: ' + JSON.stringify(r.error));
    const out = r.result ?? {};
    if (out.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text));
    return out.result?.value;
  };

    await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: `http://localhost:${WEB}/index.html` });
  const navUrl = `http://localhost:${WEB}/index.html`;
  let navCount = 0;
  for (let i = 0; i < 90; i++) { // 45s budget: poll for boot, re-navigate if the renderer stalls
    const probe = await evalJs(`typeof window.__app`).catch(() => 'eval-error');
    if (probe === 'function') break;
    if (i > 0 && i % 30 === 0 && navCount < 2) {
      navCount++;
      console.log('RENAV: renderer stalled, re-navigating (' + navCount + '/2)');
      await send('Page.navigate', { url: navUrl });
    }
    if (i === 89) { try {
        const diagBase = await evalJs(`(async () => {
          let reimport;
          try { reimport = await import('./app/main.js').then(() => 'module-ok'); } catch (e) { reimport = 'ERR: ' + String(e && e.message || e).slice(0, 200); }
          return JSON.stringify({ url: location.href, ready: document.readyState, pre: document.querySelector('pre')?.textContent?.slice(0,200) ?? null, res404: performance.getEntriesByType('resource').filter(r => r.responseStatus >= 400).map(r => r.name + '=' + r.responseStatus), allRes: performance.getEntriesByType('resource').length, reimport });
        })()`);
        console.log('BOOT-DIAG:', diagBase);
      } catch (e) { console.log('BOOT-DIAG failed:', e.message); } }
    await sleep(500);
  }

  const boot = await evalJs(`
    (async () => {
      document.getElementById('tab-world').click();
      await new Promise(r => setTimeout(r, 400));
      const { state, worldSim } = window.__app();
      return {
        ready: document.readyState,
        app: typeof window.__app,
        names: state.world.vehiclePrototypes.map(p => p.name),
        insts: worldSim.instances.length,
      };
    })()
  `);
  if (boot.app !== 'function' || boot.names.length !== 1) fail('boot: ' + JSON.stringify(boot));

  // --- ADD: click "+ Add Vehicle" ---
  const add = await evalJs(`
    (() => {
      document.getElementById('add-vehicle').click();
      const { state, worldSim } = window.__app();
      return {
        names: state.world.vehiclePrototypes.map(p => p.name),
        ids: state.world.vehiclePrototypes.map(p => p.id),
        insts: worldSim.instances.length,
        protoIds: [...new Set(worldSim.instances.map(i => i.protoId))].length,
        blocks: document.querySelectorAll('.proto-block').length,
        hasBodies: worldSim.instances.every(i => i.body && Number.isFinite(i.body.position.x)),
      };
    })()
  `);
  if (add.names[1] !== 'Vehicle B') fail('add: expected name "Vehicle B", got ' + JSON.stringify(add));
  if (!/^proto_/.test(add.ids[1])) fail('add: bad proto id ' + add.ids[1]);
  if (add.insts < 6) fail('add: expected >=6 live instances (3+3), got ' + add.insts);
  if (add.protoIds !== 2) fail('add: instances should span 2 prototypes, got ' + add.protoIds);
  if (add.blocks !== 2) fail('add: expected 2 proto-blocks, got ' + add.blocks);
  if (!add.hasBodies) fail('add: not all new instances have finite bodies');

  // --- ADD again: must skip the taken name ---
  const add2 = await evalJs(`
    (() => {
      document.getElementById('add-vehicle').click();
      return window.__app().state.world.vehiclePrototypes.map(p => p.name);
    })()
  `);
  if (add2[2] !== 'Vehicle C') fail('add2: expected "Vehicle C", got ' + JSON.stringify(add2));

  // --- ADD cycles body color: every type gets a distinct palette color ---
  const colors = await evalJs(`
    (() => window.__app().state.world.vehiclePrototypes.map(p => (p._vehicle?.body?.color ?? '#4da3ff')))()
  `);
  if (colors.length < 3) fail('color: expected 3 prototypes, got ' + colors.length);
  if (new Set(colors).size !== colors.length) fail('color: Add Vehicle did not assign distinct body colors: ' + JSON.stringify(colors));

  // --- REMOVE: stub confirm, delete Vehicle B, check physics cleanup ---
  const del = await evalJs(`
    (() => {
      window.confirm = () => true;
      const { state, worldSim } = window.__app();
      const before = new Set(worldSim.instances.map(i => i.protoId));
      const target = state.world.vehiclePrototypes.find(p => p.name === 'Vehicle B');
      const removeBtns = document.querySelectorAll('.proto-block [data-act="remove"]').length;
      worldSim.removeVehicle(target);
      const after = worldSim.instances.map(i => i.protoId);
      return {
        removeBtns,
        names: state.world.vehiclePrototypes.map(p => p.name),
        droppedAllB: after.filter(x => x === target.id).length === 0,
        keptOthers: [...before].every(pid => pid === target.id || after.includes(pid)),
        blocks: document.querySelectorAll('.proto-block').length,
      };
    })()
  `);
  if (del.names.length !== 2 || del.names.includes('Vehicle B')) fail('remove: doc still has Vehicle B ' + JSON.stringify(del));
  if (!del.droppedAllB) fail('remove: Vehicle B instances still running');
  if (!del.keptOthers) fail('remove: other prototypes lost instances');
  if (del.blocks !== 2) fail('remove: expected 2 proto-blocks, got ' + del.blocks);
  if (del.removeBtns < 2) fail('remove: expected Remove buttons per proto-block, got ' + del.removeBtns);

  // --- DRAG a running robot to reposition it (synthetic mouse on the canvas) ---
  const dragRes = await evalJs(`
    (() => {
      const { worldSim: sim } = window.__app();
      const cv = document.getElementById('world-canvas');
      const rect = cv.getBoundingClientRect();
      const toScreen = p => ({
        x: (p.x - sim.view.x) * sim.view.zoom + rect.left + rect.width / 2,
        y: (p.y - sim.view.y) * sim.view.zoom + rect.top + rect.height / 2,
      });
      const fire = (type, target, x, y) =>
        target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
      const inst = sim.instances[0];
      const b = inst.body;
      const start = { x: b.position.x, y: b.position.y };
      const target = { x: start.x + 250, y: start.y - 150 };
      let s = toScreen(start);
      fire('mousedown', cv, s.x, s.y);
      s = toScreen(target);
      fire('mousemove', window, s.x, s.y);
      fire('mouseup', window);
      const after = { x: b.position.x, y: b.position.y };
      // Reset must restore the dropped pose (seed adopted on mouseup)
      document.getElementById('btn-reset').click();
      const resetPos = { x: b.position.x, y: b.position.y };
      return {
        moved: Math.hypot(after.x - target.x, after.y - target.y) < 2,
        zeroV: b.velocity.x === 0 && b.velocity.y === 0 && b.angularVelocity === 0,
        seedOk: Math.hypot(resetPos.x - target.x, resetPos.y - target.y) < 2,
      };
    })()
  `);
  if (!dragRes.moved) fail('drag: instance did not follow the mouse to the target point');
  if (!dragRes.zeroV) fail('drag: momentum not zeroed on drop (robot would fling away)');
  if (!dragRes.seedOk) fail('drag: Reset did not restore the dropped pose (seed not adopted)');

  // --- REMOVE vetoed by confirm() leaves everything intact ---
  const veto = await evalJs(`
    (() => {
      const { state, worldSim } = window.__app();
      const beforeN = state.world.vehiclePrototypes.length;
      const beforeI = worldSim.instances.length;
      window.confirm = () => false;
      const target = state.world.vehiclePrototypes.find(p => p.name === 'Vehicle A');
      worldSim.removeVehicle(target);
      return {
        sameN: state.world.vehiclePrototypes.length === beforeN,
        sameI: worldSim.instances.length === beforeI,
      };
    })()
  `);
  if (!veto.sameN || !veto.sameI) fail('veto: confirm()=false must leave doc + instances untouched ' + JSON.stringify(veto));

  ok('proto CRUD + robot drag: add B/C; remove drops only target; drag repositions (zero momentum, seed adopted); veto intact');

} catch (err) {
  fail(err.message ?? String(err));
}
