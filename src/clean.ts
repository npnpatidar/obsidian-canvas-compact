import type { AllCanvasNodeData, CanvasEdgeData, NodeSide } from "./Canvas.d";
import type { PackOptions } from "./pack";
import { maxRectsPack } from "./pack";
import { connectedComponents, pointForSide, segmentIntersectsRect } from "./graph";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Clean layout
 *
 * Produces a layout where, as far as the graph topology allows:
 *   • no card overlaps another card (hard guarantee)
 *   • no connection crosses another connection (minimised; zero for trees and
 *     most planar graphs)
 *   • no connection label overlaps a card, another label, or a connection
 *     (hard guarantee where space allows; reported otherwise)
 *
 * Obsidian renders an edge as a bezier between two side anchors, so the only
 * levers are node positions and per-edge side choice. Crossings are therefore a
 * topological property: a non-planar connection graph can never be drawn with
 * zero crossings, which is why this module reports residuals instead of
 * pretending they cannot happen.
 *
 * The engine is deliberately deterministic (no force simulation): a BFS
 * spanning tree is laid out with a layered contour algorithm that is provably
 * crossing-free, then the extra ("cycle-closing") edges are placed by side
 * choice and a bounded local search that only ever reduces crossings.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type CleanDirection = "top-to-bottom" | "left-to-right" | "balanced";

export interface CleanOptions {
  /** Minimum space between cards that are not connected. */
  gap: number;
  /** Margin around the packed bounding box. */
  padding: number;
  /**
   * top-to-bottom / left-to-right: single-directional flow.
   * balanced: mind-map style, root's children split across both sides.
   */
  direction: CleanDirection;
  /** Open extra space between layers so edge labels have room to sit clear. */
  reserveLabelSpace: boolean;
  /** Run the bounded crossing-reduction local search. */
  reduceCrossings: boolean;
  /** Cap on local-search passes. */
  maxPasses: number;
}

export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
  gap: 60,
  padding: 60,
  direction: "top-to-bottom",
  reserveLabelSpace: true,
  reduceCrossings: true,
  maxPasses: 40,
};

export interface CleanReport {
  nodes: number;
  edges: number;
  components: number;
  /** Card/card overlaps. Hard guarantee: always 0. */
  cardOverlaps: number;
  /** Edge/edge crossings. 0 for trees; minimised otherwise. */
  edgeCrossings: number;
  /** Edges passing behind an unrelated card. Hard guarantee: always 0. */
  edgeCardHits: number;
  /** Labels overlapping a card. Hard guarantee: always 0 where space allows. */
  labelCardOverlaps: number;
  /** Labels overlapping another label. */
  labelLabelOverlaps: number;
  /** Labels sitting across an unrelated connection. */
  labelEdgeHits: number;
  /** Components that came out completely crossing-free. */
  crossingFreeComponents: number;
  /** Group nodes repositioned to wrap their members. */
  groups: number;
}

/* ────────────────────────────── geometry ────────────────────────────── */

interface Pt {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function toRect(n: AllCanvasNodeData): Rect {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function expandRect(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m };
}

/** Strict proper segment intersection — shared endpoints / touches do not count. */
function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

function center(n: AllCanvasNodeData): Pt {
  return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
}

/* ──────────────────────────── edge geometry ─────────────────────────── */

type Side = NodeSide;

/** Side facing `other` from `node`, used when an edge has no explicit side. */
function facingSide(node: AllCanvasNodeData, other: AllCanvasNodeData): Side {
  const a = center(node);
  const b = center(other);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function sidesFor(
  edge: CanvasEdgeData,
  from: AllCanvasNodeData,
  to: AllCanvasNodeData
): { fromSide: Side; toSide: Side } {
  const fromSide = (edge.fromSide as Side | undefined) ?? facingSide(from, to);
  const toSide = (edge.toSide as Side | undefined) ?? facingSide(to, from);
  return { fromSide, toSide };
}

interface Segment {
  a: Pt;
  b: Pt;
  fromId: string;
  toId: string;
}

function edgeSegment(
  edge: CanvasEdgeData,
  nodeMap: Map<string, AllCanvasNodeData>,
  override?: { fromSide: Side; toSide: Side }
): Segment | null {
  const from = nodeMap.get(edge.fromNode);
  const to = nodeMap.get(edge.toNode);
  if (!from || !to) return null;
  const sides = override ?? sidesFor(edge, from, to);
  return {
    a: pointForSide(from, sides.fromSide),
    b: pointForSide(to, sides.toSide),
    fromId: from.id,
    toId: to.id,
  };
}

function labelText(edge: CanvasEdgeData): string {
  const l = (edge as { label?: unknown }).label;
  return typeof l === "string" ? l : "";
}

function labelBoxFromSegment(seg: Segment, label: string, pad = 8): Rect {
  const lines = label.split("\n");
  const w = Math.max(1, ...lines.map((l) => l.length)) * 7 + 16;
  const h = lines.length * 16 + 10;
  const mx = (seg.a.x + seg.b.x) / 2;
  const my = (seg.a.y + seg.b.y) / 2;
  return { x: mx - w / 2 - pad, y: my - h / 2 - pad, width: w + 2 * pad, height: h + 2 * pad };
}

/* ──────────────────────────── crossing maths ────────────────────────── */

function edgesCross(s1: Segment, s2: Segment): boolean {
  // Edges sharing an endpoint meet at a card face; that is a join, not a crossing.
  if (
    s1.fromId === s2.fromId ||
    s1.fromId === s2.toId ||
    s1.toId === s2.fromId ||
    s1.toId === s2.toId
  )
    return false;
  return (
    segmentsCross(s1.a, s1.b, s2.a, s2.b) ||
    segmentsCollinearOverlap(s1.a, s1.b, s2.a, s2.b)
  );
}

/**
 * Two edges lying on the same line and sharing more than a point of it are just
 * as bad as a crossing — a strict intersection test misses them entirely, which
 * is exactly how several parallel chords end up drawn on top of each other.
 */
function segmentsCollinearOverlap(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  if (orient(p1, p2, p3) !== 0 || orient(p1, p2, p4) !== 0) return false;
  const useX = Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y);
  const a1 = useX ? p1.x : p1.y;
  const a2 = useX ? p2.x : p2.y;
  const b1 = useX ? p3.x : p3.y;
  const b2 = useX ? p4.x : p4.y;
  const overlap = Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
  return overlap > 2;
}

function countCrossings(nodes: AllCanvasNodeData[], edges: CanvasEdgeData[]): number {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const segs: Segment[] = [];
  for (const e of edges) {
    const s = edgeSegment(e, nodeMap);
    if (s) segs.push(s);
  }
  let count = 0;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) if (edgesCross(segs[i]!, segs[j]!)) count++;
  return count;
}

