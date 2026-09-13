/**
 * Shared d3-dag cluster layout.
 *
 * The Clean engine and the DagCola engine both start from the same ranked
 * arrangement: a Sugiyama layered layout per connected cluster. Keeping it in
 * one module is what makes `Direction` mean the same thing in both engines —
 * `top-to-bottom`, `left-to-right` (extents swapped, coordinates transposed) and
 * `balanced` (root's branches split into two mirrored wings, mind-map style).
 *
 * DagCola then feeds these positions to webcola for constraint refinement;
 * Clean uses them directly.
 */

import type { AllCanvasNodeData, CanvasEdgeData } from "./Canvas.d";
import type { CleanDirection, CleanOptions } from "./clean";
import {
  graphConnect,
  sugiyama,
  layeringLongestPath,
  decrossOpt,
  decrossTwoLayer,
  coordSimplex,
  coordGreedy,
  type GraphNode,
} from "d3-dag";

/** Component size at or below which crossing minimisation is solved exactly. */
export const DEFAULT_EXACT_DECROSS = 30;
/** `decrossOpt` is exponential; never let a setting push a run past this. */
export const MAX_EXACT_DECROSS = 60;
/** Above this, coordinate assignment falls back to the fast heuristic. */
export const SIMPLEX_LIMIT = 120;

interface DagNodeDatum {
  id: string;
  width: number;
  height: number;
  original: AllCanvasNodeData;
}

interface DagLinkDatum {
  source: string;
  target: string;
  original: CanvasEdgeData;
}

type DagGraphNode = GraphNode<DagNodeDatum, DagLinkDatum>;

function labelText(edge: CanvasEdgeData): string {
  const label = (edge as { label?: unknown }).label;
  return typeof label === "string" ? label : "";
}

/** Shift a cluster so its bounding box starts at the origin. */
export function normalise(nodes: AllCanvasNodeData[]): AllCanvasNodeData[] {
  if (nodes.length === 0) return nodes;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  return nodes.map((n) => ({ ...n, x: n.x - minX, y: n.y - minY }));
}

/**
 * Spacing actually used for a cluster: widened to fit connection labels when the
 * caller asked for label space, matching the Clean engine's estimate of a
 * rendered label box. Resolved once per cluster and then used by every candidate
 * engine, so d3-dag lays out at that spacing and webcola keeps exactly that
 * spacing rather than squeezing it away again.
 */
export function clusterGap(compEdges: CanvasEdgeData[], opts: CleanOptions): number {
  const gap = opts.gap;
  if (!opts.reserveLabelSpace) return gap;
  const labels = compEdges.map(labelText).filter((l) => l.length > 0);
  if (labels.length === 0) return gap;
  let maxLabelW = 0;
  let maxLabelH = 0;
  for (const l of labels) {
    const lines = l.split("\n");
    maxLabelW = Math.max(maxLabelW, Math.max(...lines.map((s) => s.length)) * 7 + 16);
    maxLabelH = Math.max(maxLabelH, lines.length * 16 + 10);
  }
  return Math.min(400, Math.max(gap, maxLabelW + 24, maxLabelH + 24));
}

/**
 * Lay out one cluster with d3-dag's Sugiyama pipeline.
 *
 * Both axes are handled by the same call: for `left-to-right` the node extents
 * fed to d3-dag are swapped and the resulting coordinates are transposed, so the
 * lane spacing that guarantees separation is computed from the extent that ends
 * up on that axis.
 */
export function layeredCluster(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  direction: "top-to-bottom" | "left-to-right",
  exactDecross: number,
  gap: number
): AllCanvasNodeData[] {
  if (compNodes.length <= 1) return normalise(compNodes);

  const leftToRight = direction === "left-to-right";
  const dataById = new Map<string, DagNodeDatum>(
    compNodes.map((n) => [n.id, { id: n.id, width: n.width, height: n.height, original: n }])
  );

  // Self-connections are not edges in a DAG and d3-dag rejects them.
  const linkData: DagLinkDatum[] = compEdges
    .filter((e) => e.fromNode !== e.toNode && dataById.has(e.fromNode) && dataById.has(e.toNode))
    .map((e) => ({ source: e.fromNode, target: e.toNode, original: e }));

  const graph = graphConnect()
    .sourceId((d: DagLinkDatum) => d.source)
    .targetId((d: DagLinkDatum) => d.target)
    .nodeDatum((id: string) => dataById.get(id) ?? { id, width: 100, height: 50, original: {} as AllCanvasNodeData })(
      linkData
    );

  // d3-dag reserves `nodeSize` per node and adds `.gap()` spacing on top, so the
  // node's own extents must be given without the gap added in.
  const sizeOf = (node: DagGraphNode): readonly [number, number] =>
    leftToRight ? [node.data.height, node.data.width] : [node.data.width, node.data.height];

  const exact = compNodes.length <= exactDecross;
  sugiyama()
    .nodeSize(sizeOf)
    .gap([gap, gap])
    .layering(layeringLongestPath())
    .decross(exact ? decrossOpt() : decrossTwoLayer())
    .coord(compNodes.length <= SIMPLEX_LIMIT ? coordSimplex() : coordGreedy())(graph);

  // d3-dag stores the assigned centre in `ux`/`uy`; `x`/`y` throw while unset.
  const positioned = new Map<string, DagGraphNode>();
  for (const node of graph.nodes()) positioned.set(node.data.id, node);

  const placed = compNodes.map((n) => {
    const node = positioned.get(n.id);
    if (!node || node.ux === undefined || node.uy === undefined) return { ...n } as AllCanvasNodeData;
    const cx = node.ux;
    const cy = node.uy;
    // Transposed for left-to-right: the lane axis becomes y, the rank axis x.
    return (
      leftToRight
        ? { ...n, x: cy - n.width / 2, y: cx - n.height / 2 }
        : { ...n, x: cx - n.width / 2, y: cy - n.height / 2 }
    ) as AllCanvasNodeData;
  });

  return normalise(placed);
}

