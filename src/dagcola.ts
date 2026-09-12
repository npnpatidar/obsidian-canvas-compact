/**
 * d3-dag + webcola integration for Obsidian Canvas layout.
 *
 * This module provides:
 * 1. Layered (Sugiyama) layout via d3-dag — optimal crossing minimization
 * 2. Constraint-based refinement via webcola — hard guarantees for:
 *    - No node overlaps
 *    - Edge separation (directed flow)
 *    - Group/container containment
 *    - Label clearance
 *
 * Note: webcola refinement is experimental and currently disabled by default
 * due to issues with constraint satisfaction. The d3-dag layout alone
 * provides excellent results with optimal crossing minimization.
 */

import type { AllCanvasNodeData, CanvasEdgeData } from "./Canvas.d";
import type { CleanOptions, CleanDirection, CleanReport } from "./clean";
import { verifyCleanLayout, describeCleanReport, DEFAULT_CLEAN_OPTIONS } from "./clean";
import { connectedComponents, pointForSide, type EdgeSide } from "./graph";
import { maxRectsPack, type PackOptions } from "./pack";
import {
  graphConnect,
  sugiyama,
  layeringLongestPath,
  decrossOpt,
  decrossTwoLayer,
  coordSimplex,
  coordGreedy,
  type GraphNode,
  type GraphLink,
  type LayoutResult,
} from "d3-dag";
import { Layout, type Link, type Node, type Group } from "webcola";

// ──────────────────────────────────────────────────────────────────────────────
// Type definitions
// ──────────────────────────────────────────────────────────────────────────────

interface DagNodeDatum {
  id: string;
  width: number;
  height: number;
  type?: string;
  original: AllCanvasNodeData;
}

interface DagLinkDatum {
  source: string;
  target: string;
  original: CanvasEdgeData;
}

type DagGraphNode = GraphNode<DagNodeDatum, DagLinkDatum>;
type DagGraphLink = GraphLink<DagNodeDatum, DagLinkDatum>;

// webcola node/link with our data
interface ColaNode extends Node {
  id: string;
  original: AllCanvasNodeData;
}

interface ColaLink extends Link<ColaNode> {
  original: CanvasEdgeData;
}

// ──────────────────────────────────────────────────────────────────────────────
// d3-dag: Sugiyama layered layout
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Configure and run d3-dag Sugiyama layout on a component.
 * Returns positioned nodes (x, y in component-local coordinates).
 */
function runSugiyamaLayout(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  opts: CleanOptions
): { nodes: AllCanvasNodeData[]; width: number; height: number } {
  if (compNodes.length === 0) return { nodes: [], width: 0, height: 0 };
  if (compNodes.length === 1) {
    const n = compNodes[0]!;
    return { nodes: [{ ...n, x: 0, y: 0 }], width: n.width, height: n.height };
  }

  // Build node data map
  const nodeDataMap = new Map<string, DagNodeDatum>();
  for (const n of compNodes) {
    nodeDataMap.set(n.id, {
      id: n.id,
      width: n.width,
      height: n.height,
      type: n.type,
      original: n,
    });
  }

  const linkData: DagLinkDatum[] = compEdges.map((e) => ({
    source: e.fromNode,
    target: e.toNode,
    original: e,
  }));

  // Create graph using graphConnect with custom accessors
  const builder = graphConnect()
    .sourceId((d: DagLinkDatum) => d.source)
    .targetId((d: DagLinkDatum) => d.target)
    .nodeDatum((id: string) => nodeDataMap.get(id) ?? { id, width: 100, height: 50, original: {} as AllCanvasNodeData });

  const graph = builder(linkData);

  // Calculate gap with label space reservation (matching clean.ts logic)
  let gap = opts.gap;
  if (opts.reserveLabelSpace) {
    const labels = compEdges.map((e) => labelText(e)).filter((l) => l.length > 0);
    if (labels.length > 0) {
      let maxLabelW = 0;
      let maxLabelH = 0;
      for (const l of labels) {
        const lines = l.split("\n");
        maxLabelW = Math.max(maxLabelW, Math.max(...lines.map((s) => s.length)) * 7 + 16);
        maxLabelH = Math.max(maxLabelH, lines.length * 16 + 10);
      }
      gap = Math.min(400, Math.max(gap, maxLabelW + 24, maxLabelH + 24));
    }
  }

  // Create Sugiyama layout - chain all config to avoid TS type narrowing issues
  const layout = sugiyama()
    .nodeSize((node: DagGraphNode): readonly [number, number] => [
      node.data.width + gap,
      node.data.height + gap,
    ])
    .gap([gap, gap])
    .layering(layeringLongestPath())
    .decross(compNodes.length <= 30 ? decrossOpt() : decrossTwoLayer())
    .coord(compNodes.length <= 50 ? coordSimplex() : coordGreedy());

  // Run layout
  const result: LayoutResult = layout(graph);

  // Extract positions back to our node format
  // d3-dag positions nodes at their center (x, y), we use top-left
  const positioned: AllCanvasNodeData[] = compNodes.map((n) => {
    const dagNode = [...graph.nodes()].find((dn) => dn.data.id === n.id);
    if (!dagNode || dagNode.ux === undefined || dagNode.uy === undefined) {
      return { ...n, x: 0, y: 0 };
    }
    return {
      ...n,
      x: dagNode.x - n.width / 2,
      y: dagNode.y - n.height / 2,
    };
  });

  // Normalize to origin
  const minX = Math.min(...positioned.map((n) => n.x));
  const minY = Math.min(...positioned.map((n) => n.y));
  const normalized = positioned.map((n) => ({
    ...n,
    x: n.x - minX,
    y: n.y - minY,
  }));

  return {
    nodes: normalized,
    width: result.width,
    height: result.height,
  };
}