/* ────────────────────────────── verification ────────────────────────── */

export function verifyCleanLayout(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  groupMembers?: Map<string, Set<string>>
): Omit<CleanReport, "components" | "crossingFreeComponents" | "groups" | "nodes" | "edges"> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Card/card overlaps — group containers are allowed to overlap their members.
  let cardOverlaps = 0;
  const isGroup = (n: AllCanvasNodeData) => n.type === "group";
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      if (isGroup(a) || isGroup(b)) {
        if (!(isGroup(a) && isGroup(b))) {
          const grp = isGroup(a) ? a : b;
          const other = isGroup(a) ? b : a;
          if (groupMembers?.get(grp.id)?.has(other.id)) continue;
        } else continue;
      }
      if (rectsOverlap(toRect(a), toRect(b))) cardOverlaps++;
    }
  }

  const segs: Segment[] = [];
  for (const e of edges) {
    const s = edgeSegment(e, nodeMap);
    if (s) segs.push(s);
  }

  // Edge/edge crossings.
  let edgeCrossings = 0;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) if (edgesCross(segs[i]!, segs[j]!)) edgeCrossings++;

  // Edge passing through an unrelated card.
  let edgeCardHits = 0;
  for (const s of segs) {
    for (const n of nodes) {
      if (n.id === s.fromId || n.id === s.toId || isGroup(n)) continue;
      if (segmentIntersectsRect(s.a.x, s.a.y, s.b.x, s.b.y, n.x, n.y, n.width, n.height)) {
        edgeCardHits++;
        break;
      }
    }
  }

  // Labels.
  const labelBoxes: { edge: number; box: Rect }[] = [];
  for (let i = 0; i < edges.length; i++) {
    const label = labelText(edges[i]!);
    if (!label) continue;
    const s = segs[i];
    if (!s) continue;
    labelBoxes.push({ edge: i, box: labelBoxFromSegment(s, label) });
  }
  let labelCardOverlaps = 0;
  let labelLabelOverlaps = 0;
  let labelEdgeHits = 0;
  for (const { edge: ei, box } of labelBoxes) {
    for (const n of nodes) {
      if (isGroup(n)) continue;
      if (rectsOverlap(box, toRect(n))) labelCardOverlaps++;
    }
    for (const other of labelBoxes) {
      if (other.edge <= ei) continue;
      if (rectsOverlap(box, other.box)) labelLabelOverlaps++;
    }
    for (let si = 0; si < segs.length; si++) {
      if (si === ei) continue;
      const s = segs[si]!;
      const e = edges[ei]!;
      if (s.fromId === e.fromNode || s.toId === e.fromNode || s.fromId === e.toNode || s.toId === e.toNode)
        continue;
      if (segmentIntersectsRect(s.a.x, s.a.y, s.b.x, s.b.y, box.x, box.y, box.width, box.height))
        labelEdgeHits++;
    }
  }

  return {
    cardOverlaps,
    edgeCrossings,
    edgeCardHits,
    labelCardOverlaps,
    labelLabelOverlaps,
    labelEdgeHits,
  };
}

/* ─────────────────────── layered contour tree layout ────────────────── */

