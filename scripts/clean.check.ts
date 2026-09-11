/**
 * Verification harness for the clean-layout engine.
 *
 * Runs pure (no Obsidian) synthetic canvases through cleanLayout() and checks the
 * hard guarantees: no card overlaps, no connection-behind-card, no label overlaps.
 * Crossings are reported (zero expected for trees; minimised otherwise).
 *
 * Build + run:
 *   npx tsc scripts/clean.check.ts src/clean.ts src/pack.ts src/graph.ts \
 *     --outDir /tmp/clean-check --module commonjs --target es2020 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop --strict false \
 *   && node /tmp/clean-check/scripts/clean.check.js
 */
import {
  cleanLayout,
  verifyCleanLayout,
  describeCleanReport,
  DEFAULT_CLEAN_OPTIONS,
} from "../src/clean";

type AnyNode = Record<string, unknown>;
type AnyEdge = Record<string, unknown>;

let failures = 0;

function check(cond: boolean, label: string): void {
  if (!cond) {
    failures++;
    console.log(`  ✗ ${label}`);
  }
}

function node(id: string, x: number, y: number, w = 200, h = 100): AnyNode {
  return { id, x, y, width: w, height: h, type: "text", text: id };
}

function group(id: string, x: number, y: number, w: number, h: number): AnyNode {
  return { id, x, y, width: w, height: h, type: "group", label: id };
}

function edge(id: string, from: string, to: string, label?: string): AnyEdge {
  const e: AnyEdge = { id, fromNode: from, toNode: to };
  if (label) e.label = label;
  return e;
}

function run(
  name: string,
  nodes: AnyNode[],
  edges: AnyEdge[],
  direction: string,
  members?: Map<string, Set<string>>,
  strict = true
): void {
  const dir = direction as (typeof DEFAULT_CLEAN_OPTIONS)["direction"];
  const { nodes: outNodes, edges: outEdges, report } = cleanLayout(
    nodes as never[],
    edges as never[],
    { ...DEFAULT_CLEAN_OPTIONS, direction: dir }
  );

  // Cross-check the report against an independent verification of the output.
  const independent = verifyCleanLayout(outNodes, outEdges, members);

  console.log(`\n${name} [${direction}]`);
  console.log(`  ${describeCleanReport(report)}`);

  // Hard guarantees, independent of graph topology.
  check(report.cardOverlaps === 0, `card overlaps = ${report.cardOverlaps} (expected 0)`);
  check(report.labelCardOverlaps === 0, `label/card overlaps = ${report.labelCardOverlaps} (expected 0)`);
  check(report.labelLabelOverlaps === 0, `label/label overlaps = ${report.labelLabelOverlaps} (expected 0)`);
  // Space-permitting guarantees — only expected when the graph is planar.
  if (strict) {
    check(report.edgeCrossings === 0, `connection crossings = ${report.edgeCrossings} (expected 0)`);
    check(report.edgeCardHits === 0, `connections behind cards = ${report.edgeCardHits} (expected 0)`);
  }
  check(
    independent.cardOverlaps === report.cardOverlaps &&
      independent.edgeCrossings === report.edgeCrossings &&
      independent.edgeCardHits === report.edgeCardHits &&
      independent.labelCardOverlaps === report.labelCardOverlaps &&
      independent.labelLabelOverlaps === report.labelLabelOverlaps &&
      independent.labelEdgeHits === report.labelEdgeHits,
    "reported numbers match independent verification"
  );
  // Node/edge identity must be preserved.
  check(outNodes.length === nodes.length, `node count preserved (${outNodes.length}/${nodes.length})`);
  check(outEdges.length === edges.length, `edge count preserved (${outEdges.length}/${edges.length})`);
  const idsIn = new Set(nodes.map((n) => n.id as string));
  check(outNodes.every((n) => idsIn.has(n.id)), "all node ids preserved");
  if (report.edgeCrossings > 0) console.log(`  · ${report.edgeCrossings} unavoidable crossing(s) reported`);
  if (report.labelEdgeHits > 0) console.log(`  · ${report.labelEdgeHits} label/connection touch(es) reported`);
}

