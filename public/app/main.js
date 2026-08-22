/**
 * App bootstrap: load configs + sample documents, wire up tabs,
 * file import/export, and recents (localStorage).
 */

import { VehicleEditor } from './editor.js';
import { WorldSim } from './world.js';
import { CoopWorld } from './coop.js';
import { blankVehicle } from './prototypes.js';

const $ = id => document.getElementById(id);

async function main() {
  const load = async p => JSON.parse(await (await fetch(p)).text());
  const [appCfg, uiCfg, components, sensors, actuators] = await Promise.all([
    load('config/app.json'),
    load('config/ui.json').catch(() => ({ keybindings: {} })),
    load('config/components.json'),
    load('config/sensors.json'),
    load('config/actuators.json'),
  ]);

  const state = {
    configs: { app: appCfg, ui: uiCfg, components, sensors, actuators },
    vehicle: null,
    world: null,
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

  // ---------- tabs ----------
  const tabEditor = $('tab-editor');
  const tabWorld = $('tab-world');
  const tabCoop = $('tab-coop');
  let worldSim = null;
  let coop = null;

  function activate(name) {
    const isWorld = name === 'world';
    const isCoop = name === 'coop';
    // active tab button + panel (N-tab safe).
    tabEditor.classList.toggle('active', !isWorld && !isCoop);
    tabWorld.classList.toggle('active', isWorld);
    tabCoop.classList.toggle('active', isCoop);
    $('panel-editor').classList.toggle('active', !isWorld && !isCoop);
    $('panel-world').classList.toggle('active', isWorld);
    $('panel-coop').classList.toggle('active', isCoop);
    // Contextual top-bar chrome:
    //  - the "Vehicle Editor" button is gone (reached via a vehicle's Edit control);
    //  - "Done" (was "World") appears only while editing a vehicle;
    //  - each page shows only its own load/save pair (the world buttons don't
    //    operate on the editor's in-progress vehicle, and vice-versa).
    tabEditor.hidden = true;
    if (isCoop) {
      // Co-op is a standalone shared-world view: no local editing chrome.
      tabWorld.hidden = true;
      $('import-vehicle').hidden = true;
      $('export-vehicle').hidden = true;
      $('import-world').hidden = true;
      $('export-world').hidden = true;
    } else {
      tabWorld.hidden = isWorld;
      $('import-vehicle').hidden = isWorld;
      $('export-vehicle').hidden = isWorld;
      $('import-world').hidden = !isWorld;
      $('export-world').hidden = !isWorld;
    }
  }

  const editor = new VehicleEditor($('editor-canvas'), {
    palette: $('palette'),
    gatePalette: $('gate-palette'),
    bodyColor: $('body-color'),
    placedList: $('placed-list'),
    wireList: $('wire-list'),
    wiringErrors: $('wiring-errors'),
    inspector: $('inspector'),
  }, state, {
    onVehicleChanged: v => {
      // propagate edits to all instances (plan §6.2)
      for (const p of state.world.vehiclePrototypes) {
        if (p.name === 'Vehicle A' || !p._vehicleOwnerName) p._vehicle = clone(v);
      }
    },
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
    });
  }

  function initCoop() {
    if (coop) return coop;
    coop = new CoopWorld($('coop-canvas'), {
      ui: { name: $('coop-name'), url: $('coop-url'), connect: $('coop-connect'), status: $('coop-status'), deploy: $('coop-deploy') },
      getVehicle: () => state.vehicle,
    });
    return coop;
  }

  tabEditor.onclick = () => activate('editor');
  tabWorld.onclick = () => { activate('world'); initWorldSim(); };
  tabCoop.onclick = () => { activate('coop'); initCoop(); };
  activate('editor'); // sync the top bar to the default (editor) view

  // simplify propagation: only track owner prototype after Edit
  const _onVehicleChanged = editor.hooks.onVehicleChanged;
  editor.hooks.onVehicleChanged = v => {
    const w = state.world.vehiclePrototypes.find(p => p === (state.vehicleOwner ?? null));
    if (w) w._vehicle = clone(v);
    // keep any running sim in step with the edit (signature-guarded: wire
    // maps refresh on wiring changes, bodies only on geometry changes)
    worldSim?.syncInstances();
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

  // debug/test handle (used by headless smoke tests)
  window.__app = () => ({ state, get worldSim() { return worldSim; }, get editor() { return editor; }, get coop() { return coop; } });
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
