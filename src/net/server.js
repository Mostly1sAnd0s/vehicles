/**
 * WebSocket transport for one authoritative co-op session (PLAN.md §Multi-User, phase M1).
 *
 * This is deliberately thin: all rules live in the transport-agnostic `Session`. The server's jobs
 * are (1) authenticate each socket with a one-time `join` handshake, (2) feed subsequent messages to
 * `session.handle(token, msg)`, and (3) drive the world on two timers — a fixed-dt physics step at
 * ~60Hz and a snapshot broadcast at ~15Hz so every client stays in sync.
 *
 * Wire protocol (JSON). First message must be a join:
 *   → { type:'join', name, role? }            (role optional; first joiner defaults to admin)
 *   ← { type:'welcome', running, you:{name,role,protoId}, world:{elements,bots} }
 * Command messages (routed by the server to the socket's token):
 *   → { type:'deploy', vehicle }              owner-only (always the sender's own proto)
 *   ← { type:'deployed', protoId, count }     (to the deployer) + { type:'peerDeployed' } broadcast
 *   → { type:'setCount', protoId?, count }    admin-only
 *   ← { type:'countSet', protoId, count }     broadcast
 *   → { type:'controls', command:'start'|'pause'|'reset' }   admin-only
 *   ← { type:'state', running }               broadcast
 * Continuous:
 *   ← { type:'snapshot', t, bots:[{id,protoId,owner,x,y,angle,vx,vy}] }  @ ~15Hz to everyone
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Session } from '../session.js';

const OPEN = 1; // WebSocket.OPEN — use the number so we don't depend on class statics across versions.

export function createVehicleServer({ Matter, dtMs = 1000 / 60, configs, worldDoc, port = 0, host = '127.0.0.1', broadcastHz = 15 } = {}) {
  const session = new Session({ Matter, dtMs, configs, worldDoc });

  const server = http.createServer((req, res) => {
    // No static assets here — pure co-op WS endpoint. (The SPA is served separately.)
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('braitenberg co-op session (WebSocket only)\n');
  });
  const wss = new WebSocketServer({ server });
  const tokens = new Map(); // socket -> token

  wss.on('connection', (socket) => {
    let joined = false;
    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; } // ignore non-JSON frames
      if (!joined) {
        if (msg?.type !== 'join') return;              // must open with a join handshake
        const { token, role } = session.join({ name: msg.name, role: msg.role });
        tokens.set(socket, token);
        session.bind(token, (m) => { if (socket.readyState === OPEN) socket.send(JSON.stringify(m)); });
        joined = true;
        session.sendWelcome(token);
        return;
      }
      const token = tokens.get(socket);
      if (!token) return;
      session.handle(token, msg);                       // side-effects: acks + broadcasts
    });
    socket.on('close', () => { const t = tokens.get(socket); if (t) session.leave(t); tokens.delete(socket); });
    socket.on('error', () => {});                        // never let a flaky socket crash the session
  });

  // Fixed-dt physics step (~60Hz) — only advances while running.
  const simTimer = setInterval(() => { session.stepOnce(); }, dtMs);
  // Snapshot broadcast (~15Hz) — keeps all clients in sync and feeds fresh joiners even while paused.
  const bcastTimer = setInterval(() => { session.broadcast(session.currentSnapshotWire()); }, Math.max(30, Math.round(1000 / broadcastHz)));
  simTimer.unref?.(); bcastTimer.unref?.(); // don't pin the event loop in tests

  const ready = new Promise((resolve) => server.listen(port, host, () => resolve()));

  return {
    session,
    /** Resolve once listening; returns the connectable ws:// url (real ephemeral port if port=0). */
    async start() {
      await ready;
      const a = server.address();
      return `ws://${a.address}:${a.port}`;
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

export default createVehicleServer;
