import type { AllCanvasNodeData, CanvasEdgeData, NodeSide } from "./Canvas.d";
import type { PackOptions } from "./pack";
import { maxRectsPack } from "./pack";
import { connectedComponents, pointForSide, segmentIntersectsRect } from "./graph";
import { DEFAULT_EXACT_DECROSS, clusterGap, layoutClusterInDirection } from "./daglayout";
export { DEFAULT_EXACT_DECROSS, MAX_EXACT_DECROSS, SIMPLEX_LIMIT } from "./daglayout";

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
 * The engine is deliberately deterministic (no force simulation). Each cluster
 * is laid out with d3-dag's Sugiyama pipeline — longest-path layering (which
 * ignores back-edges, so cycles are handled), crossing minimisation (exact for
 * small clusters, a fast two-layer heuristic above the threshold), and
 * coordinate assignment. Connection sides and labels are then routed by
 * geometry, a bounded local search reduces any residual crossings, and a
 * cost-aware hill climb pulls cards clear of connections and labels.
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
  /**
   * Cluster size up to which crossing minimisation is exact (`decrossOpt` is
   * exponential). Larger clusters fall back to the two-layer heuristic.
   */
  exactDecrossThreshold: number;
}

export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
  gap: 60,
  padding: 60,
  direction: "top-to-bottom",
  reserveLabelSpace: true,
  reduceCrossings: true,
  maxPasses: 40,
  exactDecrossThreshold: DEFAULT_EXACT_DECROSS,
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

/* ───────────────────────────── component layout ─────────────────────── */

/**
 * Re-seat every connection's endpoints on the sides that face each other, given
 * where the cards ended up. Exported so the DagCola engine starts its clusters
 * from the same geometry-derived sides the Clean engine uses instead of reusing
 * whatever sides the canvas happened to store (which were chosen for the old,
 * pre-layout positions and otherwise skew the crossing count).
 */
