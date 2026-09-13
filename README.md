# Canvas Compact for Obsidian

Cleans up an Obsidian canvas layout — **no card or label overlaps, minimal connection crossings**.

- **Clean layout** — lays out each cluster with **d3-dag** (Sugiyama layered layout with crossing
  minimisation) so no card overlaps another card, no connection label overlaps a card, another
  label, or a connection, and connections cross as little as the graph allows (zero crossings for
  trees and planar graphs). Any residual crossings are reported.
- **Deterministic** — no force simulation. Layering comes from d3-dag's longest-path rank
  assignment and crossing minimisation; a bounded local search that only ever reduces crossings and
  a cost-aware hill climb that never accepts a globally worse layout finish the result. Because
  whether a connection can be routed clear of every card depends on how much room it has, a bounded
  set of spacing scales is tried in the chosen direction and the lexicographically cleanest wins.
- **DagCola layout** — adds **webcola**'s constraint solver on top of d3-dag, then finishes through
  the same packing, connection-routing and label-placement pipeline as Clean layout. Handles
  left→right and balanced mind-map directions, cyclic graphs, and cards of very uneven size.

## Commands

| Command | Description |
|---------|-------------|
| `Clean layout — no overlaps, minimal crossings` | Lays out each cluster so no card or label overlaps and connections don't cross (zero crossings for trees/planar graphs); reports any residual |
| `DagCola layout — d3-dag + webcola` | Layered layout from d3-dag, tightened by webcola's constraint solver; whichever comes out cleaner wins |

Also adds file menu items on any `.canvas` file:
- `Canvas Compact: Clean layout (no overlaps)`
- `Canvas Compact: DagCola layout (d3-dag + webcola)` — shown when DagCola layout is enabled in settings

### Clean layout guarantees

Connection crossings are topological, not cosmetic: Obsidian draws an edge as a bezier between two
side anchors, so a **non-planar** connection graph (e.g. five cards all connected to each other)
*cannot* be drawn without crossings. Clean layout therefore:

- **always** eliminates card/card overlap;
- **always** eliminates label/label and label/card overlap (widening spacing to make room);
- lays out trees, forests and planar graphs with **zero** crossings, and minimises crossings otherwise;
- reports whatever it could not remove in the notice, e.g. `residual: 2 connection crossings`.

### DagCola layout guarantees

DagCola keeps the Clean layout guarantees (no card/card overlap, no label overlaps, no connection
hidden behind a card) and adds:

- **Optimal crossing minimisation** — d3-dag's exact decrossing finds the true minimum crossings for
  clusters up to the configured threshold (default 30, capped at 60, because exact minimisation is
  exponential); larger clusters use a fast two-layer heuristic.
- **Cycle handling** — longest-path layering ignores back-edges, so cyclic graphs still get a clean
  layered layout.
- **Direction support** — top→bottom, left→right and balanced (mind map) are all layering
  directions, applied identically by both engines. Left→right transposes the layered result, with
  the node extents swapped first so the lane spacing that guarantees separation is computed from
  the extent that ends up on that axis.
- **Real constraints, not just heuristics** — webcola enforces the configured spacing as a hard
  constraint: no card overlaps, connections pointing parent→child, and every group's cards kept
  together. It is pinned to the layered structure produced by d3-dag (each rank stays on one line,
  in the order the crossings were minimised for), so it can tighten spacing but never permute the
  drawing and silently add crossings.

### How the two libraries work together

1. Cards are split into connected clusters (group containers are not laid out; they are wrapped
   around their members afterwards).
2. Each cluster is laid out by d3-dag's Sugiyama pipeline (shared by both engines, so Direction
   means the same thing in each): longest-path layering (cycles are handled by ignoring back-edges),
   crossing minimisation, and coordinate assignment. Clean layout searches a bounded set of spacing
   scales in the configured direction and keeps the cleanest result, because whether a connection
   can be routed clear of every card depends on how much room there is: the tightest arrangement is
   not always the cleanest.
3. With DagCola enabled, each cluster is also laid out at 1× and 1.5× the configured gap and
   re-solved by webcola at each spacing. This is where webcola earns its place — d3-dag sizes a
   rank's band by the largest card in it, so a small card following a tall one is held further away
   than its own extents require, and webcola reclaims that room.
4. Every candidate goes through the identical packing, connection-routing and label-placement
   pipeline, and the lexicographically cleanest result wins: fewest connections hidden behind a
   card first, then fewest crossings, then label clearance, then the most compact. A webcola
   refinement can therefore improve a canvas but never spoil one — when d3-dag's layered layout is
   already the better answer, the refinement is simply not selected.

## Settings

### Clean layout
- **Direction** — top→bottom / left→right / balanced mind map (applied by both engines)
- **Space between cards (px)**
- **Outer padding (px)**
- **Reserve space for connection labels**
- **Exact crossing minimization threshold** — cluster size up to which crossing minimisation is exact, for both engines (default 30, capped at 60)

### DagCola layout
- **Enable DagCola layout** — show the DagCola commands and file-menu action; off means only the Clean layout engine is available
- **Use webcola refinement** — also solve each cluster with webcola's constraint solver, and keep it when it comes out cleaner (on by default)

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
npm run dev        # watch
npm run build      # production (tsc + esbuild)
npm run typecheck  # types only
npm test           # layout-engine verification harnesses
```

`npm test` runs both harnesses (`scripts/clean.check.ts`, `scripts/dagcola.check.ts`) against
synthetic canvases. They need no Obsidian runtime and assert the hard guarantees directly: no card
overlaps, no connection behind a card, no label overlaps, correct direction behaviour, and that
webcola never turns a clean layout into a worse one.

## License

MIT