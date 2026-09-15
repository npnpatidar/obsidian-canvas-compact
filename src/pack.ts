import type { AllCanvasNodeData } from "./Canvas.d";

export type PackStrategy = "maxrects";

export interface PackOptions {
  strategy: PackStrategy;
  gap: number; // px between nodes
  padding: number; // outer padding of packed bbox

  sortBy: "input" | "areaDesc" | "heightDesc" | "widthDesc";
  binWidth?: number; // for maxrects; if omitted infer from widest row
}

/** Defaults kept for callers/tests; the engines pass explicit options. */
export const DEFAULT_PACK_OPTIONS: PackOptions = {
  strategy: "maxrects",
  gap: 20,
  padding: 20,
  sortBy: "heightDesc",
  binWidth: undefined,
};

type Rect = { x: number; y: number; width: number; height: number };

// ── Helpers ──
function sortNodes(nodes: AllCanvasNodeData[], sortBy: PackOptions["sortBy"]): AllCanvasNodeData[] {
  const a = [...nodes];
  switch (sortBy) {
    case "areaDesc":
      return a.sort((x, y) => y.width * y.height - x.width * x.height);
    case "heightDesc":
      return a.sort((x, y) => y.height - x.height || y.width - x.width);
    case "widthDesc":
      return a.sort((x, y) => y.width - x.width || y.height - x.height);
    case "input":
    default:
      return a;
  }
}

function bbox(nodes: AllCanvasNodeData[]): Rect {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + n.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ── MaxRects BSSF (Best Short Side Fit) ──
function scoreBSSF(free: Rect, w: number, h: number): number {
  const dw = free.width - w;
  const dh = free.height - h;
  if (dw < 0 || dh < 0) return Infinity;
  return Math.min(dw, dh);
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function splitFreeRects(freeRects: Rect[], placed: Rect): Rect[] {
  const next: Rect[] = [];
  for (const fr of freeRects) {
    if (!overlaps(fr, placed)) { next.push(fr); continue; }
    // No overlap case already handled; split into up to 4 fragments
    // Do NOT emit zero-area rects
    // Top
    if (placed.y > fr.y && placed.y < fr.y + fr.height) {
      const r = { x: fr.x, y: fr.y, width: fr.width, height: placed.y - fr.y };
      if (r.width > 0 && r.height > 0) next.push(r);
    }
    // Bottom
    if (placed.y + placed.height < fr.y + fr.height) {
      const r = { x: fr.x, y: placed.y + placed.height, width: fr.width, height: fr.y + fr.height - (placed.y + placed.height) };
      if (r.width > 0 && r.height > 0) next.push(r);
    }
    // Left
    if (placed.x > fr.x && placed.x < fr.x + fr.width) {
      const r = { x: fr.x, y: fr.y, width: placed.x - fr.x, height: fr.height };
      if (r.width > 0 && r.height > 0) next.push(r);
    }
    // Right
    if (placed.x + placed.width < fr.x + fr.width) {
      const r = { x: placed.x + placed.width, y: fr.y, width: fr.x + fr.width - (placed.x + placed.width), height: fr.height };
      if (r.width > 0 && r.height > 0) next.push(r);
    }
  }
  return pruneFreeRects(next);
}

function pruneFreeRects(rects: Rect[]): Rect[] {
  // Nothing to remove for 0 or 1 rects; skip the O(n²) scan entirely.
  if (rects.length < 2) return rects;
  // Remove rects contained within another
  const out: Rect[] = [];
  for (let i = 0; i < rects.length; i++) {
    let contained = false;
    for (let j = 0; j < rects.length; j++) if (i !== j) {
      const a = rects[i]!, b = rects[j]!;
      if (a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height) {
        // if strictly inside or equal but keep one
        if (a.width * a.height < b.width * b.height || (a.width * a.height === b.width * b.height && i > j)) { contained = true; break; }
      }
    }
    if (!contained) out.push(rects[i]!);
  }
  return out;
}


export function maxRectsPack(nodes: AllCanvasNodeData[], opts: PackOptions): AllCanvasNodeData[] {
  if (nodes.length === 0) return [];

  const sorted = sortNodes(nodes, opts.sortBy);
  const gap = opts.gap;
  const pad = opts.padding;

  // padded node sizes (include gap as spacing to next)
  const items = sorted.map((n) => ({ node: n, w: n.width + gap, h: n.height + gap }));

  // bin width: use opts.binWidth or estimate compact width
  let binW: number;
  if (opts.binWidth && opts.binWidth > 0) binW = opts.binWidth;
  else {
    const totalArea = items.reduce((s, it) => s + it.w * it.h, 0);
    const maxW = Math.max(...items.map((it) => it.w));
// Aim for a 1.6:1 width/height aspect-ratio bin: with area = w*h and w = a*h,
// w = sqrt(area * a). Starting from a tall bin and growing downward, a wider bin
// packs more items side by side and keeps the final shape squarish.
const est = Math.ceil(Math.sqrt(totalArea * 1.6));
    binW = Math.max(maxW + pad * 2, Math.min(est, 2000));
    // round to 20
    binW = Math.ceil(binW / 20) * 20;
  }

  // start with a tall bin, grow as needed
  let binH = 2000;
  // ensure total area fits with slack
  const totalArea = items.reduce((s, it) => s + it.w * it.h, 0);
  binH = Math.max(binH, Math.ceil(totalArea / (binW - pad * 2)) + 400);

  let free: Rect[] = [{ x: pad, y: pad, width: binW - pad * 2, height: binH - pad * 2 }];
  const placed: Rect[] = [];
  const posMap = new Map<string, { x: number; y: number }>();

  for (const it of items) {
    const w = it.w, h = it.h;
    let best: Rect | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < free.length; i++) {
      const fr = free[i]!;
      if (fr.width < w || fr.height < h) continue;
      const s = scoreBSSF(fr, w, h);
      // tie break top-left
      if (s < bestScore || (s === bestScore && best && (fr.y < best.y || (fr.y === best.y && fr.x < best.x)))) {
        bestScore = s;
        best = fr;
      }
    }
    if (!best) {
      // expand bin height and push new free rect at bottom
      const expand = Math.max(h, 400);
      const newFree: Rect = { x: pad, y: binH, width: binW - pad * 2, height: expand };
      free.push(newFree);
      binH += expand;
      // retry this item (simple: place at newFree origin)
      best = newFree;
    }
    const place: Rect = { x: best!.x, y: best!.y, width: w, height: h };
    posMap.set(it.node.id, { x: place.x, y: place.y });
    placed.push(place);
    free = splitFreeRects(free, place);
  }

  // Map sorted placements back, but preserve input order for output stability?
  // Return in sorted order first, then caller can reorder by input if desired.
  // We keep input order for file persistence (less diff noise)
  const pos = posMap;
  const out = nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) return n;
    return { ...n, x: p.x, y: p.y } as AllCanvasNodeData;
  });
  return out;
}
