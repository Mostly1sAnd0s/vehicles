/**
 * Co-op shared-world view (PLAN.md §Multi-User, phase M2).
 *
 * The thin, pixel-facing half of M2. It owns a canvas + a join bar and renders the *server's*
 * authoritative world as a read-only live view, driven by snapshot messages from `CoopClient`
 * (the socket/state core in src/net/client.js). Static elements are normalized with the same
 * `worldElementsToSnapshot` the single-player view uses, and bots are drawn with the same visual
 * conventions as worldDraw.js — so the shared arena looks like a normal Braitenberg world.
 *
 * It renders on snapshot arrival (~15Hz) rather than a hot requestAnimationFrame loop: snapshots
 * replace bot state wholesale (no old+new pair to interpolate), so redrawing at the message rate
 * is both correct and cheaper. A single coalesced rAF also fires for local pan/zoom.
 */
import { CoopClient } from '../src/net/client.js';
import { worldElementsToSnapshot } from '../src/simulation/worldSnapshot.js';
import { lightenHex, DEFAULT_BODY_COLOR } from './color.js';

const URL_KEY = 'coop.url';
const NAME_KEY = 'coop.name';

export class CoopWorld {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} ui  {name, url, connect, status, deploy} — form/label elements.
   * @param {() => object} [getVehicle]  returns the current design doc to deploy (editor's vehicle).
   */
  constructor(canvas, { ui = {}, getVehicle = null } = {}) {
    this.canvas = canvas;
    this.ui = ui;
    this.getVehicle = getVehicle;
    this.client = new CoopClient();
    this.view = { x: 0, y: 0, zoom: 1 };
    this._snap = { lights: [], obstacles: [] };
    this._raf = 0;

    if (ui.name) { try { ui.name.value = localStorage.getItem(NAME_KEY) ?? ''; } catch {} }
    if (ui.url) {
      let u; try { u = localStorage.getItem(URL_KEY); } catch {}
      ui.url.value = u ?? 'ws://localhost:8090';
    }
    this._bind();
  }

  _bind() {
    const c = this.client;
    // Status line + lifecycle, driven by the message stream.
    c.onMessage((m) => {
      if (this.ui.status && m.type === 'closed') this.setStatus('disconnected');
      else if (m.type === 'peerDeployed' && this.ui.status) this.setStatus(`${m.name} deployed a bot`);
      else if (m.type === 'countSet' && this.ui.status) this.setStatus(`clones set to ${m.count}`);
      this.requestRender(); // any message that may have changed the world (snapshot, welcome…)
    });

    const enter = () => { if (c.status === 'connected') this.connect(); };
    if (this.ui.connect) {
      this.ui.connect.addEventListener('click', () => this.connect());
      this.ui.name?.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
    }
    if (this.ui.deploy) this.ui.deploy.addEventListener('click', () => this.deploy());

    // Local pan/zoom so a participant can follow their bots.
    let drag = null;
    this.canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, v0: { ...this.view } }; });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      this.view.x = drag.v0.x - (e.clientX - drag.x) / this.view.zoom;
      this.view.y = drag.v0.y - (e.clientY - drag.y) / this.view.zoom;
      this.requestRender();
    });
    window.addEventListener('mouseup', () => { drag = null; });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this._at(e.clientX, e.clientY);
      this.view.zoom = Math.max(0.2, Math.min(3, this.view.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
      const after = this._at(e.clientX, e.clientY);
      this.view.x += before.x - after.x;
      this.view.y += before.y - after.y;
      this.requestRender();
    }, { passive: false });

    this.requestRender(); // paint the empty/waiting state once
  }

  _at(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - r.width / 2) / this.view.zoom + this.view.x,
             y: (clientY - r.top - r.height / 2) / this.view.zoom + this.view.y };
  }

  setStatus(text) { if (this.ui.status) this.ui.status.textContent = text; }

  /** Open the socket and join under the chosen name. */
  async connect() {
    const c = this.client;
    if (c.status === 'connecting' || c.status === 'connected') return;
    const name = (this.ui.name?.value ?? '').trim() || 'guest';
    const url = (this.ui.url?.value ?? '').trim() || 'ws://localhost:8090';
    try { localStorage.setItem(NAME_KEY, name); localStorage.setItem(URL_KEY, url); } catch {}
    this.setStatus(`connecting to ${url}…`);
    try {
      await c.connect(url, name);
    } catch (e) {
      this.setStatus('could not connect: ' + (e?.message ?? e));
      return;
    }
    this._snap = worldElementsToSnapshot(c.elements);
    this.setStatus(`connected as ${c.you?.name} (${c.you?.role}) · ${c.bots.length} bot(s) in the world`);
    this.requestRender();
  }

  /** Push the current design into the shared world (owner-only on the server; preview of M3). */
  deploy() {
    const c = this.client;
    if (c.status !== 'connected') { this.setStatus('not connected'); return; }
    const v = this.getVehicle?.();
    if (!v) { this.setStatus('no design to deploy yet'); return; }
    c.deploy(v);
    this.setStatus(`deploying your design… (running as ${c.you?.name})`);
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _render() {
    const cv = this.canvas;
    if (!cv?.getContext) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(cv.clientWidth * dpr) || cv.height !== Math.round(cv.clientHeight * dpr)) {
      cv.width = Math.round(cv.clientWidth * dpr);
      cv.height = Math.round(cv.clientHeight * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.translate(cv.clientWidth / 2, cv.clientHeight / 2);
    ctx.scale(this.view.zoom, this.view.zoom);
    ctx.translate(-this.view.x, -this.view.y);

    // lights: radial glow (same convention as the local world view)
    for (const l of this._snap.lights ?? []) {
      const r = 14 * Math.log2(2 + (l.intensity ?? 100));
      const g = ctx.createRadialGradient(l.x, l.y, 2, l.x, l.y, Math.max(r * 4, 60));
      g.addColorStop(0, 'rgba(255,230,150,.95)');
      g.addColorStop(0.25, 'rgba(255,200,90,.35)');
      g.addColorStop(1, 'rgba(255,200,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(l.x, l.y, Math.max(r * 4, 60), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffe08a';
      ctx.beginPath(); ctx.arc(l.x, l.y, r * 0.5, 0, Math.PI * 2); ctx.fill();
    }

    // obstacles
    for (const o of this._snap.obstacles ?? []) {
      ctx.fillStyle = '#3a4657'; ctx.strokeStyle = '#55647a'; ctx.lineWidth = 1.5;
      if (o.type === 'circle') {
        ctx.beginPath(); ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else {
        ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rotation ?? 0);
        ctx.fillRect(-o.width / 2, -o.height / 2, o.width, o.height);
        ctx.strokeRect(-o.width / 2, -o.height / 2, o.width, o.height);
        ctx.restore();
      }
    }

    const me = this.client.you?.name ?? null;
    for (const b of this.client.bots) {
      const mine = me != null && b.owner === me;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.angle);
      const color = b.color || DEFAULT_BODY_COLOR;
      ctx.fillStyle = color;
      ctx.strokeStyle = mine ? '#ffffff' : lightenHex(color);
      ctx.lineWidth = mine ? 2.5 : 1.5;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      // heading tick on the front edge
      ctx.beginPath(); ctx.moveTo(b.w / 2, 0); ctx.lineTo(b.w / 2 + 6, 0);
      ctx.strokeStyle = mine ? '#ffffff' : 'rgba(255,255,255,.5)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
      if (b.owner) {
        ctx.fillStyle = mine ? '#ffffff' : 'rgba(225,238,255,.72)';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(mine ? `${b.owner} (you)` : b.owner, b.x, b.y - b.h / 2 - 6);
      }
    }

    // friendly hint when the arena is empty
    if (this.client.status === 'connected' && this.client.bots.length === 0) {
      ctx.fillStyle = 'rgba(200,215,235,.55)';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No bots yet — deploy a design, or wait for another participant to.', 0, -10);
    }
  }

  dispose() { this.client.close(); if (this._raf) cancelAnimationFrame(this._raf); }
}

export default CoopWorld;