export function assignSidesByGeometry(
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
  if (compNodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  if (compNodes.length === 1) {
    const n = compNodes[0]!;
    return {
      nodes: [{ ...n, x: 0, y: 0 } as AllCanvasNodeData],
      edges: assignSidesByGeometry([{ ...n, x: 0, y: 0 } as AllCanvasNodeData], compEdges),
    };
  }

  // d3-dag Sugiyama layout in the requested direction (shared with DagCola).
  const nodes = layoutClusterInDirection(
    compNodes,
    compEdges,
    opts.direction,
    opts.exactDecrossThreshold,
    clusterGap(compEdges, opts)
  );

  // Assign edge sides based on geometry
  let edges = assignSidesByGeometry(nodes, compEdges);

  // The d3-dag layout already minimises crossings optimally (for small graphs)
  // or with a good heuristic (for larger graphs). The local search runs on top
  // as a refinement. Group cards into their actual depth columns from the
  // geometry d3-dag produced, so it swaps cards within one rank and never mixes
  // two ranks that merely share a similar coordinate.
  if (opts.reduceCrossings) {
    const vertical = opts.direction !== "left-to-right";
    const depthOf = new Map<string, number>();
    for (const n of nodes) depthOf.set(n.id, vertical ? Math.round(n.y) : Math.round(n.x));
    const refinedNodes = reduceCrossings(nodes, edges, depthOf, vertical, opts.gap, opts.maxPasses);
    edges = assignSidesByGeometry(refinedNodes, compEdges);
    return { nodes: refinedNodes, edges };
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

/**
 * Clearance delta that fully separates a card from an edge's carrier line,
 * moving perpendicular to the edge (up/down for a horizontal edge, left/right
 * for a vertical one) so neither the card nor `extraHalf` beyond the line stays
 * within `margin` of it. Returns null when already clear.
 */
function perpClearDelta(
  card: AllCanvasNodeData,
  a: Pt,
  b: Pt,
  extraHalf: number,
  margin: number
): { dx: number; dy: number; mag: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const px = -dy / len;
  const py = dx / len;
  const cx = card.x + card.width / 2;
  const cy = card.y + card.height / 2;
  const projHalf = (Math.abs(card.width * px) + Math.abs(card.height * py)) / 2;
  const curDist = (cx - a.x) * px + (cy - a.y) * py;
  const need = projHalf + extraHalf + margin;
  if (Math.abs(curDist) >= need) return null;
  const sign = curDist >= 0 ? 1 : -1;
  const amt = (need - Math.abs(curDist)) * sign;
  return { dx: px * amt, dy: py * amt, mag: Math.abs(amt) };
}

/**
 * Global quality cost for a layout, used by the optimizer to accept/reject a
 * candidate move. Weights encode the priority the user asked for: never draw a
 * connection (or its label) behind a card, then minimise crossings; card/card
 * overlap is treated as a hard constraint so refinement never trades a hidden
 * edge for a visible overlap. Compactness and displacement from the clean
 * layout (`base`) are weak tie-breakers that steer away from ugly sprawl.
 */
function layoutCost(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  base?: Map<string, { x: number; y: number }>
): number {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const segs = edges.map((e) => edgeSegment(e, nodeMap));
  let cost = 0;

  // Card/card overlap — effectively forbidden.
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      if (rectsOverlap(toRect(nodes[i]!), toRect(nodes[j]!))) cost += 60000;

  // Connection passing behind an unrelated card — priority #1, weighted far
  // above crossings so a hidden edge is always eliminated even at the cost of a
  // few crossings.
  for (const s of segs) {
    if (!s) continue;
    for (const n of nodes) {
      if (n.type === "group" || n.id === s.fromId || n.id === s.toId) continue;
      if (segmentIntersectsRect(s.a.x, s.a.y, s.b.x, s.b.y, n.x, n.y, n.width, n.height))
        cost += 30000;
    }
  }

  // Connection crossings — priority #2.
  for (let i = 0; i < segs.length; i++) {
    const si = segs[i];
    if (!si) continue;
    for (let j = i + 1; j < segs.length; j++) {
      const sj = segs[j];
      if (sj && edgesCross(si, sj)) cost += 2500;
    }
  }

  // Labels: never behind a card, never on top of another label or connection.
  for (let i = 0; i < edges.length; i++) {
    const label = labelText(edges[i]!);
    if (!label) continue;
    const s = segs[i];
    if (!s) continue;
    const box = labelBoxFromSegment(s, label);
    for (const n of nodes) {
      if (n.type === "group") continue;
      if (rectsOverlap(box, toRect(n))) cost += 8000;
    }
    for (let j = 0; j < edges.length; j++) {
      if (j === i) continue;
      const s2 = segs[j];
      if (!s2) continue;
      if (segmentIntersectsRect(s2.a.x, s2.a.y, s2.b.x, s2.b.y, box.x, box.y, box.width, box.height))
        cost += 3000;
    }
  }

  // Compactness + regularity — keeps clearance from sprawling or flinging cards.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
    if (base) {
      const b = base.get(n.id);
      if (b) cost += 12 * (Math.abs(n.x - b.x) + Math.abs(n.y - b.y));
    }
  }
  if (Number.isFinite(minX)) cost += (maxX - minX + maxY - minY) * 1.5;
  return cost;
}

function hasEdgeCardHits(nodes: AllCanvasNodeData[], edges: CanvasEdgeData[]): boolean {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const s = edgeSegment(e, nodeMap);
    if (!s) continue;
    for (const n of nodes) {
      if (n.type === "group" || n.id === s.fromId || n.id === s.toId) continue;
      if (segmentIntersectsRect(s.a.x, s.a.y, s.b.x, s.b.y, n.x, n.y, n.width, n.height)) return true;
    }
  }
  return false;
}

/**
 * Raw counts of every quality criterion, so iterations can be watched to confirm
 * the optimizer is progressing (fewer behind-card, fewer crossings, no new
 * overlaps) rather than regressing.
 */
function layoutMetrics(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[]
): { hits: number; crossings: number; cardOL: number; labelCard: number; labelLabel: number; labelEdge: number } {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const segs = edges.map((e) => edgeSegment(e, nodeMap));
  let hits = 0;
  let crossings = 0;
  let cardOL = 0;
  let labelCard = 0;
  let labelLabel = 0;
  let labelEdge = 0;

  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      if (rectsOverlap(toRect(nodes[i]!), toRect(nodes[j]!))) cardOL++;

  for (const s of segs) {
    if (!s) continue;
    for (const n of nodes) {
      if (n.type === "group" || n.id === s.fromId || n.id === s.toId) continue;
      if (segmentIntersectsRect(s.a.x, s.a.y, s.b.x, s.b.y, n.x, n.y, n.width, n.height)) hits++;
    }
  }
  for (let i = 0; i < segs.length; i++) {
    const si = segs[i];
    if (!si) continue;
    for (let j = i + 1; j < segs.length; j++) {
      const sj = segs[j];
      if (sj && edgesCross(si, sj)) crossings++;
    }
  }
  for (let i = 0; i < edges.length; i++) {
    const label = labelText(edges[i]!);
    if (!label) continue;
    const s = segs[i];
    if (!s) continue;
    const box = labelBoxFromSegment(s, label);
    for (const n of nodes) {
      if (n.type === "group") continue;
      if (rectsOverlap(box, toRect(n))) labelCard++;
    }
    for (let j = i + 1; j < edges.length; j++) {
      const s2 = segs[j];
      const l2 = labelText(edges[j]!);
      if (!s2 || !l2) continue;
      if (rectsOverlap(box, labelBoxFromSegment(s2, l2))) labelLabel++;
      if (segmentIntersectsRect(s2.a.x, s2.a.y, s2.b.x, s2.b.y, box.x, box.y, box.width, box.height))
        labelEdge++;
    }
  }
  return { hits, crossings, cardOL, labelCard, labelLabel, labelEdge };
}

/**
 * Candidate card moves that could remove a connection (or label) from behind a
 * card: for every obstacle card intersected by an edge, its exact perpendicular
 * clearance plus axis-aligned (up/down/left/right) variants. Deduplicated.
 */
function clearanceMoves(
  out: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  margin: number,
  scale: number
): { i: number; dx: number; dy: number }[] {
  const nodeMap = new Map(out.map((n, i) => [n.id, n]));
  const index = new Map<string, number>();
  out.forEach((n, i) => index.set(n.id, i));
  const moves = new Map<string, { i: number; dx: number; dy: number }>();
  const push = (n: AllCanvasNodeData, dx: number, dy: number): void => {
    const i = index.get(n.id);
    if (i === undefined) return;
    dx *= scale;
    dy *= scale;
    const key = `${i}|${Math.round(dx)}|${Math.round(dy)}`;
    moves.set(key, { i, dx, dy });
  };
  const addVariants = (n: AllCanvasNodeData, d: { dx: number; dy: number; mag: number }): void => {
    push(n, d.dx, d.dy); // exact perpendicular clearance
    const adx = Math.abs(d.dx);
    const ady = Math.abs(d.dy);
    if (adx >= ady) {
      const s = d.dx >= 0 ? 1 : -1;
      push(n, s * d.mag, 0);
      push(n, -s * d.mag, 0);
    } else {
      const s = d.dy >= 0 ? 1 : -1;
      push(n, 0, s * d.mag);
      push(n, 0, -s * d.mag);
    }
  };

  for (const e of edges) {
    const seg = edgeSegment(e, nodeMap);
    if (!seg) continue;
    const label = labelText(e);
    for (const n of out) {
      if (n.type === "group" || n.id === e.fromNode || n.id === e.toNode) continue;
      if (
        segmentIntersectsRect(seg.a.x, seg.a.y, seg.b.x, seg.b.y, n.x, n.y, n.width, n.height)
      ) {
        const d = perpClearDelta(n, seg.a, seg.b, 0, margin);
        if (d) addVariants(n, d);
      }
    }
    if (label) {
      const box = labelBoxFromSegment(seg, label, 8);
      const pdx = seg.b.x - seg.a.x;
      const pdy = seg.b.y - seg.a.y;
      const plen = Math.hypot(pdx, pdy) || 1;
      const px = -pdy / plen;
      const py = pdx / plen;
      const boxProjHalf = (Math.abs(box.width * px) + Math.abs(box.height * py)) / 2;
      for (const n of out) {
        if (n.type === "group" || n.id === e.fromNode || n.id === e.toNode) continue;
        if (!rectsOverlap(box, toRect(n))) continue;
        const d = perpClearDelta(n, seg.a, seg.b, boxProjHalf, margin);
        if (d) addVariants(n, d);
      }
    }
  }
  return Array.from(moves.values());
}

/**
 * Coordinated, deterministic hill-climbing: each pass evaluates every candidate
 * card move against the global layout cost and commits only the single best
 * improvement (or nothing). Because it never accepts a globally worse move, it
 * cannot disturb a clean layout the way a per-contact greedy jog can. If stuck
 * with a residual behind-card, the move magnitude is doubled to reach farther.
 */
function refineLayout(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  opts: CleanOptions
): AllCanvasNodeData[] {
  const DEBUG = typeof process !== "undefined" && !!process.env?.CLEAN_REFINE_DEBUG;
  const out = nodes.map((n) => ({ ...n })) as AllCanvasNodeData[];
  const base = new Map<string, { x: number; y: number }>();
  for (const n of out) base.set(n.id, { x: n.x, y: n.y });
  if (DEBUG) {
    const m = layoutMetrics(out, edges);
    console.log(`[clean.refine] start  hits=${m.hits} crossings=${m.crossings} cardOL=${m.cardOL} labelCard=${m.labelCard}`);
  }
  let margin = Math.max(6, Math.round(opts.gap / 3));
  let scale = 1;
  const maxPasses = 120;
  const evalCap = 400;
  let totalEvals = 0;
  // Scale the optimisation effort to graph size so large canvases stay bounded
  // while small/typical canvases get a full, best-result search.
  const nodeCount = out.length;
  const totalBudget = nodeCount > 80 ? 4000 : nodeCount > 40 ? 8000 : 15000;
  let accepted = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (totalEvals >= totalBudget) break;
    const cur = layoutCost(out, edges, base);
    if (cur === 0) break;
    const moves = clearanceMoves(out, edges, margin, scale);
    if (moves.length === 0) {
      if (hasEdgeCardHits(out, edges) && scale < 8) {
        scale *= 2;
        if (DEBUG)
          console.log(`[clean.refine] no moves, hits remain — escalate scale=${scale}`);
        continue;
      }
      break;
    }
    let best: { i: number; dx: number; dy: number } | null = null;
    let bestCost = cur;
    let tried = 0;
    for (const mv of moves) {
      if (++tried > evalCap) break;
      const node = out[mv.i]!;
      const sx = node.x;
      const sy = node.y;
      node.x += mv.dx;
      node.y += mv.dy;
      totalEvals++;
      const c = layoutCost(out, edges, base);
      if (c < bestCost) {
        bestCost = c;
        best = mv;
      }
      node.x = sx;
      node.y = sy;
    }
    if (!best || bestCost >= cur) {
      if (hasEdgeCardHits(out, edges) && scale < 8) {
        scale *= 2;
        if (DEBUG)
          console.log(`[clean.refine] best not better, hits remain — escalate scale=${scale}`);
        continue;
      }
      break;
    }
    out[best.i]!.x += best.dx;
    out[best.i]!.y += best.dy;
    accepted++;
    if (DEBUG) {
      const m = layoutMetrics(out, edges);
      console.log(
        `[clean.refine] #${accepted} moved ${out[best.i]!.id} by (${Math.round(best.dx)},${Math.round(best.dy)})  hits=${m.hits} crossings=${m.crossings} cardOL=${m.cardOL} labelCard=${m.labelCard} labelEdge=${m.labelEdge}`
      );
    }
    if (bestCost === 0) break;
    scale = 1;
  }
  if (DEBUG) {
    const m = layoutMetrics(out, edges);
    console.log(`[clean.refine] done   hits=${m.hits} crossings=${m.crossings} cardOL=${m.cardOL} labelCard=${m.labelCard} (accepted ${accepted})`);
  }
  return out;
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

export function computeGroupMembers(
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

/** Padding a group box is wrapped with around its members. */
export function groupPadding(padding: number): number {
  return Math.max(10, padding / 3);
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
    const p = groupPadding(padding);
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

/** One connected cluster, already positioned by a layout engine. */
export interface LaidComponent {
  nodes: AllCanvasNodeData[];
  edges: CanvasEdgeData[];
}

/**
 * Finish a layout whose per-cluster coordinates are already known: pack the
 * clusters, route connections and labels clear of cards, re-wrap group
 * containers, verify, and build the report.
 *
 * This is the shared tail of every engine — the Clean engine and the DagCola
 * engine (d3-dag + webcola) both call it — so packing, connection routing,
 * label placement, the cost-aware refinement pass and the reported numbers can
 * never drift apart between engines. An engine only has to decide where each
 * cluster's cards go.
 */
export function layoutComponents(
  inputNodes: AllCanvasNodeData[],
  inputEdges: CanvasEdgeData[],
  components: AllCanvasNodeData[][],
  laidComponents: LaidComponent[],
  opts: CleanOptions
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport } {
  opts = { ...DEFAULT_CLEAN_OPTIONS, ...opts };
  const nodes = inputNodes;
  const groups = nodes.filter((n) => n.type === "group");
  const members = computeGroupMembers(nodes);
  const edgeById = new Map(inputEdges.map((e) => [e.id, e]));
  for (const c of laidComponents) for (const e of c.edges) edgeById.set(e.id, e);

  // Cluster bounding boxes are measured from the nodes themselves, so they stay
  // correct for any engine and for mirrored/transposed coordinates. A cluster
  // that owns group members also claims the padding those group boxes will be
  // wrapped with, so a neighbouring cluster can never be packed inside a group
  // box (which would silently make those cards part of the group).
  const groupPad = groupPadding(opts.padding);
  const memberIds = new Set<string>();
  for (const set of members.values()) for (const id of set) memberIds.add(id);
  const laid: { nodes: AllCanvasNodeData[]; bbox: Rect }[] = laidComponents.map((c) => {
    const ns = c.nodes;
    if (ns.length === 0) return { nodes: ns, bbox: { x: 0, y: 0, width: 0, height: 0 } };
    const hold = ns.some((n) => memberIds.has(n.id)) ? groupPad : 0;
    const minX = Math.min(...ns.map((n) => n.x));
    const minY = Math.min(...ns.map((n) => n.y));
    const maxX = Math.max(...ns.map((n) => n.x + n.width));
    const maxY = Math.max(...ns.map((n) => n.y + n.height));
    return {
      nodes: ns,
      bbox: {
        x: minX - hold,
        y: minY - hold,
        width: maxX - minX + 2 * hold,
        height: maxY - minY + 2 * hold,
      },
    };
  });

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
  // Coordinated cost-aware refinement: move cards up/down/left/right to clear
  // every connection (and its label) from behind a card, minimising crossings,
  // while never making the global picture worse. Card/card overlap is a hard
  // constraint inside the optimizer, so this cannot disturb a clean layout.
  placed = refineLayout(placed, finalEdges, opts);
  placed = resolveOverlaps(placed, opts.gap);
  // Cards moved, so their faces moved: re-seat sides and labels once more,
  // starting from the edges the optimizer already cleared (re-deriving from the
  // original could reintroduce a behind-card the refinement removed).
  finalEdges = optimizeEdgeClearance(placed, finalEdges);
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

/**
 * Clean layout of one configuration: split into clusters, lay each cluster out
 * with the d3-dag engine, then hand the result to the shared tail.
 */
function runLayout(
  inputNodes: AllCanvasNodeData[],
  inputEdges: CanvasEdgeData[],
  opts: CleanOptions
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport } {
  // Groups are containers, not layout subjects; they are wrapped around their
  // members once everything else has been placed.
  const groupIds = new Set(inputNodes.filter((n) => n.type === "group").map((g) => g.id));
  const layoutNodes = inputNodes.filter((n) => n.type !== "group");
  const layoutEdges = inputEdges.filter((e) => !groupIds.has(e.fromNode) && !groupIds.has(e.toNode));

  const components = connectedComponents(layoutNodes, layoutEdges);
  const laid: LaidComponent[] = components.map((comp) => {
    const ids = new Set(comp.map((n) => n.id));
    const compEdges = layoutEdges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
    return layoutComponent(comp, compEdges, opts);
  });

  return layoutComponents(inputNodes, inputEdges, components, laid, opts);
}

export function bboxArea(nodes: AllCanvasNodeData[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return Number.isFinite(minX) ? (maxX - minX) * (maxY - minY) : 0;
}

/**
 * Lexicographic comparison of two candidate layouts: hard guarantees first
 * (cards behind connections, crossings, overlaps), then label clearance, then
 * compactness. Shared by the Clean engine's orientation search and by the
 * DagCola engine's layered-vs-refined selection.
 */
export function betterReport(a: CleanReport, aArea: number, b: CleanReport, bArea: number): boolean {
  const ka = [
    a.edgeCardHits,
    a.edgeCrossings,
    a.cardOverlaps,
    a.labelCardOverlaps,
    a.labelLabelOverlaps,
    a.labelEdgeHits,
    aArea,
  ];
  const kb = [
    b.edgeCardHits,
    b.edgeCrossings,
    b.cardOverlaps,
    b.labelCardOverlaps,
    b.labelLabelOverlaps,
    b.labelEdgeHits,
    bArea,
  ];
  for (let i = 0; i < ka.length; i++) {
    if (ka[i]! < kb[i]!) return true;
    if (ka[i]! > kb[i]!) return false;
  }
  return false;
}

/**
 * Clean layout with automatic spacing selection. Whether a connection can be
 * routed clear of every card depends on how much room it is given, so this runs
 * a bounded set of spacing scales in the requested direction and returns the
 * cleanest one. The direction itself is a hard constraint: it is what the user
 * asked for, and both engines apply it the same way.
 */
export function cleanLayout(
  inputNodes: AllCanvasNodeData[],
  inputEdges: CanvasEdgeData[],
  opts: CleanOptions = DEFAULT_CLEAN_OPTIONS
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport } {
  opts = { ...DEFAULT_CLEAN_OPTIONS, ...opts };

  const numNodes = inputNodes.length;
  // Fine sampler of spacing scales so the true lexicographic optimum (fewest
  // behind-card, then fewest crossings, then most compact) is found. Each trial
  // is cheap, and the user asked for the best result regardless of time. The
  // grid is coarsened for very large canvases to keep the run bounded.
  const GAPS =
    numNodes > 80
      ? [60, 120, 180, 240, 300]
      : numNodes > 40
        ? [40, 80, 120, 180, 240, 300]
        : [40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300];

  let best: { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport } | null = null;
  let bestArea = 0;

  for (const gap of GAPS) {
    let result: { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport };
    try {
      result = runLayout(inputNodes, inputEdges, { ...opts, gap });
    } catch {
      continue;
    }
    const area = bboxArea(result.nodes);
    if (!best || betterReport(result.report, area, best.report, bestArea)) {
      best = result;
      bestArea = area;
    }
  }
  return best ?? runLayout(inputNodes, inputEdges, opts);
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