function labelText(edge: CanvasEdgeData): string {
  const l = (edge as { label?: unknown }).label;
  return typeof l === "string" ? l : "";
}

// ──────────────────────────────────────────────────────────────────────────────
// webcola: Constraint-based refinement (experimental, disabled by default)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Generate separation constraints for directed edges to enforce flow direction.
 */
function generateFlowConstraints(
  nodes: ColaNode[],
  edges: ColaLink[],
  direction: CleanDirection,
  gap: number
): any[] {
  const constraints: any[] = [];

  for (const edge of edges) {
    const sourceNode = edge.source as unknown as ColaNode;
    const targetNode = edge.target as unknown as ColaNode;
    const source = nodes.find((n) => n.id === sourceNode.id);
    const target = nodes.find((n) => n.id === targetNode.id);
    if (!source || !target) continue;

    const axis = direction === "left-to-right" ? "x" : "y";
    const sep = gap + 10;

    constraints.push({
      type: "separation",
      axis,
      left: source.id,
      right: target.id,
      gap: sep,
      equality: false,
    });
  }
  return constraints;
}

/**
 * Run webcola constraint solver on a set of nodes and edges.
 * Returns refined positions satisfying all constraints.
 * NOTE: Currently experimental - may not satisfy all constraints reliably.
 */
