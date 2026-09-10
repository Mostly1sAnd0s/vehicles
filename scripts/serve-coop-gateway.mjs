/**
 * Run a STANDALONE co-op gateway — for a box that hosts shared worlds but serves nothing.
 * (You almost never need this: `npm run serve` already runs the gateway on the same port as the
 * SPA. Use this when the worlds should live on a different machine/port than the files, e.g. a
 * always-on classroom box that participants' browsers reach at a fixed address.)
 *
 * One process hosts many coded worlds (create one via a client's "Host", join one by code). Loads
 * the same config files the browser SPA uses.
 *
 *   node scripts/serve-coop-gateway.mjs
 *     COOP_PORT   port to listen on        (default 8090)
 *     COOP_HOST   bind address             (default 127.0.0.1; set 0.0.0.0 to open to your LAN)
 *
 * A client's first message is {type:'host',name} (new world) or {type:'join',name,code}.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Matter from 'matter-js';
import { createCoopGateway } from '../src/net/gateway.js';
import { pickLanInterfaces } from '../src/net/invite.js';

const ROOT = path.dirname(fileURLToPath(new URL(import.meta.url))); // scripts/
const APP = path.join(ROOT, '..');                                  // repo root
const J = (p) => readFile(path.join(APP, p), 'utf8').then((t) => JSON.parse(t));

const [appCfg, components, sensors, actuators, worldCfg] = await Promise.all([
  J('config/app.json'), J('config/components.json'), J('config/sensors.json'), J('config/actuators.json'),
  // OPTIONAL: a missing world.json must not stop the gateway (built-in fallbacks apply).
  J('config/world.json').catch(() => ({})),
]);
const configs = { app: appCfg, components, sensors, actuators, world: worldCfg };

const port = Number(process.env.COOP_PORT || 8090);
const host = process.env.COOP_HOST || '127.0.0.1';

const gw = createCoopGateway({ Matter, configs, port, host });
try {
  const { url, port: bound } = await gw.start();
  // Rank interfaces the same way the merged server does (pickLanInterfaces): "first IPv4" on a
  // laptop with a VPN up advertises a utun address nobody can join, and a bare `family ===
  // 'IPv4'` comparison silently filters everything out on old Node (family was 4/6 there).
  const lan = pickLanInterfaces(os.networkInterfaces())[0]?.address;
  console.log(`\nBraitenberg co-op gateway (M5) listening on ${url}`);
  if (host !== '127.0.0.1' && lan) console.log(`  · LAN:    ws://${lan}:${bound}   (other machines join with this)`);
  else console.log('  · local-only. Set COOP_HOST=0.0.0.0 to accept participants from your LAN.');
  console.log('  · a client hosts a world (first "Host" -> 6-char code) or joins by entering that code.\n');
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.error(`COOP_PORT ${port} is already in use. Pick another: COOP_PORT=<n> npm run serve:coop`);
    process.exit(1);
  }
  throw err;
}

process.on('SIGINT', () => { console.log('\nshutting down…'); gw.close().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { gw.close().finally(() => process.exit(0)); });
