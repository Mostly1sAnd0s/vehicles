/**
 * Co-op client core (PLAN.md §Multi-User, phase M2).
 *
 * A thin WebSocket wrapper around the session protocol that works in BOTH the browser and Node
 * (both expose a global `WebSocket`). It owns the connection + join handshake and maintains the
 * live state the shared-world view renders from (`you`, `elements`, `bots`, `running`, `status`).
 * The canvas layer (`public/app/coop.js`) is the only thing that touches pixels; everything testable
 * lives here, so `tests/multiplayer.client.test.js` can drive it against a real server with no browser.
 *
 * Protocol (matches src/net/server.js): join → welcome → {snapshot | deployed | countSet | peerDeployed | error}.
 */

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** Fill in defaults so the renderer can rely on every field being present. */
function normalizeBot(b) {
  return {
    id: b?.id, protoId: b?.protoId, owner: b?.owner ?? null,
    x: num(b?.x), y: num(b?.y), angle: num(b?.angle), vx: num(b?.vx), vy: num(b?.vy),
    w: num(b?.w, 80), h: num(b?.h, 40), color: b?.color ?? '#cc3333',
  };
}

export class CoopClient {
  constructor() {
    this.ws = null;
    this.url = null;
    this.you = null;        // {name, role, protoId} from the welcome message
    this.elements = [];     // static world elements (lights/obstacles) from the welcome message
    this.bots = [];         // latest snapshot's bots (normalized)
    this.tick = 0;          // server world tick of the last snapshot/welcome (advances while running)
    this.running = false;   // true once an admin starts the sim (from the welcome)
    this.status = 'idle';   // idle | connecting | connected | error | closed
    this.lastError = null;
    this._subs = new Set();
    this._resolveWelcome = null;
  }

  /** Subscribe to every inbound message. Returns an unsubscribe function. */
  onMessage(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _emit(msg) { for (const fn of this._subs) { try { fn(msg); } catch { /* a bad subscriber must not kill the stream */ } } }

  /**
   * Open the socket and join. Resolves with the `welcome` message once the server has assigned an
   * identity (`you`) and sent the current world; rejects on timeout, connection error, or close
   * before the welcome arrives.
   */
  connect(url, name) {
    this.url = url;
    this.status = 'connecting';
    this.lastError = null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; this.status = 'error'; this.lastError = msg; reject(new Error(msg)); } };
      let ws;
      try { ws = new WebSocket(url); } catch (e) { return fail(String(e?.message ?? e)); }
      this.ws = ws;
      this._resolveWelcome = resolve;

      const timer = setTimeout(() => { try { ws.close(); } catch {} fail('connection timed out'); }, 5000);

      ws.onopen = () => { ws.send(JSON.stringify({ type: 'join', name })); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'welcome') {
          this.status = 'connected';
          this.you = msg.you ?? null;
          this.running = !!msg.running;
          this.elements = msg.world?.elements ?? [];
          this.bots = (msg.world?.bots ?? []).map(normalizeBot);
          this.tick = msg.world?.t ?? 0;
          if (!settled) { settled = true; clearTimeout(timer); const r = this._resolveWelcome; this._resolveWelcome = null; r(msg); }
        } else if (msg.type === 'snapshot') {
          this.bots = (msg.bots ?? []).map(normalizeBot);
          this.tick = msg.t ?? this.tick;
        } else if (msg.type === 'state') {
          this.running = !!msg.running;   // authoritative running flag echoed by start/pause/reset
        } else if (msg.type === 'error') {
          this.lastError = msg.error ?? 'server error';
        }
        this._emit(msg);
      };
      ws.onerror = () => fail('connection failed');
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.status !== 'closed') this.status = 'closed';
        this._emit({ type: 'closed' });
      };
    });
  }

  // ---- commands (best-effort; the server echoes errors back as messages) ----
  deploy(vehicle) { return this._send({ type: 'deploy', vehicle }); }
  setCount(protoId, n) { return this._send({ type: 'setCount', protoId, count: n }); }
  controls(command) { return this._send({ type: 'controls', command }); }

  _send(msg) { if (this.ws && this.status === 'connected') this.ws.send(JSON.stringify(msg)); return this; }

  close() { const ws = this.ws; this.ws = null; try { ws?.close(); } catch {} this.status = 'closed'; }
}

export default CoopClient;
