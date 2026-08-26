// World sidebar tabs (Sandbox / Co-Op) + mode-transition overlay — E2E.
// The World view's left pane is split into two modes so the user only sees the controls for the
// mode they are in. This drives the real DOM: default = Sandbox visible; switching to Co-Op swaps
// the panes; Host shows "Joining world…" then the co-op world with the Sandbox tab disabled (and
// the disabled tab can't be reselected); Disconnect shows "Leaving world…" then restores the home
// single-player world and re-enables the Sandbox tab.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import Matter from 'matter-js';
import { createCoopGateway } from '../../src/net/gateway.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9245;
const WEB = 8925;
const GW_PORT = 8975;

const freePort = spawn('sh', ['-c', `lsof -ti:${WEB} | xargs kill 2>/dev/null; true`], { stdio: 'ignore' });
await new Promise(r => freePort.on('exit', r));
const srv = spawn('sh', ['-c', `python3 -m http.server ${WEB} --directory public > /tmp/bv-srv-${WEB}.log 2>&1`], { stdio: 'ignore' });
await sleep(700);

const freeChrome = spawn('sh', ['-c', "pkill -f 'user-data-dir=/tmp/bv-profile-tabs' 2>/dev/null; rm -rf /tmp/bv-profile-tabs; true"], { stdio: 'ignore' });
await new Promise(r => freeChrome.on('exit', r));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/bv-profile-tabs', 'about:blank',
], { stdio: 'ignore' });

const configs = { app: { defaults: { thrustScale: 2 } }, actuators: {}, sensors: {}, components: { components: [] } };
const gw = createCoopGateway({ Matter, configs, port: GW_PORT, host: '127.0.0.1' });
await gw.start();

const fail = m => { console.error('FAIL:', m); try { chrome.kill('SIGKILL'); srv.kill('SIGKILL'); } catch {} gw.close().catch(() => {}); process.exit(1); };
const ok = m => { console.log('PASS:', m); try { chrome.kill('SIGKILL'); srv.kill('SIGKILL'); } catch {} gw.close().catch(() => {}); process.exit(0); };