function runColaRefinement(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  opts: CleanOptions,
  groupMembers: Map<string, Set<string>>
): AllCanvasNodeData[] {
  if (nodes.length <= 1) return nodes;

  const regularNodes = nodes.filter((n) => n.type !== "group");
  const groupNodes = nodes.filter((n) => n.type === "group");

  if (regularNodes.length === 0) return nodes;

  // Create webcola nodes
  const colaNodes: ColaNode[] = regularNodes.map((n) => ({
    id: n.id,
    x: n.x + n.width / 2,
    y: n.y + n.height / 2,
    width: n.width,
    height: n.height,
    fixed: 0,
    original: n,
  }));

  const colaGroups: Group[] = groupNodes.map((g) => ({
    id: g.id,
    padding: opts.padding,
    leaves: [],
    groups: [],
    bounds: undefined,
  }));

  // Create webcola links - must reference actual node objects
  const nodeById = new Map(colaNodes.map((n) => [n.id, n]));
  const colaLinks: ColaLink[] = edges
    .filter((e) => nodeById.has(e.fromNode) && nodeById.has(e.toNode))
    .map((e) => ({
      source: nodeById.get(e.fromNode)!,
      target: nodeById.get(e.toNode)!,
      length: opts.gap + 20,
      weight: 1,
      original: e,
    }));

  // Build constraints
  const constraints: any[] = [
    ...generateFlowConstraints(colaNodes, colaLinks, opts.direction, opts.gap),
  ];

  // Create and configure cola layout
  const cola = new Layout()
    .nodes(colaNodes)
    .groups(colaGroups)
    .links(colaLinks)
    .constraints(constraints)
    .avoidOverlaps(true)
    .handleDisconnected(true)
    .flowLayout(opts.direction === "left-to-right" ? "x" : "y", opts.gap)
    .convergenceThreshold(1e-3)
    .linkDistance(opts.gap + 20)
    .defaultNodeSize(Math.max(...regularNodes.map((n) => Math.max(n.width, n.height))));

  // Run layout
  const iterations = Math.min(50, Math.max(10, nodes.length));
  cola.start(10, 30, iterations, 0, false, true);

  // Extract positions - convert from center to top-left
  const finalPositions = new Map<string, { x: number; y: number }>();
  for (const n of cola.nodes() as ColaNode[]) {
    const w = n.width ?? 100;
    const h = n.height ?? 50;
    finalPositions.set(n.id, { x: n.x - w / 2, y: n.y - h / 2 });
  }

  // Apply to all nodes (including groups)
  const result: AllCanvasNodeData[] = nodes.map((n) => {
    const pos = finalPositions.get(n.id);
    if (!pos) return n;
    return { ...n, x: pos.x, y: pos.y };
  });

  // Normalize to origin
  const minX = Math.min(...result.map((n) => n.x));
  const minY = Math.min(...result.map((n) => n.y));
  return result.map((n) => ({ ...n, x: n.x - minX, y: n.y - minY }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Edge side optimization (post-layout)
// ──────────────────────────────────────────────────────────────────────────────

function optimizeEdgeSides(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  _mode: "shortest" | "preserve-axes" = "shortest"
): CanvasEdgeData[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const sides: EdgeSide[] = ["top", "bottom", "left", "right"];

  return edges.map((edge) => {
    const from = nodeMap.get(edge.fromNode);
    const to = nodeMap.get(edge.toNode);
    if (!from || !to) return edge;

    let best: { fromSide: EdgeSide; toSide: EdgeSide; dist: number } | null = null;

    for (const fs of sides) {
      const fp = pointForSide(from, fs);
      for (const ts of sides) {
        const tp = pointForSide(to, ts);
        const dist = (tp.x - fp.x) ** 2 + (tp.y - fp.y) ** 2;
        if (!best || dist < best.dist) {
          best = { fromSide: fs, toSide: ts, dist };
        }
      }
    }
    if (!best || (best.fromSide === edge.fromSide && best.toSide === edge.toSide)) return edge;
    return { ...edge, fromSide: best.fromSide, toSide: best.toSide };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry: dagcolaLayout
// ──────────────────────────────────────────────────────────────────────────────

export interface DagColaOptions extends Partial<CleanOptions> {
  /** Use webcola refinement after d3-dag layout (default: false - experimental) */
  useColaRefinement?: boolean;
  /** Maximum component size for exact crossing minimization (default: 30) */
  exactDecrossThreshold?: number;
}

/**
 * Main layout function: d3-dag layered layout + optional webcola constraint refinement.
 *
 * Pipeline:
 * 1. Split into connected components
 * 2. For each component: d3-dag Sugiyama layered layout
 * 3. Pack components using MaxRects
 * 4. Optional: webcola refinement with constraints (non-overlap, flow, groups)
 * 5. Edge side optimization
 * 6. Quality verification
 */
export function dagcolaLayout(
  inputNodes: AllCanvasNodeData[],
  inputEdges: CanvasEdgeData[],
  options: DagColaOptions = {}
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport } {
  const opts: CleanOptions = { ...DEFAULT_CLEAN_OPTIONS, ...options };
  const useCola = options.useColaRefinement ?? false; // Disabled by default (experimental)
  const exactThreshold = options.exactDecrossThreshold ?? 30;

  if (inputNodes.length === 0) {
    return { nodes: [], edges: [], report: emptyReport() };
  }

  // Separate groups
  const groups = inputNodes.filter((n) => n.type === "group");
  const regularNodes = inputNodes.filter((n) => n.type !== "group");
  const groupIds = new Set(groups.map((g) => g.id));
  const layoutEdges = inputEdges.filter((e) => !groupIds.has(e.fromNode) && !groupIds.has(e.toNode));

  // Compute group membership
  const groupMembers = computeGroupMembers(inputNodes);

  // Find connected components
  const components = connectedComponents(regularNodes, layoutEdges);

  // Layout each component with d3-dag
  const laidComponents: { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; width: number; height: number }[] = [];

  for (const comp of components) {
    const ids = new Set(comp.map((n) => n.id));
    const compEdges = layoutEdges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));

    const { nodes, width, height } = runSugiyamaLayout(comp, compEdges, opts);

    // Optimize edge sides for this component
    const compEdgesOptimized = optimizeEdgeSides(nodes, compEdges);

    laidComponents.push({
      nodes,
      edges: compEdgesOptimized,
      width,
      height,
    });
  }

  // Pack component bounding boxes using MaxRects
  const metas = laidComponents.map((c, i) => ({
    id: `__dagcola_${i}`,
    x: 0,
    y: 0,
    width: c.width,
    height: c.height,
    type: "group",
  })) as unknown as AllCanvasNodeData[];

  const packOpts: PackOptions = {
    strategy: "maxrects",
    gap: Math.max(opts.gap, 40),
    padding: opts.padding,
    sortBy: "heightDesc",
  };
  const packedMetas = metas.length > 0 ? maxRectsPack(metas, packOpts) : [];

  // Apply component offsets
  let placed: AllCanvasNodeData[] = [];
  const compEdgesAll: CanvasEdgeData[] = [];

  laidComponents.forEach((c, i) => {
    const meta = packedMetas.find((m) => m.id === `__dagcola_${i}`);
    const dx = meta ? meta.x : opts.padding;
    const dy = meta ? meta.y : opts.padding;
    for (const n of c.nodes) placed.push({ ...n, x: n.x + dx, y: n.y + dy });
    compEdgesAll.push(...c.edges);
  });

  // Add any remaining edges (cross-component, groups)
  for (const e of inputEdges) {
    if (!compEdgesAll.some((ce) => ce.id === e.id)) compEdgesAll.push(e);
  }

  // Optional webcola refinement pass (experimental)
  if (useCola && placed.length > 1) {
    placed = runColaRefinement(placed, compEdgesAll, opts, groupMembers);
    // Re-optimize sides after cola moves nodes
    const finalEdges = optimizeEdgeSides(placed, compEdgesAll);
    compEdgesAll.length = 0;
    compEdgesAll.push(...finalEdges);
  }

  // Re-wrap groups around their members
  const withGroups = fitGroups([...placed, ...groups], groupMembers, opts.padding);

  // Verify quality
  const verified = verifyCleanLayout(withGroups, compEdgesAll, groupMembers);
  const report: CleanReport = {
    nodes: withGroups.length,
    edges: compEdgesAll.length,
    components: components.length,
    crossingFreeComponents: countCrossingFree(withGroups, compEdgesAll, components),
    groups: groups.length,
    ...verified,
  };

  // Restore input order
  const byId = new Map(withGroups.map((n) => [n.id, n]));
  const orderedNodes = inputNodes.map((n) => byId.get(n.id) ?? n);

  return { nodes: orderedNodes, edges: compEdgesAll, report };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function computeGroupMembers(nodes: AllCanvasNodeData[]): Map<string, Set<string>> {
  const members = new Map<string, Set<string>>();
  const groupNodes = nodes.filter((n) => n.type === "group");
  for (const g of groupNodes) {
    const set = new Set<string>();
    for (const n of nodes) {
      if (n.id === g.id || n.type === "group") continue;
      const cx = n.x + n.width / 2;
      const cy = n.y + n.height / 2;
      if (cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height) {
        set.add(n.id);
      }
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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
    };
  });
}

function countCrossingFree(
  nodes: AllCanvasNodeData[],
  edges: CanvasEdgeData[],
  components: AllCanvasNodeData[][]
): number {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  let count = 0;
  for (const comp of components) {
    const ids = new Set(comp.map((n) => n.id));
    const compEdges = edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
    const segs = compEdges.map((e) => {
      const from = nodeMap.get(e.fromNode);
      const to = nodeMap.get(e.toNode);
      if (!from || !to) return null;
      return {
        a: pointForSide(from, (e.fromSide as EdgeSide) ?? "right"),
        b: pointForSide(to, (e.toSide as EdgeSide) ?? "left"),
      };
    }).filter((s): s is { a: { x: number; y: number }; b: { x: number; y: number } } => !!s);

    let cross = 0;
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segmentsCross(segs[i]!, segs[j]!)) cross++;
      }
    }
    if (cross === 0) count++;
  }
  return count;
}

function segmentsCross(
  a: { a: { x: number; y: number }; b: { x: number; y: number } },
  b: { a: { x: number; y: number }; b: { x: number; y: number } }
): boolean {
  const orient = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const d1 = orient(a.a, a.b, b.a);
  const d2 = orient(a.a, a.b, b.b);
  const d3 = orient(b.a, b.b, a.a);
  const d4 = orient(b.a, b.b, a.b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function emptyReport(): CleanReport {
  return {
    nodes: 0,
    edges: 0,
    components: 0,
    crossingFreeComponents: 0,
    groups: 0,
    cardOverlaps: 0,
    edgeCrossings: 0,
    edgeCardHits: 0,
    labelCardOverlaps: 0,
    labelLabelOverlaps: 0,
    labelEdgeHits: 0,
  };
}

/**
 * Convenience function matching cleanLayout signature for drop-in replacement.
 */
export function dagcolaCleanLayout(
  inputNodes: AllCanvasNodeData[],
  inputEdges: CanvasEdgeData[],
  opts: CleanOptions = DEFAULT_CLEAN_OPTIONS
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport } {
  return dagcolaLayout(inputNodes, inputEdges, opts);
}