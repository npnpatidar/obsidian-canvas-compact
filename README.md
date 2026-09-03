# Canvas Compact for Obsidian

Resize each canvas card to fit its content and pack all cards to take minimum space.

- **Fit to content** — height auto-fit via DOM `min-content` measurement (like `advanced-canvas`) + heuristic fallback for closed canvases. Snap to 20px grid.
- **Pack layout** — two strategies:
  - **MaxRects (BSSF)** — densest packing, 85-92% occupancy, saves ~42% area on the example (26 cards: 2580×600 → 1060×840).
  - **Masonry** — preserves reading order, shortest-column.

## Commands

| Command | Description |
|---------|-------------|
| `Fit cards to content` | Resize height to fit text/markdown |
| `Pack layout — minimum area (MaxRects)` | Compact dense packing |
| `Pack layout — preserve order (Masonry)` | Order-preserving columns |
| `Fit + Pack (compact all cards)` | One-shot fit then pack |

Also adds file menu: `Fit + Pack this file` on any `.canvas` file.

## Settings

- Minimum / maximum height, snap to grid
- Gap / outer padding
- Strategy (maxrects / masonry), sort order, masonry columns

## Install

### Manual
Copy `main.js` + `manifest.json` to `<vault>/.obsidian/plugins/canvas-compact/`.

### Nix (home-manager)
```nix
mkPlugin {
  id = "canvas-compact";
  repo = "npnpatidar/obsidian-canvas-compact";
  version = "1.0.0";
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

Reference: [developer-mike/obsidian-advanced-canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas) for resize logic.

## License

MIT
