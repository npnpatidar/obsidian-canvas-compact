/**
 * DagCola: d3-dag + webcola for Obsidian Canvas layout.
 *
 * The two libraries have different jobs, and both of them matter:
 *
 * 1. **d3-dag** does the ranked work. Each cluster is laid out with a Sugiyama
 *    layered layout: longest-path layering (cycles are handled by ignoring
 *    back-edges), crossing minimisation (exact below the configured threshold,
 *    a fast two-layer heuristic above it), and coordinate assignment. This is
 *    the shared `daglayout.ts` code, so Clean and DagCola honour
 *    `top-to-bottom`, `left-to-right` and `balanced` (mind-map) identically.
 *
 * 2. **webcola** does the constraint work. Starting from the d3-dag positions it
 *    settles the cluster into a tighter arrangement that satisfies hard
 *    separation constraints: no card overlaps, every connection pointing the way
 *    the layering says it does, and each canvas group's cards kept together.
 *    A refinement is kept only when it is still overlap-free and smaller than
 *    the layered layout, so webcola can tighten a cluster but never spoil one.
 *
 * Both are finished by the same tail as the Clean engine
 * (`layoutComponents` in clean.ts): cluster packing, connection routing, label
 * placement, the cost-aware refinement pass, and verification.
 */

import type { AllCanvasNodeData, CanvasEdgeData } from "./Canvas.d";
import type { CleanOptions, CleanDirection, CleanReport } from "./clean";
import {
  verifyCleanLayout,
  DEFAULT_CLEAN_OPTIONS,
  layoutComponents,
  computeGroupMembers,
  bboxArea,
  betterReport,
  groupPadding,
  assignSidesByGeometry,
  type LaidComponent,
} from "./clean";
import { connectedComponents } from "./graph";
import {
  DEFAULT_EXACT_DECROSS,
  MAX_EXACT_DECROSS,
  clusterGap,
  layoutClusterInDirection,
} from "./daglayout";
import { Layout, type Node, type Link, type Group } from "webcola";

// ──────────────────────────────────────────────────────────────────────────────
// Options
// ──────────────────────────────────────────────────────────────────────────────

/** Re-exported so the plugin's public surface keeps exporting it from here. */
export { DEFAULT_EXACT_DECROSS };

export interface DagColaOptions extends Partial<CleanOptions> {
  /** Refine each cluster with webcola's constraint solver (default: true). */
  useColaRefinement?: boolean;
  /** Crossing minimisation is exact for clusters up to this size. */
  exactDecrossThreshold?: number;
}

interface ResolvedOptions {
  clean: CleanOptions;
  exactDecross: number;
  useCola: boolean;
  direction: CleanDirection;
}