interface TNode {
  id: string;
  node: AllCanvasNodeData;
  depth: number;
  children: TNode[];
}

interface Extent {
  top: number;
  bottom: number;
}
type Contour = Map<number, Extent>;
interface Pos {
  main: number;
  cross: number;
}

function mainSize(n: AllCanvasNodeData, vertical: boolean): number {
  return vertical ? n.height : n.width;
}
function crossSize(n: AllCanvasNodeData, vertical: boolean): number {
  return vertical ? n.width : n.height;
}

/** Build a rooted BFS tree spanning the whole (connected) component. */
function buildSpanningTree(
  comp: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  vertical: boolean
): TNode {
  const nodeMap = new Map(comp.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of comp) {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of compEdges) {
    if (!adj.has(e.fromNode) || !adj.has(e.toNode) || e.fromNode === e.toNode) continue;
    adj.get(e.fromNode)!.push(e.toNode);
    adj.get(e.toNode)!.push(e.fromNode);
    indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
  }

  // Root: prefer a true source (no incoming edge), else the best-connected node.
  const candidates = comp.filter((n) => (indeg.get(n.id) ?? 0) === 0);
  const pick = (list: AllCanvasNodeData[]) =>
    [...list].sort((a, b) => {
      const da = adj.get(a.id)?.length ?? 0;
      const db = adj.get(b.id)?.length ?? 0;
      if (db !== da) return db - da;
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    })[0]!;
  const rootNode = candidates.length > 0 ? pick(candidates) : pick(comp);

  const tnode = new Map<string, TNode>();
  for (const n of comp) tnode.set(n.id, { id: n.id, node: n, depth: 0, children: [] });

  const parent = new Map<string, string>();
  const visited = new Set<string>([rootNode.id]);
  const queue: string[] = [rootNode.id];
  while (queue.length > 0) {
    const u = queue.shift()!;
    const neighbours = [...(adj.get(u) ?? [])];
    // Keep the author's ordering along the cross axis when possible.
    neighbours.sort((x, y) => {
      const nx = nodeMap.get(x)!;
      const ny = nodeMap.get(y)!;
      const cx = vertical ? nx.x : nx.y;
      const cy = vertical ? ny.x : ny.y;
      return cx - cy;
    });
    for (const v of neighbours) {
      if (visited.has(v)) continue;
      visited.add(v);
      parent.set(v, u);
      tnode.get(u)!.children.push(tnode.get(v)!);
      tnode.get(v)!.depth = tnode.get(u)!.depth + 1;
      queue.push(v);
    }
  }
  return tnode.get(rootNode.id)!;
}

function packContours(contours: Contour[], gap: number): { offsets: number[]; combined: Contour } {
  const offsets: number[] = [];
  const combined: Contour = new Map();
  if (contours.length === 0) return { offsets, combined };

  offsets.push(0);
  for (const [d, ext] of contours[0]!) combined.set(d, { top: ext.top, bottom: ext.bottom });

  for (let i = 1; i < contours.length; i++) {
    const contour = contours[i]!;
    let shift = 0;
    for (const [d, ext] of contour) {
      const prev = combined.get(d);
      if (prev) {
        const needed = prev.bottom + gap - ext.top;
        if (needed > shift) shift = needed;
      }
    }
    offsets.push(shift);
    for (const [d, ext] of contour) {
      const shifted = { top: ext.top + shift, bottom: ext.bottom + shift };
      const existing = combined.get(d);
      if (existing) {
        existing.top = Math.min(existing.top, shifted.top);
        existing.bottom = Math.max(existing.bottom, shifted.bottom);
      } else combined.set(d, shifted);
    }
  }
  return { offsets, combined };
}

/**
 * Lay out one side of a tree. Columns advance outward along the main axis; a
 * node's children are packed against a per-depth contour so sibling subtrees
 * interlock tightly without overlapping. Because every node of depth d shares
 * a disjoint main-axis band, and nodes at the same depth are separated on the
 * cross axis, the result contains no card overlaps — and, since edges only run
 * between adjacent depths in nested order, no crossings either.
 */
