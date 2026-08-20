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

const srv = spawn('sh', ['-c', `python3 -m http.server ${WEB} --directory public > /tmp/bv-srv-${WEB}.log 2>&1`], { stdio: 'ignore' });
await sleep(700); // let the server bind before Chrome navigates

// kill a leftover headless Chrome from a previous run (profile lock breaks boot)
const freeChrome = spawn('sh', ['-c', "pkill -f 'user-data-dir=/tmp/bv-profile ' 2>/dev/null; true"], { stdio: 'ignore' });
await new Promise(r => freeChrome.on('exit', r));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/bv-profile',
  'about:blank',
], { stdio: 'ignore' });

const fail = m => { console.error('FAIL:', m); chrome.kill('SIGKILL'); srv.kill('SIGKILL'); process.exit(1); };
const ok = m => { console.log('PASS:', m); chrome.kill('SIGKILL'); srv.kill('SIGKILL'); process.exit(0); };

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

  await send('Page.enable');
  await send('Runtime.enable');
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

  const boot = await evalJs(`(() => {
    const app = window.__app?.();
    if (!app) return { error: '__app not exposed' };
    if (!app.state.vehicle) return { error: 'vehicle not loaded' };
    if (!app.state.world) return { error: 'world not loaded' };
    return { vehicle: app.state.vehicle.id, world: app.state.world.name, protos: app.state.world.vehiclePrototypes.length };
  })()`);
  if (boot.error) fail('boot: ' + boot.error);
  console.log('PASS: app booted', JSON.stringify(boot));

  // Phase A: normal sensor polarity -> measure mean distance-to-light delta.
  // Phase B: invert both light sensors through the editor inspector (#ins-pol);
  //          assert the edit persisted on the vehicle prototype and the inverted
  //          output = 1 - normalized (exact complement of the normal polarity).
  // Phase C: inverted sensors must flip the distance delta vs phase A.
  // Phase D: motor polarity forward/reverse must flip thrust direction.
  const result = await evalJs(`new Promise(resolve => {
    try {
      const app = window.__app();
      document.getElementById('tab-world').click();
      const sim = app.worldSim;
      if (!sim) return resolve({ error: 'worldSim not initialized' });
      const sun = sim.state.world.elements.find(e => e.type === 'light');
      const dists = () => sim.instances.map(i => Math.hypot(i.body.position.x - sun.position.x, i.body.position.y - sun.position.y));
      const meanDelta = (a, b) => b.map((d, i) => d - a[i]).reduce((s, d) => s + d, 0) / b.length;
      const sLval = () => {
        const inst = sim.instances[0];
        return (inst.lastSamples ?? []).find(s => s.componentId === 'sL')?.value;
      };
      const selectComp = id => [...document.querySelectorAll('#placed-list li')]
        .find(li => li.textContent.startsWith(id + ' '))?.click();

      // ---- phase A: normal polarity, run briefly ----
      const d0 = dists();
      document.getElementById('btn-play').click();
      setTimeout(() => { try {
        const d1 = dists();
        const deltaA = meanDelta(d0, d1);
        const rawS = sLval();
        // pause; invert both light sensors through the editor inspector
        document.getElementById('btn-play').click();
        document.getElementById('tab-editor').click();
        for (const id of ['sL', 'sR']) {
          selectComp(id);
          const sel = document.getElementById('ins-pol');
          if (!sel) return resolve({ error: 'inspector missing polarity control for ' + id });
          sel.value = 'inverted';
          sel.dispatchEvent(new Event('change'));
        }
        // one step refreshes samples; inverted output must equal 1 - normalized
        // (exact complement of the normal polarity under threshold normalization)
        document.getElementById('tab-world').click();
        document.getElementById('btn-step').click();
        const invS = sLval();
        const lightCfg = sim.state.configs.sensors.light;
        const protoV = app.state.world.vehiclePrototypes[0]._vehicle;
        const sensorPol = protoV.components.filter(c => c.type === 'light_sensor').map(c => c.polarity);
        const d2 = dists();
        // ---- phase B: run with inverted sensors (shorter: thrust is ~100x) ----
        document.getElementById('btn-play').click();
        setTimeout(() => { try {
          const d3 = dists();
          const deltaB = meanDelta(d2, d3);
          const finite = [...d0, ...d1, ...d2, ...d3].every(d => Number.isFinite(d));
          // ---- phase D: motor polarity (UI + runtime) ----
          document.getElementById('btn-play').click(); // pause
          document.getElementById('tab-editor').click();
          selectComp('wL');
          const msel = document.getElementById('ins-pol');
          if (!msel) return resolve({ error: 'inspector missing motor polarity control' });
          msel.value = 'reverse';
          msel.dispatchEvent(new Event('change'));
          const live = app.state.world.vehiclePrototypes[0]._vehicle; // hook clones on every refresh
          const motorPol = live.components.find(c => c.id === 'wL').polarity;
          document.getElementById('tab-world').click();
          // Measure the applied actuation force directly (step() does
          // Engine.update THEN applyForce, so after one step body.force holds
          // the polarity-scaled thrust). Force projection on heading flips sign
          // with motor polarity, independent of integration lag / collisions.
          const probe = dir => {
            for (const c of live.components) if (c.type === 'powered_wheel') c.polarity = dir;
            document.getElementById('btn-step').click();
            const b = sim.instances[0].body;
            const h = { x: Math.cos(b.angle), y: Math.sin(b.angle) };
            return b.force.x * h.x + b.force.y * h.y; // signed thrust along heading
          };
          const pF = probe('forward');
          const pR = probe('reverse');
          resolve({
            count: sim.instances.length, finite,
            deltaA: Math.round(deltaA), deltaB: Math.round(deltaB),
            rawS, invS, T: lightCfg.detectionThreshold, K: lightCfg.fullScaleRatio, sensorPol, motorPol, pF, pR,
          });
        } catch (e) { resolve({ error: 'innerB: ' + String(e.stack || e).slice(0, 400) }); }
        }, 3000);
      } catch (e) { resolve({ error: 'innerA: ' + String(e.stack || e).slice(0, 400) }); }
      }, 4500);
    } catch (e) { resolve({ error: e.message + ' | ' + e.stack }); }
  })`);

  if (result.error) fail('sim: ' + result.error);
  if (!result.finite) fail('non-finite positions: ' + JSON.stringify(result));
  if (!result.count) fail('no instances');
  if (JSON.stringify(result.sensorPol) !== JSON.stringify(['inverted', 'inverted'])) {
    fail('sensor polarity edits were not persisted: ' + JSON.stringify(result.sensorPol));
  }
  if (!Number.isFinite(result.rawS) || !Number.isFinite(result.invS)) {
    fail('sensor sample values non-finite: ' + JSON.stringify(result));
  }
  // Under threshold normalization, inverted is the exact complement of normal.
  if (Math.abs(result.invS + result.rawS - 1) > 0.05) {
    fail(`inverted sensor not complement of normal: norm=${result.rawS} inv=${result.invS}`);
  }
  // inverted sensors are active in the dark: the car must move far more than
  // with normal polarity (which is barely driven at this light level)
  if (Math.abs(result.deltaB) < 50 || Math.abs(result.deltaB) < 5 * Math.abs(result.deltaA)) {
    fail(`sensor polarity did not change behavior enough: deltaA=${result.deltaA} deltaB=${result.deltaB}`);
  }
  if (result.motorPol !== 'reverse') fail('motor polarity edit was not persisted: ' + result.motorPol);
  if (!Number.isFinite(result.pF) || !Number.isFinite(result.pR)) fail('motor probe non-finite: ' + JSON.stringify(result));
  if (Math.abs(result.pF) < 1e-6 || Math.abs(result.pR) < 1e-6) {
    fail(`motor probe too small to compare (no sensor drive?): pF=${result.pF} pR=${result.pR}`);
  }
  if (Math.sign(result.pF) === Math.sign(result.pR)) {
    fail(`motor polarity did not invert thrust: forward=${result.pF} reverse=${result.pR}`);
  }

  // --- PATHS: toggle on; trail records finite points while stepping; capped at
  //     PATH_CAP (verified by prefilling just under the limit); Reset clears it.
  const paths = await evalJs(`
    (() => {
      const { worldSim: sim } = window.__app();
      const btn = document.getElementById('btn-paths');
      btn.click();
      const labelOn = btn.textContent;
      const inst = sim.instances[0];
      inst.path = [];                                  // start fresh
      for (let i = 0; i < 4; i++) document.getElementById('btn-step').click();
      const recorded = inst.path.length;
      const finite = inst.path.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      inst.path = Array.from({ length: 1999 }, () => ({ x: 0, y: 0 })); // just under cap
      document.getElementById('btn-step').click();     // -> 2000
      document.getElementById('btn-step').click();     // -> 2001, capped to 2000
      const capped = inst.path.length;
      sim.reset();
      const clearedAfterReset = inst.path.length === 0;
      btn.click();
      const labelOff = btn.textContent;
      return { labelOn, recorded, finite, capped, clearedAfterReset, labelOff };
    })()
  `);
  if (!/Paths: on/.test(paths.labelOn)) fail('paths: toggle did not turn on: ' + paths.labelOn);
  if (paths.recorded < 2 || !paths.finite) fail('paths: trail did not record finite points while stepping: ' + JSON.stringify(paths));
  if (paths.capped !== 2000) fail('paths: cap not enforced (expected 2000, got ' + paths.capped + ')');
  if (!paths.clearedAfterReset) fail('paths: Reset did not clear the trail');
  if (!/Paths: off/.test(paths.labelOff)) fail('paths: toggle did not turn off: ' + paths.labelOff);

  ok(`simulation + sensor/motor polarity: ${result.count} instances, dΔ ${result.deltaA} -> ${result.deltaB}, sL raw=${result.rawS.toFixed(3)} inv=${result.invS.toFixed(3)}, thrust F=${result.pF.toExponential(2)} R=${result.pR.toExponential(2)}`);
} catch (e) {
  fail(e.stack ?? String(e));
}