function resolveOptions(options: DagColaOptions): ResolvedOptions {
  const clean: CleanOptions = { ...DEFAULT_CLEAN_OPTIONS, ...options };
  const requested = options.exactDecrossThreshold ?? DEFAULT_EXACT_DECROSS;
  return {
    clean,
    exactDecross: Math.min(MAX_EXACT_DECROSS, Math.max(2, Math.round(requested))),
    useCola: options.useColaRefinement ?? true,
    direction: clean.direction,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// webcola: constraint refinement per cluster
// ──────────────────────────────────────────────────────────────────────────────

interface ColaNode extends Node {
  id: string;
  index: number;
}

interface ColaLink extends Link<ColaNode> {
  original: CanvasEdgeData;
}

/** A webcola separation constraint: `right` must sit at least `gap` past `left`. */
interface Separation {
  axis: "x" | "y";
  left: number;
  right: number;
  gap: number;
}

/** A webcola alignment constraint: these nodes share one coordinate on `axis`. */
interface Alignment {
  type: "alignment";
  axis: "x" | "y";
  offsets: { node: number; offset: number }[];
}

/**
 * Where each card sits in the layered layout: which rank (row) and its position
 * within that rank.
 *
 * Read off the geometry rather than out of d3-dag internals — same-rank cards are
 * centred on the same flow coordinate, and their order across the rank is their
 * cross-axis order. This works for every orientation, including the two
 * independently laid-out wings of a balanced mind map.
 */
export function clusterRanks(
  cards: AllCanvasNodeData[],
  leftToRight: boolean
): Map<string, { rank: number; order: number }> {
  const main = (n: AllCanvasNodeData): number =>
    leftToRight ? n.x + n.width / 2 : n.y + n.height / 2;
  const cross = (n: AllCanvasNodeData): number =>
    leftToRight ? n.y + n.height / 2 : n.x + n.width / 2;

  const ranks: AllCanvasNodeData[][] = [];
  let lastCentre = Number.NaN;
  for (const n of [...cards].sort((a, b) => main(a) - main(b))) {
    const centre = main(n);
    if (ranks.length === 0 || Math.abs(centre - lastCentre) > 1) {
      ranks.push([]);
      lastCentre = centre;
    }
    ranks[ranks.length - 1]!.push(n);
  }

  const out = new Map<string, { rank: number; order: number }>();
  ranks.forEach((row, rank) => {
    [...row]
      .sort((a, b) => cross(a) - cross(b))
      .forEach((n, order) => out.set(n.id, { rank, order }));
  });
  return out;
}

/** Pairwise ordering constraints above which the layered structure is left unpinned. */
const MAX_ORDERING_CONSTRAINTS = 20000;


/**
 * Constraints that pin the layered structure so a refinement can tighten the
 * layout but never permute it.
 *
 * Crossings come from the *order* of cards, not their exact spacing, so every
 * pair is pinned at the minimum legal separation and every rank is held on one
 * line. That freezes the drawing's structure while leaving webcola free to pull
 * ranks together — which is the slack worth reclaiming, because d3-dag sizes a
 * rank's band by the tallest card in it, so a short card following a tall one is
 * held further away than its own extents require. Without the alignment the
 * solver is free to slide cards out of their rows, which silently destroys the
 * crossing minimality the whole layout was built for.
 */
function orderingConstraints(
  cards: AllCanvasNodeData[],
  colaNodes: ColaNode[],
  ranks: Map<string, { rank: number; order: number }>,
  axis: "x" | "y"
): (Separation | Alignment)[] {
  const nodeOf = new Map<string, ColaNode>();
  for (const node of colaNodes) nodeOf.set(node.id, node);

  const rows = new Map<number, ColaNode[]>();
  for (const card of cards) {
    const info = ranks.get(card.id);
    const node = nodeOf.get(card.id);
    if (!info || !node) continue;
    const row = rows.get(info.rank);
    if (row) row.push(node);
    else rows.set(info.rank, [node]);
  }
  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  if (ordered.length === 0) return [];

  const crossAxis: "x" | "y" = axis === "x" ? "y" : "x";
  // ColaNode extents already carry the requested spacing (see colaRefine).
  const extent = (n: ColaNode, on: "x" | "y"): number => (on === "x" ? n.width ?? 0 : n.height ?? 0);

  const constraints: (Separation | Alignment)[] = [];

  // Within a rank: cards share one line and stay side by side, in the order
  // d3-dag chose for them.
  for (const row of ordered) {
    const sorted = [...row].sort((a, b) => ranks.get(a.id)!.order - ranks.get(b.id)!.order);
    if (sorted.length > 1) {
      constraints.push({
        type: "alignment",
        axis,
        offsets: sorted.map((n) => ({ node: n.index, offset: 0 })),
      });
    }
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        constraints.push({
          axis: crossAxis,
          left: sorted[i]!.index,
          right: sorted[j]!.index,
          gap: (extent(sorted[i]!, crossAxis) + extent(sorted[j]!, crossAxis)) / 2,
        });
      }
    }
  }

  // Between neighbouring ranks: every card of one rank stays downstream of every
  // card of the rank before it, whatever their sizes.
  for (let r = 0; r + 1 < ordered.length; r++) {
    for (const above of ordered[r]!) {
      for (const below of ordered[r + 1]!) {
        constraints.push({
          axis,
          left: above.index,
          right: below.index,
          gap: (extent(above, axis) + extent(below, axis)) / 2,
        });
      }
    }
  }

  return constraints;
}

/**
 * webcola reads groups as a hierarchy of node indices: `leaves` and `groups`
 * are indices into the node array and the group array respectively, and passing
 * indices (rather than objects) is what makes webcola mark each node's `parent`
 * and therefore generate the containing constraints.
 */
