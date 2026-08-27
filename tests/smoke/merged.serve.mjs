// Merged server + invite link — E2E. This is the probe for "one command, one port": it spawns the
// REAL `npm run serve` process (no separate gateway, no python http.server) and asserts that the
// same port serves the SPA, answers /info, and carries the co-op WebSocket. Then it exercises the
// whole LAN hosting story in the browser: Host → code + invite link built from /info (never
// `localhost`) → Copy → a second page opened at the invite URL joins with ZERO clicks.
//
//   node tests/smoke/merged.serve.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9235;          // CDP
const WEB = 8915;           // the ONE port: static files + gateway
const PROFILE = '/tmp/bv-profile-merged';
const BASE = `http://127.0.0.1:${WEB}`;

spawn('sh', ['-c', `lsof -ti:${WEB} | xargs kill 2>/dev/null; true`], { stdio: 'ignore' });
await sleep(300);
spawn('sh', ['-c', `pkill -f 'user-data-dir=${PROFILE}' 2>/dev/null; rm -rf ${PROFILE}; true`], { stdio: 'ignore' });
await sleep(200);

// The merged server, exactly as a user starts it. LAN-open by default, pinned to a port for the run.
const srv = spawn('node', ['scripts/serve.mjs'], {
  cwd: APP, env: { ...process.env, PORT: String(WEB) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d.toString(); });
srv.stderr.on('data', (d) => { srvLog += d.toString(); });
srv.on('exit', (code) => { if (code !== 0 && code !== null) console.error(`serve.mjs exited ${code}\n${srvLog}`); });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, 'about:blank',
], { stdio: 'ignore' });

let _lastStep = 'start';
const step = (m) => { _lastStep = m; console.error(`step: ${m}`); };
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { srv.kill('SIGKILL'); } catch {} };
const fail = (m) => { console.error('FAIL:', m); console.error('--- serve.mjs output ---\n' + srvLog.slice(-1500)); cleanup(); process.exit(1); };
const ok = (m) => { console.log('PASS:', m); cleanup(); process.exit(0); };
setTimeout(() => { console.error(`WATCHDOG: stuck at ${_lastStep}\n${srvLog.slice(-800)}`); cleanup(); process.exit(3); }, 420_000);

// --- the server answers on one port: files, /info, and a WebSocket -----------------------------
step('server up + /info');
let info = null;
for (let i = 0; i < 60 && !info; i++) {
  try { const r = await fetch(BASE + '/info'); if (r.ok) info = await r.json(); } catch { await sleep(250); }
}
if (!info) fail('merged server never answered GET /info\n' + srvLog.slice(-500));
if (info.coop !== true) fail('/info says co-op is off: ' + JSON.stringify(info));
if (info.port !== WEB) fail(`/info port ${info.port} != served port ${WEB}`);
if (!info.host) fail('/info advertised no host address: ' + JSON.stringify(info));
if (!Array.isArray(info.lan)) fail('/info.lan is not a list: ' + JSON.stringify(info));

const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, type: r.headers.get('content-type') ?? '' }; };
const root = await get('/');
if (root.status !== 200 || !/text\/html/.test(root.type)) fail('GET / over the merged server: ' + JSON.stringify(root));
const mod = await get('/src/net/invite.js'); // the public/src symlink, served by the merged server
if (mod.status !== 200) fail('GET /src/net/invite.js: ' + JSON.stringify(mod) + ' — run `npm run build` first');
const sneaky = await get('/../../package.json');
if (sneaky.status === 200) fail('path traversal served a file outside public/');

step('websocket host+join on the SAME port as the SPA');
const wsProbe = await new Promise((resolve, reject) => {
  const a = new WebSocket(`ws://127.0.0.1:${WEB}`);
  const t = setTimeout(() => reject(new Error('ws handshake timed out')), 8000);
  a.onopen = () => a.send(JSON.stringify({ type: 'host', name: 'node-host' }));
  a.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== 'welcome') return;
    const b = new WebSocket(`ws://127.0.0.1:${WEB}`);
    b.onopen = () => b.send(JSON.stringify({ type: 'join', name: 'node-joiner', code: m.code }));
    b.onmessage = (e2) => {
      const m2 = JSON.parse(e2.data);
      if (m2.type !== 'welcome') return;
      clearTimeout(t);
      a.close(); b.close();
      resolve({ code: m.code, hostRole: m.you.role, joinRole: m2.you.role });
    };
    b.onerror = () => { clearTimeout(t); reject(new Error('joiner ws error')); };
  };
  a.onerror = () => { clearTimeout(t); reject(new Error('host ws error on the static port')); };
});
if (wsProbe.hostRole !== 'admin' || wsProbe.joinRole !== 'participant') fail('roles over the shared port: ' + JSON.stringify(wsProbe));
const worldsAfter = (await (await fetch(BASE + '/info')).json()).worlds;
if (!(worldsAfter >= 1)) fail('/info worlds count did not rise with a hosted world: ' + worldsAfter);

