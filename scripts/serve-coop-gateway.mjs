/**
 * Run the authoritative co-op GATEWAY (PLAN.md §Multi-User, phase M5).
 *
 * One process hosts many coded worlds (create one via a client's "Host", join one by code). Loads
 * the same config files the browser SPA uses. Pure server-side — run `npm run serve` separately
 * for the editor SPA.
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

const ROOT = path.dirname(fileURLToPath(new URL(import.meta.url))); // scripts/
const APP = path.join(ROOT, '..');                                  // repo root
const J = (p) => readFile(path.join(APP, p), 'utf8').then((t) => JSON.parse(t));

const [appCfg, components, sensors, actuators] = await Promise.all([
  J('config/app.json'), J('config/components.json'), J('config/sensors.json'), J('config/actuators.json'),
]);
const configs = { app: appCfg, components, sensors, actuators };

const port = Number(process.env.COOP_PORT || 8090);
const host = process.env.COOP_HOST || '127.0.0.1';

const gw = createCoopGateway({ Matter, configs, port, host });
try {
  const { url, port: bound } = await gw.start();
  const lan = Object.values(os.networkInterfaces()).flat().find?.(i => i.family === 'IPv4' && !i.internal)?.address;
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