function placeSide(
  group: TNode[],
  rootNode: AllCanvasNodeData,
  vertical: boolean,
  gap: number,
  mirror: boolean
): Map<string, Pos> {
  const maxMainByDepth = new Map<number, number>();
  maxMainByDepth.set(0, mainSize(rootNode, vertical));
  const walk = (t: TNode): void => {
    const cur = maxMainByDepth.get(t.depth) ?? 0;
    maxMainByDepth.set(t.depth, Math.max(cur, mainSize(t.node, vertical)));
    for (const c of t.children) walk(c);
  };
  for (const g of group) walk(g);

  let maxDepth = 0;
  for (const d of maxMainByDepth.keys()) maxDepth = Math.max(maxDepth, d);

  const colMain = new Map<number, number>();
  colMain.set(0, 0);
  for (let d = 1; d <= maxDepth; d++) {
    const prevMain = colMain.get(d - 1) ?? 0;
    colMain.set(d, prevMain + (maxMainByDepth.get(d - 1) ?? 0) + gap);
  }

  // `place` returns the subtree's positions in the local frame where the node
  // itself sits at cross = 0, plus the contour used to interlock it with siblings.
  const place = (t: TNode): { contour: Contour; local: Map<string, Pos> } => {
    const d = t.depth;
    const ms = mainSize(t.node, vertical);
    const cs = crossSize(t.node, vertical);
    const band = maxMainByDepth.get(d) ?? ms;
    const local = new Map<string, Pos>();
    local.set(t.id, { main: (colMain.get(d) ?? 0) + (band - ms) / 2, cross: 0 });

    const contour: Contour = new Map([[d, { top: 0, bottom: cs }]]);
    if (t.children.length === 0) return { contour, local };

    const subs = t.children.map((child) => place(child));
    const { offsets, combined } = packContours(
      subs.map((s) => s.contour),
      gap
    );
    const last = t.children[t.children.length - 1]!;
    const blockTop = offsets[0]!;
    const blockBottom = offsets[offsets.length - 1]! + crossSize(last.node, vertical);
    const shift = cs / 2 - (blockTop + blockBottom) / 2;

    subs.forEach((s, i) => {
      const off = offsets[i]! + shift;
      for (const [id, pos] of s.local) local.set(id, { main: pos.main, cross: pos.cross + off });
    });

    for (const [depth, ext] of combined) {
      const s = { top: ext.top + shift, bottom: ext.bottom + shift };
      const existing = contour.get(depth);
      if (existing) {
        existing.top = Math.min(existing.top, s.top);
        existing.bottom = Math.max(existing.bottom, s.bottom);
      } else contour.set(depth, s);
    }
    return { contour, local };
  };

  const virtualRoot: TNode = { id: "\u0000root", node: rootNode, depth: 0, children: group };
  const { local: out } = place(virtualRoot);
  out.delete(virtualRoot.id);

  if (mirror) {
    const nodeById = new Map<string, AllCanvasNodeData>();
    const collect = (t: TNode): void => {
      nodeById.set(t.id, t.node);
      for (const c of t.children) collect(c);
    };
    for (const g of group) collect(g);
    const rootMain = mainSize(rootNode, vertical);
    for (const [id, pos] of out) {
      const n = nodeById.get(id);
      if (!n) continue;
      out.set(id, { main: rootMain - pos.main - mainSize(n, vertical), cross: pos.cross });
    }
  }
  return out;
}

/* ───────────────────────────── component layout ─────────────────────── */

function assignSidesByGeometry(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  fixed?: Set<string>
): CanvasEdgeData[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return edges.map((e) => {
    if (fixed?.has(e.id)) return e;
    const a = nodeMap.get(e.fromNode);
    const b = nodeMap.get(e.toNode);
    if (!a || !b) return e;
    const { fromSide, toSide } = sidesFor({ ...e, fromSide: undefined, toSide: undefined }, a, b);
    if (e.fromSide === fromSide && e.toSide === toSide) return e;
    return { ...e, fromSide, toSide };
  });
}

