/**
 * Co-op sidebar panel (PLAN.md §Multi-User, phase M5 — UI phases 2–4).
 *
 * Sharing lives at the bottom of the World sidebar (the standalone tab was removed). One gateway
 * process hosts many coded worlds; this panel is the whole client side of it:
 *   - **Host** → `{type:'host'}` creates a fresh world, shows its 6-char code big, and tracks the
 *     live client count (gateway `roster` messages) next to the server address.
 *   - **Join** + code box → `{type:'join', code}` enters that world; wrong codes are refused by
 *     the gateway (error → surfaced in the status line).
 *   - **Deploy design** → pushes the current editor vehicle into the shared world (owner-only on
 *     the server: everyone drives their own bots, no one else's).
 *   - **▶/⏸/↺** session controls (host-only; admin on the server).
 *   - **Shared fleet list** → every participant's prototype with its live bot count (from
 *     snapshots); the host can add/remove (not edit) other participants' vehicles with −/+/✕,
 *     which map to `setCount` (server enforces admin-only).
 *   - **Disconnect** → closes the socket; the server prunes this client's bots from the world.
 *
 * All rules live server-side (Session/gateway); this file only flips DOM state to match.
 * `CoopClient` (src/net/client.js) owns the socket and is fully unit-tested, so this class is a
 * thin glue layer probed end to end by tests/smoke/coop.panel.mjs.
 */
import CoopClient from '../src/net/client.js';

