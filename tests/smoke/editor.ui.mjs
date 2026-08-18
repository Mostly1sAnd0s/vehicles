// Headless smoke test for the Vehicle Editor: places a component on a snap
// point via canvas click, adds a wire through the form, and checks that
// validation and lists update.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9225;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/bv-profile4',
  'about:blank',
], { stdio: 'ignore' });

const fail = m => { console.error('FAIL:', m); chrome.kill(); process.exit(1); };
const ok = m => { console.log('PASS:', m); chrome.kill(); process.exit(0); };

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
  await send('Page.navigate', { url: 'http://localhost:8901/index.html' });
  await sleep(2500);

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

      res({ placedAfter, localOk, wireOk, errors, dupReported });
    } catch (e) { res({ error: e.stack }); }
  }, 500))`);

  if (result.error) fail(result.error);
  if (result.placedAfter !== 5) fail('expected 5 placed components (4 seeded + 1 new), got ' + result.placedAfter);
  if (!result.localOk) fail('component not placed at snap point: ' + JSON.stringify(result));
  if (!result.wireOk) fail('wire not created');
  if (result.errors !== '') fail('unexpected validation errors on first wire: ' + result.errors);
  if (!result.dupReported) fail('duplicate connection not reported by validator');
  ok('editor: placed component at snap point, wired sensor->wheel, duplicate detected');
} catch (e) {
  fail(e.stack ?? String(e));
}