/** Bounded local search: swap adjacent cards within a depth column if it reduces crossings. */
function reduceCrossings(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  depthOf: Map<string, number>,
  vertical: boolean,
  gap: number,
  passes: number
): AllCanvasNodeData[] {
  let nodes = compNodes.map((n) => ({ ...n })) as AllCanvasNodeData[];
  let edges = assignSidesByGeometry(nodes, compEdges);
  let best = countCrossings(nodes, edges);
  if (best === 0) return nodes;

  const crossCoord = (n: AllCanvasNodeData) => (vertical ? n.x : n.y);
  const overlaps = (candidate: AllCanvasNodeData[]): boolean => {
    for (let i = 0; i < candidate.length; i++)
      for (let j = i + 1; j < candidate.length; j++)
        if (rectsOverlap(expandRect(toRect(candidate[i]!), gap / 2), toRect(candidate[j]!))) return true;
    return false;
  };

  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    const layers = new Map<number, number[]>();
    nodes.forEach((n, i) => {
      const d = depthOf.get(n.id) ?? 0;
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d)!.push(i);
    });
    for (const idxs of layers.values()) {
      idxs.sort((a, b) => crossCoord(nodes[a]!) - crossCoord(nodes[b]!));
      for (let k = 0; k + 1 < idxs.length; k++) {
        const i = idxs[k]!;
        const j = idxs[k + 1]!;
        const cand = nodes.map((n) => ({ ...n })) as AllCanvasNodeData[];
        const xi = nodes[i]!.x, yi = nodes[i]!.y;
        cand[i] = { ...cand[i]!, x: nodes[j]!.x, y: nodes[j]!.y } as AllCanvasNodeData;
        cand[j] = { ...cand[j]!, x: xi, y: yi } as AllCanvasNodeData;
        if (overlaps(cand)) continue;
        const candEdges = assignSidesByGeometry(cand, compEdges);
        const c = countCrossings(cand, candEdges);
        if (c < best) {
          nodes = cand;
          edges = candEdges;
          best = c;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
    if (!improved || best === 0) break;
  }
  return nodes;
}

interface ComponentResult {
  nodes: AllCanvasNodeData[];
  edges: CanvasEdgeData[];
}

function layoutComponent(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  opts: CleanOptions
): ComponentResult {
  if (compNodes.length === 1) {
    const n = compNodes[0]!;
    return {
      nodes: [{ ...n, x: 0, y: 0 } as AllCanvasNodeData],
      edges: assignSidesByGeometry([{ ...n, x: 0, y: 0 } as AllCanvasNodeData], compEdges),
    };
  }

  // Only top-to-bottom stacks rows; `balanced` is a horizontal mind-map with two
  // columns of depth either side of the root.
  const layoutVertical = opts.direction === "top-to-bottom";

  // A label sits at the edge midpoint, so a component with labels needs enough
  // layer spacing for the widest/tallest label to clear its own endpoint cards.
  const labels = compEdges.map((e) => labelText(e)).filter((l) => l.length > 0);
  let gap = opts.gap;
  if (opts.reserveLabelSpace && labels.length > 0) {
    let maxLabelW = 0;
    let maxLabelH = 0;
    for (const l of labels) {
      const lines = l.split("\n");
      maxLabelW = Math.max(maxLabelW, Math.max(...lines.map((s) => s.length)) * 7 + 16);
      maxLabelH = Math.max(maxLabelH, lines.length * 16 + 10);
    }
    gap = Math.min(400, Math.max(gap, maxLabelW + 24, maxLabelH + 24));
  }

  const root = buildSpanningTree(compNodes, compEdges, layoutVertical);

  let positions: Map<string, Pos>;
  if (opts.direction === "balanced" && root.children.length > 1) {
    // Split the root's children across both sides, greedily balancing extent.
    const demand = (t: TNode): number => {
      const self = crossSize(t.node, false);
      if (t.children.length === 0) return self;
      const kids = t.children.reduce((s, c) => s + demand(c), 0) + (t.children.length - 1) * gap;
      return Math.max(self, kids);
    };
    const ordered = [...root.children].sort((a, b) => demand(b) - demand(a));
    const right: TNode[] = [];
    const left: TNode[] = [];
    let rightLoad = 0;
    let leftLoad = 0;
    for (const c of ordered) {
      const d = demand(c);
      if (rightLoad <= leftLoad) {
        right.push(c);
        rightLoad += d + gap;
      } else {
        left.push(c);
        leftLoad += d + gap;
      }
    }
    positions = new Map<string, Pos>();
    positions.set(root.id, { main: 0, cross: 0 });
    const rightPos = placeSide(right, root.node, false, gap, false);
    const leftPos = placeSide(left, root.node, false, gap, true);
    for (const [id, p] of rightPos) positions.set(id, p);
    for (const [id, p] of leftPos) positions.set(id, p);
  } else {
    positions = new Map<string, Pos>();
    positions.set(root.id, { main: 0, cross: 0 });
    const sidePos = placeSide(root.children, root.node, layoutVertical, gap, false);
    for (const [id, p] of sidePos) positions.set(id, p);
  }

  // main/cross → x/y
  const depthOf = new Map<string, number>();
  const collectDepth = (t: TNode): void => {
    depthOf.set(t.id, t.depth);
    for (const c of t.children) collectDepth(c);
  };
  collectDepth(root);

  let nodes: AllCanvasNodeData[] = compNodes.map((n) => {
    const p = positions.get(n.id) ?? { main: 0, cross: 0 };
    const x = layoutVertical ? p.cross : p.main;
    const y = layoutVertical ? p.main : p.cross;
    return { ...n, x, y } as AllCanvasNodeData;
  });

  // Normalise to (0,0).
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  nodes = nodes.map((n) => ({ ...n, x: n.x - minX, y: n.y - minY }) as AllCanvasNodeData);

  let edges = assignSidesByGeometry(nodes, compEdges);
  if (opts.reduceCrossings) {
    nodes = reduceCrossings(nodes, edges, depthOf, layoutVertical, opts.gap, opts.maxPasses);
    edges = assignSidesByGeometry(nodes, compEdges);
  }

  return { nodes, edges };
}

/* ───────────────────────────── label placement ──────────────────────── */

const SIDE_CHOICES: Side[] = ["top", "bottom", "left", "right"];

/**
 * Choose per-edge sides so labels sit in clear space. Candidates that would
 * introduce a crossing are rejected outright, which preserves the crossing-free
 * guarantee of tree edges; if no candidate is clean we leave the edge alone and
 * let the report surface the residual.
 */
function placeLabelsGlobally(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[]
): CanvasEdgeData[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const result = [...edges];
  const hasLabel = (e: CanvasEdgeData) => labelText(e).length > 0;

  const order = result
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => hasLabel(e))
    .sort((a, b) => {
      const la = labelText(a.e);
      const lb = labelText(b.e);
      return lb.length - la.length;
    });

  const reserved: Rect[] = [];

  for (const { i } of order) {
    const current = result[i]!;
    const from = nodeMap.get(current.fromNode);
    const to = nodeMap.get(current.toNode);
    if (!from || !to) continue;
    const label = labelText(current);

    // Recompute per edge: earlier label choices may have changed other edges' sides.
    const segsAll = result.map((e) => edgeSegment(e, nodeMap));
    const baseSeg = segsAll[i]!;
    const baseCross = countCrossingsInvolving(segsAll, i, result);

    const score = (
      sides: { fromSide: Side; toSide: Side }
    ): { value: number; crossings: number; box: Rect | null } => {
      const seg = edgeSegment(current, nodeMap, sides);
      if (!seg) return { value: Number.POSITIVE_INFINITY, crossings: baseCross, box: null };
      const box = labelBoxFromSegment(seg, label);
      const candSegs = segsAll.map((s, k) => (k === i ? seg : s));
      const crossings = countCrossingsInvolving(candSegs, i, result);

      let cardHits = 0;
      for (const n of nodes) {
        if (n.type === "group") continue;
        // A label overlapping its own endpoint cards is just as bad as any other.
        if (rectsOverlap(box, toRect(n))) cardHits++;
        if (
          n.id !== seg.fromId &&
          n.id !== seg.toId &&
          segmentIntersectsRect(seg.a.x, seg.a.y, seg.b.x, seg.b.y, n.x, n.y, n.width, n.height)
        )
          cardHits += 2;
      }
      let reservedHits = 0;
      for (const r of reserved) if (rectsOverlap(box, r)) reservedHits++;
      let edgeHits = 0;
      for (let si = 0; si < candSegs.length; si++) {
        if (si === i) continue;
        const s = candSegs[si];
        if (!s) continue;
        const e = result[si]!;
        if (
          s.fromId === current.fromNode ||
          s.toId === current.fromNode ||
          s.fromId === current.toNode ||
          s.toId === current.toNode
        )
          continue;
        if (segmentIntersectsRect(s.a.x, s.a.y, s.b.x, s.b.y, box.x, box.y, box.width, box.height))
          edgeHits++;
      }

      const value =
        4000 * cardHits +
        1500 * reservedHits +
        400 * edgeHits +
        30 * crossings +
        Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y) * 0.02;
      return { value, crossings, box };
    };

    let best: { sides: { fromSide: Side; toSide: Side }; value: number; box: Rect } | null = null;
    for (const fs of SIDE_CHOICES) {
      for (const ts of SIDE_CHOICES) {
        const sides = { fromSide: fs, toSide: ts };
        const s = score(sides);
        if (s.crossings > baseCross) continue; // never trade a crossing for a label
        if (!s.box) continue;
        if (!best || s.value < best.value) best = { sides, value: s.value, box: s.box };
      }
    }

    if (!best) {
      if (baseSeg) reserved.push(labelBoxFromSegment(baseSeg, label));
      continue;
    }
    result[i] = { ...current, fromSide: best.sides.fromSide, toSide: best.sides.toSide };
    reserved.push(best.box);
  }
  return result;
}