try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
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
  const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise(r => ws.onopen = r);
  const evalJs = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');

  for (let attempt = 0; attempt < 3; attempt++) {
    await send('Page.navigate', { url: `http://localhost:${WEB}/index.html` });
    let booted = false;
    for (let i = 0; i < 30; i++) { if (await evalJs('document.readyState === "complete" && typeof window.__app === "function"')) { booted = true; break; } await sleep(400); }
    if (booted) break;
    if (attempt < 2) { console.log('RENAV: renderer stalled, re-navigating (' + (attempt + 1) + '/3)'); }
  }
  const pre = await evalJs(`document.querySelector('pre')?.textContent || ''`);
  if (pre) fail('app did not boot: ' + pre.slice(0, 200));

  // Drive the whole scenario in-page so live element state is observed.
  let out;
  try {
    out = JSON.parse(await evalJs(`(async () => {
      const $ = id => document.getElementById(id);
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const poll = async (fn, tries = 80) => { for (let i = 0; i < tries; i++) { let v; try { v = fn(); } catch {} if (v) return v; await sleep(100); } throw new Error('poll timeout'); };
      const rec = {};
      $('tab-world').click(); // switch to the World view
      rec.default = { sandboxActive: $('mode-sandbox').classList.contains('active'), coopPaneHidden: $('side-pane-coop').hidden,
        sandboxPaneShown: !$('side-pane-sandbox').hidden, sandboxEnabled: !$('mode-sandbox').disabled };
      // Co-Op tab replaces the Sandbox items.
      $('mode-coop').click();
      rec.coopTab = { coopActive: $('mode-coop').classList.contains('active'), sandboxPaneHidden: $('side-pane-sandbox').hidden,
        coopPaneShown: !$('side-pane-coop').hidden };
      // Host: the world clears to "Joining world…" then the shared world appears; Sandbox is disabled.
      $('coop-gw-url').value = 'ws://127.0.0.1:${GW_PORT}'; $('coop-gw-name').value = 'tabchk';
      $('coop-host').click();
      await sleep(60); // the overlay is up before the socket round-trip settles
      rec.joiningOverlay = { shown: !$('world-transition').hidden, msg: $('world-transition-msg').textContent };
      await poll(() => !$('coop-gw-code').hidden ? true : null); // welcome received
      rec.connected = { sandboxDisabled: $('mode-sandbox').disabled, coopPaneShown: !$('side-pane-coop').hidden,
        sandboxPaneHidden: $('side-pane-sandbox').hidden, disconnectShown: !$('coop-disconnect').hidden };
      await poll(() => $('world-transition').hidden ? true : null); // overlay lifts after its min time
      rec.overlayLifted = $('world-transition').hidden;
      // A disabled Sandbox tab must not be reselectable.
      $('mode-sandbox').click();
      rec.disabledNoSwitch = { sandboxPaneStillHidden: $('side-pane-sandbox').hidden, coopPaneStillShown: !$('side-pane-coop').hidden };
      // Disconnect: "Leaving world…" then the home world is restored and Sandbox re-enabled.
      $('coop-disconnect').click();
      await sleep(60);
      rec.leavingOverlay = { shown: !$('world-transition').hidden, msg: $('world-transition-msg').textContent };
      await poll(() => !$('coop-gw-row').hidden ? true : null); // layout back to Host/Join
      rec.left = { sandboxEnabled: !$('mode-sandbox').disabled, sandboxPaneShown: !$('side-pane-sandbox').hidden,
        coopPaneHidden: $('side-pane-coop').hidden };
      await poll(() => $('world-transition').hidden ? true : null);
      rec.overlayLiftedAgain = $('world-transition').hidden;
      return JSON.stringify(rec);
    })()`));
  } catch (e) { fail('scenario error: ' + (e?.message ?? e)); }

  if (logs.some(l => l.startsWith('EXC'))) fail('page threw:\n' + logs.filter(l => l.startsWith('EXC')).join('\n'));

  const d = out.default, c = out.coopTab;
  const checks = [
    ['default: Sandbox active, its pane shown, Co-Op pane hidden', d.sandboxActive && d.sandboxPaneShown && d.coopPaneHidden && d.sandboxEnabled],
    ['Co-Op tab swaps panes (Sandbox hidden, Co-Op shown)', c.coopActive && c.sandboxPaneHidden && c.coopPaneShown],
    ['Host shows a "Joining world…" overlay', out.joiningOverlay.shown && /Joining world/i.test(out.joiningOverlay.msg)],
    ['connected: Sandbox disabled + co-op world shown (Disconnect visible)', out.connected.sandboxDisabled && out.connected.coopPaneShown && out.connected.sandboxPaneHidden && out.connected.disconnectShown],
    ['overlay lifts once the shared world is live', out.overlayLifted === true],
    ['disabled Sandbox tab cannot be reselected', out.disabledNoSwitch.sandboxPaneStillHidden && out.disabledNoSwitch.coopPaneStillShown],
    ['Disconnect shows a "Leaving world…" overlay', out.leavingOverlay.shown && /Leaving world/i.test(out.leavingOverlay.msg)],
    ['left: home world restored + Sandbox re-enabled', out.left.sandboxEnabled && out.left.sandboxPaneShown && out.left.coopPaneHidden],
    ['overlay lifts again on the way home', out.overlayLiftedAgain === true],
  ];
  const bad = checks.filter(([, pass]) => !pass);
  if (bad.length) fail('tab/overlay mismatch: ' + JSON.stringify({ bad: bad.map(([n]) => n), out }));

  ok(`world tabs: default sandbox · tab swaps panes · host→"Joining world…"+co-op world+Sandbox disabled · disconnect→"Leaving world…"+home+Sandbox re-enabled`);
} catch (err) {
  fail(err?.stack ?? String(err));
}