function buildColaGroups(
  compNodes: AllCanvasNodeData[],
  indexOf: Map<string, number>,
  groupMembers: Map<string, Set<string>>,
  padding: number
): Group[] {
  // Only groups that actually hold cards of this cluster take part.
  const groups = compNodes.filter(
    (n) => n.type === "group" && [...(groupMembers.get(n.id) ?? [])].some((id) => indexOf.has(id))
  );
  if (groups.length === 0) return [];

  const groupIndex = new Map(groups.map((g, i) => [g.id, i]));

  // A canvas group's parent is the smallest group enclosing its centre — the
  // same rule Obsidian uses when a group is dropped inside another.
  const parentOf = new Map<string, string>();
  for (const g of groups) {
    const cx = g.x + g.width / 2;
    const cy = g.y + g.height / 2;
    let best: AllCanvasNodeData | null = null;
    for (const other of groups) {
      if (other.id === g.id) continue;
      const inside =
        cx >= other.x && cx <= other.x + other.width && cy >= other.y && cy <= other.y + other.height;
      if (!inside) continue;
      if (!best || other.width * other.height < best.width * best.height) best = other;
    }
    if (best) parentOf.set(g.id, best.id);
  }

  const childGroups = new Map<string, string[]>();
  for (const g of groups) {
    const parent = parentOf.get(g.id);
    if (parent) childGroups.set(parent, [...(childGroups.get(parent) ?? []), g.id]);
  }

  /** Cards owned by a nested group belong to that group, not to its ancestor. */
  const nestedCards = new Map<string, Set<string>>();
  const collectNested = (id: string, seen: Set<string> = new Set()): Set<string> => {
    const cached = nestedCards.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    nestedCards.set(id, out);
    if (seen.has(id)) return out;
    seen.add(id);
    for (const child of childGroups.get(id) ?? []) {
      for (const member of groupMembers.get(child) ?? []) out.add(member);
      for (const member of collectNested(child, seen)) out.add(member);
    }
    return out;
  };

  const clusterPadding = groupPadding(padding);
  return groups.map((g) => {
    const nested = collectNested(g.id);
    const leaves = [...(groupMembers.get(g.id) ?? [])]
      .filter((id) => indexOf.has(id) && !nested.has(id))
      .map((id) => indexOf.get(id)!);
    return {
      id: g.id,
      padding: clusterPadding,
      leaves,
      groups: (childGroups.get(g.id) ?? []).map((id) => groupIndex.get(id)!),
    } as unknown as Group;
  });
}

/**
 * Refine one cluster with webcola, starting from the layered positions.
 *
 * Constraints handed to webcola are all index-based, which is the only form its
 * projection solver understands:
 *  - non-overlap comes from `avoidOverlaps` over the real card extents,
 *  - flow direction comes from `flowLayout`, whose generated separation
 *    constraints are cycle-safe (edges inside a strongly connected component are
 *    skipped) and are given a centre-to-centre gap covering both cards' extents,
 *  - group containment comes from the group hierarchy built above.
 *
 * No unconstrained iterations are run: the d3-dag positions are the starting
 * point and must survive, so only the constrained phases move anything.
 */