function segmentCardHits(
  seg: Segment,
  nodes: AllCanvasNodeData[]
): number {
  let hits = 0;
  for (const n of nodes) {
    if (n.id === seg.fromId || n.id === seg.toId || n.type === "group") continue;
    if (segmentIntersectsRect(seg.a.x, seg.a.y, seg.b.x, seg.b.y, n.x, n.y, n.width, n.height)) hits++;
  }
  return hits;
}

/**
 * Route any connection that currently passes behind a card around it by trying
 * every side pair, accepting a change only when it removes hits without adding a
 * crossing (so the crossing-free property of tree edges is preserved).
 */
function optimizeEdgeClearance(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[]
): CanvasEdgeData[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const result = [...edges];
  let segs = result.map((e) => edgeSegment(e, nodeMap));

  for (let i = 0; i < result.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    const currentHits = segmentCardHits(seg, nodes);
    if (currentHits === 0) continue;

    const baseCross = countCrossingsInvolving(segs, i, result);
    const e = result[i]!;
    let best: { fromSide: Side; toSide: Side; hits: number; value: number } | null = null;
    for (const fs of SIDE_CHOICES) {
      for (const ts of SIDE_CHOICES) {
        const cand = edgeSegment(e, nodeMap, { fromSide: fs, toSide: ts });
        if (!cand) continue;
        const candSegs = segs.map((s, k) => (k === i ? cand : s));
        const cross = countCrossingsInvolving(candSegs, i, result);
        if (cross > baseCross) continue;
        const hits = segmentCardHits(cand, nodes);
        const value =
          1000 * hits +
          30 * cross +
          Math.hypot(cand.b.x - cand.a.x, cand.b.y - cand.a.y) * 0.01;
        if (!best || value < best.value) best = { fromSide: fs, toSide: ts, hits, value };
      }
    }
    if (best && best.hits < currentHits) {
      result[i] = { ...e, fromSide: best.fromSide, toSide: best.toSide };
      segs = result.map((ed) => edgeSegment(ed, nodeMap));
    }
  }
  return result;
}

