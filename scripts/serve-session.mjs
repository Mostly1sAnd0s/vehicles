/**
 * Run an authoritative co-op session server (PLAN.md §Multi-User, phase M1).
 *
 * Loads the same config files the browser SPA uses, hosts one HeadlessWorld over WebSocket, and
 * streams snapshots to every joined participant. Pure server-side — no static assets here (run
 * `npm run serve` separately for the editor SPA).
 *
 *   node scripts/serve-session.mjs [world.json]
 *     COOP_PORT   port to listen on        (default 8090)
 *     COOP_HOST   bind address             (default 127.0.0.1; set 0.0.0.0 to open to your LAN)
 *
 * The first joiner is the admin and starts the sim with {type:"controls",command:"start"}.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Matter from 'matter-js';
import { createVehicleServer } from '../src/net/server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = (p) => readFile(path.join(ROOT, p), 'utf8').then((t) => JSON.parse(t));

const [appCfg, components, sensors, actuators] = await Promise.all([
  J('config/app.json'), J('config/components.json'), J('config/sensors.json'), J('config/actuators.json'),
]);
const configs = { app: appCfg, components, sensors, actuators };

// Preload a world (static lights/obstacles) if given; otherwise start empty.
const worldFile = process.argv[2];
const worldDoc = worldFile ? await J(worldFile) : { elements: [], vehiclePrototypes: [] };

const port = Number(process.env.COOP_PORT || 8090);
const host = process.env.COOP_HOST || '127.0.0.1';

const srv = createVehicleServer({ Matter, configs, worldDoc, port, host });
try {
  await srv.start();
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.error(`COOP_PORT ${port} is already in use. Pick another: COOP_PORT=<n> npm run serve:coop`);
    process.exit(1);
  }
  throw err;
}

console.log(`\nBraitenberg co-op session (M1) listening on ws://${host}:${port}`);
if (host === '127.0.0.1') console.log('  · local-only. Set COOP_HOST=0.0.0.0 to accept participants from your LAN.');
console.log(`  · ${worldDoc.elements?.length ?? 0} static element(s) loaded; first joiner is the admin.`);
console.log('  · admin: {type:"controls",command:"start"}   participant: {type:"deploy",vehicle:{...}}\n');

process.on('SIGINT', () => { console.log('\nshutting down…'); srv.close().finally(() => process.exit(0)); });