export function colaRefine(
  compNodes: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[],
  direction: CleanDirection,
  groupMembers: Map<string, Set<string>>,
  gap: number,
  padding: number,
  iterations?: number
): AllCanvasNodeData[] {
  const cards = compNodes.filter((n) => n.type !== "group");
  if (cards.length < 2) return compNodes;

  const indexOf = new Map<string, number>(cards.map((n, i) => [n.id, i]));
  // webcola enforces separation on the boxes it is handed, so every card's box is
  // inflated by the requested spacing. The solver then keeps a real gap between
  // cards instead of letting them touch, which is what stops a refinement from
  // silently throwing away the caller's spacing (and with it the room that
  // connection labels need).
  const colaNodes: ColaNode[] = cards.map((n, i) => ({
    id: n.id,
    index: i,
    // webcola works with card centres, the canvas stores top-left corners.
    x: n.x + n.width / 2,
    y: n.y + n.height / 2,
    width: n.width + gap,
    height: n.height + gap,
  }));

  const colaLinks = compEdges
    .filter((e) => e.fromNode !== e.toNode && indexOf.has(e.fromNode) && indexOf.has(e.toNode))
    .map((e) => ({
      source: colaNodes[indexOf.get(e.fromNode)!]!,
      target: colaNodes[indexOf.get(e.toNode)!]!,
      weight: 1,
      original: e,
    })) as unknown as ColaLink[];

  const axis = direction === "left-to-right" ? "x" : "y";
  const extentOn = (node: Node): number => (axis === "y" ? node.height ?? 0 : node.width ?? 0);
  // Centre-to-centre minimum for a connection: the two half-extents, which the
  // inflation above has already loaded with the requested spacing.
  const separation = (link: ColaLink): number => (extentOn(link.source) + extentOn(link.target)) / 2;

  const layout = new Layout()
    .nodes(colaNodes)
    .links(colaLinks)
    .avoidOverlaps(true)
    .handleDisconnected(false) // one connected cluster at a time
    .convergenceThreshold(1e-3)
    // Pull connected cards to the tightest spacing the constraints allow.
    .linkDistance(separation as unknown as (t: Link<Node | number>) => number);

  const groups = buildColaGroups(compNodes, indexOf, groupMembers, padding);
  if (groups.length > 0) layout.groups(groups).groupCompactness(1e-3);

  // Freeze the structure the crossings were minimised for. Past the cap the
  // structure is left unpinned and the caller's candidate comparison decides.
  const ordering = orderingConstraints(
    cards,
    colaNodes,
    clusterRanks(cards, direction === "left-to-right"),
    axis
  );
  if (ordering.length > 0 && ordering.length <= MAX_ORDERING_CONSTRAINTS) layout.constraints(ordering);

  layout.flowLayout(axis, separation as unknown as (t: unknown) => number);

  layout.start(0, 30, iterations ?? Math.min(60, Math.max(20, cards.length * 2)), 0, false, false);

  const centres = new Map<string, { x: number; y: number }>();
  for (const node of layout.nodes() as unknown as ColaNode[]) {
    const card = cards[node.index];
    if (!card) continue;
    centres.set(node.id, { x: node.x - card.width / 2, y: node.y - card.height / 2 });
  }

  return compNodes.map((n) => {
    const centre = centres.get(n.id);
    return centre ? ({ ...n, x: centre.x, y: centre.y } as AllCanvasNodeData) : n;
  });
}

/**
 * Drop a refinement that left cards on top of each other — that is never
 * acceptable, whatever else it may have improved.
 */
function keepApart(
  refined: AllCanvasNodeData[],
  layered: AllCanvasNodeData[],
  compEdges: CanvasEdgeData[]
): AllCanvasNodeData[] {
  if (refined.filter((n) => n.type !== "group").length < 2) return layered;
  return verifyCleanLayout(refined, compEdges).cardOverlaps > 0 ? layered : refined;
}

