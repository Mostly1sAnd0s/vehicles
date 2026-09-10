/**
 * App bootstrap: load configs + sample documents, wire up tabs,
 * file import/export, and recents (localStorage).
 */

import { VehicleEditor } from './editor.js';
import { WorldSim } from './world.js';
import { CoopPanel } from './coopPanel.js';
import { blankVehicle } from './prototypes.js';

const $ = id => document.getElementById(id);

async function main() {
  const load = async p => JSON.parse(await (await fetch(p)).text());
  const [appCfg, uiCfg, components, sensors, actuators, worldCfg] = await Promise.all([
    load('config/app.json'),
    load('config/ui.json').catch(() => ({ keybindings: {} })),
    load('config/components.json'),
    load('config/sensors.json'),
    load('config/actuators.json'),
    // OPTIONAL: world.json carries the solid-light defaults. Optional so a checkout whose
    // public/config/ predates the file still boots — every read of it has a built-in
    // fallback in src/models/solidBody.js.
    load('config/world.json').catch(() => ({})),
  ]);

  // Sentinel owner for the co-op design edit slot: while it's set, editor changes land in
  // state.coopVehicle (what "Deploy design" ships) instead of a local world prototype.
  const COOP_DESIGN_MARKER = { __coopDesign: true };
  const state = {
    configs: { app: appCfg, ui: uiCfg, components, sensors, actuators, world: worldCfg },
    vehicle: null,
    world: null,
    coopVehicle: null, // this participant's design for the shared world (null until edited/deployed)
  };

  const [vehicle, world] = await Promise.all([
    load('vehicles/sun-car.json').catch(() => blankVehicle()),
    load('worlds/light-field.json').catch(() => blankWorld()),
  ]);
  state.vehicle = vehicle;
  state.world = world;

  // resolve vehicle references used by prototypes (inlined for simulation)
  await Promise.all(
    world.vehiclePrototypes.map(async p => {
      if (!p.vehicle && p.vehicleRef) {
        try { p._vehicle = await load(p.vehicleRef); } catch { p._vehicle = blankVehicle(); }
      } else if (p.vehicle) {
        p._vehicle = p.vehicle;
      }
    })
  );

  // ---------- tabs (editor / world) ----------
  // Co-op is no longer a tab: it lives in the World sidebar (coopPanel below), so the
  // standalone panel + its top-bar chrome are gone.
  const tabEditor = $('tab-editor');
  const tabWorld = $('tab-world');
  let worldSim = null;

  function activate(name) {
    const isWorld = name === 'world';
    // active tab button + panel.
    tabEditor.classList.toggle('active', !isWorld);
    tabWorld.classList.toggle('active', isWorld);
    $('panel-editor').classList.toggle('active', !isWorld);
    $('panel-world').classList.toggle('active', isWorld);
    // Contextual top-bar chrome:
    //  - the "Vehicle Editor" button is gone (reached via a vehicle's Edit control);
    //  - "Done" (was "World") appears only while editing a vehicle;
    //  - each page shows only its own load/save pair (the world buttons don't
    //    operate on the editor's in-progress vehicle, and vice-versa).
    tabEditor.hidden = true;
    tabWorld.hidden = isWorld;
    $('import-vehicle').hidden = isWorld;
    $('export-vehicle').hidden = isWorld;
    $('import-world').hidden = !isWorld;
    $('export-world').hidden = !isWorld;
  }

  // ---------- World sidebar tabs (Sandbox / Co-Op) + mode-transition overlay ----------
  // The World view's left pane is split into two modes so the user only sees the controls for the
  // mode they are in: Sandbox (elements + vehicles) and Co-Op (gateway/name/host/join/etc.).
  // Joining a shared world disables the Sandbox tab; leaving re-enables it. A brief overlay
  // ("Joining/Leaving world…") covers the canvas while the world clears and swaps modes.
  // (These are the World-view sub-tabs, NOT the retired top-level Co-op tab; distinct ids on
  // purpose so tests that assert `!#tab-coop` for the standalone tab keep passing.)
  const sideTabSandbox = $('mode-sandbox');
  const sideTabCoop = $('mode-coop');
  const paneSandbox = $('side-pane-sandbox');
  const paneCoop = $('side-pane-coop');
  const worldTransition = $('world-transition');
  const worldTransitionMsg = $('world-transition-msg');

  function setSideTab(name) { // 'sandbox' | 'coop' — swap which pane's controls are visible
    const coop = name === 'coop';
    sideTabSandbox.classList.toggle('active', !coop);
    sideTabCoop.classList.toggle('active', coop);
    paneSandbox.hidden = coop;
    paneCoop.hidden = !coop;
  }

  // Deactivating the Sandbox tab means we are in a shared world: show Co-Op controls and grey the
  // (now-disabled) Sandbox tab. Re-enabling it (leaving) puts us back on the single-player world.
  function setSandboxDisabled(disabled) {
    sideTabSandbox.disabled = disabled;
    setSideTab(disabled ? 'coop' : 'sandbox');
  }

  // The transition overlay: shown when a join/leave starts, then held for at least minMs so the
  // animation is visible even if the socket round-trip is fast. _wtShownAt tracks when it went up,
  // so the minimum time is measured from the reveal rather than from the (earlier) trigger.
  let _wtShownAt = 0;
  let _wtHideTimer = null;
  function showWorldTransition(msg) {
    clearTimeout(_wtHideTimer);
    _wtShownAt = performance.now();
    if (msg) worldTransitionMsg.textContent = msg;
    worldTransition.hidden = false;
  }
  function hideWorldTransition(minMs = 750) {
    clearTimeout(_wtHideTimer);
    const wait = Math.max(0, minMs - (performance.now() - _wtShownAt));
    _wtHideTimer = setTimeout(() => { worldTransition.hidden = true; }, wait);
  }

  sideTabSandbox.onclick = () => { if (!sideTabSandbox.disabled) setSideTab('sandbox'); };
  sideTabCoop.onclick = () => { if (!sideTabCoop.disabled) setSideTab('coop'); };
  setSideTab('sandbox'); // default: the single-player sandbox is shown first

  const editor = new VehicleEditor($('editor-canvas'), {
    palette: $('palette'),
    gatePalette: $('gate-palette'),
    bodyColor: $('body-color'),
    placedList: $('placed-list'),
    wireList: $('wire-list'),
    wiringErrors: $('wiring-errors'),
    inspector: $('inspector'),
  }, state, {
    // The world tab guards its own shortcuts; the editor needs the same gate so Delete/Backspace
    // on the World view cannot delete a component still selected in the (hidden) editor.
    isEditorTabActive: () => $('panel-editor').classList.contains('active'),
    // NOTE: onVehicleChanged is installed below (single wrapper handling prototype propagation
    // AND co-op live-sync). The pre-wrapper version here — which propagated edits to "Vehicle A
    // or !p._vehicleOwnerName" — was overwritten before ever running, and _vehicleOwnerName was
    // never assigned anywhere.
  });

  function initWorldSim() {
    if (worldSim) return;
    worldSim = new WorldSim($('world-canvas'), {
      addLight: $('add-light'),
      addRock: $('add-rock'),
      addWall: $('add-wall'),
      btnPlay: $('btn-play'),
      btnStep: $('btn-step'),
      btnReset: $('btn-reset'),
      timescale: $('timescale'),
      timescaleVal: $('timescale-val'),
      btnBeams: $('btn-beams'),
      btnValues: $('btn-values'),
      btnPaths: $('btn-paths'),
      addVehicle: $('add-vehicle'),
      prototypes: $('prototypes'),
      worldInspector: $('world-inspector'),
    }, state, {
      isWorldTabActive: () => tabWorld.classList.contains('active'),
      openEditor: proto => {
        // load this prototype's vehicle into the editor (propagation on change)
        state.vehicle = clone(proto._vehicle ?? blankVehicle());
        state.vehicleOwner = proto;
        editor.refresh();
        activate('editor');
      },
      // Co-op (M5 p3): the host's add/drag of elements syncs out to the shared world.
      onElementChange: (info) => {
        const c = coopPanel.client;
        if (c.status !== 'connected' || c.you?.role !== 'admin') return; // single-player or read-only
        if (info.op === 'add') c.addElement(info.element);
        else if (info.op === 'move') c.moveElement(info.id, info.x, info.y);
        else if (info.op === 'remove') c.removeElement(info.id); // inspector Delete — without this
        else if (info.op === 'update') c.updateElement(info.id, info.patch); // rot/scale/intensity/…
      },
      // Co-op (M5 p3): shared-world bots render on top of the local world (both roles).
      remoteBots: () => {
        const c = coopPanel.client;
        if (c.status !== 'connected') return [];
        // isMine keys on the participant TOKEN (names can collide — two people, or the random
        // Bot-NN default, can share one; name-equality mis-attributed the highlight/popups).
        return c.bots.map((b) => ({ ...b, mine: c.isMine(b) }));
      },
      // Co-op: Play/Pause/Reset run the SHARED world (server-authoritative); the button label
      // comes back via the authoritative `state` message (worldSim.setRunning).
      onSharedControl: (cmd) => coopPanel.client.controls(cmd),
      // Co-op (M5 p3): the host may drag shared-world bots on the canvas; participants may not.
      isCoopAdmin: () => {
        const c = coopPanel.client;
        return c.status === 'connected' && c.you?.role === 'admin';
      },
      // Co-op (M5 p3): a dragged/edited shared bot syncs out to the server (host only;
      // server-authoritative). `rot` (radians) comes from the inspector's Rot field.
      onBotChange: (info) => {
        const c = coopPanel.client;
        if (c.status !== 'connected' || c.you?.role !== 'admin') return; // single-player or read-only
        c.moveBot(info.id, info.x, info.y, info.rot);
        // Optimistic: patch the snapshot bot so canvas + popup reflect the pose before the
        // server's echo arrives (the immediate broadcast corrects it within a few ms).
        const b = (c.bots ?? []).find(bb => bb.id === info.id);
        if (b) {
          b.x = info.x; b.y = info.y;
          if (info.rot != null && Number.isFinite(info.rot)) b.angle = info.rot;
        }
      },
    });
  }

  tabEditor.onclick = () => activate('editor');
  tabWorld.onclick = () => { activate('world'); initWorldSim(); };
  activate('editor'); // sync the top bar to the default (editor) view

  // ---------- co-op sidebar panel (always in the DOM with the World page) ----------
  const coopPanel = new CoopPanel({
    hostAddr: $('coop-host-addr'), advanced: $('coop-advanced'), advancedTag: $('coop-advanced-tag'),
    hostAddrHint: $('coop-host-addr-hint'),
    name: $('coop-gw-name'), fields: $('coop-gw-fields'), row: $('coop-gw-row'),
    host: $('coop-host'), join: $('coop-join'), joinCode: $('coop-join-code'),
    disconnect: $('coop-disconnect'), code: $('coop-gw-code'), status: $('coop-gw-status'),
    deploy: $('coop-deploy'), editDesign: $('coop-edit'),
    invite: $('coop-invite'), inviteRow: $('coop-invite-row'), inviteAlt: $('coop-invite-alt'),
    copyInvite: $('coop-copy'),
    remoteFleet: $('remote-fleet'),
  }, {
    // An invite link (`#join=CODE`) connects without a click, so bring the World view up first —
    // otherwise you would join a shared world you cannot see.
    onDeepLink: () => { activate('world'); initWorldSim(); },
    // World mode transition (Sandbox ⇄ Co-Op tabs + canvas overlay): shown when the user presses
    // Host/Join (the world clears to "Joining world…") and again on Disconnect ("Leaving world…").
    // The Sandbox tab is disabled/enabled from the client.onMessage handler below, once the shared
    // world has actually loaded or gone.
    onConnectStart: () => { setSideTab('coop'); showWorldTransition('Joining world…'); },
    onDisconnectStart: () => { showWorldTransition('Leaving world…'); },
    // "Deploy design" ships the participant's co-op design (falls back to the editor's live
    // vehicle before a co-op design exists).
    getVehicle: () => state.coopVehicle ?? state.vehicle,
    // "Edit my design": open the editor on THIS participant's co-op design. Hosts and joiners
    // alike edit their own vehicle this way; deploying then updates it in the shared world.
    onEditDesign: () => {
      if (coopPanel.client.status !== 'connected') return;
      if (!state.coopVehicle) state.coopVehicle = clone(state.vehicle); // seed from the current design
      state.vehicle = clone(state.coopVehicle);
      state.vehicleOwner = COOP_DESIGN_MARKER;
      editor.refresh();
      activate('editor');
    },
  });

  // App-level co-op binding (M5 p3): the World canvas IS the shared world.
  const addElementBtns = [ $('add-light'), $('add-rock'), $('add-wall') ];
  coopPanel.client.onMessage((msg) => {
    const c = coopPanel.client;
    if (msg.type === 'welcome') {
      // The host edits elements on the canvas; participants get a mirrored read-only world.
      const isHost = c.you?.role === 'admin';
      for (const b of addElementBtns) b.disabled = !isHost;
      if (isHost && c.mode === 'host') {
        // Seed the shared world with the host's whole local element list — otherwise a joiner
        // would only ever see elements added AFTER joining (the pre-loaded world never crossed
        // the wire).
        c.setElements(clone(state.world.elements));
      } else if (!isHost) {
        // Mirror immediately on join (welcome carries the current shared elements), not just on
        // later host edits. Remember the home world so we can restore it when the session ends.
        state._localElementsBackup = clone(state.world.elements);
        state.world.elements = clone(c.elements ?? []);
      }
      // The World canvas IS the shared world from here on (both roles): stop the local
      // simulation's stepping/drawing of its home instances; bots ride on snapshots.
      if (!worldSim) initWorldSim();
      worldSim.setCoop(true);
      worldSim.setRunning(c.running); // welcome carries the authoritative running flag
      worldSim.buildObstacles();
      setSandboxDisabled(true); // in a shared world: the single-player Sandbox tab is no longer usable
      hideWorldTransition();    // the "Joining world…" overlay can lift — the co-op world is live
    } else if (msg.type === 'elements' && c.status === 'connected' && c.you?.role !== 'admin') {
      // Mirror the host's edit: replace the local static elements and rebuild obstacle bodies.
      state.world.elements = clone(msg.elements ?? []);
      worldSim?.buildObstacles();
      // Keep an open read-only element popup live during the host's drag, and drop it if the
      // host deleted the selected element. (Inputs are disabled here, so no focus is at risk.)
      worldSim?.renderInspector();
    } else if (msg.type === 'snapshot') {
      // Accrue one motion-trail point per bot (Paths toggle reads these client-side).
      worldSim?.onCoopSnapshot();
    } else if (msg.type === 'state') {
      // Authoritative running flag flips the Play/Pause label; reset clears local trails.
      worldSim?.setRunning(msg.running);
      if (msg.reset) worldSim?.clearCoopPaths();
    } else if (msg.type === 'closed' || msg.type === 'worldClosed') {
      for (const b of addElementBtns) b.disabled = false; // back to single-player editing
      // Return the participant to their home world (the shared mirror is gone now).
      if (c.you?.role !== 'admin' && state._localElementsBackup) {
        state.world.elements = clone(state._localElementsBackup);
        state._localElementsBackup = null;
      }
      // Back to single-player: the local world steps + draws its own instances again.
      worldSim?.setCoop(false);
      worldSim?.buildObstacles();
      setSandboxDisabled(false); // left the shared world: the Sandbox tab is usable again
      hideWorldTransition();     // the "Leaving world…" overlay can lift — home world restored
    }
  });

  // Single editor-change seam: propagate to the OWNER prototype and (co-op) live-sync the
  // deployed design. Co-op: once a participant has deployed, LIVE edits re-deploy automatically (throttled). The
  // server rebuilds each clone's body in place (pose + momentum preserved), so picking a body
  // color in the editor updates your running shared bot within ~400ms — no second "Deploy
  // design" click. A content signature skips no-op resends (refresh() churn is common).
  let _coopSyncSig = null;
  let _coopSyncTimer = null;
  const coopHasDeployedBots = () => {
    const c = coopPanel.client;
    return c.status === 'connected' && (c.bots ?? []).some(b => c.isMine(b));
  };
  editor.hooks.onVehicleChanged = v => {
    const w = state.world.vehiclePrototypes.find(p => p === (state.vehicleOwner ?? null));
    if (w) w._vehicle = clone(v);
    // Co-op: while editing the participant's own co-op design, remember it there — "Deploy
    // design" ships this exact document into the shared world.
    if (state.vehicleOwner === COOP_DESIGN_MARKER) state.coopVehicle = clone(v);
    // keep any running sim in step with the edit (signature-guarded: wire
    // maps refresh on wiring changes, bodies only on geometry changes)
    worldSim?.syncInstances();
    // Co-op live sync: ship the same doc "Deploy design" would ship right now. While editing the
    // coop design that is state.coopVehicle (just updated above); otherwise the coop design if
    // one exists, else the editor's current vehicle. Skipped until something actually deployed.
    if (coopHasDeployedBots()) {
      const doc = state.coopVehicle ?? v;
      const sig = JSON.stringify(doc);
      if (sig !== _coopSyncSig) {
        _coopSyncSig = sig;
        clearTimeout(_coopSyncTimer);
        _coopSyncTimer = setTimeout(() => coopPanel.client.deploy(clone(doc)), 400);
      }
    }
  };

  // ---------- file import/export ----------
  let importingKind = null;
  $('import-vehicle').onclick = () => { importingKind = 'vehicle'; $('file-input').click(); };
  $('import-world').onclick = () => { importingKind = 'world'; $('file-input').click(); };
  $('file-input').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (importingKind === 'vehicle') {
        state.vehicle = data;
        editor.refresh();
        addRecent(f.name, 'vehicle', data);
      } else {
        state.world = data;
        await Promise.all(
          data.vehiclePrototypes.map(async p => {
            if (!p._vehicle && !p.vehicle && p.vehicleRef) {
              try { p._vehicle = JSON.parse(await (await fetch(p.vehicleRef)).text()); } catch { /* ignore */ }
            } else if (p.vehicle) p._vehicle = p.vehicle;
          })
        );
        worldSim?.renderPrototypes();
        addRecent(f.name, 'world', data);
      }
    } catch (err) {
      alert('Could not parse JSON: ' + err.message);
    }
    e.target.value = '';
  };

  const download = (name, data) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('export-vehicle').onclick = () => {
    download(`${state.vehicle.id ?? 'vehicle'}.json`, state.vehicle);
    addRecent(`${state.vehicle.id}.json`, 'vehicle', state.vehicle);
  };
  $('export-world').onclick = () => {
    download(`${state.world.name ?? 'world'}.json`, state.world);
    addRecent(`${state.world.name}.json`, 'world', state.world);
  };

  // ---------- recents (localStorage) ----------
  const RECENTS_KEY = 'bv.recents';
  function loadRecents() {
    try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) ?? []; } catch { return []; }
  }
  function addRecent(name, kind, data) {
    const recents = loadRecents().filter(r => r.name !== name);
    recents.unshift({ name, kind, ts: Date.now(), data });
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, 12)));
    refreshRecentSelect();
  }
  function refreshRecentSelect() {
    const sel = $('recent-select');
    sel.innerHTML = '<option value="">Recents…</option>';
    for (const r of loadRecents()) {
      const o = document.createElement('option');
      o.value = String(r.ts);
      o.textContent = `[${r.kind}] ${r.name}`;
      sel.appendChild(o);
    }
  }
  $('recent-select').onchange = e => {
    const r = loadRecents().find(x => String(x.ts) === e.target.value);
    if (!r) return;
    if (r.kind === 'vehicle') { state.vehicle = clone(r.data); editor.refresh(); activate('editor'); }
    else { state.world = clone(r.data); worldSim?.renderPrototypes(); activate('world'); }
    e.target.value = '';
  };
  refreshRecentSelect();

  // seed owner so initial edits propagate to the first prototype
  state.vehicleOwner = state.world.vehiclePrototypes[0] ?? null;
  state.vehicleOwner && (state.vehicleOwner._vehicle = clone(state.vehicle));

  // Reflect the app version in the title bar. The number lives in package.json
  // and is copied to public/config/version.json by scripts/sync-config.mjs on
  // every build/serve, so bumping the version there updates the UI automatically.
  try {
    const v = JSON.parse(await load('config/version.json'));
    if (v && v.version) $('app-brand').textContent = `Vehicle Sandbox v${v.version}`;
  } catch { /* version file optional until a build has run; keep the static title */ }

  // A deep-linked invite (`#join=CODE`) is the whole join flow: prefill + connect, no clicks. Run
  // last, so the panel, the World sim and the tab wiring all exist by the time it fires.
  coopPanel.autoJoinFromLink();

  // debug/test handle (used by headless smoke tests)
  window.__app = () => ({ state, get worldSim() { return worldSim; }, get editor() { return editor; }, get coopPanel() { return coopPanel; } });
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

function blankWorld() {
  return {
    schemaVersion: 1,
    name: 'New World',
    physics: { gravity: 0, timeScale: 1 },
    elements: [],
    vehiclePrototypes: [{ id: 'proto1', name: 'Vehicle A', vehicleRef: '', _vehicle: null, instances: [] }],
  };
}

main().catch(err => {
  console.error(err);
  document.body.innerHTML += `<pre style="color:#ff5d5d;padding:12px">${err.stack}</pre>`;
});