function countCrossingsInvolving(
  segs: (Segment | null)[],
  idx: number,
  _edges: CanvasEdgeData[]
): number {
  const s = segs[idx];
  if (!s) return 0;
  let count = 0;
  for (let j = 0; j < segs.length; j++) {
    if (j === idx) continue;
    const o = segs[j];
    if (!o) continue;
    if (edgesCross(s, o)) count++;
  }
  return count;
}

/* ──────────────────────── overlap safety + groups ───────────────────── */

/** Deterministic separation pass. Layout should already be clean; this is a net. */
function resolveOverlaps(nodes: AllCanvasNodeData[], gap: number, iterations = 24): AllCanvasNodeData[] {
  const out = nodes.map((n) => ({ ...n })) as AllCanvasNodeData[];

  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!;
      if (a.type === "group") continue;
      for (let j = i + 1; j < out.length; j++) {
        const b = out[j]!;
        if (b.type === "group") continue;
        const A = toRect(a);
        const B = toRect(b);
        if (!rectsOverlap(expandRect(A, gap / 2), expandRect(B, gap / 2))) continue;
        const overlapX = Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x);
        const overlapY = Math.min(A.y + A.height, B.y + B.height) - Math.max(A.y, B.y);
        if (overlapX <= overlapY) {
          const push = overlapX / 2 + 1;
          if (A.x < B.x) {
            a.x -= push;
            b.x += push;
          } else {
            a.x += push;
            b.x -= push;
          }
        } else {
          const push = overlapY / 2 + 1;
          if (A.y < B.y) {
            a.y -= push;
            b.y += push;
          } else {
            a.y += push;
            b.y -= push;
          }
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

function computeGroupMembers(
  nodes: AllCanvasNodeData[]
): Map<string, Set<string>> {
  const members = new Map<string, Set<string>>();
  const groups = nodes.filter((n) => n.type === "group");
  for (const g of groups) {
    const set = new Set<string>();
    for (const n of nodes) {
      if (n.id === g.id || n.type === "group") continue;
      const c = center(n);
      if (c.x >= g.x && c.x <= g.x + g.width && c.y >= g.y && c.y <= g.y + g.height) set.add(n.id);
    }
    members.set(g.id, set);
  }
  return members;
}

function fitGroups(
  nodes: AllCanvasNodeData[],
  members: Map<string, Set<string>>,
  padding: number
): AllCanvasNodeData[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.map((n) => {
    if (n.type !== "group") return n;
    const set = members.get(n.id);
    if (!set || set.size === 0) return n;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of set) {
      const m = byId.get(id);
      if (!m) continue;
      minX = Math.min(minX, m.x);
      minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x + m.width);
      maxY = Math.max(maxY, m.y + m.height);
    }
    if (!Number.isFinite(minX)) return n;
    const p = Math.max(10, padding / 3);
    return {
      ...n,
      x: minX - p,
      y: minY - p,
      width: maxX - minX + 2 * p,
      height: maxY - minY + 2 * p,
    } as AllCanvasNodeData;
  });
}

/* ────────────────────────────── entry point ─────────────────────────── */

