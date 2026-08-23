/**
 * Co-op client core (PLAN.md §Multi-User; M5 is the current model).
 *
 * A thin WebSocket wrapper around the session protocol that works in BOTH the browser and Node
 * (both expose a global `WebSocket`). It owns the connection + host/join handshake and maintains
 * the live state the UI renders from (`you`, `code`, `clients`, `elements`, `bots`, `running`).
 * The sidebar panel (`public/app/coopPanel.js`) and the World-canvas overlay are the only things
 * that touch pixels; everything testable lives here, so `tests/multiplayer.client.test.js` can
 * drive it against a real gateway with no browser.
 *
 * Protocol (matches src/net/gateway.js): host/join → welcome → {snapshot | roster | elements |
 * deployed | countSet | peerDeployed | error}.
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
    this.code = null;       // 6-char world code (gateway handshake; null on the single-world server)
    this.mode = null;       // 'host' | 'join' — how this client entered the shared world
    this.clients = [];      // live roster [{name, role, protoId}] from gateway `roster` messages
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
   * identity (`you`) and sent the current world; rejects on timeout, connection error, a server
   * `error` before the welcome (e.g. joining an unknown code), or close before the welcome arrives.
   *
   * `opts.mode` selects the gateway handshake (the only transport):
   *   - `{mode:'host', name}`       → create a fresh world (client becomes its admin); the
   *     welcome carries the new world's 6-char `code`.
   *   - `{mode:'join', code, name}` → enter an existing world by code (participant).
   */
  connect(url, name, opts = {}) {
    if (opts.mode !== 'host' && opts.mode !== 'join') {
      throw new TypeError(`CoopClient.connect: opts.mode must be 'host' or 'join' (got ${JSON.stringify(opts.mode ?? null)})`);
    }
    this.url = url;
    this.mode = opts.mode;
    this.code = null;
    this.clients = [];
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

      const first = opts.mode === 'host'
        ? { type: 'host', name }
        : { type: 'join', name, code: String(opts.code ?? '') };
      ws.onopen = () => { ws.send(JSON.stringify(first)); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'welcome') {
          this.status = 'connected';
          this.you = msg.you ?? null;
          this.code = msg.code ?? null;
          this.running = !!msg.running;
          this.elements = msg.world?.elements ?? [];
          this.bots = (msg.world?.bots ?? []).map(normalizeBot);
          this.tick = msg.world?.t ?? 0;
          if (!settled) { settled = true; clearTimeout(timer); const r = this._resolveWelcome; this._resolveWelcome = null; r(msg); }
        } else if (msg.type === 'snapshot') {
          this.bots = (msg.bots ?? []).map(normalizeBot);
          this.tick = msg.t ?? this.tick;
        } else if (msg.type === 'elements') {
          // Host edited the shared world (add/drag/delete); adopt the full list.
          this.elements = msg.elements ?? [];
        } else if (msg.type === 'state') {
          this.running = !!msg.running;   // authoritative running flag echoed by start/pause/reset
        } else if (msg.type === 'roster') {
          this.clients = (msg.clients ?? []).map((c) => ({ name: c?.name, role: c?.role, protoId: c?.protoId ?? null }));
        } else if (msg.type === 'error') {
          this.lastError = msg.error ?? 'server error';
          if (!settled) { try { ws.close(); } catch {} fail(this.lastError); } // handshake refused (unknown code, …)
        }
        this._emit(msg);
      };
      ws.onerror = () => fail('connection failed');
      ws.onclose = () => {
        clearTimeout(timer);
        if (!settled) fail(this.lastError ?? 'server closed the connection'); // e.g. gateway hung up after an error
        if (this.status !== 'closed') this.status = 'closed';
        this._emit({ type: 'closed' });
      };
    });
  }

  // ---- commands (best-effort; the server echoes errors back as messages) ----
  deploy(vehicle) { return this._send({ type: 'deploy', vehicle }); }
  setCount(protoId, n) { return this._send({ type: 'setCount', protoId, count: n }); }
  controls(command) { return this._send({ type: 'controls', command }); }
  // Shared-world element edits (host-only on the server; participants get refusal errors).
  addElement(element) { return this._send({ type: 'addElement', element }); }
  moveElement(id, x, y) { return this._send({ type: 'moveElement', id, x, y }); }
  removeElement(id) { return this._send({ type: 'removeElement', id }); }

  _send(msg) { if (this.ws && this.status === 'connected') this.ws.send(JSON.stringify(msg)); return this; }

  close() { const ws = this.ws; this.ws = null; try { ws?.close(); } catch {} this.status = 'closed'; }
}

export default CoopClient;
