# Canvas Compact for Obsidian

Cleans up an Obsidian canvas layout — **no card or label overlaps, minimal connection crossings**.

- **Clean layout** — lays out each cluster so no card overlaps another card, no connection label
  overlaps a card, another label, or a connection, and connections cross as little as the graph
  allows (zero crossings for trees and planar graphs). Any residual crossings are reported.
- **Deterministic** — no force simulation; a BFS spanning tree is placed with a layered contour
  algorithm that is provably crossing-free, then cycle-closing edges are routed by side choice and
  a bounded local search that only ever reduces crossings.
- **DagCola layout (experimental)** — combines **d3-dag** (optimal Sugiyama layered layout with
  exact crossing minimization) and **webcola** (constraint-based solver with hard guarantees
  for no overlaps, flow direction, group containers, and label clearance). Best for complex
  graphs with cycles, many labels, or group containers.

## Commands

| Command | Description |
|---------|-------------|
| `Clean layout — no overlaps, minimal crossings` | Lays out each cluster so no card or label overlaps and connections don't cross (zero crossings for trees/planar graphs); reports any residual |
| `DagCola layout — d3-dag + webcola (experimental)` | Uses d3-dag for optimal layered layout + webcola constraint solver for hard guarantees on overlaps, flow, and groups |

Also adds file menu items on any `.canvas` file:
- `Canvas Compact: Clean layout (no overlaps)`
- `Canvas Compact: DagCola layout (d3-dag + webcola)`

### Clean layout guarantees

Connection crossings are topological, not cosmetic: Obsidian draws an edge as a bezier between two
side anchors, so a **non-planar** connection graph (e.g. five cards all connected to each other)
*cannot* be drawn without crossings. Clean layout therefore:

- **always** eliminates card/card overlap;
- **always** eliminates label/label and label/card overlap (widening spacing to make room);
- lays out trees, forests and planar graphs with **zero** crossings, and minimises crossings otherwise;
- reports whatever it could not remove in the notice, e.g. `residual: 2 connection crossings`.

### DagCola layout guarantees (experimental)

In addition to the Clean layout guarantees, DagCola adds:

- **Hard constraint satisfaction** — webcola's solver mathematically guarantees no node overlaps,
  flow-direction separation (top→bottom or left→right), and group containment.
- **Optimal crossing minimization** — d3-dag's exact decrossing (for components ≤30 nodes by default)
  finds the true minimum crossings; larger components use a fast two-layer heuristic.
- **Cycle handling** — d3-dag's longest-path layering automatically ignores back-edges, producing
  clean layered layouts even for cyclic graphs.
- **Label-aware spacing** — webcola's constraint system naturally handles label clearance without
  requiring manual gap tuning.

## Settings

### Clean layout
- **Direction** — top→bottom / left→right / balanced mind map
- **Space between cards (px)**
- **Outer padding (px)**
- **Reserve space for connection labels**

### DagCola layout (experimental)
- **Enable DagCola layout** — use the new engine
- **Use webcola refinement** — run constraint solver after d3-dag layout (recommended)
- **Exact crossing minimization threshold** — component size below which to use exact crossing minimization (default: 30)

## Install

### Manual
Copy `main.js` + `manifest.json` to `<vault>/.obsidian/plugins/canvas-compact/`.

### Nix (home-manager)
```nix
mkPlugin {
  id = "canvas-compact";
  repo = "npnpatidar/obsidian-canvas-compact";
  version = "2.0.0";
  mainJsHash = "...";
  manifestHash = "...";
}
```

### BRAT
Add `npnpatidar/obsidian-canvas-compact`.

## Development

```bash
npm install
npm run dev      # watch
npm run build    # production (tsc + esbuild)
```

## License

MIT