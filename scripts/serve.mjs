/**
 * Static dev server for public/ — Node built-ins only (no Python needed).
 * Port selection: $PORT if set, else 8080; if taken, probes upward (8081…)
 * until it finds a free port and tells you loudly. Ctrl-C to stop.
 */
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
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
    console.log(`   (set PORT=<n> to pin a specific port)\n`);
  }
  return port;
}

const port = await pickPort();

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.normalize(path.join(ROOT, urlPath));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      // dev server: never serve stale ES modules from heuristic cache
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} got taken between probe and bind. Pick another: PORT=<n> npm run serve`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => {
  console.log(`Serving public/ at http://localhost:${port}`);
});