/**
 * Mind-map orientation: split the root's branches into two wings, lay each wing
 * out independently as a layered cluster, mirror one of them, and stand them
 * side by side with the root centred above. The wings occupy disjoint x ranges
 * and sit entirely below the root, so the result cannot self-overlap.
 */
export function balancedCluster(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  exactDecross: number,
  gap: number
): AllCanvasNodeData[] {
  const fallback = () => layeredCluster(compNodes, compEdges, "top-to-bottom", exactDecross, gap);
  if (compNodes.length <= 2) return fallback();

  const childrenOf = (id: string): string[] =>
    compEdges.filter((e) => e.fromNode === id && e.toNode !== id).map((e) => e.toNode);

  const root = compNodes.find((n) => !compEdges.some((e) => e.toNode === n.id && e.fromNode !== n.id));
  if (!root) return fallback();

  const ordered = [...new Set(childrenOf(root.id))]
    .map((id) => compNodes.find((n) => n.id === id))
    .filter((n): n is AllCanvasNodeData => !!n)
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (ordered.length < 2) return fallback();

  // Walk out from each wing's branches; every other card must be reachable from
  // exactly one of them or the graph is not a single-rooted tree and the plain
  // layered layout is the better answer.
  const sideOf = new Map<string, "left" | "right">();
  const assign = (ids: string[], side: "left" | "right"): void => {
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop()!;
      if (sideOf.has(id) || id === root.id) continue;
      sideOf.set(id, side);
      stack.push(...childrenOf(id));
    }
  };
  const half = Math.ceil(ordered.length / 2);
  assign(ordered.slice(0, half).map((n) => n.id), "right");
  assign(ordered.slice(half).map((n) => n.id), "left");
  if (sideOf.size !== compNodes.length - 1) return fallback();

  const wing = (side: "left" | "right"): AllCanvasNodeData[] => {
    const nodes = compNodes.filter((n) => sideOf.get(n.id) === side);
    const ids = new Set(nodes.map((n) => n.id));
    return layeredCluster(
      nodes,
      compEdges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode)),
      "top-to-bottom",
      exactDecross,
      gap
    );
  };
  const right = wing("right");
  const left = wing("left");
  if (left.length === 0 || right.length === 0) return fallback();

  const leftSpan = Math.max(...left.map((n) => n.x + n.width));
  const mirrored = left.map((n) => ({ ...n, x: leftSpan - n.x - n.width }));
  const leftWidth = Math.max(...mirrored.map((n) => n.x + n.width));
  const rightWidth = Math.max(...right.map((n) => n.x + n.width));
  const rowGap = Math.max(gap, 40);
  const wingY = root.height + rowGap;
  // Centre the root over whichever wing is wider, then flank it with both.
  const rootX = Math.max(leftWidth, rightWidth) + rowGap;
  const leftX = rootX - rowGap - leftWidth;

  return normalise([
    { ...root, x: rootX, y: 0 } as AllCanvasNodeData,
    ...mirrored.map((n) => ({ ...n, x: n.x + leftX, y: n.y + wingY }) as AllCanvasNodeData),
    ...right.map((n) => ({ ...n, x: n.x + rootX + root.width + rowGap, y: n.y + wingY }) as AllCanvasNodeData),
  ]);
}

/** Lay out one cluster in the requested direction. */
export function layoutClusterInDirection(
  comp: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  direction: CleanDirection,
  exactDecross: number,
  gap: number
): AllCanvasNodeData[] {
  return direction === "balanced"
    ? balancedCluster(comp, compEdges, exactDecross, gap)
    : layeredCluster(comp, compEdges, direction, exactDecross, gap);
}
