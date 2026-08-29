/**
 * The one command you need: serves public/ AND hosts the co-op gateway on the SAME port.
 *
 *   npm run serve
 *     PORT=<n>        pin the port (fails on collision). Default: probe up from 8080.
 *     HOST=<addr>     bind address. Default 0.0.0.0 — LAN-open, because co-op means other people
 *                     joining you. HOST=127.0.0.1 locks it to this machine (and then joining from
 *                     another computer cannot work at all).
 *     NO_COOP=1       serve the SPA only (no gateway, no matter-js sim timers).
 *
 * Why one port: a joiner needs exactly one address to reach the host. When the SPA and the gateway
 * share a port, "they can load the page" and "they can reach the shared world" become the same
 * fact — no second port to open, no `ws://…:8090` to mistype, and the client can simply default to
 * its own origin. `ws` consumes only the HTTP `upgrade` event, so the static request handler below
 * is untouched. `GET /info` tells the SPA which LAN address to advertise (a browser cannot discover
 * its own), and `GET /health` stays for monitoring.
 *
 * Still available separately: `npm run serve:coop` runs a gateway-only process (a box that hosts
 * worlds but serves nothing).
 */
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Matter from 'matter-js';
import { createCoopGateway } from '../src/net/gateway.js';
import { buildServerInfo } from '../src/net/invite.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SCAN = 50;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const noStore = (res, type, extra = {}) =>
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...extra });

function isFree(port) {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(true)); // nothing listening (or refused)
  });
}

async function pickPort() {
  if (process.env.PORT) {
    const p = Number(process.env.PORT);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      console.error(`Invalid $PORT: ${process.env.PORT}`);
      process.exit(1);
    }
    return p; // hard pin: fail on collision rather than silently move
  }
  let port = 8080;
  while (!(await isFree(port)) && port - 8080 < MAX_SCAN) port++;
  if (port !== 8080) {
    console.log(`\n⚠  port 8080 is already in use — serving on ${port} instead`);
    console.log(`   (invite links carry this port automatically; set PORT=<n> to pin one)\n`);
  }
  return port;
}

const port = await pickPort();
const bindHost = process.env.HOST || '0.0.0.0';
const coopEnabled = process.env.NO_COOP !== '1';

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/info' || url.pathname === '/health') {
      // /info is how the SPA learns the LAN address to advertise in an invite link: browsers are
      // deliberately unable to ask this themselves. `lan` is ranked best-first (see invite.js).
      const info = buildServerInfo({ hostname: os.hostname(), interfaces: os.networkInterfaces(), port });
      const worlds = coopEnabled ? gw.worlds.size : 0;
      noStore(res, 'application/json');
      res.end(JSON.stringify({ ...info, coop: coopEnabled, worlds }));
      return;
    }
    let urlPath = decodeURIComponent(url.pathname);
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.normalize(path.join(ROOT, urlPath));
    // ROOT + sep, not bare ROOT: a plain prefix check also accepts SIBLINGS whose absolute path
    // starts with the same string (…/public-backup/x.json passes startsWith('…/public')).
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    const body = await readFile(file);
    // dev server: never serve stale ES modules from heuristic cache
    noStore(res, MIME[path.extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

// The shared world, attached to the same server (same port as the SPA).
const [appCfg, components, sensors, actuators] = await Promise.all(
  ['app', 'components', 'sensors', 'actuators'].map((f) =>
    readFile(path.join(APP, 'config', `${f}.json`), 'utf8').then((t) => JSON.parse(t))),
);
const gw = coopEnabled
  ? createCoopGateway({
    Matter,
    configs: { app: appCfg, components, sensors, actuators },
    server, // ← the merge: no second listener
    onStepError: (err, code, label) => console.error(`[coop] world ${code} ${label} failed:`, err?.message ?? err),
  })
  : null;

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} got taken between probe and bind. Pick another: PORT=<n> npm run serve`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, bindHost, async () => {
  if (gw) await gw.start();
  const lan = buildServerInfo({ hostname: os.hostname(), interfaces: os.networkInterfaces(), port });
  console.log(`\nBraitenberg Vehicles`);
  console.log(`  · local:    http://localhost:${port}`);
  for (const i of lan.lan) console.log(`  · LAN:      http://${i.address}:${port}   (${i.name} — share this to co-op)`);
  if (!lan.lan.length) {
    console.log(`  · LAN:      no usable LAN interface found (Wi-Fi off? in a VPN-only state?)`);
  } else if (lan.lan.length > 1) {
    console.log(`             multiple interfaces — use the one your participants can reach;`);
    console.log(`             the panel lists all of them and the invite link is editable`);
  }
  console.log(coopEnabled
    ? `  · co-op:    gateway on the SAME port (${lan.wsUrl}) — Host in the World sidebar, then share the invite link`
    : `  · co-op:    disabled (NO_COOP=1)`);
  if (coopEnabled && bindHost === '0.0.0.0') {
    console.log(`  · note:     macOS may ask to allow incoming connections for Node.js — click Allow,`);
    console.log(`             otherwise participants load nothing. HOST=127.0.0.1 npm run serve locks it down.`);
  }
  console.log('');
});

const shutdown = () => { (gw ? gw.close() : Promise.resolve()).finally(() => process.exit(0)); };
process.on('SIGINT', () => { console.log('\nshutting down…'); shutdown(); });
process.on('SIGTERM', shutdown);