/* ── scenario 1: mind-map tree, three levels ── */
const tree: AnyNode[] = [node("root", 0, 0)];
const treeEdges: AnyEdge[] = [];
const NOUNS = ["Design", "Build", "Test", "Ship", "Docs", "Ops"];
for (let i = 0; i < 3; i++) {
  tree.push(node(`branch${i}`, 400 * i, 300));
  treeEdges.push(edge(`e-root-${i}`, "root", `branch${i}`, "part of"));
  for (let j = 0; j < 3; j++) {
    tree.push(node(`leaf${i}${j}`, 400 * i + 120 * j, 600));
    treeEdges.push(edge(`e-${i}-${j}`, `branch${i}`, `leaf${i}${j}`, NOUNS[(i * 3 + j) % NOUNS.length]));
  }
}

/* ── scenario 2: four-node cycle (planar) ── */
const cycle: AnyNode[] = [
  node("a", 0, 0),
  node("b", 400, 0),
  node("c", 400, 300),
  node("d", 0, 300),
];
const cycleEdges: AnyEdge[] = [
  edge("a-b", "a", "b"),
  edge("b-c", "b", "c"),
  edge("c-d", "c", "d"),
  edge("d-a", "d", "a"),
];

/* ── scenario 3: K5 (non-planar — crossings are unavoidable) ── */
const k5: AnyNode[] = ["a", "b", "c", "d", "e"].map((id, i) => node(id, i * 250, 0));
const k5Edges: AnyEdge[] = [];
{
  const ids = ["a", "b", "c", "d", "e"];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) k5Edges.push(edge(`${ids[i]}-${ids[j]}`, ids[i]!, ids[j]!));
}

/* ── scenario 4: two trees + isolated card, with a group ── */
const forest: AnyNode[] = [
  group("g1", -50, -50, 600, 400),
  node("r1", 0, 0),
  node("r1a", 0, 250),
  node("r1b", 250, 250),
  node("r2", 1200, 0),
  node("r2a", 1200, 250),
  node("solo", 2000, 0),
];
const forestEdges: AnyEdge[] = [
  edge("r1-r1a", "r1", "r1a"),
  edge("r1-r1b", "r1", "r1b"),
  edge("r2-r2a", "r2", "r2a", "linked"),
];

/* ── scenario 5: star with long labels (label space pressure) ── */
const star: AnyNode[] = [node("hub", 0, 0)];
const starEdges: AnyEdge[] = [];
const LONG = "a rather long connection label that needs clearance";
for (let i = 0; i < 6; i++) {
  star.push(node(`s${i}`, i * 300, 400));
  starEdges.push(edge(`hub-s${i}`, "hub", `s${i}`, LONG));
}

/* ── scenario 6: spanning edge must cross its own row of cards ── */
// n0..n3 stacked in a column with a bounding edge n0<->n3; n1/n2 sit in the
// way and must be jogged up/down rather than have the edge drawn behind them.
const spanNodes: AnyNode[] = [node("n0", 0, 0), node("n1", 0, 200), node("n2", 0, 400), node("n3", 0, 600)];
const spanEdges: AnyEdge[] = [
  edge("e01", "n0", "n1"),
  edge("e12", "n1", "n2"),
  edge("e23", "n2", "n3"),
  edge("e30", "n3", "n0", "spanning"),
];

console.log("=== clean layout verification ===");
run("Mind-map tree", tree, treeEdges, "top-to-bottom");
run("Mind-map tree", tree, treeEdges, "balanced");
run("Mind-map tree", tree, treeEdges, "left-to-right");
run("4-cycle (planar)", cycle, cycleEdges, "top-to-bottom");
run(
  "Forest + isolated + group",
  forest,
  forestEdges,
  "top-to-bottom",
  new Map([["g1", new Set(["r1", "r1a", "r1b"])]])
);
run("Star, long labels", star, starEdges, "balanced");
run("K5 (non-planar)", k5, k5Edges, "top-to-bottom", undefined, false);
run("Spanning edge across cards", spanNodes, spanEdges, "top-to-bottom");

const treeReport = cleanLayout(tree as never[], treeEdges as never[], {
  ...DEFAULT_CLEAN_OPTIONS,
  direction: "balanced",
}).report;
check(treeReport.edgeCrossings === 0, `tree crossings = ${treeReport.edgeCrossings} (expected 0)`);

const spanResult = cleanLayout(spanNodes as never[], spanEdges as never[], {
  ...DEFAULT_CLEAN_OPTIONS,
  direction: "top-to-bottom",
});
check(spanResult.report.edgeCardHits === 0, `spanning edge behind cards = ${spanResult.report.edgeCardHits} (expected 0)`);
check(spanResult.report.labelCardOverlaps === 0, `spanning label behind cards = ${spanResult.report.labelCardOverlaps} (expected 0)`);

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
