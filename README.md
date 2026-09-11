# Canvas Compact for Obsidian

Cleans up an Obsidian canvas layout — **no card or label overlaps, minimal connection crossings**.

- **Clean layout** — lays out each cluster so no card overlaps another card, no connection label
  overlaps a card, another label, or a connection, and connections cross as little as the graph
  allows (zero crossings for trees and planar graphs). Any residual crossings are reported.
- **Deterministic** — no force simulation; a BFS spanning tree is placed with a layered contour
  algorithm that is provably crossing-free, then cycle-closing edges are routed by side choice and
  a bounded local search that only ever reduces crossings.

## Command

| Command | Description |
|---------|-------------|
| `Clean layout — no overlaps, minimal crossings` | Lays out each cluster so no card or label overlaps and connections don't cross (zero crossings for trees/planar graphs); reports any residual |

Also adds a file menu item `Canvas Compact: Clean layout (no overlaps)` on any `.canvas` file.

### Clean layout guarantees

Connection crossings are topological, not cosmetic: Obsidian draws an edge as a bezier between two
side anchors, so a **non-planar** connection graph (e.g. five cards all connected to each other)
*cannot* be drawn without crossings. Clean layout therefore:

- **always** eliminates card/card overlap;
- **always** eliminates label/label and label/card overlap (widening spacing to make room);
- lays out trees, forests and planar graphs with **zero** crossings, and minimises crossings otherwise;
- reports whatever it could not remove in the notice, e.g. `residual: 2 connection crossings`.

## Settings

- **Direction** — top→bottom / left→right / balanced mind map
- **Space between cards (px)**
- **Outer padding (px)**
- **Reserve space for connection labels**

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
