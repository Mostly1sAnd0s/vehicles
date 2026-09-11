/**
 * Co-op sidebar panel (PLAN.md §Multi-User, phase M5 — UI phases 2–4).
 *
 * Sharing lives at the bottom of the World sidebar (the standalone tab was removed). The gateway
 * runs on the same port as this page (one process, `npm run serve`), so there is no server address
 * to configure: the page's own origin IS the gateway. This panel is the whole client side of it:
 *   - **Host** → `{type:'host'}` creates a fresh world, shows its 6-char code big plus a one-line
 *     invite link (whose LAN address comes from the server's `GET /info`, because a browser cannot
 *     discover its own), and tracks the live client count (gateway `roster` messages).
 *   - **Join** + code box → `{type:'join', code}` enters that world; wrong codes are refused by
 *     the gateway (error → surfaced in the status line).
 *   - **Invite link** (`#join=CODE`) → `autoJoinFromLink()` prefills the code and connects, so a
 *     pasted link is the entire join flow. The address lives under **Advanced** for the rare case
 *     of joining a world from a page served somewhere else; it accepts `ip`, `ip:port`,
 *     `name.local`, a full `ws://` URL, or a whole invite link (see `src/net/invite.js`).
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
import { parseHostInput, buildWsUrl, buildInvite, joinCodeFromHash, formatHostPort } from '../src/net/invite.js';

const HOST_KEY = 'bv.coop.hostAddr';   // only ever an OVERRIDE; empty means "this server"
const NAME_KEY = 'bv.coop.name';
// Pre-merge builds stored a full gateway URL (default ws://127.0.0.1:8090). Keep a genuine custom
// gateway, but drop the old default: it would silently shadow the automatic same-origin address.
const LEGACY_URL_KEY = 'bv.coop.url';
const LEGACY_URL_DEFAULT = 'ws://127.0.0.1:8090';
const MAX_FLEET = 50;
const randName = () => 'Bot-' + String((Math.random() * 90 + 10) | 0);
// Addresses that only work on this machine — never good enough to put in an invite link.
const isLocalOnly = (h) => {
  const s = String(h ?? '').toLowerCase();
  return !s || s === 'localhost' || s.startsWith('127.') || s === '::1' || s.endsWith('.localhost');
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class CoopPanel {
  /**
   * @param {object} ui element map: {hostAddr, advanced, advancedTag, hostAddrHint, name, row, host,
   *                                   join, joinCode, disconnect, code, status, deploy, invite,
   *                                   inviteRow, inviteAlt, copyInvite, remoteFleet,
   *                                   arrange, arrangeRandom, arrangeLine, arrangeGrid}
   * @param {{client?:CoopClient, getVehicle?:(()=>object), onDeepLink?:(()=>void),
   *           getViewCenter?:(()=>{x:number,y:number}|null)}} [opts]
   */
  constructor(ui, { client, getVehicle, onEditDesign, onConnectStart, onDisconnectStart, onDeepLink, getViewCenter } = {}) {
    // Fail fast with the missing element's name rather than a cryptic null error mid-constructor.
    for (const [k] of Object.entries(ui)) if (!ui[k]) throw new Error('CoopPanel: missing UI element "' + k + '"');
    this.ui = ui;
    this.getVehicle = getVehicle;
    this.getViewCenter = getViewCenter;
    this.onEditDesign = onEditDesign;
    // Mode-transition lifecycle hooks (main.js owns the canvas overlay + Sandbox tab state):
    // onConnectStart fires when Host/Join is pressed; onDisconnectStart when Disconnect is.
    this.onConnectStart = onConnectStart;
    this.onDisconnectStart = onDisconnectStart;
    this.onDeepLink = onDeepLink;
    this.client = client ?? new CoopClient();
    this._wasConnected = false; // for "unexpected drop" handling on `closed`
    this._userLeft = false;     // set by an intentional Disconnect so `closed` stays quiet

    // What you're called, and an address override if you ever need one (see the class header).
    this._auto = this._autoAddress();
    const savedOverride = this._loadOverride();
    this.ui.hostAddr.value = savedOverride ?? '';
    this.ui.name.value = localStorage.getItem(NAME_KEY) || '';
    if (!this.ui.name.value) this.ui.name.placeholder = randName();
    // Open Advanced only when it is actually needed: no automatic address (opened from disk), or a
    // saved override the user should be able to see they are carrying.
    if (!this._auto || savedOverride) this.ui.advanced.open = true;
    this._syncAddressHint();
    this._syncAdvancedTag();
    this.ui.advanced.addEventListener('toggle', () => this._syncAdvancedTag());
    this.ui.hostAddr.addEventListener('input', () => { this._syncAddressHint(); this._syncAdvancedTag(); });
    this.ui.copyInvite.addEventListener('click', () => this.copyInvite());
    // An alternate-interface chip swaps the invite link (multi-homed host: Wi-Fi vs Ethernet).
    this.ui.inviteAlt.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-addr]');
      if (chip && this.client.code) {
        this._inviteHost = chip.dataset.addr;
        this._showInvite();
      }
    });

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

    // Fleet organising: one command per layout, aimed at the host's camera centre. The server
    // is the authority on who may send this (participants are refused); the row is merely
    // hidden from them so they are not invited to be told no.
    for (const [btn, mode] of [[this.ui.arrangeRandom, 'random'], [this.ui.arrangeLine, 'line'], [this.ui.arrangeGrid, 'grid']]) {
      btn.addEventListener('click', () => {
        const c = this.getViewCenter?.() ?? null;
        this.client.arrangeBots(mode, c);
      });
    }


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

    // Manual fleet size: the host types an exact number in a row's input and presses Enter (or
    // blurs / clicks away); it goes to setCount clamped 0..MAX_FLEET, same as −/+/✕.
    const applyFleetCount = (input) => {
      if (!input || input.dataset.protoId == null) return;
      const n = Math.max(0, Math.min(MAX_FLEET, Math.trunc(Number(input.value)) || 0));
      input.value = n; // snap the field to what actually goes over the wire
      this.client.setCount(input.dataset.protoId, n);
    };
    this.ui.remoteFleet.addEventListener('change', (e) => { if (e.target.matches('.fleet-count-input')) applyFleetCount(e.target); });
    this.ui.remoteFleet.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('.fleet-count-input')) { e.preventDefault(); applyFleetCount(e.target); }
    });

    this.client.onMessage((msg) => {
      const c = this.client;
      if (msg.type === 'welcome') {
        // Both design buttons are always visible now; welcome is what un-greys Deploy.
        this.ui.deploy.disabled = false;
        this.renderFleet();
        this._publishInvite(); // the world code exists now, so the shareable link can too
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
        this._autoJoined = false;
        this._clearJoinHash(); // that world is gone; a refresh must not try to rejoin it
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

  /**
   * The invite link did its job: `http://<host>:<port>/#join=CODE` was opened, so this page was
   * served BY the host and the address is already correct. Prefill the code, let go of any stale
   * Advanced override (the link you just followed beats an address remembered from last week), and
   * connect with your remembered name — or the same Bot-NN the form would have used.
   * @returns {boolean} true when a join was started from the URL.
   */
  autoJoinFromLink() {
    const code = joinCodeFromHash(location.hash) || joinCodeFromHash(location.search);
    if (!code) return false;
    if (this.client.status === 'connecting' || this.client.status === 'connected') return false;
    this.ui.joinCode.value = code;
    if (this.ui.hostAddr.value.trim()) this.ui.hostAddr.value = ''; // the link names its own host
    this._syncAddressHint();
    this._syncAdvancedTag();
    this._autoJoined = true;
    this.onDeepLink?.(); // main.js: show the World tab, or you'd auto-join into a screen you can't see
    this.join();
    return true;
  }

  /** Push the current editor design into the shared world (owner-only on the server). */
  deploy() {
    const c = this.client;
    if (c.status !== 'connected') { this.ui.status.textContent = 'not in a shared world'; return; }
    const v = this.getVehicle?.(); // the co-op design if one exists, else the editor's live vehicle
    if (!v) { this.ui.status.textContent = 'no design to deploy — build a vehicle in the editor first'; return; }
    c.deploy(v);
    this.ui.status.textContent = `deploying your design… (driving as ${c.you?.name})`;
  }



  disconnect() {
    if (this.client.status !== 'connected') return;
    this.onDisconnectStart?.(); // "Leaving world…" overlay + clear (main.js)
    this._userLeft = true;
    const code = this.client.code;
    this._wasConnected = false;
    this._autoJoined = false;
    this._clearJoinHash(); // "leave" means leave: a refresh must not drop you straight back in
    this.client.close(); // server prunes this participant's bots on socket close
    this.setConnectedLayout(false);
    this.setBusy(false);
    this.ui.status.textContent = `left ${code ?? 'the world'} — your bots were removed`;
  }

  // ---- addressing ---------------------------------------------------------
  /** The server that served this page, which is also the gateway (one port, one process). */
  _autoAddress() {
    const r = parseHostInput('', { origin: location.href, defaultPort: location.port || 8080 });
    return r.ok ? { ...r, display: formatHostPort(r) } : null;
  }

  /** A remembered override, minus the pre-merge `ws://127.0.0.1:8090` default that would shadow it. */
  _loadOverride() {
    const saved = localStorage.getItem(HOST_KEY);
    if (saved) return saved;
    const legacy = localStorage.getItem(LEGACY_URL_KEY);
    if (!legacy) return null;
    localStorage.removeItem(LEGACY_URL_KEY);
    if (legacy === LEGACY_URL_DEFAULT) return null;
    const r = parseHostInput(legacy, { origin: location.href });
    return r.ok ? formatHostPort(r) : null;
  }

  /** Live feedback in Advanced: what the field currently means (or why it doesn't). */
  _syncAddressHint() {
    const raw = this.ui.hostAddr.value.trim();
    const auto = this._auto;
    this.ui.hostAddr.placeholder = auto ? auto.display : '192.168.1.20:8080';
    if (!raw) {
      this.ui.hostAddrHint.textContent = auto
        ? `automatic — this page came from ${auto.display}`
        : 'this page was opened from disk, so type the host\u2019s IP address (and its port)';
      return;
    }
    const r = this._resolveTarget();
    this.ui.hostAddrHint.textContent = r.ok
      ? `\u2192 ${r.url}${r.code ? ` \u00b7 code ${r.code}` : ''}`
      : '\u26a0 ' + r.error;
  }

  /** Keep the collapsed summary honest: show the override without making people open it. */
  _syncAdvancedTag() {
    const raw = this.ui.hostAddr.value.trim();
    this.ui.advancedTag.textContent = raw ? ` \u00b7 ${raw}` : '';
  }

  /** Resolve the field (possibly empty) into a concrete socket target, or a usable error. */
  _resolveTarget() {
    const r = parseHostInput(this.ui.hostAddr.value.trim(), {
      origin: location.href,
      defaultPort: Number(location.port) || 8080,
    });
    if (!r.ok) return r;
    return { ...r, url: buildWsUrl(r), display: formatHostPort(r) };
  }

  async connect(opts, pendingMsg) {
    const target = this._resolveTarget();
    if (!target.ok) {
      this.ui.status.textContent = '\u26a0 ' + target.error;
      this.ui.advanced.open = true; // the field that needs fixing lives in there
      this._failAutoJoin();
      return;
    }
    this._target = target;
    // A whole invite link pasted into Advanced carries its own code: use it, don't make them
    // retype the six characters that were already in the thing they copied.
    if (target.code && !this.ui.joinCode.value.trim()) this.ui.joinCode.value = target.code;
    const name = this.ui.name.value.trim() || randName();
    this.ui.name.value = name;
    localStorage.setItem(NAME_KEY, name);
    // Only an override is worth remembering. Persisting the automatic address would pin one IP and
    // break the next time the host's DHCP lease moves.
    if (target.source === 'input') localStorage.setItem(HOST_KEY, target.display);
    else localStorage.removeItem(HOST_KEY);
    this._syncAdvancedTag();

    this.onConnectStart?.({ mode: opts.mode }); // "Joining world…" overlay + clear (main.js)
    this.setBusy(true);
    this.ui.status.textContent = pendingMsg;
    try {
      await this.client.connect(target.url, name, opts); // resolves on `welcome`
      this._wasConnected = true;
      this._autoJoined = false;
      this.ui.code.textContent = this.client.code ?? '\u2014';
      this.setConnectedLayout(true);
      this.setBusy(false); // success path: Disconnect must be clickable (host/join are hidden now)
      this.renderStatus(this.client.mode === 'host' ? 'you host' : 'you joined');
    } catch (e) {
      // Say what was actually dialled: "could not reach 192.168.1.44:8080" beats a bare "failed" when
      // the host is on another port, or the firewall denied Node.
      const host = `\u2717 could not reach ${target.display}`;
      this.ui.status.textContent = target.source === 'origin'
        ? `${host} \u2014 is the host running \`npm run serve\`?`
        : `${host} \u2014 check the address under Advanced (${target.display})`; 
      if (e?.message && !/connection failed|timed out/i.test(String(e.message))) {
        this.ui.status.textContent = '\u2717 ' + e.message; // a server refusal (bad code, …) is specific: keep it
      }
      this.setBusy(false);
      this._failAutoJoin(); // a deep link that can't work must not retry itself on every refresh
    }
  }

  // ---- invite link --------------------------------------------------------
  /** `GET /info` from the server that served this page: LAN addresses + port. Cached per session. */
  async _fetchInfo() {
    if (this._info) return this._info;
    try {
      const r = await fetch('/info', { cache: 'no-store' });
      if (!r.ok) return null;
      this._info = await r.json();
      return this._info;
    } catch { return null; } // opened from disk, or a static host with no /info: fall back quietly
  }

  /**
   * Build the shareable link once we have a world code. A browser cannot report its own LAN IP, so
   * a host asks the server (`/info`) and never publishes `localhost` in a link meant for other
   * people; a joiner's link points at the gateway they actually connected to, so forwarding it works.
   */
  async _publishInvite() {
    const code = this.client.code;
    if (!code) return;
    let host = this._target?.host ?? location.hostname;
    let port = this._target?.port ?? (Number(location.port) || 8080);
    const secure = this._target?.secure ?? location.protocol === 'https:';
    this._inviteSecure = secure;
    this._inviteHost = null;
    if (this.client.mode === 'host' && isLocalOnly(host)) {
      const info = await this._fetchInfo();
      if (info?.host && !isLocalOnly(info.host)) host = info.host;
      if (info?.port) port = Number(info.port) || port;
    }
    this._inviteDefaults = { host, port };
    // A multi-homed host (Wi-Fi + Ethernet + VPN) should be able to pick which network to invite on.
    const info = this.client.mode === 'host' ? await this._fetchInfo() : null;
    const alts = (info?.lan ?? []).filter((i) => i.address && i.address !== host).slice(0, 4);
    if (alts.length) {
      this.ui.inviteAlt.hidden = false;
      this.ui.inviteAlt.innerHTML = 'other networks: ' + alts
        .map((i) => `<span class="coop-alt" data-addr="${esc(i.address)}" title="advertise on ${esc(i.name)}">${esc(i.address)}</span>`)
        .join(' \u00b7 ');
    } else {
      this.ui.inviteAlt.hidden = true;
      this.ui.inviteAlt.innerHTML = '';
    }
    this._showInvite();
  }

  _showInvite() {
    const { host, port } = this._inviteDefaults ?? {};
    if (!host || !this.client.code) return;
    this._invite = buildInvite({
      host: this._inviteHost || host, port, code: this.client.code, secure: this._inviteSecure,
    });
    this.ui.invite.value = this._invite;
    this.ui.inviteRow.hidden = false;
  }

  /**
   * Copy the invite. `navigator.clipboard` needs a secure context and a LAN is plain http, so the
   * selection route is the normal path here, not a rare fallback; worst case the text is left
   * selected for ⌘C.
   */
  async copyInvite() {
    const text = this.ui.invite.value || this._invite;
    if (!text) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; }
    } catch { /* permission denied / not a secure context → fall through */ }
    if (!copied) {
      try {
        this.ui.invite.focus();
        this.ui.invite.select();
        copied = document.execCommand?.('copy') ?? false;
      } catch { copied = false; }
    }
    if (copied) {
      this.ui.copyInvite.textContent = 'Copied';
      clearTimeout(this._copyTimer);
      this._copyTimer = setTimeout(() => { this.ui.copyInvite.textContent = 'Copy'; }, 1200);
    } else {
      this.ui.invite.select();
      this.ui.status.textContent = '\u26a0 copy blocked by the browser \u2014 the link is selected, press \u2318C';
    }
  }

  /** Drop `#join=…` so a manual Disconnect (or a failed auto-join) isn't undone by a refresh. */
  _clearJoinHash() {
    try {
      if (joinCodeFromHash(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    } catch { /* file:// or a sandboxed history: nothing to clear */ }
  }

  _failAutoJoin() {
    if (!this._autoJoined) return;
    this._autoJoined = false;
    this._clearJoinHash();
  }

  // ---- layout -------------------------------------------------------------
  /** Connected: swap Host/Join row for Disconnect, reveal code + deploy + fleet. Joiners lose the bottom sim controls; hosts keep them. */
  setConnectedLayout(on) {
    this.ui.fields.hidden = on; // gateway URL + name only make sense for a fresh connection
    this.ui.row.hidden = on;
    this.ui.disconnect.hidden = !on;
    this.ui.code.hidden = !on;
    this.ui.deploy.disabled = !on; // grey out until a world is actually joined/hosted
    this.ui.inviteRow.hidden = !on;
    if (!on) {
      this.ui.remoteFleet.hidden = true;
      this.ui.remoteFleet.innerHTML = '';
      this.ui.inviteAlt.hidden = true;
      this.ui.inviteAlt.innerHTML = '';
      this.ui.invite.value = '';
      this._invite = null;
      this._inviteHost = null;
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
    // Fleet layouts move OTHER people's bots, so they are host-only — and hidden entirely
    // outside a connected world, where there is no shared population to arrange.
    if (this.ui.arrange) this.ui.arrange.hidden = !this._wasConnected || hide;
  }

  setBusy(busy) { for (const el of [this.ui.host, this.ui.join, this.ui.disconnect]) if (el) el.disabled = busy; }

  renderStatus(lead) {
    const c = this.client;
    if (c.status !== 'connected') return;
    const n = c.clients.length;
    const you = c.you ? ` · ${esc(c.you.name)} (${c.you.role})` : '';
    this.ui.status.textContent =
      `${lead ?? (c.mode === 'host' ? 'hosting' : 'in world')} ${this.client.code ?? ''}` +
      ` · ${this._target?.display ?? c.url}` +
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
    el.hidden = rows.length === 0;
    // Rebuild the rows only when membership or role changes; otherwise patch counts/disabled state
    // IN PLACE. A full innerHTML wipe ran at snapshot rate (15 Hz) and destroyed the −/+/✕ buttons
    // mid-press, so most real mouse clicks were swallowed before the delegated handler saw them
    // (a click only registers when mousedown+mouseup hit the same element) — hosts had to spam the
    // buttons for seconds before one went through. Programmatic .click() in the smoke tests never
    // exposed this because it dispatches synchronously.
    const key = (isAdmin ? 'A' : '') + ':' + rows.map((r) => r.protoId ?? '').join(',');
    if (key !== this._fleetKey) {
      this._fleetKey = key;
      el.innerHTML = '';
      for (const r of rows) el.appendChild(this._makeFleetRow(r, isAdmin, c.you?.protoId));
      return;
    }
    const live = new Map(Array.from(el.querySelectorAll('.fleet-row')).map((row) => [row.dataset.protoId, row]));
    for (const r of rows) {
      const row = live.get(r.protoId ?? '');
      if (!row) continue; // membership changed → next call rebuilds
      row.querySelector('.fleet-count').textContent =
        `${r.count} bot${r.count === 1 ? '' : 's'}${isAdmin && r.protoId !== c.you?.protoId ? ' · other' : ''}`;
      const input = row.querySelector('.fleet-count-input');
      if (input && document.activeElement !== input) input.value = r.count; // never clobber a half-typed number
      for (const act of ['minus', 'plus', 'remove']) {
        const b = row.querySelector(`button[data-act="${act}"]`);
        if (!b) continue;
        b.dataset.count = r.count;
        b.disabled = act === 'plus' ? r.count >= MAX_FLEET : r.count === 0;
      }
    }
  }

  /** One fleet row (host gets −/+/✕); stable DOM so renderFleet can patch it without stealing clicks. */
  _makeFleetRow(r, isAdmin, myProtoId) {
    const row = document.createElement('div');
    row.className = 'fleet-row';
    row.dataset.protoId = r.protoId ?? '';
    row.innerHTML =
      `<span class="fleet-name">${esc(r.name)}</span>` +
      `<span class="dim fleet-count">${r.count} bot${r.count === 1 ? '' : 's'}${isAdmin && r.protoId !== myProtoId ? ' · other' : ''}</span>`;
    if (isAdmin && r.protoId) {
      const mk = (act, label, title, disabled) =>
        `<button data-act="${act}" data-proto-id="${esc(r.protoId)}" data-count="${r.count}" ${disabled ? 'disabled' : ''} title="${title}">${label}</button>`;
      row.innerHTML +=
        `<span class="fleet-btns">` +
        mk('minus', '−', `Remove one of ${r.name}'s bots`, r.count === 0) +
        `<input class="fleet-count-input" type="number" min="0" max="${MAX_FLEET}" step="1" value="${r.count}"` +
        ` data-proto-id="${esc(r.protoId)}" aria-label="Fleet size for ${esc(r.name)}"` +
        ` title="Type the exact number of bots, press Enter">` +
        mk('plus', '+', `Add one bot to ${r.name}'s fleet`, r.count >= MAX_FLEET) +
        mk('remove', '✕', `Remove all of ${r.name}'s bots`, r.count === 0) +
        `</span>`;
    }
    return row;
  }
}

export default CoopPanel;