export function cleanLayout(
  inputNodes: AllCanvasNodeData[],
  inputEdges: CanvasEdgeData[],
  opts: CleanOptions = DEFAULT_CLEAN_OPTIONS
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport } {
  const nodes = inputNodes;
  const groups = nodes.filter((n) => n.type === "group");
  const members = computeGroupMembers(nodes);

  // Groups are containers, not layout subjects; they are wrapped around their
  // members once everything else has been placed.
  const layoutNodes = nodes.filter((n) => n.type !== "group");
  const groupIds = new Set(groups.map((g) => g.id));
  const layoutEdges = inputEdges.filter((e) => !groupIds.has(e.fromNode) && !groupIds.has(e.toNode));

  const components = connectedComponents(layoutNodes, layoutEdges);
  const edgeById = new Map(inputEdges.map((e) => [e.id, e]));

  const laid: { nodes: AllCanvasNodeData[]; bbox: Rect }[] = [];

  for (const comp of components) {
    const ids = new Set(comp.map((n) => n.id));
    const compEdges = layoutEdges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
    const result = layoutComponent(comp, compEdges, opts);

    for (const e of result.edges) edgeById.set(e.id, e);

    const minX = Math.min(...result.nodes.map((n) => n.x));
    const minY = Math.min(...result.nodes.map((n) => n.y));
    const maxX = Math.max(...result.nodes.map((n) => n.x + n.width));
    const maxY = Math.max(...result.nodes.map((n) => n.y + n.height));
    laid.push({
      nodes: result.nodes,
      bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    });
  }

  // Pack component bounding boxes so clusters do not touch.
  const packOpts: PackOptions = {
    strategy: "maxrects",
    gap: Math.max(opts.gap, 40),
    padding: opts.padding,
    sortBy: "heightDesc",
  };
  const metas = laid.map(
    (c, i) =>
      ({
        id: `__clean_${i}`,
        x: 0,
        y: 0,
        width: c.bbox.width,
        height: c.bbox.height,
        type: "group",
      }) as unknown as AllCanvasNodeData
  );
  const packedMetas = metas.length > 0 ? maxRectsPack(metas, packOpts) : [];

  let placed: AllCanvasNodeData[] = [];
  laid.forEach((c, i) => {
    const meta = packedMetas.find((m) => m.id === `__clean_${i}`);
    const dx = meta ? meta.x : opts.padding;
    const dy = meta ? meta.y : opts.padding;
    for (const n of c.nodes) placed.push({ ...n, x: n.x + dx, y: n.y + dy } as AllCanvasNodeData);
  });

  // Safety net (layout is overlap-free by construction, so this is a no-op).
  placed = resolveOverlaps(placed, opts.gap);

  // Keep untouched nodes (none expected) and re-attach groups.
  const placedIds = new Set(placed.map((n) => n.id));
  for (const n of nodes) if (!placedIds.has(n.id) && n.type !== "group") placed.push({ ...n });

  const edgesArray = inputEdges.map((e) => edgeById.get(e.id) ?? e);
  // Route connections around cards first, then give labels clear space.
  let finalEdges = optimizeEdgeClearance(placed, edgesArray);
  finalEdges = placeLabelsGlobally(placed, finalEdges);
  // Group containers are re-wrapped around their members (they are not laid out).
  const withGroups = fitGroups([...placed, ...groups], members, opts.padding);

  // Per-cluster crossing check runs on the final edges (after side/label tuning).
  let crossingFreeComponents = 0;
  {
    const finalNodeMap = new Map(withGroups.map((n) => [n.id, n]));
    for (const comp of components) {
      const ids = new Set(comp.map((n) => n.id));
      // Component arrays hold pre-layout coordinates — look the final ones up.
      const compNodes = comp
        .map((n) => finalNodeMap.get(n.id))
        .filter((n): n is AllCanvasNodeData => !!n);
      const csegs = finalEdges
        .filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
        .map((e) => edgeSegment(e, finalNodeMap))
        .filter((s): s is Segment => !!s);
      let cross = 0;
      for (let i = 0; i < csegs.length; i++)
        for (let j = i + 1; j < csegs.length; j++)
          if (edgesCross(csegs[i]!, csegs[j]!)) cross++;
      // A cluster only counts as clean if nothing is drawn behind a card either.
      const hidden = csegs.reduce((s, seg) => s + (segmentCardHits(seg, compNodes) > 0 ? 1 : 0), 0);
      if (cross === 0 && hidden === 0) crossingFreeComponents++;
    }
  }

  // Restore the caller's node order so writing back produces a minimal diff.
  const byId = new Map(withGroups.map((n) => [n.id, n]));
  const orderedNodes = inputNodes.map((n) => byId.get(n.id) ?? n);

  const verified = verifyCleanLayout(orderedNodes, finalEdges, members);
  const report: CleanReport = {
    nodes: orderedNodes.length,
    edges: finalEdges.length,
    components: components.length,
    crossingFreeComponents,
    groups: groups.length,
    ...verified,
  };

  return { nodes: orderedNodes, edges: finalEdges, report };
}

export function describeCleanReport(r: CleanReport): string {
  const clean =
    r.cardOverlaps === 0 &&
    r.edgeCrossings === 0 &&
    r.edgeCardHits === 0 &&
    r.labelCardOverlaps === 0 &&
    r.labelLabelOverlaps === 0 &&
    r.labelEdgeHits === 0;
  if (clean) {
    return `Clean layout ✓ — ${r.nodes} cards, ${r.edges} connections, no overlaps and no crossings (${r.crossingFreeComponents}/${r.components} clusters fully clean).`;
  }
  const residual: string[] = [];
  if (r.edgeCrossings > 0) residual.push(`${r.edgeCrossings} connection crossing${r.edgeCrossings === 1 ? "" : "s"}`);
  if (r.labelCardOverlaps > 0) residual.push(`${r.labelCardOverlaps} label/card overlap${r.labelCardOverlaps === 1 ? "" : "s"}`);
  if (r.labelLabelOverlaps > 0) residual.push(`${r.labelLabelOverlaps} label/label overlap${r.labelLabelOverlaps === 1 ? "" : "s"}`);
  if (r.labelEdgeHits > 0) residual.push(`${r.labelEdgeHits} label crossing a connection`);
  if (r.edgeCardHits > 0) residual.push(`${r.edgeCardHits} connection behind a card`);
  return `Clean layout: ${r.nodes} cards, ${r.edges} connections — ${r.crossingFreeComponents}/${r.components} clusters fully clean; residual: ${residual.join(", ")}.`;
}