// --- the browser half --------------------------------------------------------------------------
step('cdp pages');
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
if (!targets?.find((t) => t.type === 'page')) fail('no CDP page target');

const newPage = async () => {
  let t;
  try { t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); }
  catch { t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`)).json(); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? {}); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 250));
  };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  const ev = async (expression, timeoutMs = 25000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`CDP ev timeout ${timeoutMs}ms`)), timeoutMs).unref()),
    ]);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  return { ev, logs };
};
const boot = async (pg, url) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await pg.ev(`location.href=${JSON.stringify(url)}`).catch(() => {});
    for (let i = 0; i < 60 && (await pg.ev('typeof window.__app').catch(() => null)) !== 'function'; i++) await sleep(250);
    if ((await pg.ev('typeof window.__app').catch(() => null)) === 'function') return;
    console.log(`RENAV: renderer stalled for ${url}, retrying (${attempt + 1}/3)`);
  }
  throw new Error('page never booted: ' + (pg.logs.join(' | ') || 'no console errors'));
};
// Why a poll failed, in the page's own words: the panel's live state is the only useful trace.
const DIAG_JS = `(()=>{ try {
  const p = window.__app().coopPanel, $ = id => document.getElementById(id);
  return 'status=' + $('coop-gw-status').textContent
    + ' | client=' + p.client.status + ' mode=' + p.client.mode + ' code=' + p.client.code
    + ' target=' + (p._target ? p._target.display : '-')
    + ' defaults=' + JSON.stringify(p._inviteDefaults ?? null)
    + ' invite="' + $('coop-invite').value + '" rowHidden=' + $('coop-invite-row').hidden
    + ' advancedOpen=' + $('coop-advanced').open
    + ' rej=' + (window.__rej || []).join(';');
} catch (e) { return 'diag unavailable: ' + e; } })()`;
const poll = async (pg, fnBody, ms = 12000, label = '') => {
  const v = await pg.ev(`(async()=>{const $=id=>document.getElementById(id);const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<${Math.ceil(ms / 100)};i++){let v;try{v=(()=>{ ${fnBody} })();}catch(e){throw e;}if(v)return v;await sleep(100);}return null;})()`);
  if (v === null) throw new Error(`timeout: ${label} — ${await pg.ev(DIAG_JS).catch((e) => 'diag failed: ' + e)}`);
  return v;
};

const H = await newPage();
step('host page boots (no invite hash)');
await boot(H, `http://localhost:${WEB}/index.html`);
// Surface anything the page swallows (CoopClient._emit catches subscriber throws, async ones become
// unhandled rejections) so a failure names the broken step instead of just timing out.
await H.ev(`window.__rej=[];addEventListener('unhandledrejection',e=>window.__rej.push(String(e.reason?.message??e.reason)));1`);

step('advanced is collapsed and the address is automatic');
const pre = await H.ev(`(()=>{const $=id=>document.getElementById(id);return JSON.stringify({
  noGatewayField: !document.getElementById('coop-gw-url'),
  advancedClosed: !$('coop-advanced').open,
  addrEmpty: $('coop-host-addr').value === '',
  placeholder: $('coop-host-addr').placeholder,
  hint: $('coop-host-addr-hint').textContent,
  inviteHidden: getComputedStyle($('coop-invite-row')).display === 'none',
});})()`).then(JSON.parse);
if (!pre.noGatewayField) fail('the old Gateway field is still in the page');
if (!pre.advancedClosed) fail('Advanced should start collapsed — the address is automatic now');
if (!pre.addrEmpty) fail('host address field should be empty (automatic), got: ' + pre.addrEmpty);
if (pre.placeholder !== `localhost:${WEB}`) fail(`automatic placeholder should be the serving origin, got "${pre.placeholder}"`);
if (!/automatic/i.test(pre.hint)) fail('Advanced should explain the automatic address, got: ' + pre.hint);
if (!pre.inviteHidden) fail('invite row must stay hidden before you host/join');

