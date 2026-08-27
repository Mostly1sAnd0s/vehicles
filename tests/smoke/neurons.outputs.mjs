// Headless smoke test for P4 UI features in the Vehicle Editor:
//   A) a sensor's inspector exposes one Out slot + an "Add Output" button;
//      clicking it grows outputs to [out, out1] and renders a second Out slot.
//   B) a Neuron's inspector defaults to the "bell" response (shape selector +
//      peak slider), and switching to "custom" reveals the interactive spline
//      editor (an <svg> with >=2 draggable points).
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9226;
const WEB = 8904; // its own port: proto.crud also claimed 8903, and running back-to-back raced its teardown

const freePort = spawn('sh', ['-c', `lsof -ti:${WEB} | xargs kill 2>/dev/null; true`], { stdio: 'ignore' });
await new Promise(r => freePort.on('exit', r));
const srv = spawn('sh', ['-c', `python3 -m http.server ${WEB} --directory public > /tmp/bv-srv-${WEB}.log 2>&1`], { stdio: 'ignore' });
await sleep(700);

// Fresh profile each run: a reused one can serve stale JS modules from its HTTP cache, which would
// test last run's app (or a mix of old index.html + new modules) instead of the current source.
const freeChrome = spawn('sh', ['-c', "pkill -f 'user-data-dir=/tmp/bv-profile-p4' 2>/dev/null; rm -rf /tmp/bv-profile-p4; true"], { stdio: 'ignore' });
await new Promise(r => freeChrome.on('exit', r));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/bv-profile-p4', 'about:blank'], { stdio: 'ignore' });

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
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? {}); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise(r => ws.onopen = r);
  const evalJs = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval error');
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  // Boot, with the re-navigation retry the other probes learned to need: headless Chrome here
  // intermittently stalls module loading for tens of seconds after first paint (server logs show
  // everything served immediately), so a long wait PLUS a retry is what absorbs it.
  let booted = false;
  for (let attempt = 0; attempt < 3 && !booted; attempt++) {
    await send('Page.navigate', { url: `http://localhost:${WEB}/index.html` });
    for (let i = 0; i < 45; i++) {
      if ((await evalJs('typeof window.__app').catch(() => '')) === 'function') { booted = true; break; }
      await sleep(500);
    }
    if (!booted && attempt < 2) console.log('RENAV: renderer stalled, re-navigating (' + (attempt + 1) + '/2)');
  }
  if (!booted) {
    const diag = await evalJs(`JSON.stringify({ready:document.readyState, app:typeof window.__app,
      pre:document.querySelector('pre')?.textContent?.slice(0,300) ?? null})`).catch(e => 'diag failed ' + e);
    fail('editor app did not boot: ' + diag);
  }

  // ---- PART A: sensor "Add Output" grows taps + renders a second Out slot ----
  const a = await evalJs(`(async () => {
    const app = window.__app(); const v = app.state.vehicle;
    const sL = v.components.find(c => c.id === 'sL');
    if (!sL) return { error: 'default vehicle has no sL sensor' };
    const ed = app.editor;
    ed.selectedComp = 'sL'; ed.refresh();
    const out0 = document.querySelectorAll('#inspector select[id^="conn-out-"]').length;
    const hasAdd0 = !!document.querySelector('#inspector #ins-add-out');
    document.querySelector('#inspector #ins-add-out')?.click();
    ed.refresh();
    const out1 = document.querySelectorAll('#inspector select[id^="conn-out-"]').length;
    return { outputs: sL.outputs ?? null, out0, out1, hasAdd0 };
  })()`);
  if (a.error) fail('A: ' + a.error);
  if (!a.hasAdd0) fail('A: sensor inspector must show an "Add Output" button: ' + JSON.stringify(a));
  if (a.out0 !== 1) fail('A: a fresh sensor should expose exactly one Out slot, got ' + a.out0 + ' ' + JSON.stringify(a));
  if (JSON.stringify(a.outputs) !== JSON.stringify(['out', 'out1'])) fail('A: clicking Add Output should set outputs=[out,out1], got ' + JSON.stringify(a.outputs));
  if (a.out1 !== 2) fail('A: after Add Output the inspector should render two Out slots, got ' + a.out1);

  // ---- PART B: Neuron inspector — bell default + custom spline editor ----
  const b = await evalJs(`(async () => {
    const app = window.__app(); const v = app.state.vehicle;
    if (!v.logicGates) v.logicGates = [];
    if (!v.logicGates.find(g => g.id === 'n1')) v.logicGates.push({ id: 'n1', type: 'neuron', pos: { x: 0, y: 60 } });
    const ed = app.editor; ed.selectedComp = 'n1'; ed.refresh();
    const shapeSel = document.querySelector('#inspector #ins-nshape');
    const shapeVal = shapeSel ? shapeSel.value : null;
    const hasThresh = !!document.querySelector('#inspector #ins-nthresh');
    if (shapeSel) { shapeSel.value = 'custom'; shapeSel.dispatchEvent(new Event('change')); ed.refresh(); }
    const spline = document.querySelector('#inspector #neuron-spline svg');
    const dots = document.querySelectorAll('#inspector #neuron-spline circle').length;
    // editing a point should mutate the neuron's spline (proof it is interactive)
    let mutated = false;
    const c0 = document.querySelector('#inspector #neuron-spline circle');
    if (c0) {
      const r = c0.getBoundingClientRect();
      c0.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left - 40, clientY: r.top - 30, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      const n1 = app.state.vehicle.logicGates.find(g => g.id === 'n1');
      mutated = !!(n1.props && Array.isArray(n1.props.spline) && n1.props.spline.length >= 2);
    }
    return { shapeVal, hasThresh, hasSpline: !!spline, dots, mutated };
  })()`);
  if (!b.shapeVal) fail('B: neuron inspector must show a Response shape selector: ' + JSON.stringify(b));
  if (b.shapeVal !== 'bell') fail('B: a new neuron should default to the "bell" response, got ' + b.shapeVal);
  if (!b.hasThresh) fail('B: bell/triangle neuron inspector should show a Peak intensity slider: ' + JSON.stringify(b));
  if (!b.hasSpline) fail('B: switching to "custom" must render the interactive spline editor (an <svg>): ' + JSON.stringify(b));
  if (b.dots < 2) fail('B: spline editor should show at least two draggable points, got ' + b.dots);
  if (!b.mutated) fail('B: dragging a spline point must write the neuron props.spline (editor is not interactive): ' + JSON.stringify(b));

  // ---- PART C: symmetric multi-output anchors + rotation + spline fixes ----
  const c = await evalJs(`(async () => {
    try {
      const app = window.__app(); const v = app.state.vehicle; const ed = app.editor;
      if (!v.logicGates) v.logicGates = [];
      let n = v.logicGates.find(g => g.id === 'n1');
      if (!n) { n = { id: 'n1', type: 'neuron', pos: { x: 0, y: 60 } }; v.logicGates.push(n); }
      // C1: two output taps must anchor symmetrically about the node centre (both on the right edge)
      n.outputs = ['out', 'out1'];
      const aOut = ed.gateAnchor(n, 'out');
      const aOut1 = ed.gateAnchor(n, 'out1');
      const dy0 = aOut.y - n.pos.y, dy1 = aOut1.y - n.pos.y;
      const symmetricTaps = aOut.x === aOut1.x && aOut.x > n.pos.x && Math.abs(dy0) === Math.abs(dy1) && dy0 < 0 && dy1 > 0;
      // C2: rotating a gate 180 moves its output stub from the right side to the left
      let gr = v.logicGates.find(g => g.id === 'gr');
      if (!gr) { gr = { id: 'gr', type: 'gate_and', pos: { x: 0, y: -60 } }; v.logicGates.push(gr); }
      gr.rot = 0; const outR0 = ed.gateAnchor(gr, 'out');
      gr.rot = 180; const outR180 = ed.gateAnchor(gr, 'out');
      const rotWorks = outR0.x > gr.pos.x && outR180.x < gr.pos.x;
      ed.selectedComp = 'gr'; ed.refresh();
      const hasRotSel = !!document.querySelector('#inspector #ins-rot');
      // C3: custom spline — 3 gridlines, input 0 LEFT of input 1 (not mirrored), endpoints x-locked
      n.props = n.props || {}; n.shape = 'custom'; delete n.props.spline;
      ed.selectedComp = 'n1'; ed.refresh();
      const addBtn = document.querySelector('#inspector #ins-naddnode'); if (addBtn) addBtn.click();
      ed.refresh();
      const svg = document.querySelector('#inspector #neuron-spline svg');
      const lines = svg ? [...svg.querySelectorAll('line')] : [];
      const gridlines = lines.filter(l => l.getAttribute('y1') === l.getAttribute('y2')).length;
      const circles = [...document.querySelectorAll('#inspector #neuron-spline circle')];
      const leftCx = circles[0] ? +circles[0].getAttribute('cx') : NaN;
      const rightCx = circles.length ? +circles[circles.length - 1].getAttribute('cx') : NaN;
      const notMirrored = leftCx < rightCx;
      let midBefore = null, midAfter = null;
      if (circles.length >= 3) {
        midBefore = n.props.spline[1].x;
        const mr = circles[1].getBoundingClientRect();
        circles[1].dispatchEvent(new PointerEvent('pointerdown', { clientX: mr.left + 5, clientY: mr.top + 5, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: mr.left + 45, clientY: mr.top + 5, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        midAfter = n.props.spline[1].x;
      }
      let epBefore = null, epAfter = null;
      if (circles.length >= 2) {
        epBefore = n.props.spline[0].x;
        const fr = circles[0].getBoundingClientRect();
        circles[0].dispatchEvent(new PointerEvent('pointerdown', { clientX: fr.left + 5, clientY: fr.top + 5, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: fr.left + 65, clientY: fr.top - 15, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        epAfter = n.props.spline[0].x;
      }
      // C4: the Delete key must remove a selected gate and a selected neuron
      ed.selectedComp = 'gr'; ed.refresh();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
      const delGate = !v.logicGates.some(g => g.id === 'gr');
      ed.selectedComp = 'n1'; ed.refresh();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
      const delNeuron = !v.logicGates.some(g => g.id === 'n1');
      // C5: with no real selection (a click on empty space leaves selectedWire =
      // -1), Delete must do NOTHING; a genuinely selected wire deletes exactly
      // once, and the following press must not cascade to another wire.
      const wBefore = v.wires.length;
      ed.selectedComp = null; ed.selectedWire = -1;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
      const noOp = v.wires.length === wBefore;
      let oneShot = true, noCascade = true;
      if (v.wires.length) {
        ed.selectedWire = 0;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
        oneShot = v.wires.length === wBefore - 1;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })); // selection was cleared by the first delete
        noCascade = v.wires.length === wBefore - 1;
      }
      return { symmetricTaps, dy0, dy1, rotWorks, hasRotSel, gridlines, notMirrored, leftCx, rightCx, midBefore, midAfter, epBefore, epAfter, delGate, delNeuron, noOp, oneShot, noCascade };
    } catch (e) { return { error: e.stack }; }
  })()`);
  if (c.error) fail('C: ' + c.error);
  if (!c.symmetricTaps) fail('C1: the two output taps on one node must anchor symmetrically about its centre: ' + JSON.stringify(c));
  if (!c.rotWorks) fail('C2: rotating a gate 180 must move its output stub from the right to the left side: ' + JSON.stringify(c));
  if (!c.hasRotSel) fail('C2: the inspector must show an Orientation selector for logic gates/neurons');
  if (c.gridlines !== 3) fail('C3: the custom spline editor must show three horizontal reference lines (25/50/75%), got ' + c.gridlines);
  if (!c.notMirrored) fail('C3: input 0 must plot LEFT of input 1 (X axis was mirrored): leftCx=' + c.leftCx + ' rightCx=' + c.rightCx);
  if (!(c.midAfter > c.midBefore)) fail('C3: dragging a middle spline point right must increase its x: before=' + c.midBefore + ' after=' + c.midAfter);
  if (Math.abs(c.epAfter - c.epBefore) > 1e-6) fail('C3: an endpoint must not move along the X axis when dragged: before=' + c.epBefore + ' after=' + c.epAfter);
  if (!c.delGate) fail('C4: pressing Delete did not remove a selected gate');
  if (!c.delNeuron) fail('C4: pressing Delete did not remove a selected neuron');
  if (!c.noOp) fail('C5: with no real selection, Delete must not delete any wire');
  if (!c.oneShot) fail('C5: a selected wire should delete exactly once');
  if (!c.noCascade) fail('C5: after deleting a selected wire, the next Delete must not cascade to another wire');

  ok('P4 UI: sensor "Add Output" grows taps [out,out1] + renders a 2nd Out slot; Neuron inspector (Peak slider, bell/triangle/custom) with a non-mirrored, gridlined, x-locked spline editor; multi-output wire anchors are symmetric; gates/neurons rotate/mirror via an Orientation control; Delete key removes a selected gate or neuron');
} catch (e) { fail(e.stack ?? String(e)); }
