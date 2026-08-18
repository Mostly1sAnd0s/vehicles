PLAN.md
# Braitenberg Vehicles Simulator - Plan

## 1. Overview

A self-hosted, LAN-accessible web simulator for constructing and simulating Braitenberg Vehicles 1-7. The application is a single-page web app with two primary modes: Vehicle Editor and World Simulator.

The design goal is intuitive construction via snap-able components, explicit sensor-to-actuator wiring with polarity and weight, and a realistic 2D physics world with light and distance sensing.

The system is client-side only with manual JSON import/export for sharing. No server-side state is required.

## 2. Scope

### In Scope
* Vehicle construction from a rectangular start shape with attachable components via snap points
* Component library: body shapes, powered wheels, passive wheels/casters, light sensor, distance/proximity sensor, generic sensor mount
* Visual wiring editor with drag-and-drop arcing lines, excitatory/inhibitory polarity, and weight/scaling per connection
* Wiring remains editable after vehicle creation
* World simulation with full 2D physics, primitive obstacles and light sources
* Realistic sensors: inverse-square light falloff, raycast distance/proximity with toggleable beam visualization
* World elements editable in World view: position, rotation, scale
* World and vehicle save/load as JSON
* Vehicle instances list with prototype editing propagation. Instance count controlled via slider/integer
* Responsive world view that expands to browser window

### Out of Scope
* Multi-user collaboration, authentication, or global library
* Server-side persistence
* 3D simulation

## 3. Architecture

### 3.1 Runtime
Static SPA. No build-time backend dependency. Suitable for macOS and Linux self-hosting via nginx, Caddy, or simple Python http.server.

Recommended stack:
* Frontend: ES Modules, Canvas 2D for rendering, HTML5 for UI
* Physics: 2D rigid body physics engine, e.g., Matter.js
* UI: Vanilla JS with a lightweight component model. No framework lock-in
* Storage: Browser localStorage for recent files + manual File System Access API / download for sharing

All code is modular with clear separation: Config, Data Models, Editor, World, Simulation, Rendering, UI.

### 3.2 Config System
No hard-coded variables. All tunable parameters live in JSON config files, each <500 lines.

* `config/app.json` - App metadata, default settings
* `config/components.json` - Component definitions: id, name, category, mass, size, snap compatibility, default properties
* `config/sensors.json` - Sensor types, falloff models, raycast params, beam visualization options
* `config/actuators.json` - Actuator types, force limits, power curves
* `config/world.json` - Default world settings, obstacle primitives, light defaults
* `config/ui.json` - UI layout, tab defaults, snap point density

Config files are loaded at startup and hot-reloadable in development.

## 4. Data Models

### 4.1 Vehicle JSON Schema
```json
{
  "id": "uuid",
  "name": "string",
  "version": 1,
  "body": {
    "shape": "rect|polygon|ellipse",
    "size": {"w": number, "h": number},
    "mass": number
  },
  "snapPoints": [
    {"id": "uuid", "angle": number, "radius": number}
  ],
  "components": [
    {
      "id": "uuid",
      "type": "component_id",
      "snapPointId": "uuid",
      "localOffset": {"x": number, "y": number},
      "rotation": number,
      "properties": {}
    }
  ],
  "wiring": [
    {
      "id": "uuid",
      "sourceId": "component_id_sensor",
      "targetId": "component_id_actuator",
      "polarity": "excitatory|inhibitory",
      "weight": number
    }
  ]
}
```

### 4.2 World JSON Schema
```json
{
  "id": "uuid",
  "name": "string",
  "settings": {
    "gravity": number,
    "timeScale": number
  },
  "elements": [
    {
      "id": "uuid",
      "type": "light|obstacle|rock",
      "primitive": "rect|circle|polygon",
      "position": {"x": number, "y": number},
      "rotation": number,
      "scale": {"x": number, "y": number},
      "properties": {}
    }
  ],
  "vehiclePrototypes": [
    {
      "vehicleId": "uuid",
      "vehicleRef": "<vehicle JSON or ref>",
      "instances": [
        {"id": "uuid", "position": {"x": number, "y": number}, "rotation": number}
      ]
    }
  ]
}
```

Sharing is via import/export of these JSON files. Manual drag-and-drop file handling is supported.

## 5. Vehicle Editor

### 5.1 Construction Flow
* Start with a selectable body shape. Default is rectangle.
* Snap points are generated as an even distribution around the perimeter, including corners. Snap points are universal.
* Component palette from `components.json`. User drags component onto body; system snaps to nearest valid snap point.
* Attached components can be repositioned along snap point, rotated locally, and removed.
* Components support passive wheels/casters and multiple sensor mounts per component.

### 5.2 Wiring Editor
* Open wiring mode after components are placed.
* Sensor outputs and actuator inputs are shown as connection handles.
* Drag from sensor to powered wheel to create a wire. Visual arcing line rendered.
* Per-wire properties: polarity toggle excitatory/inhibitory, weight slider 0-1.
* Wiring is stored in vehicle JSON and remains editable in editor. Validation prevents duplicate connections and type mismatches.

## 6. World Simulator

### 6.1 World View
* Tabbed SPA. Editor tab and World tab.
* World view occupies max browser real estate. UI chrome collapses on play.
* World elements: primitive shapes, rocks, light sources. Editable in world view via gizmos for position, rotation, scale.
* Elements are created from a palette and saved in world JSON.

### 6.2 Vehicle Instances
* Left panel lists vehicle prototypes by name, e.g., Vehicle A.
* Each prototype shows instance count with slider/integer input. Changing count adds/removes instances in world.
* Edits to prototype via "Edit" button open Vehicle Editor. Changes propagate to all instances on save.
* World-level distribution tools: Add Here, Random Distribute, Line Up, Grid.

### 6.3 Simulation Loop
* Physics step via Matter.js with fixed timestep.
* Sensor sampling per step:
  - Light sensor: samples light sources with inverse-square falloff. Summation of all sources in range.
  - Distance/Proximity sensor: raycast with configurable angle and range. Beam pattern toggleable for visualization.
* Actuator update: sensor value * weight * polarity -> motor force/torque applied to powered wheels. Differential drive behavior emerges naturally from wiring.
* Controls: Play/Pause, Reset, Step, Time Scale.

## 7. Rendering & UX

* Modern simple aesthetic. Clean lines, minimal chrome.
* Snap point highlight on hover. Valid drop target feedback.
* Wiring arcs with color coding for polarity.
* Toggleable sensor beam visualization.
* World camera pan/zoom with mouse. Vehicle orientation editable via drag handle or rotate gizmo.
* Keyboard shortcuts for common actions defined in `ui.json`.

## 8. Persistence & Sharing

* Client-side only. Save/Load via file download and file input.
* Recent files stored in localStorage.
* Vehicle JSON and World JSON are human-readable and versioned for future compatibility.

## 9. Deployment

* Static files served from `dist/`. No server code required.
* Self-host on macOS/Linux with nginx/Caddy.
* LAN access via local IP. No external dependencies at runtime.

## 10. Future Expansion Design

* Component system is data-driven via `components.json`. New components require only config entry, no code change.
* Sensor and actuator models are pluggable via config.
* JSON schemas are versioned. Migration functions handle schema evolution.
* Config files <500 lines each to maintain readability.
* Simulation engine is abstracted behind an interface to allow swapping physics or adding new sensor models.
* UI panels are defined in `ui.json` to allow layout changes without code.

This plan provides a modular, config-driven foundation for Vehicles 1-7 simulation with clear paths for extension.
