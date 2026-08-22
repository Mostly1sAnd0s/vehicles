/**
 * Co-op GATEWAY (PLAN.md §Multi-User, phase M5). Hosts MANY independent coded worlds on one port.
 *
 * Unlike `net/server.js` (one world per process), the gateway multiplexes a `Map<code, Session>`.
 * A client's first message is either:
 *   → { type:'host', name }              create a fresh world; this client becomes its host (admin)
 *   ← { type:'welcome', code, running, you:{name,role,protoId}, world:{elements,bots} }
 *   → { type:'join', name, code }        join an existing world by its 6-char code (participant)
 * and every membership change fans out:
 *   ← { type:'roster', clients:[{name,role,protoId}] }   to everyone in that world.
 *
 * A socket leaving a world prunes its bots (Session.leave); an emptied world is garbage-collected.
 * One fixed-dt step + snapshot-broadcast loop iterates every active world. Transport-agnostic
 * `Session` still owns all rules — this file only routes sockets to worlds, so it's unit-testable
 * over a real socket with no browser.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Session } from '../session.js';

const OPEN = 1; // WebSocket.OPEN as a number (no dependency on class statics across versions).
// Unambiguous alphabet: no I/L/O/0/1 so a spoken code is easy to type back.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

function randomCode(used) {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
  } while (used.has(code));
  return code;
}

export function createCoopGateway({ Matter, dtMs = 1000 / 60, configs, port = 0, host = '127.0.0.1', broadcastHz = 15 } = {}) {
  const worlds = new Map(); // code -> {code, session, createdAt}

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ worlds: worlds.size }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('braitenberg co-op gateway (WebSocket only)\n');
  });
  const wss = new WebSocketServer({ server });

  const rosterOf = (w) => [...w.session.participants.values()].map((p) => ({ name: p.name, role: p.role, protoId: p.protoId }));
  const bind = (socket, w, token) => {
    w.session.bind(token, (m) => { if (socket.readyState === OPEN) socket.send(JSON.stringify(m)); });
  };

  wss.on('connection', (socket) => {
    let state = null; // {code, token} once the host/join handshake completes
    socket.on('message', (data) => {
      let msg; try { msg = JSON.parse(data); } catch { return; } // ignore non-JSON frames
      if (!state) {
        if (msg?.type === 'host') {
          const code = randomCode(worlds);
          const session = new Session({ Matter, dtMs, configs, worldDoc: { elements: [], vehiclePrototypes: [] } });
          session.code = code; // echoed in the welcome so the UI can display/persist it
          const w = { code, session, createdAt: Date.now() };
          worlds.set(code, w);
          const { token } = session.join({ name: msg.name, role: 'admin' }); // host == that world's admin
          state = { code, token };
          bind(socket, w, token);
          session.sendWelcome(token);
          session.broadcast({ type: 'roster', clients: rosterOf(w) });
        } else if (msg?.type === 'join') {
          const code = String(msg.code ?? '').toUpperCase();
          const w = worlds.get(code);
          if (!w) { socket.send(JSON.stringify({ type: 'error', error: `no such world: ${code || '(empty)'}` })); return; }
          const { token } = w.session.join({ name: msg.name, role: 'participant' });
          state = { code, token };
          bind(socket, w, token);
          w.session.sendWelcome(token);
          w.session.broadcast({ type: 'roster', clients: rosterOf(w) });
        } else {
          socket.send(JSON.stringify({ type: 'error', error: `first message must be "host" or "join" (got ${msg?.type})` }));
        }
        return;
      }
      const w = worlds.get(state.code);
      if (!w) return; // world was GC'd under us; drop further input
      w.session.handle(state.token, msg); // acks + broadcasts happen inside Session
    });
    socket.on('close', () => {
      if (!state) return;
      const w = worlds.get(state.code);
      if (!w) return;
      w.session.leave(state.token); // prunes this participant's bots from the world
      if (w.session.participants.size === 0) worlds.delete(state.code); // nothing left: reclaim it
      else w.session.broadcast({ type: 'roster', clients: rosterOf(w) });
    });
    socket.on('error', () => {}); // never let a flaky socket crash a world
  });

  // One loop serves every world (a per-world interval would pin the loop in tests).
  const simTimer = setInterval(() => { for (const w of worlds.values()) w.session.stepOnce(); }, dtMs);
  const bcastTimer = setInterval(() => { for (const w of worlds.values()) w.session.broadcast(w.session.currentSnapshotWire()); }, Math.max(30, Math.round(1000 / broadcastHz)));
  simTimer.unref?.(); bcastTimer.unref?.(); // don't pin the event loop in tests

  const ready = new Promise((resolve) => server.listen(port, host, () => resolve()));

  return {
    worlds,
    /** Resolve once listening; returns the connectable ws url + the real (possibly ephemeral) port. */
    async start() {
      await ready;
      const a = server.address();
      return { url: `ws://${a.address}:${a.port}`, port: a.port };
    },
    async close() {
      clearInterval(simTimer);
      clearInterval(bcastTimer);
      for (const s of wss.clients) s.terminate?.();
      await new Promise((r) => (wss.close ? wss.close(r) : r()));
      await new Promise((r) => server.close(r));
    },
  };
}

export default createCoopGateway;
