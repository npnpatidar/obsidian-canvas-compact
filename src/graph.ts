import type { AllCanvasNodeData, CanvasEdgeData } from "./Canvas.d";
import type { PackOptions } from "./pack";
import { maxRectsPack } from "./pack";

// ── Context-aware helpers ──
function extractYear(text: string): number | null {
  const m = text.match(/(18|19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
}
const KNOWN_PLACES = ["Ajmer","Jaipur","Jodhpur","Beawer","Bundi","Jaisalmer","Kota","Culcutta","Calcutta","Bombay","Agra","Dungarpur","Bikaner","Udaipur","Alwar","Bharatpur","Kishangarh","Nagaur","Pali","Sikar"];
function extractPlace(text: string): string | null {
  for (const p of KNOWN_PLACES) if (text.toLowerCase().includes(p.toLowerCase())) return p;
  return null;
}
function contextSimilarity(a: AllCanvasNodeData, b: AllCanvasNodeData): number {
  const ta = (a as unknown as { text?: string }).text ?? "", tb = (b as unknown as { text?: string }).text ?? "";
  let s = 0;
  const ya = extractYear(ta), yb = extractYear(tb);
  if (ya !== null && yb !== null) {
    const d = Math.abs(ya - yb);
    if (d === 0) s += 0.45;
    else if (d <= 3) s += 0.32;
    else if (d <= 7) s += 0.18;
    else if (d <= 15) s += 0.07;
  }
  const pa = extractPlace(ta), pb = extractPlace(tb);
  if (pa && pb && pa === pb) s += 0.38;
  // keyword overlap (simple Jaccard on words >3 chars)
  const wa = new Set(ta.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wb = new Set(tb.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const uni = wa.size + wb.size - inter;
  if (uni > 0) s += (inter / uni) * 0.25;
  return Math.min(1, s);
}

// ── Edge side optimization (port of felixchenier/obsidian-optimize-canvas-connections) ──
export type EdgeSide = "top" | "bottom" | "left" | "right";
export type OptimizeMode = "shortest" | "preserve-axes";

function pointForSide(node: AllCanvasNodeData, side: EdgeSide): { x: number; y: number } {
  switch (side) {
    case "top": return { x: node.x + node.width / 2, y: node.y };
    case "bottom": return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left": return { x: node.x, y: node.y + node.height / 2 };
    case "right": return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

function sideOptions(current: string | undefined, mode: OptimizeMode): EdgeSide[] {
  if (mode === "shortest") return ["top", "bottom", "left", "right"];
  if (current === "top" || current === "bottom") return ["top", "bottom"];
  if (current === "left" || current === "right") return ["left", "right"];
  return ["top", "bottom", "left", "right"];
}

function segmentIntersectsRect(
  x1: number, y1: number, x2: number, y2: number,
  rx: number, ry: number, rw: number, rh: number
): boolean {
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
  if (maxX < rx || minX > rx + rw || maxY < ry || minY > ry + rh) return false;
  if (x1 >= rx && x1 <= rx + rw && y1 >= ry && y1 <= ry + rh) return true;
  if (x2 >= rx && x2 <= rx + rw && y2 >= ry && y2 <= ry + rh) return true;
  function ccw(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
    return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  }
  function segI(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
    return ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) && ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy);
  }
  const rx2 = rx + rw, ry2 = ry + rh;
  if (segI(x1, y1, x2, y2, rx, ry, rx2, ry)) return true;
  if (segI(x1, y1, x2, y2, rx2, ry, rx2, ry2)) return true;
  if (segI(x1, y1, x2, y2, rx2, ry2, rx, ry2)) return true;
  if (segI(x1, y1, x2, y2, rx, ry2, rx, ry)) return true;
  return false;
}

function countIntersections(
  fromPt: { x: number; y: number }, toPt: { x: number; y: number },
  nodes: AllCanvasNodeData[], excludeIds: Set<string>
): number {
  let c = 0;
  for (const n of nodes) {
    if (excludeIds.has(n.id)) continue;
    if (segmentIntersectsRect(fromPt.x, fromPt.y, toPt.x, toPt.y, n.x, n.y, n.width, n.height)) c++;
  }
  return c;
}

/**
 * Optimize each edge's fromSide/toSide to minimize squared Euclidean distance
 * between side anchor points, given current node positions.
 * Returns new edges array (shallow-copied with updated sides).
 */
export function optimizeEdges(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  mode: OptimizeMode = "shortest",
  onlySelectedIds?: Set<string>
): CanvasEdgeData[] {
  if (edges.length === 0) return edges;
  const nodeMap = new Map<string, AllCanvasNodeData>();
  for (const n of nodes) nodeMap.set(n.id, n);

  return edges.map((edge) => {
    const fromNode = nodeMap.get(edge.fromNode);
    const toNode = nodeMap.get(edge.toNode);
    if (!fromNode || !toNode) return edge;

    const applyFrom = !onlySelectedIds || onlySelectedIds.has(fromNode.id);
    const applyTo = !onlySelectedIds || onlySelectedIds.has(toNode.id);
    if (!applyFrom && !applyTo) return edge;

    const fromOpts = applyFrom ? sideOptions(edge.fromSide as string, mode) : [edge.fromSide as EdgeSide].filter(Boolean) as EdgeSide[];
    const toOpts = applyTo ? sideOptions(edge.toSide as string, mode) : [edge.toSide as EdgeSide].filter(Boolean) as EdgeSide[];
    // fallback if no current side
    const fOpts = fromOpts.length ? fromOpts : (["top","bottom","left","right"] as EdgeSide[]);
    const tOpts = toOpts.length ? toOpts : (["top","bottom","left","right"] as EdgeSide[]);

    let best: { fromSide: EdgeSide; toSide: EdgeSide; dist: number; hits: number; labelHits: number } | null = null;
    const exclude = new Set([fromNode.id, toNode.id]);
    const label = (edge as unknown as { label?: string }).label ?? "";
    for (const fs of fOpts) {
      const fp = pointForSide(fromNode, fs);
      for (const ts of tOpts) {
        const tp = pointForSide(toNode, ts);
        const d = (tp.x - fp.x) ** 2 + (tp.y - fp.y) ** 2;
        const hits = countIntersections(fp, tp, nodes, exclude);
        let labelHits = 0;
        if (label) {
          const mx = (fp.x + tp.x) / 2, my = (fp.y + tp.y) / 2;
          const lines = label.split("\n").length;
          const w = Math.max(...label.split("\n").map((l) => l.length)) * 7 + 16;
          const h = lines * 16 + 10;
          const lbx = mx - w / 2, lby = my - h / 2;
          for (const n of nodes) {
            if (exclude.has(n.id)) continue;
            if (!(lbx + w < n.x || n.x + n.width < lbx || lby + h < n.y || n.y + n.height < lby)) labelHits++;
          }
          // also require minimum edge length for label to fit (60px + label width)
          const minLen = Math.max(70, w + 20);
          if (Math.hypot(tp.x - fp.x, tp.y - fp.y) < minLen) labelHits++;
        }
        if (!best || labelHits < best.labelHits || (labelHits === best.labelHits && (hits < best.hits || (hits === best.hits && d < best.dist)))) {
          best = { fromSide: fs, toSide: ts, dist: d, hits, labelHits };
        }
      }
    }
    if (!best) return edge;
    // only mutate if changed to avoid churn
    if (best.fromSide === edge.fromSide && best.toSide === edge.toSide) return edge;
    return { ...edge, fromSide: best.fromSide, toSide: best.toSide };
  });
}

// ── Graph utilities ──
export function connectedComponents(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[]
): AllCanvasNodeData[][] {
  if (edges.length === 0) return nodes.map((n) => [n]);
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (!adj.has(e.fromNode) || !adj.has(e.toNode)) continue;
    adj.get(e.fromNode)!.add(e.toNode);
    adj.get(e.toNode)!.add(e.fromNode);
  }
  const visited = new Set<string>();
  const idToNode = new Map(nodes.map((n) => [n.id, n]));
  const comps: AllCanvasNodeData[][] = [];
  for (const n of nodes) {
    if (visited.has(n.id)) continue;
    const stack = [n.id];
    const comp: AllCanvasNodeData[] = [];
    visited.add(n.id);
    while (stack.length) {
      const cur = stack.pop()!;
      const nd = idToNode.get(cur);
      if (nd) comp.push(nd);
      for (const nb of adj.get(cur) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

// ── Force-directed layout for a single connected component ──
interface PosNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
}

function overlap(a: PosNode, b: PosNode, gap: number): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

function resolveCollisions(nodes: PosNode[], gap: number): void {
  // simple pairwise push apart if overlap (one pass)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!;
      if (!overlap(a, b, gap)) continue;
      // compute overlap on each axis
      const overlapX = Math.min(a.x + a.width + gap - b.x, b.x + b.width + gap - a.x);
      const overlapY = Math.min(a.y + a.height + gap - b.y, b.y + b.height + gap - a.y);
      if (overlapX < overlapY) {
        // push on X
        const push = overlapX / 2 + 1;
        if (a.x < b.x) {
          a.x -= push;
          b.x += push;
        } else {
          a.x += push;
          b.x -= push;
        }
      } else {
        const push = overlapY / 2 + 1;
        if (a.y < b.y) {
          a.y -= push;
          b.y += push;
        } else {
          a.y += push;
          b.y -= push;
        }
      }
    }
  }
}

/**
 * Layered (Sugiyama-style) layout for DAG components — compact, respects flow.
 * Returns null if graph has cycles (fallback to force).
 */
export function layeredLayoutComponent(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  gap: number
): AllCanvasNodeData[] | null {
  const n = compNodes.length;
  const idToNode = new Map(compNodes.map((v) => [v.id, v]));
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const nd of compNodes) { adj.set(nd.id, []); indeg.set(nd.id, 0); }
  for (const e of compEdges) {
    if (!idToNode.has(e.fromNode) || !idToNode.has(e.toNode)) continue;
    if (e.fromNode === e.toNode) continue;
    adj.get(e.fromNode)!.push(e.toNode);
    indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
  }
  const q: string[] = [];
  const layer = new Map<string, number>();
  for (const [id, d] of indeg) if (d === 0) { q.push(id); layer.set(id, 0); }
  let processed = 0;
  const queue = [...q];
  while (queue.length) {
    const cur = queue.shift()!;
    processed++;
    const curL = layer.get(cur) ?? 0;
    for (const nb of adj.get(cur) ?? []) {
      const proposed = curL + 1;
      if ((layer.get(nb) ?? -1) < proposed) layer.set(nb, proposed);
      const nd = (indeg.get(nb) ?? 0) - 1;
      indeg.set(nb, nd);
      if (nd === 0) queue.push(nb);
    }
  }
  if (processed !== n) return null; // cycle detected

  const layers = new Map<number, AllCanvasNodeData[]>();
  let maxLayer = 0;
  for (const nd of compNodes) {
    const l = layer.get(nd.id) ?? 0;
    maxLayer = Math.max(maxLayer, l);
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(nd);
  }
  for (const [, arr] of layers) arr.sort((a, b) => a.x - b.x || b.width - a.width);

  let curY = 0;
  const out = new Map<string, AllCanvasNodeData>();
  let maxLayerWidth = 0;
  for (let l = 0; l <= maxLayer; l++) {
    const arr = layers.get(l) ?? [];
    const w = arr.reduce((s, nd) => s + nd.width, 0) + Math.max(0, arr.length - 1) * gap;
    maxLayerWidth = Math.max(maxLayerWidth, w);
  }
  for (let l = 0; l <= maxLayer; l++) {
    const arr = layers.get(l) ?? [];
    const layerW = arr.reduce((s, nd) => s + nd.width, 0) + Math.max(0, arr.length - 1) * gap;
    let curX = (maxLayerWidth - layerW) / 2;
    let maxH = 0;
    for (const nd of arr) maxH = Math.max(maxH, nd.height);
    for (const nd of arr) {
      const yOff = (maxH - nd.height) / 2;
      out.set(nd.id, { ...nd, x: curX, y: curY + yOff } as AllCanvasNodeData);
      curX += nd.width + gap;
    }
    curY += maxH + gap + 30;
  }
  return compNodes.map((nd) => out.get(nd.id) ?? nd);
}

/**
 * Cycle-tolerant layered layout: longest-path layering that tolerates cycles (ignores
 * back-edges), so it works for any graph topology. Connected nodes across ranks get
 * bottom→top edges, within-rank nodes get left→right edges — clean orthogonal connections.
 * direction="top-to-bottom" stacks ranks downward; "left-to-right" stacks them rightward.
 */
function layeredLayoutAny(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  gap: number,
  direction: "top-to-bottom" | "left-to-right" = "top-to-bottom"
): AllCanvasNodeData[] {
  const n = compNodes.length;
  if (n === 0) return compNodes;
  const idToNode = new Map(compNodes.map((v) => [v.id, v]));
  const adj = new Map<string, string[]>();
  for (const nd of compNodes) adj.set(nd.id, []);
  for (const e of compEdges) {
    if (!idToNode.has(e.fromNode) || !idToNode.has(e.toNode)) continue;
    if (e.fromNode === e.toNode) continue;
    adj.get(e.fromNode)!.push(e.toNode);
  }
  const layer = new Map<string, number>();
  for (const nd of compNodes) layer.set(nd.id, 0);
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (const nd of compNodes) {
      for (const nb of adj.get(nd.id) ?? []) {
        const target = (layer.get(nd.id) ?? 0) + 1;
        if ((layer.get(nb) ?? 0) < target) {
          layer.set(nb, target);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const layers = new Map<number, AllCanvasNodeData[]>();
  let maxLayer = 0;
  for (const nd of compNodes) {
    const l = layer.get(nd.id) ?? 0;
    maxLayer = Math.max(maxLayer, l);
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(nd);
  }
  for (const [, arr] of layers) arr.sort((a, b) => a.x - b.x || b.width - a.width);

  const orderUp = new Map<string, number>();
  for (let l = 0; l <= maxLayer; l++) (layers.get(l) ?? []).forEach((nd, i) => orderUp.set(nd.id, i));
  for (let sweep = 0; sweep < maxLayer; sweep++) {
    for (let l = 1; l <= maxLayer; l++) {
      const arr = layers.get(l) ?? [];
      const scored = arr.map((nd) => {
        const ups: number[] = [];
        for (const o of compNodes) if ((adj.get(o.id) ?? []).includes(nd.id) && (layer.get(o.id) ?? 0) === l - 1) ups.push(orderUp.get(o.id) ?? 0);
        for (const nn of adj.get(nd.id) ?? []) if ((layer.get(nn) ?? 0) === l - 1) ups.push(orderUp.get(nn) ?? 0);
        const bary = ups.length ? ups.reduce((s, x) => s + x, 0) / ups.length : (orderUp.get(nd.id) ?? 0);
        return { nd, bary };
      });
      scored.sort((a, b) => a.bary - b.bary || (orderUp.get(a.nd.id) ?? 0) - (orderUp.get(b.nd.id) ?? 0));
      layers.set(l, scored.map((s) => s.nd));
      scored.forEach((s, i) => orderUp.set(s.nd.id, i));
    }
  }

  const nbrDown = new Map<string, number>();
  for (let l = 0; l <= maxLayer; l++) (layers.get(l) ?? []).forEach((nd, i) => nbrDown.set(nd.id, i));
  for (let sweep = 0; sweep < maxLayer; sweep++) {
    for (let l = maxLayer - 1; l >= 0; l--) {
      const arr = layers.get(l) ?? [];
      const scored = arr.map((nd) => {
        const ups: number[] = [];
        for (const nn of adj.get(nd.id) ?? []) if ((layer.get(nn) ?? 0) === l + 1) ups.push(nbrDown.get(nn) ?? 0);
        for (const o of compNodes) if ((adj.get(o.id) ?? []).includes(nd.id) && (layer.get(o.id) ?? 0) === l + 1) ups.push(nbrDown.get(o.id) ?? 0);
        const bary = ups.length ? ups.reduce((s, x) => s + x, 0) / ups.length : (nbrDown.get(nd.id) ?? 0);
        return { nd, bary };
      });
      scored.sort((a, b) => a.bary - b.bary || (nbrDown.get(a.nd.id) ?? 0) - (nbrDown.get(b.nd.id) ?? 0));
      layers.set(l, scored.map((s) => s.nd));
      scored.forEach((s, i) => nbrDown.set(s.nd.id, i));
    }
  }

  const isLR = direction === "left-to-right";
  let curMain = 0;
  const out = new Map<string, AllCanvasNodeData>();
  let maxLayerSpan = 0;
  for (let l = 0; l <= maxLayer; l++) {
    const arr = layers.get(l) ?? [];
    const span = arr.reduce((s, nd) => s + (isLR ? nd.height : nd.width), 0) + Math.max(0, arr.length - 1) * gap;
    maxLayerSpan = Math.max(maxLayerSpan, span);
  }
  for (let l = 0; l <= maxLayer; l++) {
    const arr = layers.get(l) ?? [];
    const layerSpan = arr.reduce((s, nd) => s + (isLR ? nd.height : nd.width), 0) + Math.max(0, arr.length - 1) * gap;
    let curCross = (maxLayerSpan - layerSpan) / 2;
    let maxCross = 0;
    for (const nd of arr) maxCross = Math.max(maxCross, isLR ? nd.width : nd.height);
    for (const nd of arr) {
      const mainOff = (maxCross - (isLR ? nd.width : nd.height)) / 2;
      if (isLR) {
        out.set(nd.id, { ...nd, x: curMain + mainOff, y: curCross } as AllCanvasNodeData);
      } else {
        out.set(nd.id, { ...nd, x: curCross, y: curMain + mainOff } as AllCanvasNodeData);
      }
      curCross += (isLR ? nd.height : nd.width) + gap;
    }
    curMain += maxCross + gap + 30;
  }
  return compNodes.map((nd) => out.get(nd.id) ?? nd);
}

/**
 * Force-directed layout for a component.
 * Nodes are mutated in place (via PosNode array) and returned as positioned nodes.
 */
export function forceLayoutComponent(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  gap: number,
  iterations = 250
): AllCanvasNodeData[] {
  // small complete graphs (e.g., relations 3 nodes triangle) — place in triangle/circle for label visibility
  if (compNodes.length === 3 && compEdges.length === 3) {
    const [a, b, c] = compNodes;
    if (!a || !b || !c) return compNodes;
    const maxW = Math.max(a.width, b.width, c.width);
    const maxH = Math.max(a.height, b.height, c.height);
    return [
      { ...a, x: 0, y: 0 } as AllCanvasNodeData,
      { ...b, x: maxW + gap + 40, y: 0 } as AllCanvasNodeData,
      { ...c, x: (maxW + gap) / 2, y: maxH + gap + 60 } as AllCanvasNodeData,
    ];
  }
  // try layered first for DAGs (more compact & edge-friendly)
  const layered = layeredLayoutComponent(compNodes, compEdges, gap);
  if (layered) return layered;

  if (compNodes.length <= 1) return compNodes;
  if (compNodes.length === 2 && compEdges.length === 1) {
    const [a, b] = compNodes;
    if (!a || !b) return compNodes;
    return [
      { ...a, x: 0, y: 0 } as AllCanvasNodeData,
      { ...b, x: a.width + gap + 30, y: (a.height - b.height) / 2 } as AllCanvasNodeData,
    ];
  }

  const n = compNodes.length;
  const avgW = compNodes.reduce((s, nd) => s + nd.width, 0) / n;
  const avgH = compNodes.reduce((s, nd) => s + nd.height, 0) / n;
  // tighter area estimate than before (1.1 instead of 1.8) for compactness
  const area = n * (avgW + gap) * (avgH + gap) * 1.15;
  const k = Math.sqrt(area / n) * 0.55; // smaller optimal distance -> tighter

  // init grid
  const cols = Math.ceil(Math.sqrt(n));
  const pos: PosNode[] = compNodes.map((nd, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    return {
      id: nd.id,
      x: col * (avgW + gap + 20),
      y: row * (avgH + gap + 20),
      width: nd.width,
      height: nd.height,
      vx: 0,
      vy: 0,
    };
  });
  const idToIdx = new Map(pos.map((p, i) => [p.id, i]));
  const edgePairs: [number, number][] = [];
  for (const e of compEdges) {
    const a = idToIdx.get(e.fromNode);
    const b = idToIdx.get(e.toNode);
    if (a !== undefined && b !== undefined && a !== b) edgePairs.push([a, b]);
  }

  // center of mass for gravity
  let temp = 1.0;
  const damping = 0.85;
  for (let iter = 0; iter < iterations; iter++) {
    // repulsive between all pairs
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos[i]!, b = pos[j]!;
        let dx = (a.x + a.width / 2) - (b.x + b.width / 2);
        let dy = (a.y + a.height / 2) - (b.y + b.height / 2);
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        // avoid huge forces at tiny distances
        dist = Math.max(dist, 40);
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx * 0.05;
        a.vy += fy * 0.05;
        b.vx -= fx * 0.05;
        b.vy -= fy * 0.05;
      }
    }
    // attractive along edges
    for (const [ai, bi] of edgePairs) {
      const a = pos[ai]!, b = pos[bi]!;
      let dx = (a.x + a.width / 2) - (b.x + b.width / 2);
      let dy = (a.y + a.height / 2) - (b.y + b.height / 2);
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist * dist) / k * 0.04;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
    // straight-line alignment for explicit edges — keeps connections straight (vertical/horizontal) to minimize space and stay visible
    for (const [ai, bi] of edgePairs) {
      const a = pos[ai]!, b = pos[bi]!;
      const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
      const bx = b.x + b.width / 2, by = b.y + b.height / 2;
      const dx = ax - bx, dy = ay - by;
      if (Math.abs(dx) < Math.abs(dy)) {
        const midX = (ax + bx) / 2;
        const fxA = (ax - midX) * 0.14 * temp, fxB = (bx - midX) * 0.14 * temp;
        a.vx -= fxA; b.vx -= fxB;
      } else {
        const midY = (ay + by) / 2;
        const fyA = (ay - midY) * 0.14 * temp, fyB = (by - midY) * 0.14 * temp;
        a.vy -= fyA; b.vy -= fyB;
      }
    }
    // context-aware soft attraction for similar cards (year/place/text) — keeps related papers near each other even without explicit edge
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (edgePairs.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) continue;
        const sim = contextSimilarity(compNodes[i]!, compNodes[j]!);
        if (sim < 0.19) continue;
        const a = pos[i]!, b = pos[j]!;
        let dx = (a.x + a.width / 2) - (b.x + b.width / 2);
        let dy = (a.y + a.height / 2) - (b.y + b.height / 2);
        let dist = Math.hypot(dx, dy) || 1;
        if (dist > 900) continue;
        const force = (dist * dist) / k * 0.032 * sim;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
    // gravity to center (keep compact)
    const cx = pos.reduce((s, p) => s + p.x + p.width / 2, 0) / n;
    const cy = pos.reduce((s, p) => s + p.y + p.height / 2, 0) / n;
    for (const p of pos) {
      const dx = p.x + p.width / 2 - cx;
      const dy = p.y + p.height / 2 - cy;
      p.vx -= dx * 0.01 * temp;
      p.vy -= dy * 0.01 * temp;
    }
    // edge visibility: push nodes away from edges they would hide
    for (const [ai, bi] of edgePairs) {
      const a = pos[ai]!, b = pos[bi]!;
      const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
      const bx = b.x + b.width / 2, by = b.y + b.height / 2;
      for (let ni = 0; ni < n; ni++) {
        if (ni === ai || ni === bi) continue;
        const p = pos[ni]!;
        if (segmentIntersectsRect(ax, ay, bx, by, p.x - gap / 2, p.y - gap / 2, p.width + gap, p.height + gap)) {
          const ex = bx - ax, ey = by - ay;
          const len = Math.hypot(ex, ey) || 1;
          const nx = -ey / len, ny = ex / len;
          const px = p.x + p.width / 2, py = p.y + p.height / 2;
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          const dot = (px - mx) * nx + (py - my) * ny;
          const dir = dot >= 0 ? 1 : -1;
          const push = 16 * (1 - iter / iterations * 0.5);
          p.vx += nx * dir * push;
          p.vy += ny * dir * push;
          // also slightly push endpoints apart to reduce overlap
          a.vx -= nx * dir * 2;
          a.vy -= ny * dir * 2;
          b.vx += nx * dir * 2;
          b.vy += ny * dir * 2;
        }
      }
    }

    // integrate
    for (const p of pos) {
      p.x += p.vx * temp;
      p.y += p.vy * temp;
      p.vx *= damping;
      p.vy *= damping;
    }
    // collision
    if (iter % 5 === 0) resolveCollisions(pos, gap);

    temp = 1 - iter / iterations; // cooling
  }
  resolveCollisions(pos, gap);
  // normalize to min 0,0
  const minX = Math.min(...pos.map((p) => p.x));
  const minY = Math.min(...pos.map((p) => p.y));
  for (const p of pos) {
    p.x -= minX;
    p.y -= minY;
  }
  // map back
  const outMap = new Map(pos.map((p) => [p.id, p]));
  return compNodes.map((nd) => {
    const p = outMap.get(nd.id);
    if (!p) return nd;
    return { ...nd, x: p.x, y: p.y } as AllCanvasNodeData;
  });
}

// ── Component packing via MaxRects (reuses pack.ts logic) ──

function bboxOfNodes(nodes: AllCanvasNodeData[]): { x: number; y: number; width: number; height: number } {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + n.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Edge-aware pack: group into components, force-layout each, then pack components to minimize area.
 * Also optimizes edge sides.
 */
export function graphPack(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  opts: PackOptions & { optimizeMode?: OptimizeMode; iterations?: number }
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[] } {
  if (nodes.length === 0) return { nodes, edges };
  if (edges.length === 0) {
    // fallback: pure area packing
    return { nodes: maxRectsPack(nodes, opts), edges };
  }
  const gap = opts.gap;
  const padding = opts.padding;
  const visibilityGap = gap + 14;
  const comps = connectedComponents(nodes, edges);
  const laidComps: AllCanvasNodeData[][] = [];
  for (const comp of comps) {
    const compEdgeSet = edges.filter((e) => comp.some((n) => n.id === e.fromNode) && comp.some((n) => n.id === e.toNode));
    const laid = forceLayoutComponent(comp, compEdgeSet, visibilityGap, opts.iterations ?? 280);
    // normalize each comp's bbox to start at 0,0 for clean packing (already normalized)
    // shift to have min 0,0 within component (already)
    laidComps.push(laid);
  }

  // Now pack components as meta-rectangles via MaxRects
  // Build meta nodes representing each component's bbox
  type Meta = { id: string; x: number; y: number; width: number; height: number; compIdx: number };
  const metas: Meta[] = laidComps.map((comp, idx) => {
    const bb = bboxOfNodes(comp);
    return { id: `__comp_${idx}`, x: 0, y: 0, width: bb.width, height: bb.height, compIdx: idx };
  });
  // Use maxRectsPack on metas (treat as nodes)
  // Convert metas to AllCanvasNodeData-like for packing
  const metaNodes = metas.map((m) => ({ id: m.id, x: m.x, y: m.y, width: m.width, height: m.height, type: "group" } as unknown as AllCanvasNodeData));
  const packedMetas = maxRectsPack(metaNodes, opts);
  // Map meta positions back to component offsets
  const compOffsets = new Map<number, { dx: number; dy: number }>();
  for (const pm of packedMetas) {
    const idx = parseInt(pm.id.replace("__comp_", ""), 10);
    // pm.x,y is meta position (including padding), comp's internal min is 0,0
    compOffsets.set(idx, { dx: pm.x, dy: pm.y });
  }

  // Apply offsets to each node's position
  const outNodes: AllCanvasNodeData[] = [];
  for (let ci = 0; ci < laidComps.length; ci++) {
    const comp = laidComps[ci]!;
    const off = compOffsets.get(ci) ?? { dx: padding, dy: padding };
    for (const nd of comp) {
      outNodes.push({ ...nd, x: nd.x + off.dx, y: nd.y + off.dy } as AllCanvasNodeData);
    }
  }

  // Finally optimize edge sides for new positions
  let finalNodes = outNodes;
  let finalEdges = optimizeEdges(finalNodes, edges, opts.optimizeMode ?? "shortest");

  // Ensure complete edge visibility: if any edge segment still intersects a card, nudge the blocker
  for (let iter = 0; iter < 8; iter++) {
    let hidden: { edge: CanvasEdgeData; nodeId: string } | null = null;
    outer: for (const e of finalEdges) {
      const fromN = finalNodes.find((n) => n.id === e.fromNode);
      const toN = finalNodes.find((n) => n.id === e.toNode);
      if (!fromN || !toN) continue;
      const fromPt = pointForSide(fromN, (e.fromSide as EdgeSide) ?? "right");
      const toPt = pointForSide(toN, (e.toSide as EdgeSide) ?? "left");
      for (const n of finalNodes) {
        if (n.id === e.fromNode || n.id === e.toNode) continue;
        if (segmentIntersectsRect(fromPt.x, fromPt.y, toPt.x, toPt.y, n.x, n.y, n.width, n.height)) {
          hidden = { edge: e, nodeId: n.id };
          break outer;
        }
      }
    }
    if (!hidden) break;
    const idx = finalNodes.findIndex((n) => n.id === hidden.nodeId);
    if (idx === -1) break;
    const node = finalNodes[idx]!;
    const edge = hidden.edge;
    const fromN = finalNodes.find((n) => n.id === edge.fromNode)!;
    const toN = finalNodes.find((n) => n.id === edge.toNode)!;
    const fromPt = pointForSide(fromN, (edge.fromSide as EdgeSide) ?? "right");
    const toPt = pointForSide(toN, (edge.toSide as EdgeSide) ?? "left");
    const ex = toPt.x - fromPt.x, ey = toPt.y - fromPt.y;
    const len = Math.hypot(ex, ey) || 1;
    const nx = -ey / len, ny = ex / len;
    const px = node.x + node.width / 2, py = node.y + node.height / 2;
    const mx = (fromPt.x + toPt.x) / 2, my = (fromPt.y + toPt.y) / 2;
    const dot = (px - mx) * nx + (py - my) * ny;
    const dir = dot >= 0 ? 1 : -1;
    finalNodes = finalNodes.map((n, i) => (i === idx ? { ...n, x: n.x + nx * dir * 42, y: n.y + ny * dir * 42 } as AllCanvasNodeData : n));
    finalEdges = optimizeEdges(finalNodes, finalEdges, opts.optimizeMode ?? "shortest");
  }
  // Straight-line pass: try to make edges straight (vertical/horizontal) — each straight edge can be a single segment, combined they minimize bbox
  function isStraight(a: AllCanvasNodeData, b: AllCanvasNodeData, fs: string, ts: string): boolean {
    if ((fs === "top" && ts === "bottom") || (fs === "bottom" && ts === "top")) return Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)) < 10;
    if ((fs === "left" && ts === "right") || (fs === "right" && ts === "left")) return Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < 10;
    return false;
  }
  for (let iter = 0; iter < 12; iter++) {
    let made = false;
    for (let ei = 0; ei < finalEdges.length; ei++) {
      const e = finalEdges[ei]!;
      const a = finalNodes.find((n) => n.id === e.fromNode)!, b = finalNodes.find((n) => n.id === e.toNode)!;
      if (isStraight(a, b, e.fromSide as string, e.toSide as string)) continue;
      const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2;
      const tryVertical = Math.abs(ax - bx) < Math.abs(ay - by);
      const candNodes = finalNodes.map((n) => {
        if (n.id !== b.id) return n;
        if (tryVertical) return { ...n, x: a.x + (a.width - n.width) / 2 } as AllCanvasNodeData;
        return { ...n, y: a.y + (a.height - n.height) / 2 } as AllCanvasNodeData;
      });
      let overlap = false;
      for (let i = 0; i < candNodes.length; i++) for (let j = i + 1; j < candNodes.length; j++) {
        const ca = candNodes[i]!, cb = candNodes[j]!;
        if (!(ca.x + ca.width + 20 <= cb.x || cb.x + cb.width + 20 <= ca.x || ca.y + ca.height + 20 <= cb.y || cb.y + cb.height + 20 <= ca.y)) { overlap = true; break; }
      }
      if (overlap) continue;
      let hiddenAfter = 0;
      for (const ce of finalEdges) {
        const ca = candNodes.find((n) => n.id === ce.fromNode)!, cb = candNodes.find((n) => n.id === ce.toNode)!;
        const fp = pointForSide(ca, ce.fromSide as EdgeSide), tp = pointForSide(cb, ce.toSide as EdgeSide);
        for (const n of candNodes) {
          if (n.id === ce.fromNode || n.id === ce.toNode) continue;
          if (segmentIntersectsRect(fp.x, fp.y, tp.x, tp.y, n.x, n.y, n.width, n.height)) { hiddenAfter++; break; }
        }
      }
      if (hiddenAfter > 0) continue;
      const candEdges = optimizeEdges(candNodes, finalEdges, opts.optimizeMode ?? "shortest");
      let straightBefore = 0, straightAfter = 0;
      for (const ce of finalEdges) {
        const ca = finalNodes.find((n) => n.id === ce.fromNode)!, cb = finalNodes.find((n) => n.id === ce.toNode)!;
        if (isStraight(ca, cb, ce.fromSide as string, ce.toSide as string)) straightBefore++;
      }
      for (const ce of candEdges) {
        const ca = candNodes.find((n) => n.id === ce.fromNode)!, cb = candNodes.find((n) => n.id === ce.toNode)!;
        if (isStraight(ca, cb, ce.fromSide as string, ce.toSide as string)) straightAfter++;
      }
      if (straightAfter > straightBefore) {
        finalNodes = candNodes;
        finalEdges = candEdges;
        made = true;
        break;
      }
    }
    if (!made) break;
  }

  return { nodes: finalNodes, edges: finalEdges };
}

/**
 * Orthogonal layered layout for a component of any topology. Assigns layers via
 * cycle-tolerant longest path, orders nodes by barycenter to reduce crossings, then
 * allocates a slot per parent that is divided among its children so parent and child
 * centers align — producing straight cross-layer connections.
 *
 * direction="top-to-bottom": layers flow downward, edges bottom→top
 * direction="left-to-right": layers flow rightward, edges right→left
 */
function orthogonalLayeredLayout(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  gap: number,
  direction: "top-to-bottom" | "left-to-right" = "top-to-bottom"
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[] } {
  const n = compNodes.length;
  if (n === 0) return { nodes: compNodes, edges: compEdges };
  const idToNode = new Map(compNodes.map((v) => [v.id, v]));
  const adj = new Map<string, string[]>();
  for (const nd of compNodes) adj.set(nd.id, []);
  for (const e of compEdges) {
    if (!idToNode.has(e.fromNode) || !idToNode.has(e.toNode) || e.fromNode === e.toNode) continue;
    adj.get(e.fromNode)!.push(e.toNode);
  }
  const layer = new Map<string, number>();
  for (const nd of compNodes) layer.set(nd.id, 0);
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (const nd of compNodes) for (const nb of adj.get(nd.id) ?? []) {
      if ((layer.get(nb) ?? 0) < (layer.get(nd.id) ?? 0) + 1) { layer.set(nb, (layer.get(nd.id) ?? 0) + 1); changed = true; }
    }
    if (!changed) break;
  }

  const layers = new Map<number, AllCanvasNodeData[]>();
  let maxLayer = 0;
  for (const nd of compNodes) {
    const l = layer.get(nd.id) ?? 0;
    maxLayer = Math.max(maxLayer, l);
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(nd);
  }
  for (const [, arr] of layers) arr.sort((a, b) => a.x - b.x || b.width - a.width);

  const children = new Map<string, string[]>();
  for (const nd of compNodes) children.set(nd.id, []);
  for (const e of compEdges) {
    if ((layer.get(e.fromNode) ?? 0) < (layer.get(e.toNode) ?? 0)) children.get(e.fromNode)!.push(e.toNode);
    else if ((layer.get(e.fromNode) ?? 0) > (layer.get(e.toNode) ?? 0)) children.get(e.toNode)!.push(e.fromNode);
    else {
      if ((orderIndex(layers, e.fromNode) ?? 0) < (orderIndex(layers, e.toNode) ?? 0)) children.get(e.fromNode)!.push(e.toNode);
      else children.get(e.toNode)!.push(e.fromNode);
    }
  }
  for (const [, arr] of layers) for (const nd of arr) {
    const ch = children.get(nd.id)!;
    ch.sort((a, b) => (orderIndex(layers, a) ?? 0) - (orderIndex(layers, b) ?? 0));
  }

  // Slot allocation: for TB direction, measure horizontal extent of subtrees; for LR, measure vertical.
  const isLR = direction === "left-to-right";
  const dimOf = new Map<string, number>();
  function subtreeDim(id: string): number {
    if (dimOf.has(id)) return dimOf.get(id)!;
    const ch = children.get(id) ?? [];
    const nd = idToNode.get(id)!;
    const selfDim = isLR ? nd.height : nd.width;
    if (ch.length === 0) { dimOf.set(id, selfDim); return selfDim; }
    const kidsDim = ch.reduce((s, c) => s + subtreeDim(c), 0) + (ch.length - 1) * gap;
    const d = Math.max(selfDim, kidsDim);
    dimOf.set(id, d);
    return d;
  }
  for (const nd of compNodes) subtreeDim(nd.id);

  const placed = new Map<string, number>();
  let gc = 0;
  function assign(id: string, pos: number): number {
    if (placed.has(id)) return pos;
    placed.set(id, pos);
    const node = idToNode.get(id)!;
    const ch = children.get(id) ?? [];
    const selfDim = isLR ? node.height : node.width;
    if (ch.length === 0) return pos + selfDim + gap;
    const kidsDim = ch.reduce((s, c) => s + dimOf.get(c)!, 0) + (ch.length - 1) * gap;
    const center = pos + selfDim / 2;
    let cur = center - kidsDim / 2;
    for (const kid of ch) {
      const kidNode = idToNode.get(kid)!;
      const kidSelfDim = isLR ? kidNode.height : kidNode.width;
      assign(kid, cur + (dimOf.get(kid)! - kidSelfDim) / 2);
      cur += dimOf.get(kid)! + gap;
    }
    return Math.max(pos + selfDim, cur);
  }
  for (const root of (layers.get(0) ?? []).map((nd) => nd.id)) {
    gc = assign(root, gc);
  }

  if (placed.size < n) {
    for (const nd of compNodes) if (!placed.has(nd.id)) { placed.set(nd.id, gc); gc += (isLR ? nd.height : nd.width) + gap; }
  }

  const globalMin = Math.min(...compNodes.map((nd) => placed.get(nd.id) ?? 0));

  const out = new Map<string, AllCanvasNodeData>();
  let layerCursor = 0;
  for (let l = 0; l <= maxLayer; l++) {
    const arr = layers.get(l) ?? [];
    let maxCross = 0;
    for (const nd of arr) maxCross = Math.max(maxCross, isLR ? nd.width : nd.height);
    for (const nd of arr) {
      const pos = (placed.get(nd.id) ?? 0) - globalMin;
      const crossOff = (maxCross - (isLR ? nd.width : nd.height)) / 2;
      if (isLR) {
        out.set(nd.id, { ...nd, x: layerCursor + crossOff, y: pos } as AllCanvasNodeData);
      } else {
        out.set(nd.id, { ...nd, x: pos, y: layerCursor + crossOff } as AllCanvasNodeData);
      }
    }
    const maxMain = Math.max(...arr.map((nd) => isLR ? nd.width : nd.height));
    layerCursor += maxMain + gap + 30;
  }
  const laidNodes = compNodes.map((nd) => out.get(nd.id) ?? nd);

  // Edge sides: TB uses bottom→top; LR uses right→left
  const fromSideTB = "bottom" as const, toSideTB = "top" as const;
  const fromSideLR = "right" as const, toSideLR = "left" as const;
  const fromSideCrossTB = "right" as const, toSideCrossTB = "left" as const;
  const fromSideCrossLR = "bottom" as const, toSideCrossLR = "top" as const;
  const resultEdges = compEdges.map((e) => {
    const la = layer.get(e.fromNode) ?? 0, lb = layer.get(e.toNode) ?? 0;
    if (la < lb) return { ...e, fromSide: isLR ? fromSideLR : fromSideTB, toSide: isLR ? toSideLR : toSideTB } as CanvasEdgeData;
    if (la > lb) return { ...e, fromSide: isLR ? toSideLR : fromSideTB, toSide: isLR ? fromSideLR : toSideTB } as CanvasEdgeData;
    const oa = orderIndex(layers, e.fromNode) ?? 0, ob = orderIndex(layers, e.toNode) ?? 0;
    if (oa < ob) return { ...e, fromSide: isLR ? fromSideCrossLR : fromSideCrossTB, toSide: isLR ? toSideCrossLR : toSideCrossTB } as CanvasEdgeData;
    return { ...e, fromSide: isLR ? toSideCrossLR : toSideCrossTB, toSide: isLR ? fromSideCrossLR : fromSideCrossTB } as CanvasEdgeData;
  });
  return { nodes: laidNodes, edges: resultEdges };
}

function orderIndex(layers: Map<number, AllCanvasNodeData[]>, id: string): number | undefined {
  for (const [, arr] of layers) for (let i = 0; i < arr.length; i++) if (arr[i]!.id === id) return i;
  return undefined;
}

/**
 * Tidy layout: arrange nodes and connections to look clean and organized (not minimum-area).
 * Each connected component (any topology) is laid out internally, then components are placed
 * as separate blocks with generous spacing so nothing overlaps and all labels stay visible.
 */
export function tidyLayout(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  opts: PackOptions & { preserveDirection?: boolean; gap?: number; iterations?: number; optimizeMode?: OptimizeMode; direction?: "top-to-bottom" | "left-to-right" }
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[] } {
  if (nodes.length === 0) return { nodes, edges };
  const gap = opts.gap ?? 40;
  const margin = opts.padding ?? 60;
  const preserve = opts.preserveDirection ?? false;
  const direction = opts.direction ?? "top-to-bottom";

  const comps = connectedComponents(nodes, edges);
  const compEdgeList: CanvasEdgeData[][] = comps.map((comp) => {
    const ids = new Set(comp.map((n) => n.id));
    return edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
  });

  const perCompEdges: CanvasEdgeData[][] = [];
  const laid: AllCanvasNodeData[][] = comps.map((comp, i) => {
    if (comp.length <= 0) return comp;
    if (!preserve) {
      const r = orthogonalLayeredLayout(comp, compEdgeList[i]!, gap, direction);
      perCompEdges[i] = r.edges;
      return r.nodes;
    }
    perCompEdges[i] = compEdgeList[i]!;
    return layeredLayoutAny(comp, compEdgeList[i]!, gap, direction);
  });

  // Arrange component blocks in a clean flow: place each block after the previous,
  // wrapping to a new row when too wide. Generous spacing, no tight packing.
  const blocks = laid.map((comp) => ({
    comp,
    bb: bboxOfNodes(comp),
  }));
  let cursorX = 0, cursorY = 0, rowMaxH = 0;
  const maxRowWidth = 1600;
  const blockGap = 120;
  const offsets: { dx: number; dy: number }[] = [];
  for (const b of blocks) {
    if (cursorX > 0 && cursorX + b.bb.width > maxRowWidth) {
      cursorX = 0;
      cursorY += rowMaxH + blockGap;
      rowMaxH = 0;
    }
    offsets.push({ dx: margin + cursorX, dy: margin + cursorY });
    cursorX += b.bb.width + blockGap;
    rowMaxH = Math.max(rowMaxH, b.bb.height);
  }

  const outNodes: AllCanvasNodeData[] = [];
  const outEdges: CanvasEdgeData[] = [];
  for (let ci = 0; ci < laid.length; ci++) {
    const off = offsets[ci] ?? { dx: margin, dy: margin };
    for (const nd of laid[ci]!) outNodes.push({ ...nd, x: nd.x + off.dx, y: nd.y + off.dy } as AllCanvasNodeData);
    const ids = new Set(laid[ci]!.map((n) => n.id));
    for (const e of perCompEdges[ci] ?? []) {
      if (!ids.has(e.fromNode) || !ids.has(e.toNode)) continue;
      outEdges.push(e);
    }
  }
  const laidIds = new Set(outNodes.map((n) => n.id));
  for (const e of edges) if (!laidIds.has(e.fromNode) || !laidIds.has(e.toNode)) outEdges.push(e);

  let finalEdges = outEdges;
  if (preserve) {
    finalEdges = optimizeEdges(outNodes, outEdges, opts.optimizeMode ?? "shortest");
  }

  return ensureVisibility(outNodes, finalEdges, opts.optimizeMode ?? "shortest", !preserve);
}

/**
 * Ensure every edge (and its label, if any) is fully visible — no edge segment hidden behind
 * a card and no label box overlapping a card. Nudges blocking cards out of the way.
 */
function ensureVisibility(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  optimizeMode: OptimizeMode,
  preserveSides = false
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[] } {
  let finalNodes = nodes;
  let finalEdges = edges;
  for (let iter = 0; iter < 10; iter++) {
    let blocker: { edge: CanvasEdgeData; nodeId: string; labelOverlap: boolean } | null = null;
    outer: for (const e of finalEdges) {
      const fromN = finalNodes.find((n) => n.id === e.fromNode);
      const toN = finalNodes.find((n) => n.id === e.toNode);
      if (!fromN || !toN) continue;
      const fromPt = pointForSide(fromN, (e.fromSide as EdgeSide) ?? "right");
      const toPt = pointForSide(toN, (e.toSide as EdgeSide) ?? "left");
      const label = (e as unknown as { label?: string }).label ?? "";
      const mx = (fromPt.x + toPt.x) / 2, my = (fromPt.y + toPt.y) / 2;
      const lines = label ? label.split("\n").length : 1;
      const lw = label ? Math.max(...label.split("\n").map((l) => l.length)) * 7 + 16 : 0;
      const lh = label ? lines * 16 + 10 : 0;
      for (const n of finalNodes) {
        if (n.id === e.fromNode || n.id === e.toNode) continue;
        if (segmentIntersectsRect(fromPt.x, fromPt.y, toPt.x, toPt.y, n.x, n.y, n.width, n.height)) {
          blocker = { edge: e, nodeId: n.id, labelOverlap: false };
          break outer;
        }
        if (label) {
          const lbx = mx - lw / 2, lby = my - lh / 2;
          if (!(lbx + lw < n.x || n.x + n.width < lbx || lby + lh < n.y || n.y + n.height < lby)) {
            blocker = { edge: e, nodeId: n.id, labelOverlap: true };
            break outer;
          }
        }
      }
    }
    if (!blocker) break;
    const idx = finalNodes.findIndex((n) => n.id === blocker.nodeId);
    if (idx === -1) break;
    const node = finalNodes[idx]!;
    const e = blocker.edge;
    const fromN = finalNodes.find((n) => n.id === e.fromNode)!;
    const toN = finalNodes.find((n) => n.id === e.toNode)!;
    const fromPt = pointForSide(fromN, (e.fromSide as EdgeSide) ?? "right");
    const toPt = pointForSide(toN, (e.toSide as EdgeSide) ?? "left");
    const ex = toPt.x - fromPt.x, ey = toPt.y - fromPt.y;
    const len = Math.hypot(ex, ey) || 1;
    const nx = -ey / len, ny = ex / len;
    const px = node.x + node.width / 2, py = node.y + node.height / 2;
    const mx = (fromPt.x + toPt.x) / 2, my = (fromPt.y + toPt.y) / 2;
    const dot = (px - mx) * nx + (py - my) * ny;
    const dir = dot >= 0 ? 1 : -1;
    const nudge = blocker.labelOverlap ? 26 : 42;
    finalNodes = finalNodes.map((n, i) => (i === idx ? { ...n, x: n.x + nx * dir * nudge, y: n.y + ny * dir * nudge } as AllCanvasNodeData : n));
    if (!preserveSides) finalEdges = optimizeEdges(finalNodes, finalEdges, optimizeMode);
  }
  return { nodes: finalNodes, edges: finalEdges };
}