step('host → code + invite link (from /info, not localhost)');
await H.ev(`(async()=>{const $=id=>document.getElementById(id);$('tab-world').click();$('mode-coop').click();$('coop-gw-name').value='lanhost';$('coop-host').click();})()`);
const hostCode = await poll(H, `return !$('coop-gw-code').hidden ? $('coop-gw-code').textContent : null;`, 15000, 'host code');
if (!/^[A-Z0-9]{6}$/.test(hostCode)) fail('host did not reveal a 6-char code: ' + hostCode);
// Note `display !== "none"`, not `!display === "none"`: unary ! binds tighter than ===.
const invite = await poll(H, `const v=$('coop-invite').value; return (getComputedStyle($('coop-invite-row')).display!=="none" && v.includes("#join=")) ? v : null;`, 10000, 'invite link');
const wantInvite = `http://${info.host}:${WEB}/#join=${hostCode}`;
if (invite !== wantInvite) fail(`invite should be ${wantInvite} (host address from /info + the world code), got ${invite}`);
if (/localhost|127\.0\.0\.1/.test(invite)) fail('an invite link must never carry a loopback host: ' + invite);
if (await H.ev(`document.getElementById('coop-advanced').open`)) fail('hosting should not have forced Advanced open');

step('copy button does something useful');
await H.ev(`document.getElementById('coop-copy').click()`);
await sleep(400);
const copy = await H.ev(`JSON.stringify({label:document.getElementById('coop-copy').textContent, status:document.getElementById('coop-gw-status').textContent})`).then(JSON.parse);
// http is not a secure context, so a browser may refuse the clipboard: the fallback (select + ⌘C
// instruction) is a legitimate outcome, a thrown exception is not.
if (copy.label !== 'Copied' && !/⌘C/.test(copy.status)) fail('Copy did nothing visible: ' + JSON.stringify(copy));

step('a Node joiner reaches the same port by code');
const joined = await new Promise((resolve, reject) => {
  const b = new WebSocket(`ws://127.0.0.1:${WEB}`);
  const t = setTimeout(() => reject(new Error('join timed out')), 8000);
  b.onopen = () => b.send(JSON.stringify({ type: 'join', name: 'node-observer', code: hostCode }));
  b.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'welcome') { clearTimeout(t); b.close(); resolve(m); } };
  b.onerror = () => { clearTimeout(t); reject(new Error('join error')); };
});
if (joined.you?.role !== 'participant') fail('node joiner role: ' + JSON.stringify(joined.you));

step('invite link joins a second page with ZERO clicks');
const D = await newPage();
await boot(D, invite); // the exact link a host would send
const deep = await poll(D, `return (!$('coop-gw-code').hidden && $('coop-gw-code').textContent==='${hostCode}') ? JSON.stringify({
    code: $('coop-gw-code').textContent,
    status: $('coop-gw-status').textContent,
    worldTab: document.getElementById('panel-world').classList.contains('active'),
    addr: $('coop-host-addr').value,
    hash: location.hash,
  }) : null;`, 20000, 'deep-linked join').then(JSON.parse);
if (!/you joined|in world/i.test(deep.status)) fail('deep link did not connect (status: ' + deep.status + ')');
if (!deep.worldTab) fail('deep link should bring up the World view, not the editor');
if (deep.addr !== '') fail('a deep link must not honour a stale Advanced override, field held: ' + deep.addr);
if (!/#join=/i.test(deep.hash)) fail('the invite hash should survive a successful auto-join (a refresh rejoins), got: ' + deep.hash);
await poll(H, `return window.__app().coopPanel.client.clients.length === 2 ? 'two' : null;`, 12000, 'host sees 2 clients');

step('disconnect means leave for good (hash cleared)');
await D.ev(`document.getElementById('coop-disconnect').click()`);
await poll(D, `return !$('coop-gw-row').hidden && location.hash === '' ? 'left' : null;`, 10000, 'left + hash cleared');
await poll(H, `return window.__app().coopPanel.client.clients.length === 1 ? 'one' : null;`, 12000, 'host back to 1 client');

if (H.logs.filter((l) => l.startsWith('EXC')).length || D.logs.filter((l) => l.startsWith('EXC')).length) {
  fail('page threw:\n' + [...H.logs, ...D.logs].filter((l) => l.startsWith('EXC')).join('\n'));
}

ok(`merged server: one port (${WEB}) serves SPA+/info+WebSocket · co-op on by default · traversal blocked ·
   no Gateway field · Advanced collapsed with automatic ${pre.placeholder} · invite=${invite} (LAN host from /info) ·
   copy handled · node join by code · invite link auto-joined (2 clients) · disconnect cleared the hash`);
