/**
 * Verification harness for the dagcola (d3-dag + webcola) layout engine.
 *
 * Runs synthetic canvases through dagcolaLayout() and checks the hard
 * guarantees, twice for every scenario — once with the webcola refinement on and
 * once with it off — so neither half of the engine can regress unnoticed.
 * Also exercises colaRefine() directly, since that is where the constraint
 * indices and the compaction have to be right.
 *
 * Build + run:
 *   npx tsc scripts/dagcola.check.ts src/dagcola.ts src/clean.ts src/pack.ts src/graph.ts \
 *     --outDir /tmp/dagcola-check --module commonjs --target es2020 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop --strict false \
 *   && NODE_PATH="$PWD/node_modules" node /tmp/dagcola-check/scripts/dagcola.check.js
 */
import {
  dagcolaLayout,
  colaRefine,
} from "../src/dagcola";
import {
  verifyCleanLayout,
  describeCleanReport,
  DEFAULT_CLEAN_OPTIONS,
  bboxArea,
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

function area(nodes: AnyNode[]): number {
  return bboxArea(nodes as never[]);
}

/** Centre of a card, used to test that group boxes really contain their members. */
function centre(n: AnyNode): { x: number; y: number } {
  return { x: (n.x as number) + (n.width as number) / 2, y: (n.y as number) + (n.height as number) / 2 };
}

function run(
  name: string,
  nodes: AnyNode[],
  edges: AnyEdge[],
  direction: string,
  members?: Map<string, Set<string>>,
  strict = true
): { areaWithCola: number; areaWithoutCola: number } {
  const dir = direction as (typeof DEFAULT_CLEAN_OPTIONS)["direction"];

  const withCola = dagcolaLayout(nodes as never[], edges as never[], {
    ...DEFAULT_CLEAN_OPTIONS,
    direction: dir,
    useColaRefinement: true,
  });
  const withoutCola = dagcolaLayout(nodes as never[], edges as never[], {
    ...DEFAULT_CLEAN_OPTIONS,
    direction: dir,
    useColaRefinement: false,
  });

  console.log(`\n${name} [${direction}]`);

  for (const [label, result] of [
    ["+cola", withCola],
    ["-cola", withoutCola],
  ] as const) {
    const { nodes: outNodes, edges: outEdges, report } = result;

    // Cross-check the report against an independent verification of the output.
    const independent = verifyCleanLayout(outNodes, outEdges, members);

    console.log(`  ${label}: ${describeCleanReport(report)}`);

    // Hard guarantees, independent of graph topology.
    check(report.cardOverlaps === 0, `${label} card overlaps = ${report.cardOverlaps} (expected 0)`);
    check(report.labelCardOverlaps === 0, `${label} label/card overlaps = ${report.labelCardOverlaps} (expected 0)`);
    check(report.labelLabelOverlaps === 0, `${label} label/label overlaps = ${report.labelLabelOverlaps} (expected 0)`);
    // Space-permitting guarantees — only expected when the graph is planar.
    if (strict) {
      check(report.edgeCrossings === 0, `${label} connection crossings = ${report.edgeCrossings} (expected 0)`);
      check(report.edgeCardHits === 0, `${label} connections behind cards = ${report.edgeCardHits} (expected 0)`);
    }
    check(
      independent.cardOverlaps === report.cardOverlaps &&
        independent.edgeCrossings === report.edgeCrossings &&
        independent.edgeCardHits === report.edgeCardHits &&
        independent.labelCardOverlaps === report.labelCardOverlaps &&
        independent.labelLabelOverlaps === report.labelLabelOverlaps &&
        independent.labelEdgeHits === report.labelEdgeHits,
      `${label} reported numbers match independent verification`
    );
    // Node/edge identity must be preserved.
    check(outNodes.length === nodes.length, `${label} node count preserved (${outNodes.length}/${nodes.length})`);
    check(outEdges.length === edges.length, `${label} edge count preserved (${outEdges.length}/${edges.length})`);
    const idsIn = new Set(nodes.map((n) => n.id as string));
    check(outNodes.every((n) => idsIn.has(n.id)), `${label} all node ids preserved`);
    // Group boxes must actually contain their members.
    if (members) {
      for (const [groupId, memberIds] of members) {
        const box = outNodes.find((n) => n.id === groupId);
        if (!box) continue;
        for (const id of memberIds) {
          const m = outNodes.find((n) => n.id === id);
          if (!m) continue;
          const c = centre(m as AnyNode);
          const inside =
            c.x >= (box.x as number) &&
            c.x <= (box.x as number) + (box.width as number) &&
            c.y >= (box.y as number) &&
            c.y <= (box.y as number) + (box.height as number);
          check(inside, `${label} member ${id} inside group ${groupId}`);
        }
      }
    }
    if (report.edgeCrossings > 0) console.log(`  · ${label}: ${report.edgeCrossings} unavoidable crossing(s) reported`);
    if (report.labelEdgeHits > 0) console.log(`  · ${label}: ${report.labelEdgeHits} label/connection touch(es) reported`);
  }

  return { areaWithCola: area(withCola.nodes), areaWithoutCola: area(withoutCola.nodes) };
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
const forestMembers = new Map([["g1", new Set(["r1", "r1a", "r1b"])]]);
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
const spanNodes: AnyNode[] = [node("n0", 0, 0), node("n1", 0, 200), node("n2", 0, 400), node("n3", 0, 600)];
const spanEdges: AnyEdge[] = [
  edge("e01", "n0", "n1"),
  edge("e12", "n1", "n2"),
  edge("e23", "n2", "n3"),
  edge("e30", "n3", "n0", "spanning"),
];

/* ── scenario 7: complex graph with cycles ── */
const complex: AnyNode[] = [
  node("A", 0, 0),
  node("B", 300, 0),
  node("C", 600, 0),
  node("D", 0, 250),
  node("E", 300, 250),
  node("F", 600, 250),
  node("G", 0, 500),
  node("H", 300, 500),
  node("I", 600, 500),
];
const complexEdges: AnyEdge[] = [
  edge("A-B", "A", "B"),
  edge("B-C", "B", "C"),
  edge("D-E", "D", "E"),
  edge("E-F", "E", "F"),
  edge("G-H", "G", "H"),
  edge("H-I", "H", "I"),
  edge("A-D", "A", "D"),
  edge("D-G", "D", "G"),
  edge("B-E", "B", "E"),
  edge("E-H", "E", "H"),
  edge("C-F", "C", "F"),
  edge("F-I", "F", "I"),
  edge("A-E", "A", "E"),
  edge("E-A", "E", "A"),
  edge("B-F", "B", "F"),
  edge("D-H", "D", "H"),
  edge("E-I", "E", "I"),
];

/* ── scenario 8: self-connection (d3-dag rejects self loops) ── */
const selfLoop: AnyNode[] = [node("p", 0, 0), node("q", 300, 0)];
const selfLoopEdges: AnyEdge[] = [edge("p-q", "p", "q"), edge("p-p", "p", "p")];

console.log("=== dagcola layout verification ===");
const treeTb = run("Mind-map tree", tree, treeEdges, "top-to-bottom");
const treeLr = run("Mind-map tree", tree, treeEdges, "left-to-right");
run("Mind-map tree", tree, treeEdges, "balanced");
run("4-cycle (planar)", cycle, cycleEdges, "top-to-bottom");
run("4-cycle (planar)", cycle, cycleEdges, "left-to-right");
run("Forest + isolated + group", forest, forestEdges, "top-to-bottom", forestMembers);
run("Forest + isolated + group", forest, forestEdges, "left-to-right", forestMembers);
run("Forest + isolated + group", forest, forestEdges, "balanced", forestMembers);
run("Star, long labels", star, starEdges, "balanced");
run("Star, long labels", star, starEdges, "left-to-right");
run("K5 (non-planar)", k5, k5Edges, "top-to-bottom", undefined, false);
run("Spanning edge across cards", spanNodes, spanEdges, "top-to-bottom");
run("Complex cyclic graph", complex, complexEdges, "top-to-bottom");
run("Self-connection", selfLoop, selfLoopEdges, "top-to-bottom");

/* ── orientation must actually change the layout ── */
{
  const tb = dagcolaLayout(tree as never[], treeEdges as never[], {
    ...DEFAULT_CLEAN_OPTIONS,
    direction: "top-to-bottom",
    useColaRefinement: false,
  });
  const lr = dagcolaLayout(tree as never[], treeEdges as never[], {
    ...DEFAULT_CLEAN_OPTIONS,
    direction: "left-to-right",
    useColaRefinement: false,
  });
  const span = (nodes: { x: number; y: number; width: number; height: number }[]): { w: number; h: number } => ({
    w: Math.max(...nodes.map((n) => n.x + n.width)) - Math.min(...nodes.map((n) => n.x)),
    h: Math.max(...nodes.map((n) => n.y + n.height)) - Math.min(...nodes.map((n) => n.y)),
  });
  const tbSpan = span(tb.nodes);
  const lrSpan = span(lr.nodes);
  console.log(`\nOrientation: top-to-bottom ${tbSpan.w}x${tbSpan.h}, left-to-right ${lrSpan.w}x${lrSpan.h}`);
  check(tbSpan.w !== lrSpan.w || tbSpan.h !== lrSpan.h, "left-to-right differs from top-to-bottom");
  // The tree is shallow and wide: depth (3 levels) becomes the horizontal or
  // vertical extent depending on which way the ranks advance.
  check(tbSpan.w > tbSpan.h, "top-to-bottom spreads the shallow tree horizontally");
  check(lrSpan.h > lrSpan.w, "left-to-right spreads the shallow tree vertically");
  check(lrSpan.h > tbSpan.h, "left-to-right is taller than top-to-bottom");
}

/* ── the webcola refinement itself ── */
{
  console.log("\nwebcola refinement");
  // A deliberately loose chain: d3-dag's own spacing would leave ~220px between
  // layers for 100px tall cards, so there is real slack for cola to remove.
  const chain: AnyNode[] = [node("c0", 0, 0), node("c1", 0, 220), node("c2", 0, 440)];
  const chainEdges: AnyEdge[] = [edge("c0-c1", "c0", "c1"), edge("c0-c2", "c1", "c2")];
  const refined = colaRefine(
    chain as never[],
    chainEdges as never[],
    "top-to-bottom",
    new Map(),
    DEFAULT_CLEAN_OPTIONS.gap,
    DEFAULT_CLEAN_OPTIONS.padding
  );
  const before = area(chain);
  const after = area(refined as unknown as AnyNode[]);
  console.log(`  chain area ${Math.round(before)} -> ${Math.round(after)}`);
  check(verifyCleanLayout(refined, chainEdges as never[]).cardOverlaps === 0, "refined chain has no card overlaps");
  check(after < before, "refinement tightens a loose chain");
  check(
    refined.some((n, i) => n.x !== chain[i]!.x || n.y !== chain[i]!.y),
    "refinement actually moves cards"
  );

  // Groups must survive the constraint build (this is where the old
  // string-indexed constraints used to throw).
  const grouped: AnyNode[] = [
    group("g", -20, -20, 240, 340),
    node("a", 0, 0),
    node("b", 0, 220),
  ];
  const groupedEdges: AnyEdge[] = [edge("a-b", "a", "b")];
  let threw = false;
  try {
    colaRefine(
      grouped as never[],
      groupedEdges as never[],
      "top-to-bottom",
      new Map([["g", new Set(["a", "b"])]]),
      DEFAULT_CLEAN_OPTIONS.gap,
      DEFAULT_CLEAN_OPTIONS.padding
    );
  } catch (e) {
    threw = true;
    console.log(`  grouped refinement threw: ${(e as Error).message}`);
  }
  check(!threw, "refinement with a group does not throw");
  // And the end-to-end path with groups must stay overlap-free with cola on.
  check(
    dagcolaLayout(grouped as never[], groupedEdges as never[], {
      ...DEFAULT_CLEAN_OPTIONS,
      useColaRefinement: true,
    }).report.cardOverlaps === 0,
    "grouped canvas stays overlap-free with refinement on"
  );
}

/* ── refinement must never enlarge a layout ── */
{
  console.log("\nrefinement is never a regression");
  const cases: [string, number, number][] = [
    ["tree top-to-bottom", treeTb.areaWithCola, treeTb.areaWithoutCola],
    ["tree left-to-right", treeLr.areaWithCola, treeLr.areaWithoutCola],
  ];
  for (const [label, withCola, withoutCola] of cases) {
    console.log(`  ${label}: ${Math.round(withoutCola)} -> ${Math.round(withCola)}`);
    check(withCola <= withoutCola, `${label}: refinement is not larger (${Math.round(withCola)} <= ${Math.round(withoutCola)})`);
  }
}

/* ── webcola must actually earn its place ── */
{
  // Cards of very uneven size are where d3-dag over-reserves: it sizes a rank's
  // band by the largest card in it, so the small cards are held further apart
  // than their own extents require. webcola's constrained solve can reclaim that
  // without touching the order the crossings were minimised for.
  const uneven: AnyNode[] = [
    node("root", 0, 0, 400, 100),
    node("wide", 0, 300, 700, 100),
    node("u1", 300, 300, 120, 100),
    node("u2", 600, 300, 120, 100),
    node("u3", 900, 300, 120, 100),
    node("u4", 1200, 300, 120, 100),
    node("tall", 0, 600, 200, 400),
  ];
  const unevenEdges: AnyEdge[] = [
    edge("r-wide", "root", "wide"),
    edge("r-1", "root", "u1"),
    edge("r-2", "root", "u2"),
    edge("r-3", "root", "u3"),
    edge("r-4", "root", "u4"),
    edge("wide-tall", "wide", "tall"),
  ];
  console.log("\nwebcola earns its place: uneven card sizes");
  const withCola = dagcolaLayout(uneven as never[], unevenEdges as never[], {
    ...DEFAULT_CLEAN_OPTIONS,
    direction: "balanced",
    useColaRefinement: true,
  });
  const withoutCola = dagcolaLayout(uneven as never[], unevenEdges as never[], {
    ...DEFAULT_CLEAN_OPTIONS,
    direction: "balanced",
    useColaRefinement: false,
  });
  const tight = area(withCola.nodes);
  const loose = area(withoutCola.nodes);
  console.log(`  balanced: ${Math.round(loose)} -> ${Math.round(tight)}`);
  // The candidate set with refinement on is a superset of the one with it off,
  // so a strict area win here can only come from a webcola candidate.
  check(tight < loose, "a webcola candidate wins on uneven card sizes");
  check(withCola.report.cardOverlaps === 0, "the winning webcola layout has no card overlaps");
  check(withCola.report.edgeCrossings === 0, "the winning webcola layout has no crossings");
}

const treeReport = dagcolaLayout(tree as never[], treeEdges as never[], {
  ...DEFAULT_CLEAN_OPTIONS,
  direction: "balanced",
}).report;
check(treeReport.edgeCrossings === 0, `tree crossings = ${treeReport.edgeCrossings} (expected 0)`);

const spanResult = dagcolaLayout(spanNodes as never[], spanEdges as never[], {
  ...DEFAULT_CLEAN_OPTIONS,
  direction: "top-to-bottom",
});
check(spanResult.report.edgeCardHits === 0, `spanning edge behind cards = ${spanResult.report.edgeCardHits} (expected 0)`);
check(spanResult.report.labelCardOverlaps === 0, `spanning label behind cards = ${spanResult.report.labelCardOverlaps} (expected 0)`);

/* ── the exact-crossing threshold must do something ── */
{
  const small = dagcolaLayout(tree as never[], treeEdges as never[], {
    ...DEFAULT_CLEAN_OPTIONS,
    exactDecrossThreshold: 10,
    useColaRefinement: false,
  });
  const large = dagcolaLayout(tree as never[], treeEdges as never[], {
    ...DEFAULT_CLEAN_OPTIONS,
    exactDecrossThreshold: 60,
    useColaRefinement: false,
  });
  console.log(`\nExact-crossing threshold accepted: exact=${describeCleanReport(small.report)}`);
  check(small.report.cardOverlaps === 0 && large.report.cardOverlaps === 0, "both thresholds produce overlap-free layouts");
  check(small.report.edgeCrossings === 0 && large.report.edgeCrossings === 0, "both thresholds produce crossing-free layouts");
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
