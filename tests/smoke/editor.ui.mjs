// Headless smoke test for the Vehicle Editor: places a component on a snap
// point via canvas click, adds a wire through the form, and checks that
// validation and lists update.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9225;
const WEB = 8901;

// free the web port in case a previous run left a server behind
const freePort = spawn('sh', ['-c', `lsof -ti:${WEB} | xargs kill 2>/dev/null; true`], { stdio: 'ignore' });
await new Promise(r => freePort.on('exit', r));

const srv = spawn('sh', ['-c', `python3 -m http.server ${WEB} --directory public > /tmp/bv-srv-${WEB}.log 2>&1`], { stdio: 'ignore' });
await sleep(700); // let the server bind before Chrome navigates

// kill a leftover headless Chrome from a previous run (profile lock breaks boot)
const freeChrome = spawn('sh', ['-c', "pkill -f 'user-data-dir=/tmp/bv-profile4' 2>/dev/null; true"], { stdio: 'ignore' });
await new Promise(r => freeChrome.on('exit', r));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/bv-profile4',
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
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? {}); pending.delete(m.id); }
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
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(1500); // let the renderer settle before navigating (headless can stall module loads otherwise)
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
  const bootInfo = await evalJs(`JSON.stringify({ ready: document.readyState, title: document.title, app: typeof window.__app, url: location.href, pre: document.querySelector('pre')?.textContent?.slice(0,300) ?? null })`).catch(e => 'probe failed: ' + e.message);
  console.log('BOOT:', bootInfo);

  const result = await evalJs(`new Promise(res => setTimeout(() => {
    try {
      const app = window.__app();
      const v = app.state.vehicle;
      const canvas = document.getElementById('editor-canvas');
      const rect = canvas.getBoundingClientRect();

      // click the "Powered Wheel" palette button
      const btns = [...document.querySelectorAll('#palette button')];
      const wheelBtn = btns.find(b => b.textContent.includes('Powered Wheel'));
      wheelBtn.click();

      // canvas point for a top-right interior snap (x=40+? use top edge midpoint: local (0,-20))
      const scale = Math.min(rect.width / 320, rect.height / 240);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const snapLocalX = -40 + 80 / 3; // first interior point on top edge
      const pt = { x: cx + snapLocalX * scale, y: cy + (-20) * scale };
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: pt.x, clientY: pt.y, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('click', { clientX: pt.x, clientY: pt.y, bubbles: true }));

      const placedAfter = document.querySelectorAll('#placed-list li').length;
      const newComp = v.components[v.components.length - 1];
      // offset = wheel size 16 + 3, along outward normal (0,-1) -> y = -20 - 19
      const localOk = Math.abs(newComp.local.x - snapLocalX) < 0.5 && Math.abs(newComp.local.y - (-39)) < 0.5;

      // wire: pick first sensor -> this new wheel
      const fromSel = document.getElementById('wire-from');
      const toSel = document.getElementById('wire-to');
      fromSel.value = 'sL';
      toSel.value = newComp.id;
      document.getElementById('add-wire').click();
      const wireOk = v.wires.some(w => w.from.componentId === 'sL' && w.to.componentId === newComp.id);
      const errors = document.getElementById('wiring-errors').textContent;

      // duplicate wire must be rejected by validation
      document.getElementById('add-wire').click();
      const dupReported = document.getElementById('wiring-errors').textContent.includes('duplicate');

      // ---- drag sR to a different snap node: it must snap in place and its wire must follow ----
      const sr = v.components.find(c => c.id === 'sR');
      const before = { ...sr.local };
      const targetSnapLocal = { x: -40 + 80 / 3, y: -20 }; // interior point on top edge
      const toScreen = lp => ({ x: cx + lp.x * scale, y: cy + lp.y * scale });
      const fromS = toScreen(before);
      const toS = toScreen(targetSnapLocal);
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: fromS.x, clientY: fromS.y, bubbles: true }));
      for (let i = 1; i <= 6; i++) {
        canvas.dispatchEvent(new MouseEvent('mousemove', {
          clientX: fromS.x + (toS.x - fromS.x) * i / 6,
          clientY: fromS.y + (toS.y - fromS.y) * i / 6,
          bubbles: true,
        }));
      }
      canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: toS.x, clientY: toS.y, bubbles: true }));
      // sensor size 8 -> offset 11 along outward normal (0,-1): (-13.33, -31)
      const dragOk = Math.abs(sr.local.x - targetSnapLocal.x) < 0.5 && Math.abs(sr.local.y - -31) < 0.5;
      const aimOk = Math.abs(sr.aimAngle - -Math.PI / 2) < 1e-6;
      const wireFollows = v.wires.some(w => w.from.componentId === 'sR');

      res({ placedAfter, localOk, wireOk, errors, dupReported, dragOk, aimOk, wireFollows });
    } catch (e) { res({ error: e.stack }); }
  }, 500))`);

  if (result.error) fail(result.error);
  if (result.placedAfter !== 5) fail('expected 5 placed components (4 seeded + 1 new), got ' + result.placedAfter);
  if (!result.localOk) fail('component not placed at snap point: ' + JSON.stringify(result));
  if (!result.wireOk) fail('wire not created');
  if (result.errors !== '') fail('unexpected validation errors on first wire: ' + result.errors);
  if (!result.dupReported) fail('duplicate connection not reported by validator');
  if (!result.dragOk) fail('dragged component did not snap to the target node: ' + JSON.stringify(result));
  if (!result.aimOk) fail('sensor aim not re-aimed along node normal after drag');
  if (!result.wireFollows) fail('wire did not follow its dragged sensor');

  // --- BODY COLOR PICKER: a static 4x4 swatch palette (no native color input)
  //     that closes on click). Clicking a swatch sets the vehicle body color and
  //     marks it active; no popup is lost to the re-render.
  const picker = await evalJs(`
    (() => {
      const app = window.__app();
      const box = document.querySelector('#inspector');
      const swatches = [...box.querySelectorAll('.color-palette .swatch')];
      const hasNative = !!box.querySelector('input[type="color"]');
      const before = app.state.vehicle.body.color;
      const target = swatches.find(s => s.dataset.color !== before);
      const clicked = target.dataset.color;
      target.click();
      const after = app.state.vehicle.body.color;
      const activeNow = box.querySelectorAll('.color-palette .swatch.active').length;
      const activeIsTarget = box.querySelector('.color-palette .swatch[data-color="' + clicked + '"]')?.classList.contains('active');
      return { n: swatches.length, hasNative, before, clicked, after, activeNow, activeIsTarget };
    })()
  `);
  if (picker.n !== 16) fail('color picker: expected a 4x4 palette (16 swatches), got ' + picker.n);
  if (picker.hasNative) fail('color picker: still using the native <input type="color"> (closes on click)');
  if (picker.before === picker.clicked) fail('color picker: test must choose a color different from the current one');
  if (picker.after !== picker.clicked) fail('color picker: clicking a swatch did not set the body color ' + JSON.stringify(picker));
  if (picker.activeNow !== 1 || !picker.activeIsTarget) fail('color picker: exactly the chosen swatch must be marked active ' + JSON.stringify(picker));

  // --- EDITOR CANVAS REFLECTS THE COLOR: the editor's body fill must be the
  //     chosen color too (it used to be a fixed dark navy), matching the world view.
  //     A single center pixel is fragile (a snap dot can sit there), so scan the
  //     horizontal row through the body's vertical center and require the chosen
  //     color to appear as a filled run. Components/snap dots are small and their
  //     colors differ by >4/channel, so only the true body fill matches at tol=4.
  const paint = await evalJs(`
    (async () => {
      const frame = () => new Promise(r => requestAnimationFrame(() => r()));
      await frame(); await frame();
      const cv = document.getElementById('editor-canvas');
      const ctx = cv.getContext('2d');
      const y = (cv.height / 2) | 0;
      const d = ctx.getImageData(0, y, cv.width, 1).data;
      const hexToRgb = h => { let s = h.replace('#', ''); if (s.length === 3) s = [...s].map(c => c + c).join(''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; };
      const [er, eg, eb] = hexToRgb(${JSON.stringify(picker.clicked)});
      const tol = 4, matches = [];
      for (let i = 0; i < cv.width; i++) {
        const o = i * 4;
        if (Math.abs(d[o] - er) <= tol && Math.abs(d[o + 1] - eg) <= tol && Math.abs(d[o + 2] - eb) <= tol) matches.push(i);
      }
      let longest = 0, run = 0, prev = -1;
      for (const x of matches) { run = (x === prev + 1) ? run + 1 : 1; if (run > longest) longest = run; prev = x; }
      return { expect: [er, eg, eb], w: cv.width, h: cv.height, matchCount: matches.length, longestRun: longest };
    })()
  `);
  if (!paint.w || !paint.h) fail('editor canvas not sized yet, cannot sample fill ' + JSON.stringify(paint));
  // The body spans the central band of the canvas; a horizontal run this long is
  // unambiguously the body fill, not a stray dot/edge.
  const needRun = Math.max(8, Math.floor(paint.w * 0.03));
  if (paint.longestRun < needRun) fail('editor body fill does not reflect the chosen color ' + JSON.stringify(paint.expect) + ': longest matching run ' + paint.longestRun + ' < ' + needRun + ' (matches ' + paint.matchCount + ')');

  // --- VEHICLE DETECTION SENSOR IN THE EDITOR: it must appear in the palette
  //     (config-driven), place on a snap point with default FOV(180)/range(300),
  //     and its inspector must expose Aim + Range + FOV (FOV is no longer light-only).
  const vds = await evalJs(`
    (() => {
      const app = window.__app();
      const v = app.state.vehicle;
      const canvas = document.getElementById('editor-canvas');
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(rect.width / 320, rect.height / 240);
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;

      const btns = [...document.querySelectorAll('#palette button')];
      const vdsBtn = btns.find(b => b.textContent.includes('Vehicle Detection Sensor'));
      if (!vdsBtn) return { error: 'no Vehicle Detection Sensor in palette', labels: btns.map(b => b.textContent.trim()) };

      // same proven top-edge snap as the wheel step: local (-40+80/3, -20); normal (0,-1) -> y = -20-11
      const snapLocalX = -40 + 80 / 3;
      const pt = { x: cx + snapLocalX * scale, y: cy + (-20) * scale };

      // Absorb any stale dragConsumed left by the earlier sR-drag phase (a plain
      // click while NOT placing just clears the flag; placeComponent is untouched).
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: pt.x, clientY: pt.y, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('click', { clientX: pt.x, clientY: pt.y, bubbles: true }));

      // enter placing mode, then place on the snap
      vdsBtn.click();
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: pt.x, clientY: pt.y, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('click', { clientX: pt.x, clientY: pt.y, bubbles: true }));

      const comp = v.components[v.components.length - 1];
      const fovDefaultDeg = Math.round(comp.props.fov * 180 / Math.PI); // capture default BEFORE editing
      const box = document.querySelector('#inspector');
      const hasAim = !!box.querySelector('#ins-aim');
      const hasRange = !!box.querySelector('#ins-range');
      const hasFov = !!box.querySelector('#ins-fov');
      const fovInput = box.querySelector('#ins-fov');
      if (fovInput) { fovInput.value = '90'; fovInput.dispatchEvent(new Event('change')); }
      const fovAfterDeg = Math.round(comp.props.fov * 180 / Math.PI);
      return {
        type: comp.type,
        range: comp.props.range,
        fovDefaultDeg,
        hasAim, hasRange, hasFov,
        aimIsNum: typeof comp.aimAngle === 'number',
        localOk: Math.abs(comp.local.x - snapLocalX) < 0.5 && Math.abs(comp.local.y - (-31)) < 0.5,
        fovAfterDeg,
      };
    })()
  `);
  if (vds.error) fail('editor vehicle detection: ' + vds.error + ' ' + JSON.stringify(vds.labels));
  if (vds.type !== 'vehicle_detection_sensor') fail('editor: did not place a vehicle_detection_sensor, got ' + vds.type);
  if (!vds.localOk) fail('editor: detection sensor not placed on the snap point ' + JSON.stringify(vds));
  if (vds.range !== 300) fail('editor: detection sensor default range should be 300, got ' + vds.range);
  if (vds.fovDefaultDeg !== 180) fail('editor: detection sensor default FOV should be 180deg, got ' + vds.fovDefaultDeg);
  if (!vds.hasAim || !vds.hasRange || !vds.hasFov) fail('editor: inspector must show Aim + Range + FOV for the detection sensor ' + JSON.stringify(vds));
  if (vds.aimIsNum !== true) fail('editor: detection sensor should have a numeric aimAngle ' + JSON.stringify(vds));
  if (vds.fovAfterDeg !== 90) fail('editor: editing FOV did not update props.fov, expected 90deg got ' + vds.fovAfterDeg);

  ok('editor: placed at snap point, wired, duplicate detected, drag-snapped sR with wire following; 4x4 body-color picker works + editor canvas shows the color; vehicle-detection sensor placeable with Aim+Range+FOV');
} catch (e) {
  fail(e.stack ?? String(e));
}