function samePositions(a: AllCanvasNodeData[], b: AllCanvasNodeData[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id) return false;
    if (Math.abs(a[i]!.x - b[i]!.x) > 0.5 || Math.abs(a[i]!.y - b[i]!.y) > 0.5) return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Spacing scales each cluster is laid out at. How much room a canvas needs
 * depends on connections that have to squeeze between cards, so a couple of
 * spacings are tried and the cleanest result wins.
 */
const GAP_SCALES: number[] = [1, 1.5];

interface Candidate {
  label: string;
  clusters: LaidComponent[];
  opts: CleanOptions;
}

/**
 * Lay out a canvas with d3-dag, refine each cluster with webcola, and finish
 * through the shared pipeline.
 *
 * 1. Split cards into connected clusters (groups are containers, not subjects).
 * 2. Per cluster: d3-dag Sugiyama layout, in the configured orientation.
 * 3. Per cluster: webcola constraint refinement, pinned to the layered
 *    structure so it can tighten spacing but not permute the drawing.
 * 4. Pack the clusters and route connections/labels (shared with Clean layout).
 * 5. Re-wrap group containers and verify.
 *
 * Steps 2–4 run at a couple of spacings, and the lexicographically cleanest
 * result wins. Spacing is searched because whether a connection can be routed
 * clear of every card depends on how much room there is, so the tightest
 * arrangement is not always the cleanest. Every candidate — webcola's included —
 * goes through the identical step 4, which is what lets webcola run by default:
 * it is a second opinion, never a regression.
 */
export function dagcolaLayout(
  inputNodes: AllCanvasNodeData[],
  inputEdges: CanvasEdgeData[],
  options: DagColaOptions = {}
): { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport } {
  const resolved = resolveOptions(options);

  const groupIds = new Set(inputNodes.filter((n) => n.type === "group").map((g) => g.id));
  const cards = inputNodes.filter((n) => n.type !== "group");
  const layoutEdges = inputEdges.filter((e) => !groupIds.has(e.fromNode) && !groupIds.has(e.toNode));

  const components = connectedComponents(cards, layoutEdges);
  // Group membership is positional, so it has to be read before anything moves.
  const groupMembers = computeGroupMembers(inputNodes);

  // Connections are re-seated on the sides that face each other from their new
  // positions, so every candidate is measured on the same footing (and no
  // candidate inherits stale sides from the canvas's previous arrangement).
  const clustered = (comp: AllCanvasNodeData[], opts: CleanOptions): LaidComponent => {
    const ids = new Set(comp.map((n) => n.id));
    const compEdges = layoutEdges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
    const { nodes, notes } = layoutClusterInDirection(
      comp,
      compEdges,
      resolved.direction,
      resolved.exactDecross,
      clusterGap(compEdges, opts)
    );
    return { nodes, edges: assignSidesByGeometry(nodes, compEdges), notes };
  };

  const colaVariant = (base: LaidComponent[], opts: CleanOptions): LaidComponent[] =>
    base.map((cluster) => {
      const refined = colaRefine(
        cluster.nodes,
        cluster.edges,
        resolved.direction,
        groupMembers,
        clusterGap(cluster.edges, opts),
        opts.padding
      );
      const nodes = keepApart(refined, cluster.nodes, cluster.edges);
      return { nodes, edges: assignSidesByGeometry(nodes, cluster.edges), notes: cluster.notes };
    });

  const candidates: Candidate[] = [];
  for (const scale of GAP_SCALES) {
    const opts: CleanOptions = { ...resolved.clean, gap: resolved.clean.gap * scale };
    const base = components.map((comp) => clustered(comp, opts));
    candidates.push({ label: `d3-dag ×${scale}`, clusters: base, opts });
    if (!resolved.useCola) continue;
    const refined = colaVariant(base, opts);
    // Skip the tail entirely when webcola left every card where d3-dag put it.
    if (refined.some((c, i) => !samePositions(c.nodes, base[i]!.nodes))) {
      candidates.push({ label: `webcola ×${scale}`, clusters: refined, opts });
    }
  }

  const debug =
    resolved.clean.debug ?? (typeof process !== "undefined" && !!process.env?.DAGCOLA_DEBUG);
  let best: { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; report: CleanReport } | null = null;
  let bestArea = 0;
  let chosen = "";
  for (const candidate of candidates) {
    const result = layoutComponents(inputNodes, inputEdges, components, candidate.clusters, candidate.opts);
    const area = bboxArea(result.nodes);
    if (debug) console.log(`[dagcola] ${candidate.label.padEnd(14)} ${describe(result, area)}`);
    if (!best || betterReport(result.report, area, best.report, bestArea)) {
      best = result;
      bestArea = area;
      chosen = candidate.label;
    }
  }
  if (debug) console.log(`[dagcola] -> ${chosen}`);
  return best ?? layoutComponents(inputNodes, inputEdges, components, [], resolved.clean);
}

function describe(
  result: { report: CleanReport; nodes: AllCanvasNodeData[] },
  area: number
): string {
  const r = result.report;
  return (
    `cross=${r.edgeCrossings} behind=${r.edgeCardHits} overlap=${r.cardOverlaps} ` +
    `labelCard=${r.labelCardOverlaps} labelLabel=${r.labelLabelOverlaps} labelEdge=${r.labelEdgeHits} ` +
    `area=${Math.round(area)}`
  );
}