const URL_KEY = 'bv.coop.url';
const NAME_KEY = 'bv.coop.name';
const DEFAULT_URL = 'ws://127.0.0.1:8090';
const MAX_FLEET = 50;
const randName = () => 'Bot-' + String((Math.random() * 90 + 10) | 0);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class CoopPanel {
  /**
   * @param {object} ui element map: {url, name, row, host, join, joinCode, disconnect, code, status,
   *                                   deploy, controls, start, pause, reset, remoteFleet}
   * @param {{client?:CoopClient, getVehicle?:(()=>object)}} [opts]
   */
  constructor(ui, { client, getVehicle, onEditDesign } = {}) {
    // Fail fast with the missing element's name rather than a cryptic null error mid-constructor.
    for (const [k] of Object.entries(ui)) if (!ui[k]) throw new Error('CoopPanel: missing UI element "' + k + '"');
    this.ui = ui;
    this.getVehicle = getVehicle;
    this.onEditDesign = onEditDesign;
    this.client = client ?? new CoopClient();
    this._wasConnected = false; // for "unexpected drop" handling on `closed`
    this._userLeft = false;     // set by an intentional Disconnect so `closed` stays quiet

    // Remember where you were and what you're called.
    this.ui.url.value = localStorage.getItem(URL_KEY) || DEFAULT_URL;
    this.ui.name.value = localStorage.getItem(NAME_KEY) || '';
    if (!this.ui.name.value) this.ui.name.placeholder = randName();

    // Codes are spoken back; normalise as you type.
    this.ui.joinCode.addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });
    this.ui.joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(); });
    this.ui.host.addEventListener('click', () => this.host());
    this.ui.join.addEventListener('click', () => this.join());
    this.ui.disconnect.addEventListener('click', () => this.disconnect());
    this.ui.deploy.addEventListener('click', () => this.deploy());
    this.ui.editDesign?.addEventListener('click', () => {
      // main.js owns the editor: it loads THIS participant's co-op design into the editor.
      this.onEditDesign?.();
    });


    // Shared-fleet management (phase 4): −/+/✕ map to setCount; host-only, and the server enforces it.
    this.ui.remoteFleet.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      // Count from LIVE snapshot state, never from the rendered button's data-count: the fleet
      // re-renders at snapshot rate, so a fast click can otherwise act on a stale count (a plus
      // right after a deploy would resend the old size and appear to do nothing).
      const protoId = btn.dataset.protoId;
      const count = this.client.bots.filter((b) => b.protoId === protoId).length;
      if (btn.dataset.act === 'minus') { if (count > 0) this.client.setCount(protoId, count - 1); }
      else if (btn.dataset.act === 'plus') { if (count < MAX_FLEET) this.client.setCount(protoId, count + 1); }
      else if (btn.dataset.act === 'remove') { this.client.setCount(protoId, 0); }
    });

    this.client.onMessage((msg) => {
      const c = this.client;
      if (msg.type === 'welcome') {
        this.ui.deploy.hidden = false;
        if (this.ui.editDesign) this.ui.editDesign.hidden = false;
        this.renderFleet();
      } else if (msg.type === 'roster') {
        // membership changed — refresh the client count; do NOT run this on snapshots, or the
        // 15Hz stream would clobber event messages like "deployed…" in the status line
        if (c.status === 'connected') { this.renderStatus(); this.renderFleet(); }
      } else if (msg.type === 'snapshot' || msg.type === 'peerDeployed') {
        if (c.status === 'connected') this.renderFleet(); // bot counts changed; status stays put
      } else if (msg.type === 'deployed') {
        // ack to our own deploy: the fleet count for OUR proto just changed too
        this.renderFleet();
        this.ui.status.textContent = `deployed — ${msg.count ?? 1} bot(s) driving your design`;
      } else if (msg.type === 'error') {
        this.ui.status.textContent = '⚠ ' + (msg.error ?? 'server error');
      } else if (msg.type === 'worldClosed') {
        // The host left: the gateway dissolved the world. Return home (layout back to Host/Join).
        this._wasConnected = false;
        this.ui.status.textContent = `the host left — ${c.code ?? 'the world'} was closed`;
        this.client.close();
        this.setConnectedLayout(false);
        this.setBusy(false);
      } else if (msg.type === 'closed' && this._wasConnected) {
        // The gateway went away (or the socket dropped) mid-session.
        if (!this._userLeft) this.ui.status.textContent = 'connection closed — left the shared world';
        this.setConnectedLayout(false);
        this.setBusy(false);
      }
    });

    this.ui.status.textContent = 'not in a shared world';
  }

  // ---- actions ------------------------------------------------------------
  host() { return this.connect({ mode: 'host' }, 'creating a new shared world…'); }

  join() {
    const code = this.ui.joinCode.value.trim();
    if (!code) { this.ui.status.textContent = 'enter the 6-letter world code to join'; return; }
    return this.connect({ mode: 'join', code }, `joining ${code}…`);
  }

  /** Push the current editor design into the shared world (owner-only on the server). */
  deploy() {
    const c = this.client;
    if (c.status !== 'connected') { this.ui.status.textContent = 'not in a shared world'; return; }
    const v = this.getVehicle?.();
    if (v && !this.onEditDesign) { /* first-class design slot not wired — fall through to editor vehicle */ }
    if (!v) { this.ui.status.textContent = 'no design to deploy — build a vehicle in the editor first'; return; }
    c.deploy(v);
    this.ui.status.textContent = `deploying your design… (driving as ${c.you?.name})`;
  }



  disconnect() {
    if (this.client.status !== 'connected') return;
    this._userLeft = true;
    const code = this.client.code;
    this._wasConnected = false;
    this.client.close(); // server prunes this participant's bots on socket close
    this.setConnectedLayout(false);
    this.setBusy(false);
    this.ui.status.textContent = `left ${code ?? 'the world'} — your bots were removed`;
  }

  async connect(opts, pendingMsg) {
    const url = this.ui.url.value.trim();
    if (!url) { this.ui.status.textContent = 'enter the gateway address (ws://host:port)'; return; }
    const name = this.ui.name.value.trim() || randName();
    this.ui.name.value = name;
    this.ui.url.value = url; // normalise
    localStorage.setItem(URL_KEY, url);
    localStorage.setItem(NAME_KEY, name);

    this.setBusy(true);
    this.ui.status.textContent = pendingMsg;
    try {
      await this.client.connect(url, name, opts); // resolves on `welcome`
      this._wasConnected = true;
      this.ui.code.textContent = this.client.code ?? '—';
      this.setConnectedLayout(true);
      this.setBusy(false); // success path: Disconnect must be clickable (host/join are hidden now)
      this.renderStatus(this.client.mode === 'host' ? 'you host' : 'you joined');
    } catch (e) {
      this.ui.status.textContent = '✗ ' + (e?.message ?? e); // e.g. "no such world: ZZZZZZ"
      this.setBusy(false);
    }
  }

  // ---- layout -------------------------------------------------------------
  /** Connected: swap Host/Join row for Disconnect, reveal code + deploy + fleet. Joiners lose the bottom sim controls; hosts keep them. */
  setConnectedLayout(on) {
    this.ui.fields.hidden = on; // gateway URL + name only make sense for a fresh connection
    this.ui.row.hidden = on;
    this.ui.disconnect.hidden = !on;
    this.ui.code.hidden = !on;
    this.ui.deploy.hidden = !on;
    if (!on) {
      this.ui.remoteFleet.hidden = true;
      this.ui.remoteFleet.innerHTML = '';
    }
    this._setWorldControlsVisibility();
  }

  /** Hide play/step/reset/time for joiners (non-admins); hosts keep full control. Viz toggles stay. */
  _setWorldControlsVisibility() {
    const hide = this._wasConnected && this.client.you?.role !== 'admin';
    for (const id of ['btn-play', 'btn-step', 'btn-reset']) {
      const el = document.getElementById(id);
      if (el) el.hidden = hide;
    }
    const ts = document.getElementById('timescale-label');
    if (ts) ts.hidden = hide;
  }

  setBusy(busy) { for (const el of [this.ui.host, this.ui.join, this.ui.disconnect]) if (el) el.disabled = busy; }

  renderStatus(lead) {
    const c = this.client;
    if (c.status !== 'connected') return;
    const n = c.clients.length;
    const you = c.you ? ` · ${esc(c.you.name)} (${c.you.role})` : '';
    this.ui.status.textContent =
      `${lead ?? (c.mode === 'host' ? 'hosting' : 'in world')} ${this.client.code ?? ''}` +
      ` · ${this.ui.url.value.trim() || c.url}` +
      ` · ${n} client${n === 1 ? '' : 's'}${you}`;
  }



  /**
   * Shared fleet list (phase 3–4): every participant's prototype with its live bot count. The host
   * gets −/+/✕ (add/remove, never edit); others see a read-only roster of who is driving what.
   */
  renderFleet() {
    const c = this.client;
    const el = this.ui.remoteFleet;
    if (!el || c.status !== 'connected') return;
    const isAdmin = c.you?.role === 'admin';
    const rows = c.clients.map((p) => ({ ...p, count: c.bots.filter((b) => b.protoId === p.protoId).length }));
    el.innerHTML = '';
    el.hidden = rows.length === 0;
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'fleet-row';
      row.dataset.protoId = r.protoId ?? '';
      row.innerHTML =
        `<span class="fleet-name">${esc(r.name)}</span>` +
        `<span class="dim fleet-count">${r.count} bot${r.count === 1 ? '' : 's'}${isAdmin && r.protoId !== c.you?.protoId ? ' · other' : ''}</span>`;
      if (isAdmin && r.protoId) {
        const mk = (act, label, title, disabled) =>
          `<button data-act="${act}" data-proto-id="${esc(r.protoId)}" data-count="${r.count}" ${disabled ? 'disabled' : ''} title="${title}">${label}</button>`;
        row.innerHTML +=
          `<span class="fleet-btns">` +
          mk('minus', '−', `Remove one of ${r.name}'s bots`, r.count === 0) +
          mk('plus', '+', `Add one bot to ${r.name}'s fleet`, r.count >= MAX_FLEET) +
          mk('remove', '✕', `Remove all of ${r.name}'s bots`, r.count === 0) +
          `</span>`;
      }
      el.appendChild(row);
    }
  }
}

export default CoopPanel;
