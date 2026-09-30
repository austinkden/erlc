# ERLC Road Network Studio 🗺️

A high-performance, lane-level road mapping and network topology editor created specifically for video game road networks (Emergency Response: Liberty County).

---

## 🚀 Quick Start

1. Double-click [`start.bat`](file:///c:/Users/austi/VSCode/erlcmaps/start.bat) (or run `python -m http.server 5173`).
2. Open **[http://localhost:5173](http://localhost:5173)** in any browser.

---

## 🎮 Controls & Shortcuts

| Action | Control | Description |
|---|---|---|
| **Add Waypoint / Place** | `Left-Click` | Places waypoints along the active lane (or selects elements) |
| **Finish Lane** | `Right-Click` | Commits the drawn lane (requires $\ge 2$ points) |
| **Context Action Menu** | `Right-Click` on lane/node | Opens contextual popup (Reverse, Parallel Offset, Delete) |
| **Pan Canvas** | `Middle-Click Drag` or `Space + Left Drag` | Infinite smooth viewport panning |
| **Zoom In / Out** | `Mouse Wheel` | Smooth zoom centered directly at cursor |
| **Draw Lane Tool** | `R` | Activates lane creation tool |
| **Select / Reshape Tool** | `S` or `V` | Selects lanes/nodes and lets you drag waypoint handles |
| **Connect Lanes Tool** | `C` | Creates lane-to-lane transition / lane-change connector |
| **Duplicate Parallel Lane** | `D` | Automatically duplicates selected lane at parallel offset |
| **Toggle Postals Overlay** | `Tab` | Cycles clean map $\leftrightarrow$ postal code map |
| **Lock Straight Angle** | `Shift` (hold) | Snaps drawing angles to $0^\circ, 45^\circ, 90^\circ$ |
| **Undo / Redo** | `Ctrl + Z` / `Ctrl + Y` | Full multi-level history stack |
| **Delete Selected** | `Delete` or `Backspace` | Removes selected lane or node |
| **Fit View** | `F` | Fits map centered on screen |
| **Help & Shortcuts** | `H` or `?` | Opens shortcuts cheatsheet modal |

---

## 🛣️ Topology & Merging / Demerging

- **Lane Merging**: When drawing a lane, clicking on any existing junction node automatically snaps and joins into it. The node is classified as a **Merge Point** (amber indicator).
- **Lane Demerging (Forks / Splits)**: Start drawing from an existing node or right-click any node to *"Start New Lane Here"*. The node is classified as a **Demerge Point** (cyan indicator).
- **Parallel Lanes**: Use `D` or the **Parallel +** / **Oncoming -** buttons to generate multi-lane roads and opposing traffic lanes in 1 click.
- **Lane Connectors**: Use the **Connect Lanes (`C`)** tool to mark permissible lane changes or turn restrictions between lanes.

---

## 💾 Export Formats

Click **💾 Export** in the top bar to export:
1. **Complete Graph JSON**: Full serialized graph with nodes, directed lanes, speed limits, and waypoints.
2. **Roblox Lua Table**: Pre-formatted `Vector3.new(x, 0, z)` table ready for direct game script integration.
3. **GeoJSON**: Standard GIS `FeatureCollection` with `LineString` lanes and `Point` junction features.
