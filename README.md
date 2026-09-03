# Canvas Compact for Obsidian

Resize each canvas card to fit its content and pack all cards to take minimum space — **edge-aware**.

- **Fit to content** — height auto-fit via DOM `min-content` measurement (like `advanced-canvas`) + heuristic fallback for closed canvases. Snap to 20px grid.
- **Pack layout** — three strategies:
  - **MaxRects (BSSF)** — densest packing, 85-92% occupancy, saves ~42% area on isolated cards (26 cards: 2580×600 → 1060×840).
  - **Masonry** — preserves reading order, shortest-column.
  - **Graph (edge-aware)** — clusters by connections (connected components), force-directed layout per cluster to minimize edge length & keep neighbors close, then packs clusters via MaxRects. Also optimizes edge anchor sides.
- **Optimize connections** — re-attaches edges to nearest sides (port of `felixchenier/obsidian-optimize-canvas-connections` with `shortest` and `preserve-axes` modes). Ensures all connections are short and visible after packing.

## Commands

| Command | Description |
|---------|-------------|
| `Fit cards to content` | Resize height to fit text/markdown |
| `Pack layout — minimum area (MaxRects)` | Compact dense packing (isolated cards) |
| `Pack layout — preserve order (Masonry)` | Order-preserving columns |
| `Fit + Pack (compact all cards)` | One-shot fit then pack |
| `Optimize connections (nearest edges)` | Shortest-path or preserve-axes edge re-attachment |
| `Pack layout — edge-aware (minimize area + connections)` | Force-layout per connected component + pack clusters |
| `Fit + Graph Pack (edge-aware compact)` | **Recommended for connected canvases** — fit, then edge-aware pack |

Also adds file menu: `Fit + Pack` and `Fit + Graph Pack (edge-aware)` on any `.canvas` file.

## Settings

- Minimum / maximum height, snap to grid
- Gap / outer padding, strategy, sort order, masonry columns
- **Connections:** optimize toggle, preserve-axes toggle, force iterations (50–600)

## Install

### Manual
Copy `main.js` + `manifest.json` to `<vault>/.obsidian/plugins/canvas-compact/`.

### Nix (home-manager)
```nix
mkPlugin {
  id = "canvas-compact";
  repo = "npnpatidar/obsidian-canvas-compact";
  version = "1.1.0";
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

References:
- [developer-mike/obsidian-advanced-canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas) for resize (`min-content` trick)
- [felixchenier/obsidian-optimize-canvas-connections](https://github.com/felixchenier/obsidian-optimize-canvas-connections) for edge-side optimization — extended here to also *move* cards so area is minimized and connections stay visible

## License

MIT
